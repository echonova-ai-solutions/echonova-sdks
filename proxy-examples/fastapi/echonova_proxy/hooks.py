"""The parts you replace: who the end user is, how much they may use, and which jobs are theirs.

Pass your own versions to create_app(settings, authenticate=..., quota=..., jobs=...).
"""

from __future__ import annotations

import asyncio
import hmac
import math
import time
from collections import OrderedDict, deque
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


class JobOwners(Protocol):
    """Which of your users owns which job.

    Every user's calls reach EchoNova with the same workspace key, so the API can't tell your
    users' jobs apart. The proxy records the job each successful create (and each Speech to Text
    stream) returns as the calling user's, and answers 404 when another user reads, exports or
    deletes it. Keep these records in your database, next to the rest of your user's data.

    product is "text-to-speech", "speech-to-text" or "sound-cleaning".
    """

    async def record(self, product: str, job_id: str, user_id: str) -> None:
        """Remember that user_id created the job."""

    async def is_owner(self, product: str, job_id: str, user_id: str) -> bool:
        """Did user_id create the job? False makes the proxy answer 404."""

    async def has_other_owners(self, product: str, job_id: str, user_id: str) -> bool:
        """Does anyone besides user_id own the job? Then user_id's delete leaves it at EchoNova for them."""

    async def release(self, product: str, job_id: str, user_id: str) -> None:
        """user_id deleted the job: stop counting them as an owner. Other owners keep it."""


class InMemoryJobOwners:
    """DEMO ONLY - REPLACE THIS with a table in your database.

    Keeps job owners in this process, for the most recent max_jobs jobs. A job that falls out (or
    that was created before a restart, or on another worker or instance) is 404 for everyone, its
    owner too: the store fails closed. Store (product, job_id, user_id) rows in your database
    instead, and list a user's jobs from there.

    A job can have more than one owner: the API returns the same job for the same synthesis input
    within 24 hours, so two users who send the same text both get it.
    """

    def __init__(self, max_jobs: int = 100_000) -> None:
        self.max_jobs = max_jobs
        self.owners: OrderedDict[tuple[str, str], set[str]] = OrderedDict()  # oldest first

    async def record(self, product: str, job_id: str, user_id: str) -> None:
        key = (product, job_id)
        self.owners.setdefault(key, set()).add(user_id)
        self.owners.move_to_end(key)
        while len(self.owners) > self.max_jobs:
            self.owners.popitem(last=False)

    async def is_owner(self, product: str, job_id: str, user_id: str) -> bool:
        return user_id in self.owners.get((product, job_id), ())

    async def has_other_owners(self, product: str, job_id: str, user_id: str) -> bool:
        return bool(self.owners.get((product, job_id), set()) - {user_id})

    async def release(self, product: str, job_id: str, user_id: str) -> None:
        key = (product, job_id)
        owners = self.owners.get(key)
        if owners is not None:
            owners.discard(user_id)
            if not owners:
                del self.owners[key]
