"""The asyncio helpers must never swallow a cancellation of their caller."""

from __future__ import annotations

import asyncio

import pytest
from stream_helpers import run

from echonova._streaming._aio import cancel_and_wait, wait_event


def test_wait_event_times_out_and_returns_state() -> None:
    async def body() -> tuple[bool, bool]:
        event = asyncio.Event()
        missed = await wait_event(event, 0.01)
        asyncio.get_running_loop().call_later(0.01, event.set)
        hit = await wait_event(event, 5.0)
        return missed, hit

    assert run(body()) == (False, True)


def test_cancelling_a_waiter_propagates() -> None:
    async def body() -> None:
        event = asyncio.Event()
        task = asyncio.ensure_future(wait_event(event, 10.0))
        await asyncio.sleep(0.01)
        event.set()  # the event fires in the same loop turn as the cancel
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    run(body())


def test_cancel_and_wait_does_not_swallow_the_callers_cancellation() -> None:
    async def body() -> None:
        async def stubborn() -> None:
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                await asyncio.sleep(0.05)  # slow to clean up
                raise

        owned = asyncio.ensure_future(stubborn())
        await asyncio.sleep(0)
        closer = asyncio.ensure_future(cancel_and_wait(owned))
        await asyncio.sleep(0.01)
        closer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closer
        await asyncio.sleep(0.1)
        assert owned.cancelled()

    run(body())


def test_cancel_and_wait_retrieves_failures() -> None:
    async def body() -> None:
        async def boom() -> None:
            raise RuntimeError("x")

        failed = asyncio.ensure_future(boom())
        await asyncio.sleep(0)
        await cancel_and_wait(failed, None)
        assert isinstance(failed.exception(), RuntimeError)

    run(body())
