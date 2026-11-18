"""The proxy application: create_app(settings, authenticate=..., quota=..., jobs=...)."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qsl, urlencode

import httpx
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.websockets import WebSocketState

from .common import (
    EXPOSED_HEADERS,
    STREAM_TOKEN_PARAM,
    STREAM_TOKEN_SCOPE_KEY,
    Proxy,
    error_body,
    request_id,
    strip_prefix,
)
from .config import ConfigError, Settings
from .hooks import Authenticate, InMemoryJobOwners, InMemoryQuota, JobOwners, Quota, demo_authenticate
from .http_proxy import handle_http, proxy_error
from .log import log_event, quiet_libraries
from .tokens import mint_stream_token
from .ws_proxy import deny_error, handle_ws

ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


def create_app(
    settings: Settings,
    *,
    authenticate: Authenticate | None = None,
    quota: Quota | None = None,
    jobs: JobOwners | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    if authenticate is None:
        if not settings.demo_token:
            raise ConfigError("set PROXY_DEMO_TOKEN for the demo auth hook, or pass your own authenticate= (hooks.py)")
        authenticate = demo_authenticate(settings.demo_token, settings.session_cookie)
    if quota is None:
        quota = InMemoryQuota(settings.requests_per_minute, settings.max_streams_per_user, settings.max_streams_total)
    auth, limits = authenticate, quota
    quiet_libraries()
    timeout = httpx.Timeout(settings.read_timeout, connect=settings.connect_timeout, pool=settings.connect_timeout)
    client = httpx.AsyncClient(timeout=timeout, follow_redirects=False, transport=transport)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        log_event("proxy.start", upstream=settings.upstream_url, prefix=settings.prefix or "/")
        yield
        await client.aclose()

    # No generated docs: this app only relays the routes in routes.py.
    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    # Set here rather than at startup, so the app also works mounted inside another app
    # (mounted apps don't get their own startup and shutdown events).
    app.state.proxy = Proxy(settings, auth, limits, InMemoryJobOwners() if jobs is None else jobs, client)
    app.add_middleware(BrowserPolicy, prefix=settings.prefix, allowed_origins=settings.allowed_origins)

    @app.api_route("/healthz", methods=["GET", "HEAD"])
    async def healthz() -> JSONResponse:
        return JSONResponse({"status": "ok"}, headers={"cache-control": "no-store"})

    @app.post(f"{settings.prefix}/stream-token")
    async def stream_token(request: Request) -> Response:
        """A short-lived token for ?access_token= on a WebSocket URL (for browsers without cookies)."""
        rid = request_id(request.headers.get("x-request-id"))
        user = await auth(request)
        if not user:
            log_event("stream_token", status=401, request_id=rid)
            return proxy_error(401, rid)
        retry_after = await limits.allow_request(user)
        if retry_after is not None:
            log_event("stream_token", status=429, user=user, request_id=rid)
            return proxy_error(429, rid, headers={"retry-after": str(retry_after)})
        token = mint_stream_token(user, settings.stream_token_secret, settings.stream_token_ttl)
        log_event("stream_token", status=200, user=user, request_id=rid)
        return JSONResponse(
            {"token": token, "expiresIn": settings.stream_token_ttl},
            headers={"cache-control": "no-store", "x-request-id": rid},
        )

    @app.api_route("/{path:path}", methods=ALL_METHODS)
    async def relay_http(request: Request) -> Response:
        return await handle_http(request)

    @app.websocket("/{path:path}")
    async def relay_ws(websocket: WebSocket) -> None:
        try:
            await handle_ws(websocket)
        except Exception as exc:
            if websocket.application_state != WebSocketState.CONNECTING:
                raise
            # Anything thrown (by a hook, say) becomes a plain 500: no stack traces, no request data.
            log_event("ws.error", logging.ERROR, error=type(exc).__name__)
            await deny_error(websocket, 500, request_id(websocket.headers.get("x-request-id")), "Internal server error")

    @app.exception_handler(Exception)
    async def internal_error(request: Request, exc: Exception) -> Response:
        # Anything thrown (by a hook, say) becomes a plain 500: no stack traces, no request data.
        rid = request_id(request.headers.get("x-request-id"))
        log_event("http.error", logging.ERROR, request_id=rid, error=type(exc).__name__)
        return proxy_error(500, rid, "Internal server error")

    return app


class BrowserPolicy:
    """Browser rules for everything under the prefix.

    - CORS for the origins you list, with credentials, so web apps can use cookies.
    - Requests that carry an Origin you didn't list are refused (403), REST and WebSocket
      alike. CORS alone doesn't stop another site from *sending* a form post or opening a
      WebSocket with your users' cookies; this check does. Apps that aren't browsers
      (mobile, server-side SDKs) send no Origin and are unaffected.
    - A WebSocket's ?access_token= is taken out of the URL before anything else sees it,
      including the server's own log lines.
    """

    def __init__(self, app: ASGIApp, prefix: str, allowed_origins: frozenset[str]) -> None:
        self.app = app
        self.prefix = prefix
        self.allowed_origins = allowed_origins

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        raw_path = (scope.get("raw_path") or scope["path"].encode()).decode("latin-1")
        if strip_prefix(raw_path, self.prefix) is None:
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            _take_stream_token(scope)
        origin = _header(scope, b"origin")
        if origin is not None and origin not in self.allowed_origins:
            rid = request_id(_header(scope, b"x-request-id"))
            log_event("origin.rejected", type=scope["type"], request_id=rid)
            return await _send_error(scope, send, 403, rid)
        if origin is None or scope["type"] == "websocket":
            return await self.app(scope, receive, send)

        cors = [
            (b"access-control-allow-origin", origin.encode("latin-1")),
            (b"access-control-allow-credentials", b"true"),
            (b"vary", b"Origin"),
        ]
        if scope["method"] == "OPTIONS" and _header(scope, b"access-control-request-method") is not None:
            preflight = [
                *cors,
                (b"access-control-allow-methods", b"GET, POST, DELETE"),
                (b"access-control-allow-headers", b"Authorization, Content-Type, Idempotency-Key, X-Request-Id"),
                (b"access-control-max-age", b"600"),
            ]
            await send({"type": "http.response.start", "status": 204, "headers": preflight})
            return await send({"type": "http.response.body", "body": b""})

        async def send_with_cors(message: Message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [
                    *message.get("headers", []),
                    *cors,
                    (b"access-control-expose-headers", EXPOSED_HEADERS.encode()),
                ]
            await send(message)

        await self.app(scope, receive, send_with_cors)


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", []):
        if key.lower() == name:
            return str(value.decode("latin-1"))
    return None


def _take_stream_token(scope: dict[str, Any]) -> None:
    query = scope.get("query_string", b"").decode("latin-1")
    if STREAM_TOKEN_PARAM not in query:
        return
    pairs = parse_qsl(query, keep_blank_values=True)
    tokens = [v for k, v in pairs if k == STREAM_TOKEN_PARAM]
    scope["query_string"] = urlencode([(k, v) for k, v in pairs if k != STREAM_TOKEN_PARAM]).encode("latin-1")
    if tokens:
        scope[STREAM_TOKEN_SCOPE_KEY] = tokens[-1]


async def _send_error(scope: Scope, send: Send, status: int, rid: str) -> None:
    headers = [(b"content-type", b"application/json"), (b"x-request-id", rid.encode()), (b"cache-control", b"no-store")]
    body = error_body(status, "Origin not allowed")
    if scope["type"] == "websocket":
        if "websocket.http.response" not in scope.get("extensions", {}):
            return await send({"type": "websocket.close", "code": 1008})
        await send({"type": "websocket.http.response.start", "status": status, "headers": headers})
        return await send({"type": "websocket.http.response.body", "body": body})
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})
