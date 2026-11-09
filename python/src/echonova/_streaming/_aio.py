"""Small asyncio helpers that behave the same on every supported Python.

``asyncio.wait_for`` can swallow a cancellation on older Pythons when the
awaited future finishes at the same moment, and suppressing ``CancelledError``
around ``await task`` also swallows a cancellation of the caller. These
helpers use ``asyncio.wait``, which does neither.
"""

from __future__ import annotations

import asyncio
from typing import Any


async def wait_event(event: asyncio.Event, timeout: float | None) -> bool:
    """Wait until ``event`` is set or ``timeout`` passes. Returns whether it is set."""
    if event.is_set():
        return True
    if timeout is None:
        await event.wait()
        return True
    waiter = asyncio.ensure_future(event.wait())
    try:
        await asyncio.wait([waiter], timeout=max(0.0, timeout))
    finally:
        if not waiter.done():
            waiter.cancel()
    return event.is_set()


async def cancel_and_wait(*tasks: asyncio.Future[Any] | None, timeout: float = 5.0) -> None:
    """Cancel background tasks this object owns and wait for them to finish."""
    pending = [task for task in tasks if task is not None and not task.done()]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=timeout)
    for owned in tasks:
        if owned is not None and owned.done() and not owned.cancelled():
            owned.exception()  # mark it retrieved; failures were already reported where they happened
