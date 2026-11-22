"""REST relay: allow-list, end-user auth, quota, job ownership, key injection, streaming both ways."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator

import httpx
from starlette.background import BackgroundTask
from starlette.requests import ClientDisconnect, Request
from starlette.responses import Response, StreamingResponse

from .common import (
    FORWARDED_REQUEST_HEADERS,
    MESSAGES,
    UNEXPECTED_REDIRECT,
    Proxy,
    error_body,
    request_id,
    safe_response_headers,
    scoped_idempotency_key,
    strip_prefix,
    user_agent,
)
from .log import log_event
from .routes import (
    JOB_CREATING_ROUTES,
    JOB_NOT_FOUND,
    STREAM_ROUTES,
    created_job_id,
    job_id_of,
    match_rest,
    product_of,
)

# A job-creating answer is read whole before it is relayed, to record its job for the user before
# the app can ask for it. These answers are small JSON; a longer one is relayed unrecorded.
MAX_JOB_RESPONSE = 8 * 1024 * 1024


class BodyTooLarge(Exception):
    pass


def proxy_error(status: int, rid: str, message: str | None = None, headers: dict[str, str] | None = None) -> Response:
    return Response(
        error_body(status, message or MESSAGES[status]),
        status_code=status,
        media_type="application/json",
        headers={"x-request-id": rid, "cache-control": "no-store", **(headers or {})},
    )


def _deleted(rid: str) -> Response:
    """The API's own answer to a successful job delete."""
    return Response(
        b'{"success":true,"statusCode":200,"errorMessage":null,"data":{"deleted":true}}',
        media_type="application/json",
        headers={"x-request-id": rid, "cache-control": "no-store"},
    )


async def handle_http(request: Request) -> Response:
    proxy: Proxy = request.app.state.proxy
    settings = proxy.settings
    started = time.perf_counter()
    rid = request_id(request.headers.get("x-request-id"))
    fields: dict[str, object] = {"method": request.method, "request_id": rid}

    def done(response: Response, **extra: object) -> Response:
        fields.update(extra, status=response.status_code, ms=round((time.perf_counter() - started) * 1000))
        log_event("http", logging.WARNING if response.status_code >= 500 else logging.INFO, **fields)
        return response

    raw_path = (request.scope.get("raw_path") or request.scope["path"].encode()).decode("latin-1")
    path = strip_prefix(raw_path, settings.prefix)
    if path is None:
        return done(proxy_error(404, rid))
    if path in STREAM_ROUTES:
        return done(proxy_error(426, rid), route=path)
    route = match_rest(request.method, path)
    if not route.allowed:
        return done(proxy_error(404, rid))
    if not route.found:
        return done(proxy_error(405, rid, headers={"allow": ", ".join(route.allowed)}), route=path)
    fields["route"] = route.template

    user = await proxy.authenticate(request)
    if not user:
        return done(proxy_error(401, rid))
    fields["user"] = user
    retry_after = await proxy.quota.allow_request(user)
    if retry_after is not None:
        return done(proxy_error(429, rid, headers={"retry-after": str(retry_after)}))

    # One workspace key serves every user: a job is only its creator's to read, export or delete.
    # Someone else's job gets the API's own answer for an unknown job, so its existence stays hidden.
    product = product_of(path)
    job_id = job_id_of(str(route.template), path)
    if job_id is not None and not await proxy.jobs.is_owner(product, job_id, user):
        return done(proxy_error(404, rid, JOB_NOT_FOUND[product]), outcome="not_owner")
    creates_job = (request.method, route.template) in JOB_CREATING_ROUTES
    deletes_job = job_id is not None and request.method == "DELETE"
    if deletes_job and await proxy.jobs.has_other_owners(product, job_id, user):
        # Another user owns this job too (the API returned it for the same input), so it stays at
        # EchoNova for them. For this user it is gone, as if the API had deleted it.
        await proxy.jobs.release(product, job_id, user)
        return done(_deleted(rid), outcome="released")

    headers = {name: request.headers[name] for name in FORWARDED_REQUEST_HEADERS if name in request.headers}
    if "idempotency-key" in headers:
        headers["idempotency-key"] = scoped_idempotency_key(
            headers["idempotency-key"], user, settings.stream_token_secret
        )
    headers.update(
        {
            "authorization": f"Bearer {settings.api_key}",
            "user-agent": user_agent(request.headers.get("user-agent")),
            "x-request-id": rid,
            "accept-encoding": "identity",
        }
    )
    body: AsyncIterator[bytes] | None = None
    body_done = asyncio.Event()
    length = request.headers.get("content-length")
    if request.method == "POST" and (length is not None or "transfer-encoding" in request.headers):
        if length is not None:
            if not length.isdigit():
                return done(proxy_error(400, rid, "Invalid Content-Length"))
            if int(length) > settings.max_upload_bytes:
                return done(proxy_error(413, rid))
            headers["content-length"] = length  # streamed as-is; otherwise chunked
        body = _limited(request, settings.max_upload_bytes, body_done)
    else:
        body_done.set()

    query = request.scope.get("query_string", b"").decode("latin-1")
    url = settings.upstream_url + path + (f"?{query}" if query else "")
    upstream_request = proxy.client.build_request(request.method, url, headers=headers, content=body)

    # Wait for EchoNova's answer, but stop if the app hangs up first. EchoNova still finishes
    # (and charges) work it has started; there is just no one left to relay the answer to.
    send = asyncio.ensure_future(proxy.client.send(upstream_request, stream=True))
    hangup = asyncio.ensure_future(_wait_for_disconnect(request, body_done))
    try:
        await asyncio.wait({send, hangup}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        hangup.cancel()
        if not send.done():
            send.cancel()
            await asyncio.wait({send})
    if send.cancelled():
        return done(Response(status_code=499), outcome="client_closed")
    try:
        upstream = send.result()
    except BodyTooLarge:
        return done(proxy_error(413, rid))
    except ClientDisconnect:
        return done(Response(status_code=499), outcome="client_closed")
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
        return done(proxy_error(503, rid), upstream_error=type(exc).__name__)
    except httpx.TimeoutException as exc:
        return done(proxy_error(504, rid), upstream_error=type(exc).__name__)
    except httpx.HTTPError as exc:
        return done(proxy_error(502, rid), upstream_error=type(exc).__name__)

    if upstream.is_redirect:
        # The API doesn't redirect; the proxy never follows one (it could lead the key elsewhere).
        await upstream.aclose()
        return done(proxy_error(502, rid, UNEXPECTED_REDIRECT), upstream_status=upstream.status_code)

    ok = upstream.is_success
    kept: list[bytes] = []  # the start of a job-creating answer, read before anything is relayed
    complete = False
    chunks = upstream.aiter_bytes()
    if creates_job and ok:
        size = 0
        try:
            async for chunk in chunks:
                kept.append(chunk)
                size += len(chunk)
                if size > MAX_JOB_RESPONSE:
                    break
            else:
                complete = True
        except httpx.HTTPError as exc:
            await upstream.aclose()
            return done(proxy_error(502, rid), upstream_error=type(exc).__name__)
        created = created_job_id(b"".join(kept)) if complete else None
        if created is not None:
            await proxy.jobs.record(product, created, user)
        else:
            log_event("job.unrecorded", logging.WARNING, route=fields["route"], request_id=rid)
    if deletes_job and ok:
        await proxy.jobs.release(product, job_id, user)

    response_headers = safe_response_headers(upstream.headers.multi_items())
    upstream_rid = upstream.headers.get("x-request-id")
    if upstream_rid is None:
        response_headers.append(("x-request-id", rid))
    response_headers.append(("cache-control", "no-store"))
    if complete:
        await upstream.aclose()
        response: Response = Response(
            b"".join(kept), status_code=upstream.status_code, headers=dict(_merge(response_headers))
        )
        return done(response, upstream_request_id=upstream_rid)
    response = StreamingResponse(
        _relay(upstream, fields, kept, chunks),
        status_code=upstream.status_code,
        headers=dict(_merge(response_headers)),
        background=BackgroundTask(upstream.aclose),
    )
    return done(response, upstream_request_id=upstream_rid)


async def _limited(request: Request, limit: int, finished: asyncio.Event) -> AsyncIterator[bytes]:
    """The app's request body, chunk by chunk, never held in memory as a whole."""
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise BodyTooLarge
        if chunk:
            yield chunk
    finished.set()


async def _wait_for_disconnect(request: Request, body_done: asyncio.Event) -> None:
    await body_done.wait()  # the body belongs to the upload until it is fully read
    while (await request.receive())["type"] != "http.disconnect":
        pass


async def _relay(
    upstream: httpx.Response, fields: dict[str, object], kept: list[bytes], chunks: AsyncIterator[bytes]
) -> AsyncIterator[bytes]:
    try:
        for chunk in kept:
            yield chunk
        async for chunk in chunks:
            yield chunk
    except httpx.HTTPError as exc:
        log_event(
            "http.upstream_cut",
            logging.WARNING,
            route=fields.get("route"),
            request_id=fields.get("request_id"),
            error=type(exc).__name__,
        )
        # Re-raise so the server aborts the connection: the app must see a failed download,
        # never a shortened body that looks complete.
        raise
    finally:
        with contextlib.suppress(Exception):
            await upstream.aclose()


def _merge(headers: list[tuple[str, str]]) -> list[tuple[str, str]]:
    seen: dict[str, str] = {}
    for name, value in headers:
        seen[name] = f"{seen[name]}, {value}" if name in seen else value
    return list(seen.items())
