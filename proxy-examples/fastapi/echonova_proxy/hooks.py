"""The two parts you replace: who the end user is, and how much they may use.

Pass your own versions to create_app(settings, authenticate=..., quota=...).
"""

from __future__ import annotations

import asyncio
import hmac
import math
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Protocol

from starlette.requests import HTTPConnection

# Returns your user's id, or None to reject the request with 401.
# Called for REST requests and for WebSocket upgrades (the connection is a Request or a WebSocket).
# Stream tokens (?access_token= on WebSocket URLs) are checked by the proxy before this hook.
Authenticate = Callable[[HTTPConnection], Awaitable["str | None"]]


def demo_authenticate(token: str, cookie_name: str = "session") -> Authenticate:
    """DEMO ONLY - REPLACE THIS with your own authentication.

    Accepts one static token (PROXY_DEMO_TOKEN), sent either as `Authorization: Bearer <token>`
    or as the session cookie, and treats everyone who has it as the same user. In a real app,
    verify your own session cookie or access token here (look the session up, or check the
    JWT's signature, expiry and audience) and return that user's id.
    """
    expected = token.encode("utf-8")

    async def authenticate(conn: HTTPConnection) -> str | None:
        header = conn.headers.get("authorization", "")
        scheme, _, credentials = header.partition(" ")
        candidate = credentials.strip() if scheme.lower() == "bearer" else conn.cookies.get(cookie_name, "")
        if candidate and hmac.compare_digest(candidate.encode("utf-8"), expected):
            return "demo-user"
        return None

    return authenticate


class Quota(Protocol):
    async def allow_request(self, user_id: str) -> int | None:
        """None to allow the request, or the number of seconds to wait (sent as Retry-After)."""

    async def acquire_stream(self, user_id: str) -> bool:
        """Reserve a concurrent-stream slot. False rejects the stream with 429."""

    async def release_stream(self, user_id: str) -> None:
        """Give back a slot reserved by acquire_stream (always called once the stream ends)."""


class InMemoryQuota:
    """Example quota: N requests a minute per user, and a cap on concurrent streams.

    Every REST request and every stream connection counts as a request. The concurrent-stream
    caps apply per user and across all users: the EchoNova workspace allows 10 concurrent
    streams in total (TTS and STT combined), so a proxy that lets more through only gets 429s
    from upstream.

    State lives in this process. With several proxy instances, keep these counters in a shared
    store (Redis or your database) instead.
    """

    def __init__(
        self,
        requests_per_minute: int = 60,
        max_streams_per_user: int = 2,
        max_streams_total: int = 10,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.requests_per_minute = requests_per_minute
        self.max_streams_per_user = max_streams_per_user
        self.max_streams_total = max_streams_total
        self._clock = clock
        self._requests: dict[str, deque[float]] = {}
        self._streams: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def allow_request(self, user_id: str) -> int | None:
        async with self._lock:
            now = self._clock()
            window = self._requests.setdefault(user_id, deque())
            while window and window[0] <= now - 60:
                window.popleft()
            if len(window) >= self.requests_per_minute:
                return max(1, math.ceil(window[0] + 60 - now))
            window.append(now)
            self._forget_idle(now)
            return None

    async def acquire_stream(self, user_id: str) -> bool:
        async with self._lock:
            if self._streams.get(user_id, 0) >= self.max_streams_per_user:
                return False
            if sum(self._streams.values()) >= self.max_streams_total:
                return False
            self._streams[user_id] = self._streams.get(user_id, 0) + 1
            return True

    async def release_stream(self, user_id: str) -> None:
        async with self._lock:
            left = self._streams.get(user_id, 0) - 1
            if left > 0:
                self._streams[user_id] = left
            else:
                self._streams.pop(user_id, None)

    def _forget_idle(self, now: float) -> None:
        # Keep memory bounded: drop users with no request in the last minute.
        if len(self._requests) > 10_000:
            for user in [u for u, w in self._requests.items() if not w or w[-1] <= now - 60]:
                del self._requests[user]
