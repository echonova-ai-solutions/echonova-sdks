"""Helpers shared by the streaming tests."""

from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import Coroutine
from typing import Any, TypeVar

from mock_server import MockServer

from echonova._core._retry import RetryPolicy
from echonova._streaming import StreamOptions

T = TypeVar("T")

TEST_KEY = "ek_test"


class FastRetry(RetryPolicy):
    """The real retry table, with tiny backoff delays so tests stay fast."""

    def backoff(self, retry_number: int) -> float:
        return 0.01


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def options_for(server: MockServer, **overrides: Any) -> StreamOptions:
    base = StreamOptions(
        ws_base_url=server.url,
        headers=lambda: {"Authorization": f"Bearer {TEST_KEY}"},
        user_agent="echonova-python/test",
        open_timeout=3.0,
        close_timeout=1.0,
        retry_policy=FastRetry(rng=lambda: 0.0),
        session_start_timeout=3.0,
    )
    return dataclasses.replace(base, **overrides)


def run(coro: Coroutine[Any, Any, T], timeout: float = 15.0) -> T:
    """Run an async test body with a hard timeout, so a hang fails instead of stalling CI."""

    async def guarded() -> T:
        return await asyncio.wait_for(coro, timeout)

    return asyncio.run(guarded())


def pcm(seconds: float, sample_rate: int = 16_000) -> bytes:
    """Silence-free test audio: a repeating ramp, whole 16-bit samples."""
    count = int(seconds * sample_rate)
    return bytes((i % 251) for i in range(count * 2))
