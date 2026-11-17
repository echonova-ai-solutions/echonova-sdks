"""jobs.wait() and jobs.find_candidates()."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from _support import JOB_ID, FakeTime, Recorder, fail, make_async_client, make_client, ok
from echonova import (
    APIConnectionError,
    AuthenticationError,
    JobFailedError,
    JobNotFoundError,
    JobWaitTimeoutError,
    UsageError,
)
from echonova._polling import PollLimiter
from echonova.types import JobInitiated


def statuses(*values: str, error: str | None = None) -> Recorder:
    """GET answers walk through ``values``; the last one repeats."""
    pending = list(values)

    def handler(request: httpx.Request) -> httpx.Response:
        status = pending.pop(0) if len(pending) > 1 else pending[0]
        data: dict[str, Any] = {"id": JOB_ID, "status": status, "text": "hi", "voiceId": "v"}
        if status == "failed":
            data["error"] = error
        return ok(data)

    return Recorder(handler)


def test_wait_polls_every_3_seconds_for_tts() -> None:
    time = FakeTime()
    recorder = statuses("processing", "processing", "completed")
    job = make_client(recorder, time=time).text_to_speech.jobs.wait(JOB_ID)
    assert job.status == "completed"
    assert len(recorder.requests) == 3
    assert time.sleeps == [3.0, 3.0]  # jitter is ±10%; U = 0.5 gives the exact interval


def test_wait_polls_every_5_seconds_for_stt_and_accepts_a_job_object() -> None:
    time = FakeTime()
    recorder = statuses("pending", "completed")
    created = JobInitiated(job_id=JOB_ID, status="processing")
    job = make_client(recorder, time=time).speech_to_text.jobs.wait(created)
    assert job.id == JOB_ID
    assert time.sleeps == [5.0]


@pytest.mark.parametrize(("random", "expected"), [(0.0, 2.7), (1.0, 3.3)])
def test_wait_jitter_bounds(random: float, expected: float) -> None:
    time = FakeTime(random=random)
    make_client(statuses("processing", "completed"), time=time).text_to_speech.jobs.wait(JOB_ID)
    assert time.sleeps == [pytest.approx(expected)]


def test_custom_interval_and_its_minimum() -> None:
    time = FakeTime()
    make_client(statuses("processing", "completed"), time=time).text_to_speech.jobs.wait(JOB_ID, poll_interval=10)
    assert time.sleeps == [10.0]
    with pytest.raises(UsageError, match="at least 1"):
        make_client(statuses("completed")).text_to_speech.jobs.wait(JOB_ID, poll_interval=0.5)


def test_unknown_statuses_are_not_terminal() -> None:
    recorder = statuses("queued", "transcoding", "completed")
    make_client(recorder).speech_to_text.jobs.wait(JOB_ID)
    assert len(recorder.requests) == 3


def test_failed_job_raises_or_is_returned() -> None:
    with pytest.raises(JobFailedError, match="Job timed out") as info:
        make_client(statuses("failed", error="Job timed out")).text_to_speech.jobs.wait(JOB_ID)
    assert info.value.job.status == "failed"
    job = make_client(statuses("failed")).text_to_speech.jobs.wait(JOB_ID, raise_on_failure=False)
    assert job.status == "failed"


def test_timeout_raises_with_the_last_job() -> None:
    time = FakeTime()
    with pytest.raises(JobWaitTimeoutError) as info:
        make_client(statuses("processing"), time=time).text_to_speech.jobs.wait(JOB_ID, timeout=10)
    assert info.value.job_id == JOB_ID
    assert info.value.last_job.status == "processing"
    assert sum(time.sleeps) <= 10


def test_default_timeout_is_20_minutes() -> None:
    time = FakeTime()
    recorder = statuses("processing")
    with pytest.raises(JobWaitTimeoutError):
        make_client(recorder, time=time).speech_to_text.jobs.wait(JOB_ID)
    assert 1195 <= sum(time.sleeps) <= 1200
    assert len(recorder.requests) == 241  # at 0, 5, ..., 1200 s


def test_transient_errors_keep_polling() -> None:
    answers: list[Any] = [httpx.ConnectError] * 3 + [fail(503, "Database unavailable")] * 3
    answers.append(ok({"id": JOB_ID, "status": "completed"}))

    def handler(request: httpx.Request) -> httpx.Response:
        step = answers.pop(0)
        if isinstance(step, httpx.Response):
            return step
        raise step("down", request=request)

    job = make_client(Recorder(handler)).text_to_speech.jobs.wait(JOB_ID)
    assert job.status == "completed"


def test_throttle_during_wait_sleeps_retry_after() -> None:
    time = FakeTime()
    throttled = fail(429, "ThrottlerException: Too Many Requests", headers={"Retry-After": "40"})
    answers = [throttled, ok({"id": JOB_ID, "status": "completed"})]
    client = make_client(lambda r: answers.pop(0), time=time, max_retries=0)
    client.text_to_speech.jobs.wait(JOB_ID)
    assert time.sleeps == [40.0]


@pytest.mark.parametrize(
    ("response", "error"),
    [(fail(404, "TTS Job not found"), JobNotFoundError), (fail(401, "Unauthorized"), AuthenticationError)],
)
def test_permanent_errors_raise_immediately(response: httpx.Response, error: type[Exception]) -> None:
    recorder = Recorder(lambda r: response)
    with pytest.raises(error):
        make_client(recorder).text_to_speech.jobs.wait(JOB_ID)
    assert len(recorder.requests) == 1


def test_timeout_after_transient_errors_keeps_the_cause() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    with pytest.raises(JobWaitTimeoutError) as info:
        make_client(down).text_to_speech.jobs.wait(JOB_ID, timeout=4)
    assert isinstance(info.value.__cause__, APIConnectionError)
    assert info.value.last_job is None


# --- Shared poll limiter ------------------------------------------------------------------------


def test_limiter_allows_80_polls_per_minute() -> None:
    time = FakeTime()
    limiter = PollLimiter(clock=time.clock)
    delays = [limiter.reserve("text_to_speech.jobs.get") for _ in range(81)]
    assert delays[:80] == [0.0] * 80
    assert delays[80] == pytest.approx(60.0)
    assert limiter.reserve("speech_to_text.jobs.get") == 0.0  # each job-get endpoint has its own budget
    time.monotonic += 61
    assert limiter.reserve("text_to_speech.jobs.get") == pytest.approx(0.0)


def test_many_waiters_share_the_limit() -> None:
    time = FakeTime()
    sent: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(time.monotonic)
        return ok({"id": request.url.path.rsplit("/", 1)[1], "status": "processing"})

    client = make_async_client(handler, time=time)

    async def run() -> None:
        waits = [client.text_to_speech.jobs.wait(f"job{i}", timeout=60) for i in range(50)]
        results = await asyncio.gather(*waits, return_exceptions=True)
        assert all(isinstance(r, JobWaitTimeoutError) for r in results)

    asyncio.run(run())
    sent.sort()
    for i in range(len(sent)):
        window = [t for t in sent[i:] if t < sent[i] + 60]
        assert len(window) <= 80, "more than 80 job polls in a minute"


# --- find_candidates ----------------------------------------------------------------------------

SENT_AT = datetime(2026, 11, 9, 12, 0, 0, tzinfo=UTC)


def listing(created: list[tuple[str, float, str]]) -> Callable[[httpx.Request], httpx.Response]:
    """Jobs as (id, seconds relative to SENT_AT, text), served newest first, 2 per page."""
    jobs = [
        {"id": jid, "status": "completed", "text": text, "createdAt": (SENT_AT + timedelta(seconds=s)).isoformat()}
        for jid, s, text in sorted(created, key=lambda c: -c[1])
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        offset = int(request.url.params.get("offset", 0))
        assert request.url.params["limit"] == "100"
        return ok({"items": jobs[offset : offset + 2], "total": len(jobs)})

    return handler


JOBS = [("a", 30, "hello"), ("b", 2, "other"), ("c", -1, "hello "), ("d", -4.5, "hello"), ("e", -6, "hello")]


def test_find_candidates_returns_jobs_in_the_window() -> None:
    recorder = Recorder(listing(JOBS))
    found = make_client(recorder).text_to_speech.jobs.find_candidates(SENT_AT)
    assert [j.id for j in found] == ["a", "b", "c", "d"]
    assert len(recorder.requests) == 3  # stops at the first page that reaches older jobs


def test_find_candidates_filters_by_text() -> None:
    found = make_client(listing(JOBS)).text_to_speech.jobs.find_candidates(SENT_AT, text="hello")
    assert [j.id for j in found] == ["a", "c", "d"]


@pytest.mark.parametrize("service", ["text_to_speech", "speech_to_text"])
def test_find_candidates_skips_stream_jobs(service: str) -> None:
    created = (SENT_AT + timedelta(seconds=1)).isoformat()
    jobs = [
        {"id": "s", "status": "completed", "text": "hello", "createdAt": created, "stream": {"sessionId": "x"}},
        {"id": "r", "status": "completed", "text": "hello", "createdAt": created},
    ]
    client = make_client(lambda r: ok({"items": jobs, "total": 2}))
    found = getattr(client, service).jobs.find_candidates(SENT_AT)
    assert [j.id for j in found] == ["r"]  # a lost REST request never made a stream job


def test_find_candidates_for_stt_and_naive_datetimes() -> None:
    naive_local = SENT_AT.astimezone().replace(tzinfo=None)
    found = make_client(listing(JOBS)).speech_to_text.jobs.find_candidates(naive_local)
    assert [j.id for j in found] == ["a", "b", "c", "d"]
    with pytest.raises(UsageError):
        make_client(listing(JOBS)).speech_to_text.jobs.find_candidates(None)  # type: ignore[arg-type]


def test_find_candidates_after_a_lost_post() -> None:
    time = FakeTime()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            raise httpx.ReadTimeout("lost", request=request)
        return listing([("x", 1, "hi")])(request)

    client = make_client(handler, time=time)
    with pytest.raises(APIConnectionError) as info:
        client.text_to_speech.jobs.create("hi", voice_id="v")  # no Idempotency-Key: never sent again
    assert info.value.sent_at == time.start
    assert [j.id for j in client.text_to_speech.jobs.find_candidates(info.value.sent_at, text="hi")] == ["x"]


def test_async_wait_and_find_candidates() -> None:
    time = FakeTime()
    client = make_async_client(statuses("processing", "completed"), time=time)
    assert asyncio.run(client.text_to_speech.jobs.wait(JOB_ID)).status == "completed"
    found = asyncio.run(make_async_client(listing(JOBS)).speech_to_text.jobs.find_candidates(SENT_AT))
    assert [j.id for j in found] == ["a", "b", "c", "d"]
