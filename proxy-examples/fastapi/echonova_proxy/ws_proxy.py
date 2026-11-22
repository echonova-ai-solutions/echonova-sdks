"""WebSocket pass-through for the two EchoNova streams.

The app's upgrade is held until EchoNova has accepted (or refused) the proxy's own upgrade, so:
- a refused upstream handshake is answered with the same HTTP status, JSON body and safe headers;
- once both sides are open, text and binary frames are relayed in order, both ways, one at a
  time (each send waits for the socket to drain, which gives backpressure);
- a close on either side is repeated on the other with the same code and reason. A connection
  that drops without a close frame (1006) is dropped on the other side too. A close frame with
  no code (1005) is repeated as 1000, because a server can't send "no code" here.
- the job id a Speech to Text session announces is recorded as the user's (JobOwners in hooks.py)
  before the message carrying it reaches the app.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Awaitable, Callable
from urllib.parse import parse_qsl, urlencode

from starlette.responses import Response
from starlette.websockets import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

from .common import (
    MESSAGES,
    STREAM_TOKEN_SCOPE_KEY,
    TOO_MANY_STREAMS,
    UNEXPECTED_REDIRECT,
    Proxy,
    error_body,
    request_id,
    safe_response_headers,
    strip_prefix,
    user_agent,
)
from .log import log_event
from .routes import JOB_CREATING_STREAM, STREAM_ROUTES, session_job_id
from .tokens import verify_stream_token

MAX_FRAME_BYTES = 16 * 1024 * 1024  # frames from EchoNova (the API itself caps app frames at 1 MiB)
MAX_REJECTION_BODY = 64 * 1024


async def deny(websocket: WebSocket, status: int, rid: str, body: bytes, headers: list[tuple[str, str]]) -> None:
    """Refuse the upgrade with a plain HTTP response (the app sees the status and the body)."""
    merged = dict(headers)
    merged.setdefault("x-request-id", rid)
    response = Response(body, status_code=status, headers=merged)
    try:
        await websocket.send_denial_response(response)
    except RuntimeError:  # the ASGI server can't send HTTP responses to an upgrade; it answers 403
        await websocket.close(code=1008)


class _ConnectWithoutRedirects(connect):
    """connect() that never follows a redirect: it would send the workspace key to the new location."""

    def process_redirect(self, exc: Exception) -> Exception | str:
        return exc


async def deny_error(websocket: WebSocket, status: int, rid: str, message: str | None = None, **headers: str) -> None:
    extra = [("content-type", "application/json"), *((k.replace("_", "-"), v) for k, v in headers.items())]
    await deny(websocket, status, rid, error_body(status, message or MESSAGES[status]), extra)


async def handle_ws(websocket: WebSocket) -> None:
    proxy: Proxy = websocket.app.state.proxy
    settings = proxy.settings
    started = time.perf_counter()
    rid = request_id(websocket.headers.get("x-request-id"))
    fields: dict[str, object] = {"request_id": rid}

    def log(event: str, **extra: object) -> None:
        fields.update(extra, ms=round((time.perf_counter() - started) * 1000))
        status = fields.get("status")
        log_event(event, logging.WARNING if isinstance(status, int) and status >= 500 else logging.INFO, **fields)

    raw_path = (websocket.scope.get("raw_path") or websocket.scope["path"].encode()).decode("latin-1")
    path = strip_prefix(raw_path, settings.prefix)
    if path is None or path not in STREAM_ROUTES:
        await deny_error(websocket, 404, rid)
        return log("ws.rejected", status=404)
    fields["route"] = path

    token = websocket.scope.get(STREAM_TOKEN_SCOPE_KEY)
    if token is not None:
        user = verify_stream_token(token, settings.stream_token_secret)
    else:
        user = await proxy.authenticate(websocket)
    if not user:
        await deny_error(websocket, 401, rid)
        return log("ws.rejected", status=401)
    fields["user"] = user
    retry_after = await proxy.quota.allow_request(user)
    if retry_after is not None:
        await deny_error(websocket, 429, rid, retry_after=str(retry_after))
        return log("ws.rejected", status=429)
    if not await proxy.quota.acquire_stream(user):
        await deny_error(websocket, 429, rid, TOO_MANY_STREAMS)
        return log("ws.rejected", status=429, reason="streams")

    try:
        allowed = STREAM_ROUTES[path]
        params = [
            (k, v) for k, v in parse_qsl(websocket.scope.get("query_string", b"").decode("latin-1")) if k in allowed
        ]
        url = settings.upstream_ws_url + path + (f"?{urlencode(params)}" if params else "")
        try:
            upstream = await _ConnectWithoutRedirects(
                url,
                additional_headers={"Authorization": f"Bearer {settings.api_key}", "X-Request-Id": rid},
                user_agent_header=user_agent(websocket.headers.get("user-agent")),
                open_timeout=settings.connect_timeout,
                max_size=MAX_FRAME_BYTES,
                compression=None,
            )
        except InvalidStatus as exc:
            if 300 <= exc.response.status_code < 400:
                # The API doesn't redirect, and the proxy never follows one (it could lead the key elsewhere).
                await deny_error(websocket, 502, rid, UNEXPECTED_REDIRECT)
                return log("ws.rejected", status=502, upstream_status=exc.response.status_code)
            # EchoNova refused: give the app the same answer, so the SDK maps it to the same error.
            refused = exc.response
            body = bytes(refused.body or b"")[:MAX_REJECTION_BODY]
            await deny(websocket, refused.status_code, rid, body, safe_response_headers(refused.headers.raw_items()))
            return log(
                "ws.rejected", status=refused.status_code, upstream_request_id=refused.headers.get("x-request-id")
            )
        except TimeoutError:
            await deny_error(websocket, 504, rid)
            return log("ws.rejected", status=504, upstream_error="TimeoutError")
        except OSError as exc:
            await deny_error(websocket, 503, rid)
            return log("ws.rejected", status=503, upstream_error=type(exc).__name__)
        except InvalidHandshake as exc:
            await deny_error(websocket, 502, rid)
            return log("ws.rejected", status=502, upstream_error=type(exc).__name__)

        try:
            await websocket.accept(headers=[(b"x-request-id", rid.encode())])
            log_event("ws.open", **fields)
            counts = {"frames_up": 0, "frames_down": 0}

            async def watch(frame: str) -> None:
                job_id = session_job_id(frame)
                if job_id is None:
                    return
                try:
                    await proxy.jobs.record("speech-to-text", job_id, user)
                except Exception as exc:
                    log_event("job.unrecorded", logging.ERROR, **fields, error=type(exc).__name__)

            closed_by, code, _ = await _relay(
                websocket, upstream, counts, watch if path == JOB_CREATING_STREAM else None
            )
            log("ws.close", closed_by=closed_by, code=code, **counts)
        finally:
            with contextlib.suppress(Exception):
                await upstream.close()  # no-op when the relay already closed it
    finally:
        await proxy.quota.release_stream(user)


async def _relay(
    app: WebSocket,
    upstream: ClientConnection,
    counts: dict[str, int],
    watch: Callable[[str], Awaitable[None]] | None = None,
) -> tuple[str, int, str]:
    """Relay until one side closes, repeat the close on the other side, return who closed and how.

    watch sees EchoNova's text frames before they are relayed.
    """

    async def app_to_upstream() -> tuple[str, int, str] | None:
        while True:
            message = await app.receive()
            if message["type"] == "websocket.disconnect":
                return "app", int(message.get("code") or 1005), message.get("reason") or ""
            data = message.get("bytes")
            try:
                await upstream.send(data if data is not None else message.get("text") or "")
            except ConnectionClosed:
                return None  # upstream is closing; upstream_to_app reports how
            counts["frames_up"] += 1

    async def upstream_to_app() -> tuple[str, int, str] | None:
        try:
            async for data in upstream:
                if isinstance(data, bytes):
                    await app.send_bytes(data)
                else:
                    if watch is not None:
                        await watch(data)
                    await app.send_text(data)
                counts["frames_down"] += 1
        except ConnectionClosed:
            pass
        except (WebSocketDisconnect, OSError, RuntimeError):
            return None  # the app is gone; app_to_upstream reports how
        return "upstream", upstream.close_code or 1006, upstream.close_reason or ""

    up = asyncio.ensure_future(app_to_upstream())
    down = asyncio.ensure_future(upstream_to_app())
    done, _ = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
    first = done.pop()
    other = down if first is up else up
    result = first.result()
    if result is None:
        try:
            result = await asyncio.wait_for(other, timeout=15)
        except TimeoutError:
            result = None
    else:
        other.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await other
    closed_by, code, reason = result or ("app", 1006, "")

    if closed_by == "upstream":
        if code == 1006:
            return closed_by, code, reason  # returning without a close drops the app's connection too
        with contextlib.suppress(Exception):
            await app.close(code=1000 if code == 1005 else code, reason=reason)
    else:
        try:
            await upstream.close(code=1000 if code in (1005, 1006) else code, reason=reason)
        except Exception:  # a code the API can't receive: close normally instead
            with contextlib.suppress(Exception):
                await upstream.close()
    return closed_by, code, reason
