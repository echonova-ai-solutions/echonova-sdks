"""``jobs.wait()`` and ``jobs.find_candidates()``, shared by the sync and async clients."""

from __future__ import annotations

import functools
import threading
import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from ._config import Runtime
from ._logging import logger
from ._transport import Call, Failure, Flow, Sleep
from .errors import (
    APIConnectionError,
    EchoNovaError,
    JobFailedError,
    JobWaitTimeoutError,
    ProtocolError,
    RateLimitError,
    RequestTimeoutError,
    ServerError,
    UsageError,
)

TTS_POLL_INTERVAL = 3.0
STT_POLL_INTERVAL = 5.0
MIN_POLL_INTERVAL = 1.0
DEFAULT_WAIT_TIMEOUT = 1200.0
POLL_RATE = 80  # polls per minute per job-get endpoint, below the API's 100 per minute
CANDIDATE_WINDOW = timedelta(seconds=5)
CANDIDATE_MAX_PAGES = 10

_TRANSIENT = (APIConnectionError, RateLimitError, RequestTimeoutError, ServerError, ProtocolError)


class PollLimiter:
    """A sliding-window limit shared by every ``wait()`` on one client, so many waiters can't exhaust a key."""

    def __init__(self, *, rate: int = POLL_RATE, period: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self._rate = rate
        self._period = period
        self._clock = clock
        self._slots: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def reserve(self, bucket: str) -> float:
        """Reserve the next free slot and return how long to wait for it."""
        with self._lock:
            now = self._clock()
            slots = self._slots.setdefault(bucket, deque())
            while len(slots) > self._rate and slots[0] <= now - self._period:
                slots.popleft()
            at = now if not slots else max(now, slots[-1])
            if len(slots) >= self._rate:
                at = max(at, slots[-self._rate] + self._period)
            slots.append(at)
            return at - now


def check_interval(poll_interval: float | None, default: float) -> float:
    if poll_interval is None:
        return default
    if poll_interval < MIN_POLL_INTERVAL:
        raise UsageError(
            f"poll_interval must be at least {MIN_POLL_INTERVAL:g} s; the API asks clients not to poll faster"
        )
    return float(poll_interval)


def wait_flow(
    *,
    job_id: str,
    get: Callable[[], Any],
    interval: float,
    timeout: float,
    raise_on_failure: bool,
    limiter: PollLimiter,
    bucket: str,
    runtime: Runtime,
) -> Flow[Any]:
    if timeout < 0:
        raise UsageError("timeout must not be negative")
    clock = runtime.clock
    deadline = clock() + timeout
    last_job: Any = None
    last_error: EchoNovaError | None = None

    def give_up() -> JobWaitTimeoutError:
        status = getattr(last_job, "status", None) or "unknown"
        error = JobWaitTimeoutError(
            f"job {job_id} is still {status} after {timeout:g} s; calling wait() again is safe",
            job_id=job_id,
            last_job=last_job,
        )
        error.__cause__ = last_error
        return error

    while True:
        delay = limiter.reserve(bucket)
        if delay > 0:
            if clock() + delay > deadline:
                raise give_up()
            yield Sleep(delay)
        outcome = yield Call(get)
        pause = max(MIN_POLL_INTERVAL, interval * (0.9 + 0.2 * runtime.random()))
        if isinstance(outcome, Failure):
            error = outcome.error
            if not isinstance(error, _TRANSIENT):
                raise error
            last_error = error
            if isinstance(error, RateLimitError) and error.retry_after:
                pause = max(pause, error.retry_after)
            logger.debug("polling job %s failed (%s); polling again in %.1f s", job_id, type(error).__name__, pause)
        else:
            last_job, last_error = outcome, None
            if outcome.status == "completed":
                return outcome
            if outcome.status == "failed":
                if raise_on_failure:
                    raise JobFailedError(f"job {job_id} failed: {outcome.error or 'no error message'}", job=outcome)
                return outcome
        if clock() + pause > deadline:
            raise give_up()
        yield Sleep(pause)


def _aware(value: datetime) -> datetime:
    if not isinstance(value, datetime):
        raise UsageError("sent_at must be a datetime, such as the sent_at of an APIConnectionError")
    return value if value.tzinfo else value.astimezone()  # naive means local time, as datetime.now() returns


def candidates_flow(
    *,
    list_page: Callable[[int], Any],
    sent_at: datetime,
    text: str | None = None,
) -> Flow[list[Any]]:
    """Jobs created at or after ``sent_at`` minus 5 s, newest first. Never picks one for you.

    Jobs made on a stream (with a ``stream`` block) are skipped: a lost REST request never made one.
    """
    earliest = _aware(sent_at).astimezone(UTC) - CANDIDATE_WINDOW
    wanted = text.strip() if text is not None else None
    found: list[Any] = []
    seen: set[str] = set()
    offset = 0
    for _ in range(CANDIDATE_MAX_PAGES):
        outcome = yield Call(functools.partial(list_page, offset))
        if isinstance(outcome, Failure):
            raise outcome.error
        reached_older = False
        for job in outcome.items:
            if job.created_at is None:
                continue
            if job.created_at < earliest:
                reached_older = True
                continue
            if job.id in seen:
                continue
            seen.add(job.id)
            if getattr(job, "stream", None) is not None:
                continue
            if wanted is not None and (job.text or "").strip() != wanted:
                continue
            found.append(job)
        if reached_older or not outcome.has_next_page():
            break
        offset = outcome.next_offset
    return found
