"""Client-side rate limiting: preflight, shared throttle blocks, and the rate-limit metadata."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from _support import JOB_ID, FakeTime, Recorder, fail, make_async_client, make_client, ok
from echonova import RateLimitError

JOB = {"id": JOB_ID, "status": "completed"}
THROTTLED = {"Retry-After": "5"}


def limits(remaining: int, reset: int = 20) -> dict[str, str]:
    return {"X-RateLimit-Limit": "100", "X-RateLimit-Remaining": str(remaining), "X-RateLimit-Reset": str(reset)}


def test_preflight_waits_for_the_window_when_nothing_remains() -> None:
    time = FakeTime()
    recorder = Recorder(lambda r: ok(JOB, headers=limits(0, reset=20)))
    client = make_client(recorder, time=time)
    client.text_to_speech.jobs.get(JOB_ID)
    assert time.sleeps == []
    client.text_to_speech.jobs.get(JOB_ID)
    assert time.sleeps == [20]
    client.speech_to_text.jobs.get(JOB_ID)  # another endpoint has its own bucket
    assert time.sleeps == [20]


def test_preflight_can_be_turned_off() -> None:
    time = FakeTime()
    client = make_client(lambda r: ok(JOB, headers=limits(0)), time=time, rate_limit_preflight=False)
    client.text_to_speech.jobs.get(JOB_ID)
    client.text_to_speech.jobs.get(JOB_ID)
    assert time.sleeps == []


def test_throttle_blocks_the_bucket_for_later_calls() -> None:
    time = FakeTime()
    answers = [fail(429, "ThrottlerException: Too Many Requests", headers=THROTTLED)]
    recorder = Recorder(lambda r: answers.pop(0) if answers else ok(JOB))
    client = make_client(recorder, time=time, max_retries=0)
    with pytest.raises(RateLimitError):
        client.text_to_speech.jobs.get(JOB_ID)
    client.text_to_speech.jobs.get(JOB_ID)  # waits out the block instead of extending it
    assert time.sleeps == [5]
    assert len(recorder.requests) == 2


def test_a_block_longer_than_allowed_fails_fast_without_sending() -> None:
    time = FakeTime()
    answers = [fail(429, "ThrottlerException: Too Many Requests", headers={"Retry-After": "3600"})]
    recorder = Recorder(lambda r: answers.pop(0) if answers else ok(JOB))
    client = make_client(recorder, time=time)
    with pytest.raises(RateLimitError):
        client.text_to_speech.jobs.get(JOB_ID)
    with pytest.raises(RateLimitError, match="nothing was sent") as info:
        client.text_to_speech.jobs.get(JOB_ID)
    assert info.value.retry_after == pytest.approx(3600)
    assert len(recorder.requests) == 1


class SteppedTime(FakeTime):
    """Async sleeps wait until the test moves the clock."""

    async def async_sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        target = self.monotonic + seconds
        while self.monotonic < target:
            await asyncio.sleep(0)


async def settle() -> None:
    for _ in range(50):
        await asyncio.sleep(0)


def test_throttle_block_is_shared_by_concurrent_calls() -> None:
    time = SteppedTime()
    answers = [fail(429, "ThrottlerException: Too Many Requests", headers=THROTTLED)]
    recorder = Recorder(lambda r: answers.pop(0) if answers else ok(JOB))
    client = make_async_client(recorder, time=time)

    async def run() -> None:
        first = asyncio.create_task(client.text_to_speech.jobs.get(JOB_ID))
        await settle()
        assert len(recorder.requests) == 1  # throttled; now waiting Retry-After
        second = asyncio.create_task(client.text_to_speech.jobs.get(JOB_ID))
        other = asyncio.create_task(client.speech_to_text.jobs.get(JOB_ID))
        await settle()
        assert [r.url.path for r in recorder.requests[1:]] == [f"/v1/speech-to-text/jobs/{JOB_ID}"]
        time.monotonic += 6
        await asyncio.gather(first, second, other)

    asyncio.run(run())
    assert len(recorder.requests) == 4
    assert time.sleeps[0] == pytest.approx(5.5)  # Retry-After + jitter
    assert time.sleeps[1] == pytest.approx(5.0)  # the second caller waited for the block, not a 429 of its own


def test_rate_limits_and_raw_response_metadata() -> None:
    client = make_client(lambda r: ok(JOB, headers=limits(42, reset=17), request_id="req-77"))
    raw = client.with_raw_response.text_to_speech.jobs.get(JOB_ID)
    assert raw.status_code == 200
    assert raw.request_id == "req-77"
    assert raw.rate_limit is not None
    assert raw.rate_limit.remaining == 42
    assert raw.headers["x-ratelimit-reset"] == "17"
    job = raw.parse()
    assert job.id == JOB_ID
    assert job.request_id == "req-77"
    assert raw.parse() is job
    info = client.rate_limits["text_to_speech.jobs.get"]
    assert (info.limit, info.remaining, info.reset_seconds) == (100, 42, 17.0)


def test_raw_response_parse_reports_a_malformed_body() -> None:
    from echonova import ProtocolError

    raw = make_client(lambda r: httpx.Response(200, text="not json")).with_raw_response.text_to_speech.jobs.get("j")
    assert raw.content == b"not json"
    with pytest.raises(ProtocolError):
        raw.parse()


def test_raw_response_for_every_wrapped_method() -> None:
    client = make_client(lambda r: ok({"items": [], "total": 0, **JOB, "jobId": JOB_ID, "ticket": "t"}))
    raw = client.with_raw_response
    assert raw.text_to_speech.voices.list().parse().total == 0
    page = raw.text_to_speech.jobs.list(limit=5).parse()
    assert page.items == []
    assert page.limit == 5
    assert raw.widgets.create_ticket("wdg_1").parse().ticket == "t"
    assert raw.sound_cleaning.jobs.get(JOB_ID).parse().id == JOB_ID


def test_async_raw_response() -> None:
    client = make_async_client(lambda r: ok({"items": [JOB], "total": 1}, headers=limits(3)))

    async def run() -> None:
        raw = await client.with_raw_response.speech_to_text.jobs.list()
        assert raw.rate_limit is not None
        assert raw.rate_limit.remaining == 3
        page = raw.parse()
        assert [job.id for job in page.items] == [JOB_ID]

    asyncio.run(run())
