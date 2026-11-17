"""Retries end to end: what is retried, after how long, and what the error says when it isn't.

A plain POST here is async job creation (``text_to_speech.jobs.create``), which takes no
Idempotency-Key, so ADR 0004 applies. The calls that send a key are in test_idempotency.py.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from _support import JOB_ID, WAV, FakeTime, Recorder, fail, make_async_client, make_client, ok
from echonova import (
    APIConnectionError,
    APITimeoutError,
    GatewayError,
    InvalidRequestError,
    JobNotFoundError,
    ProtocolError,
    RateLimitError,
    ServerError,
    ServiceUnavailableError,
    SpendingLimitError,
)

RESULT = {"jobId": JOB_ID, "id": JOB_ID, "status": "completed", "deleted": True}


def sequence(*steps: Any) -> Recorder:
    """Answer each request with the next step: a response, or an httpx exception class to raise."""
    pending = list(steps)

    def handler(request: httpx.Request) -> httpx.Response:
        step = pending.pop(0) if pending else ok(RESULT)
        if isinstance(step, httpx.Response):
            return step
        raise step(f"simulated {step.__name__}", request=request)

    return Recorder(handler)


def generate(client: Any) -> Any:
    """A POST without an Idempotency-Key."""
    return client.text_to_speech.jobs.create("hello", voice_id="v1")


def test_post_read_timeout_is_not_retried_and_may_have_executed() -> None:
    time = FakeTime()
    recorder = sequence(httpx.ReadTimeout)
    with pytest.raises(APITimeoutError) as info:
        generate(make_client(recorder, time=time))
    error = info.value
    assert len(recorder.requests) == 1
    assert error.kind == "read"
    assert error.may_have_executed is True
    assert error.sent_at == time.start
    assert "may have run" in str(error)


@pytest.mark.parametrize("exc", [httpx.ReadError, httpx.RemoteProtocolError])
def test_post_reset_after_sending_is_not_retried(exc: type[Exception]) -> None:
    recorder = sequence(exc)
    with pytest.raises(APIConnectionError) as info:
        generate(make_client(recorder))
    assert len(recorder.requests) == 1
    assert info.value.may_have_executed is True
    assert not isinstance(info.value, APITimeoutError)


def test_get_read_timeout_is_retried() -> None:
    time = FakeTime()
    recorder = sequence(httpx.ReadTimeout, httpx.ReadTimeout)
    job = make_client(recorder, time=time).text_to_speech.jobs.get(JOB_ID)
    assert job.id == JOB_ID
    assert len(recorder.requests) == 3
    assert time.sleeps == [0.375, 0.75]  # min(8, 0.5 * 2^(n-1)) * U(0.5, 1) with U = 0.75


def test_get_gives_up_after_max_retries() -> None:
    recorder = sequence(httpx.ReadTimeout, httpx.ReadTimeout, httpx.ReadTimeout)
    with pytest.raises(APITimeoutError) as info:
        make_client(recorder).text_to_speech.jobs.get(JOB_ID)
    assert len(recorder.requests) == 3
    assert info.value.may_have_executed is False  # only a POST can have run and been charged


@pytest.mark.parametrize(
    ("exc", "kind"), [(httpx.ConnectError, None), (httpx.ConnectTimeout, "connect"), (httpx.PoolTimeout, "pool")]
)
def test_post_connect_failure_is_retried(exc: type[Exception], kind: str | None) -> None:
    recorder = sequence(exc)
    assert generate(make_client(recorder)).job_id == JOB_ID
    assert len(recorder.requests) == 2


def test_post_connect_failure_error_says_it_did_not_run() -> None:
    recorder = sequence(httpx.ConnectTimeout, httpx.ConnectTimeout, httpx.ConnectTimeout)
    with pytest.raises(APITimeoutError) as info:
        generate(make_client(recorder))
    assert info.value.kind == "connect"
    assert info.value.may_have_executed is False


def test_post_write_failure_is_retried_when_the_body_can_be_replayed() -> None:
    recorder = sequence(httpx.WriteTimeout)
    make_client(recorder).speech_to_text.transcribe(WAV, language="en")
    assert len(recorder.requests) == 2


def test_throttle_429_is_retried_after_retry_after() -> None:
    time = FakeTime()
    throttled = fail(429, "ThrottlerException: Too Many Requests", headers={"Retry-After": "7"})
    recorder = sequence(throttled)
    assert generate(make_client(recorder, time=time)).job_id == JOB_ID
    assert len(recorder.requests) == 2
    assert time.sleeps == [7.5]  # Retry-After + U(0, 1)


def test_throttle_429_beyond_max_retry_after_is_raised() -> None:
    recorder = sequence(fail(429, "ThrottlerException: Too Many Requests", headers={"Retry-After": "300"}))
    with pytest.raises(RateLimitError) as info:
        generate(make_client(recorder))
    assert info.value.retry_after == 300
    assert len(recorder.requests) == 1


def test_spending_limit_429_is_never_retried() -> None:
    recorder = sequence(fail(429, "Monthly spending limit exhausted"))
    with pytest.raises(SpendingLimitError) as info:
        generate(make_client(recorder))
    assert len(recorder.requests) == 1
    assert not isinstance(info.value, RateLimitError)
    assert info.value.may_have_executed is False


def test_503_temporarily_unavailable_post_is_retried() -> None:
    recorder = sequence(fail(503, "Speech service temporarily unavailable. Try again."))
    assert generate(make_client(recorder)).job_id == JOB_ID
    assert len(recorder.requests) == 2


def test_503_with_retry_after_waits_that_long() -> None:
    time = FakeTime()
    recorder = sequence(fail(503, "Audio processing is temporarily unavailable.", headers={"Retry-After": "3"}))
    make_client(recorder, time=time).speech_to_text.transcribe(WAV, language="ar")
    assert time.sleeps == [3.5]


def test_other_503_post_is_not_retried() -> None:
    recorder = sequence(fail(503, "Database unavailable"))
    with pytest.raises(ServiceUnavailableError) as info:
        generate(make_client(recorder))
    assert len(recorder.requests) == 1
    assert info.value.may_have_executed is None


def test_500_post_is_not_retried() -> None:
    recorder = sequence(fail(500, "Something went wrong"))
    with pytest.raises(ServerError) as info:
        generate(make_client(recorder))
    assert len(recorder.requests) == 1
    assert info.value.may_have_executed is None  # unknown


def test_500_get_is_retried() -> None:
    recorder = sequence(fail(500, "Something went wrong"))
    make_client(recorder).text_to_speech.jobs.get(JOB_ID)
    assert len(recorder.requests) == 2


def test_non_json_504_post_is_not_retried() -> None:
    recorder = sequence(httpx.Response(504, text="stream timeout"))
    with pytest.raises(GatewayError) as info:
        generate(make_client(recorder))
    error = info.value
    assert len(recorder.requests) == 1
    assert error.from_proxy is True
    assert error.may_have_executed is True
    assert error.error_message == "stream timeout"


def test_non_json_504_get_is_retried() -> None:
    recorder = sequence(httpx.Response(504, text="stream timeout"))
    make_client(recorder).text_to_speech.jobs.get(JOB_ID)
    assert len(recorder.requests) == 2


def test_non_json_503_post_is_retried() -> None:
    recorder = sequence(httpx.Response(503, text="no healthy upstream"))
    generate(make_client(recorder))
    assert len(recorder.requests) == 2


def test_408_post_is_retried() -> None:
    recorder = sequence(fail(408, "Request Timeout"))
    make_client(recorder).speech_to_text.transcribe(WAV, language="en")
    assert len(recorder.requests) == 2


def test_client_errors_are_not_retried() -> None:
    recorder = sequence(fail(400, "text must be shorter than or equal to 500 characters, voiceId must be a string"))
    with pytest.raises(InvalidRequestError) as info:
        generate(make_client(recorder))
    assert len(recorder.requests) == 1
    assert info.value.error_message == "text must be shorter than or equal to 500 characters, voiceId must be a string"
    assert str(info.value) == (
        "400 text must be shorter than or equal to 500 characters, voiceId must be a string (request_id: req-err)"
    )


def test_max_retries_zero_and_per_call_override() -> None:
    recorder = sequence(httpx.ConnectError)
    with pytest.raises(APIConnectionError):
        make_client(recorder, max_retries=0).text_to_speech.jobs.get(JOB_ID)
    recorder = sequence(httpx.ConnectError, httpx.ConnectError, httpx.ConnectError)
    make_client(recorder).text_to_speech.jobs.get(JOB_ID, max_retries=3)
    assert len(recorder.requests) == 4


# --- Malformed success --------------------------------------------------------------------------


def test_malformed_success_post_is_a_protocol_error_that_may_have_executed() -> None:
    recorder = sequence(httpx.Response(200, text="<html>proxy page</html>"))
    with pytest.raises(ProtocolError) as info:
        generate(make_client(recorder))
    assert len(recorder.requests) == 1
    assert info.value.may_have_executed is True
    assert info.value.rule == "malformed_success"


def test_malformed_success_get_is_retried_once() -> None:
    recorder = sequence(httpx.Response(200, text="oops"), httpx.Response(200, json={"jobId": "x"}))
    with pytest.raises(ProtocolError):
        make_client(recorder).text_to_speech.jobs.get(JOB_ID)
    assert len(recorder.requests) == 2


def test_missing_required_field_is_a_protocol_error() -> None:
    recorder = sequence(ok({"status": "completed"}))
    with pytest.raises(ProtocolError, match="jobId"):
        generate(make_client(recorder))


def test_redirect_is_a_protocol_error() -> None:
    recorder = sequence(httpx.Response(302, headers={"Location": "https://elsewhere.example.com"}))
    with pytest.raises(ProtocolError):
        make_client(recorder).text_to_speech.jobs.get(JOB_ID, max_retries=0)
    assert len(recorder.requests) == 1


# --- Delete -------------------------------------------------------------------------------------


def test_delete_retried_after_no_response_treats_not_found_as_deleted() -> None:
    recorder = sequence(httpx.ReadTimeout, fail(404, "TTS Job not found"))
    result = make_client(recorder).text_to_speech.jobs.delete(JOB_ID)
    assert result.deleted is True
    assert result.already_deleted is True


def test_delete_not_found_without_an_earlier_attempt_is_an_error() -> None:
    with pytest.raises(JobNotFoundError):
        make_client(sequence(fail(404, "TTS Job not found"))).text_to_speech.jobs.delete(JOB_ID)


def test_delete_storage_failure_is_retried() -> None:
    recorder = sequence(fail(503, "The stored file could not be deleted. Try again."))
    assert make_client(recorder).speech_to_text.jobs.delete(JOB_ID).deleted is True
    assert len(recorder.requests) == 2


# --- Deadline -----------------------------------------------------------------------------------


def test_deadline_stops_retries() -> None:
    time = FakeTime()
    recorder = sequence(fail(429, "ThrottlerException: Too Many Requests", headers={"Retry-After": "30"}))
    with pytest.raises(RateLimitError):
        make_client(recorder, time=time, deadline=10).text_to_speech.jobs.get(JOB_ID)
    assert len(recorder.requests) == 1
    assert time.sleeps == []


def test_timeout_after_the_deadline_is_total() -> None:
    time = FakeTime()

    def slow(request: httpx.Request) -> httpx.Response:
        time.monotonic += 5
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(APITimeoutError) as info:
        make_client(Recorder(slow), time=time).text_to_speech.jobs.get(JOB_ID, deadline=4)
    assert info.value.kind == "total"


# --- Async parity -------------------------------------------------------------------------------


def test_async_post_read_timeout_is_not_retried() -> None:
    recorder = sequence(httpx.ReadTimeout)

    async def run() -> None:
        await make_async_client(recorder).text_to_speech.jobs.create("hi", voice_id="v")

    with pytest.raises(APITimeoutError) as info:
        asyncio.run(run())
    assert info.value.may_have_executed is True
    assert len(recorder.requests) == 1


def test_async_throttle_is_retried_after_retry_after() -> None:
    time = FakeTime()
    recorder = sequence(fail(429, "ThrottlerException: Too Many Requests", headers={"Retry-After": "2"}))
    asyncio.run(make_async_client(recorder, time=time).text_to_speech.jobs.get(JOB_ID))
    assert len(recorder.requests) == 2
    assert time.sleeps == [2.5]
