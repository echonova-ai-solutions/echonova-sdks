"""Test harness: a fake EchoNova API (HTTP + WebSocket) and the proxy, both real servers on
127.0.0.1. Nothing here talks to the real API."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import uvicorn

from echonova_proxy import Settings, create_app

API_KEY = "ek_REDACTED_proxy_test_key_0001"  # made up; must never reach the app side
USER_TOKEN = "user-token-1"
ORIGIN = "https://app.example.com"
UPSTREAM_RID = "upstream-rid-1"

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class Server:
    """Run an ASGI app with uvicorn on a free port, inside the test's event loop."""

    def __init__(self, app: Any) -> None:
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=0,
            log_config=None,
            access_log=False,
            ws="websockets-sansio",
            ws_max_size=1024 * 1024,
            ws_per_message_deflate=False,
            lifespan="on",
        )
        self.server = uvicorn.Server(config)

    async def __aenter__(self) -> Server:
        self.task = asyncio.ensure_future(self.server.serve())
        while not self.server.started:
            if self.task.done():
                self.task.result()
            await asyncio.sleep(0.005)
        self.port = self.server.servers[0].sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc: object) -> None:
        self.server.should_exit = True
        await self.task

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


@dataclass
class Recorded:
    method: str
    path: str
    query: str
    headers: dict[str, str]
    raw_headers: list[tuple[str, str]]
    body_bytes: int = 0
    body_sha256: str = ""
    chunks: int = 0


@dataclass
class FakeUpstream:
    """Stands in for api.echonova.ai. Tests inspect what it received and steer its answers."""

    requests: list[Recorded] = field(default_factory=list)
    ws_handshakes: list[Recorded] = field(default_factory=list)
    ws_closes: list[tuple[int, str]] = field(default_factory=list)
    ws_closed: asyncio.Event = field(default_factory=asyncio.Event)
    burst_sent: int = 0
    first_chunk: asyncio.Event = field(default_factory=asyncio.Event)
    # Optional custom HTTP answer: (scope, receive, send, recorded) after the body was read.
    respond: Callable[[Scope, Receive, Send, Recorded], Awaitable[None]] | None = None
    # (status, json body, extra headers) to refuse WebSocket upgrades.
    ws_reject: tuple[int, dict[str, Any], dict[str, str]] | None = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            while (await receive())["type"] != "lifespan.shutdown":
                await send({"type": "lifespan.startup.complete"})
            await send({"type": "lifespan.shutdown.complete"})
        elif scope["type"] == "http":
            await self._http(scope, receive, send)
        elif scope["type"] == "websocket":
            await self._ws(scope, receive, send)

    def _record(self, scope: Scope) -> Recorded:
        raw = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in scope["headers"]]
        return Recorded(
            method=scope.get("method", "GET"),
            path=scope["raw_path"].decode("latin-1"),
            query=scope["query_string"].decode("latin-1"),
            headers={k: v for k, v in raw},
            raw_headers=raw,
        )

    async def _http(self, scope: Scope, receive: Receive, send: Send) -> None:
        recorded = self._record(scope)
        self.requests.append(recorded)
        digest = hashlib.sha256()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if chunk:
                recorded.chunks += 1
                recorded.body_bytes += len(chunk)
                digest.update(chunk)
                self.first_chunk.set()
            if not message.get("more_body"):
                break
        recorded.body_sha256 = digest.hexdigest()
        if self.respond is not None:
            return await self.respond(scope, receive, send, recorded)
        body = json.dumps(
            {
                "data": {"method": recorded.method, "path": recorded.path, "bytes": recorded.body_bytes},
                "success": True,
                "statusCode": 200,
                "errorMessage": None,
            }
        ).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"x-request-id", UPSTREAM_RID.encode()),
                    (b"x-ratelimit-limit", b"100"),
                    (b"x-ratelimit-remaining", b"99"),
                    (b"x-ratelimit-reset", b"60"),
                    (b"set-cookie", b"upstream_session=abc; HttpOnly"),
                    (b"server", b"fake-upstream"),
                    (b"x-powered-by", b"fake"),
                    (b"access-control-allow-origin", b"*"),
                    (b"x-internal-trace", b"node-7"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def _ws(self, scope: Scope, receive: Receive, send: Send) -> None:
        recorded = self._record(scope)
        self.ws_handshakes.append(recorded)
        await receive()  # websocket.connect
        if self.ws_reject is not None:
            status, body, headers = self.ws_reject
            await send(
                {
                    "type": "websocket.http.response.start",
                    "status": status,
                    "headers": [
                        (b"content-type", b"application/json; charset=utf-8"),
                        (b"x-request-id", UPSTREAM_RID.encode()),
                        (b"x-internal-trace", b"node-7"),
                        *((k.encode(), v.encode()) for k, v in headers.items()),
                    ],
                }
            )
            await send({"type": "websocket.http.response.body", "body": json.dumps(body).encode()})
            return
        await send({"type": "websocket.accept"})
        if recorded.path.endswith("/speech-to-text/stream"):
            await send({"type": "websocket.send", "text": json.dumps({"type": "session.started"})})
        while True:
            message = await receive()
            if message["type"] == "websocket.disconnect":
                self.ws_closes.append((message.get("code", 1005), message.get("reason") or ""))
                self.ws_closed.set()
                return
            if message.get("bytes") is not None:
                await send({"type": "websocket.send", "bytes": message["bytes"]})
                continue
            text = message.get("text") or ""
            command = json.loads(text) if text.startswith("{") else {}
            if command.get("type") == "close":
                await send({"type": "websocket.send", "text": json.dumps({"type": "error", "code": "bye"})})
                await send({"type": "websocket.close", "code": command["code"], "reason": command.get("reason", "")})
                return
            if command.get("type") == "drop":
                return  # no close frame: the proxy sees 1006
            if command.get("type") == "burst":
                for i in range(command["count"]):
                    await send({"type": "websocket.send", "bytes": i.to_bytes(4, "big") * command["size"]})
                    self.burst_sent += 1
                await send({"type": "websocket.send", "text": json.dumps({"type": "done"})})
                continue
            if command.get("type") == "pause":
                await asyncio.sleep(command["seconds"])  # stop reading for a while
                continue
            await send({"type": "websocket.send", "text": text})


@dataclass
class Harness:
    fake: FakeUpstream
    upstream: Server
    proxy: Server
    client: httpx.AsyncClient

    @property
    def base(self) -> str:
        return self.proxy.url + "/echonova"

    def ws_url(self, path: str) -> str:
        return self.proxy.url.replace("http://", "ws://") + "/echonova" + path


def make_settings(upstream_url: str, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "api_key": API_KEY,
        "upstream_url": upstream_url,
        "prefix": "/echonova",
        "allowed_origins": frozenset({ORIGIN}),
        "demo_token": USER_TOKEN,
        "stream_token_secret": b"test-secret",
        "requests_per_minute": 1000,
        "max_streams_per_user": 2,
        "max_streams_total": 10,
    }
    values.update(overrides)
    return Settings(**values)


StartProxy = Callable[..., contextlib.AbstractAsyncContextManager[Harness]]


@pytest.fixture
def start_proxy() -> StartProxy:
    @contextlib.asynccontextmanager
    async def start(*, authenticate: Any = None, quota: Any = None, **overrides: Any) -> AsyncIterator[Harness]:
        fake = FakeUpstream()
        async with Server(fake) as upstream:
            settings = make_settings(overrides.pop("upstream_url", upstream.url), **overrides)
            app = create_app(settings, authenticate=authenticate, quota=quota)
            async with (
                Server(app) as proxy,
                httpx.AsyncClient(timeout=30, headers={"authorization": f"Bearer {USER_TOKEN}"}) as client,
            ):
                yield Harness(fake, upstream, proxy, client)

    return start


@pytest.fixture
async def harness(start_proxy: StartProxy) -> AsyncIterator[Harness]:
    async with start_proxy() as h:
        yield h


@pytest.fixture
def logs(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    caplog.set_level(logging.DEBUG)
    return caplog


def all_log_text(caplog: pytest.LogCaptureFixture) -> str:
    from echonova_proxy.log import JsonFormatter

    formatter = JsonFormatter()
    return "\n".join(formatter.format(r) + " " + repr(r.__dict__) for r in caplog.records)
