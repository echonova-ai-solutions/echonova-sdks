"""Track EchoNova's per-key, per-endpoint rate limits on the client side.

The API allows 100 requests per 60 s for each key on each endpoint. After a
throttle 429, every caller on that endpoint waits out ``Retry-After`` before
sending again, instead of each one finding out separately.
``X-RateLimit-Reset`` and ``Retry-After`` are read as seconds from now.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from ._envelope import header


@dataclass(frozen=True, slots=True)
class RateLimitInfo:
    limit: int | None
    remaining: int | None
    reset_seconds: float | None  # seconds until the window resets, as of when the response arrived


def _int(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def _float(value: str | None) -> float | None:
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


def parse_rate_limit(headers: Mapping[str, str]) -> RateLimitInfo | None:
    limit = _int(header(headers, "x-ratelimit-limit"))
    remaining = _int(header(headers, "x-ratelimit-remaining"))
    reset = _float(header(headers, "x-ratelimit-reset"))
    if limit is None and remaining is None and reset is None:
        return None
    return RateLimitInfo(limit=limit, remaining=remaining, reset_seconds=reset)


@dataclass(slots=True)
class _Bucket:
    info: RateLimitInfo | None = None
    window_ends_at: float | None = None
    blocked_until: float = 0.0


class RateLimitTracker:
    """Per-bucket state. A bucket is one API operation (the server counts per key per endpoint)."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()

    def observe(self, bucket: str, headers: Mapping[str, str]) -> RateLimitInfo | None:
        info = parse_rate_limit(headers)
        if info is None:
            return None
        with self._lock:
            state = self._buckets.setdefault(bucket, _Bucket())
            state.info = info
            state.window_ends_at = self._clock() + info.reset_seconds if info.reset_seconds is not None else None
        return info

    def block(self, bucket: str, seconds: float) -> None:
        """Record a throttle 429: nothing goes to this bucket for ``seconds``."""
        with self._lock:
            state = self._buckets.setdefault(bucket, _Bucket())
            state.blocked_until = max(state.blocked_until, self._clock() + seconds)

    def wait_time(self, bucket: str, *, preflight: bool = True) -> float:
        """Seconds to wait before sending to ``bucket`` (0 when it's clear)."""
        with self._lock:
            state = self._buckets.get(bucket)
            if state is None:
                return 0.0
            now = self._clock()
            wait = state.blocked_until - now
            if preflight and state.info is not None and state.info.remaining == 0 and state.window_ends_at is not None:
                wait = max(wait, state.window_ends_at - now)
            return max(0.0, wait)

    def last(self, bucket: str) -> RateLimitInfo | None:
        with self._lock:
            state = self._buckets.get(bucket)
            return state.info if state else None

    def snapshot(self) -> dict[str, RateLimitInfo]:
        with self._lock:
            return {name: state.info for name, state in self._buckets.items() if state.info is not None}
