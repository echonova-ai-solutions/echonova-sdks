"""Idempotency keys (ADR 0014): the synchronous calls send one, retry safely with it, and report it."""

from __future__ import annotations

import asyncio
import io
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from _support import (
    JOB_ID,
    WAV,
    FakeTime,
    Recorder,
    envelope_body,
    fail,
    make_async_client,
    make_client,
    multipart_fields,
    ok,
)
from echonova import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    GatewayError,
    InsufficientBalanceError,
    InvalidRequestError,
    JobWaitTimeoutError,
    RequestInProgressError,
    ServerError,
    UsageError,
)

RESULT = {"jobId": JOB_ID, "id": JOB_ID, "status": "completed"}
KEY_REUSED = "This Idempotency-Key was already used for a different request."
IN_PROGRESS = "A request with this Idempotency-Key is still running."
STARTING = "The same request is still being started. Send it again in a few seconds."

Call = Callable[..., Any]

# The three operations that accept an Idempotency-Key.
IDEMPOTENT: dict[str, Call] = {
    "text_to_speech.generate": lambda c, **kw: c.text_to_speech.generate("hello", voice_id="v1", **kw),
    "speech_to_text.transcribe": lambda c, **kw: c.speech_to_text.transcribe(WAV, language="ar", **kw),
    "sound_cleaning.clean": lambda c, **kw: c.sound_cleaning.clean(("noisy.wav", WAV), **kw),
}
# Async job creation takes no key: ADR 0004 still applies.
CREATE: dict[str, Call] = {
    "text_to_speech.jobs.create": lambda c, **kw: c.text_to_speech.jobs.create("hello", voice_id="v1", **kw),
    "speech_to_text.jobs.create": lambda c, **kw: c.speech_to_text.jobs.create(WAV, language="ar", **kw),
}


def sequence(*steps: Any) -> Recorder:
    """Answer each request with the next step: a response, or an httpx exception class to raise."""
    pending = list(steps)

    def handler(request: httpx.Request) -> httpx.Response:
        step = pending.pop(0) if pending else ok(RESULT, request_id="req-ok")
        if isinstance(step, httpx.Response):
            return step
        raise step(f"simulated {step.__name__}", request=request)

    return Recorder(handler)


def keys(recorder: Recorder) -> list[str | None]:
    return [request.headers.get("idempotency-key") for request in recorder.requests]


def run_async(call: Call, client: Any, **kwargs: Any) -> Any:
    async def go() -> Any:
        return await call(client, **kwargs)

    return asyncio.run(go())


# --- The key -------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", IDEMPOTENT)
def test_every_call_sends_a_new_uuid4_key(name: str) -> None:
    recorder = sequence()
    client = make_client(recorder)
    IDEMPOTENT[name](client)
    IDEMPOTENT[name](client)
    first, second = keys(recorder)
    assert first is not None
    assert second is not None
    assert uuid.UUID(first).version == 4
    assert first != second


@pytest.mark.parametrize("name", CREATE)
def test_async_job_creation_sends_no_key(name: str) -> None:
    recorder = sequence()
    CREATE[name](make_client(recorder))
    assert keys(recorder) == [None]


@pytest.mark.parametrize("name", IDEMPOTENT)
def test_a_callers_key_is_sent_verbatim_on_every_attempt(name: str) -> None:
    recorder = sequence(fail(500, "Something went wrong"), httpx.ReadTimeout)
    result = IDEMPOTENT[name](make_client(recorder), idempotency_key="order-1234:take 2")
    assert result.request_id == "req-ok"
    assert keys(recorder) == ["order-1234:take 2"] * 3


def test_a_key_in_extra_headers_is_the_calls_key() -> None:
    recorder = sequence(fail(502, "Bad Gateway"))
    client = make_client(recorder)
    client.text_to_speech.generate("hello", voice_id="v1", extra_headers={"idempotency-key": "from-header"})
    assert keys(recorder) == ["from-header", "from-header"]
    # default_headers never fix the key: every call still gets its own.
    recorder = sequence()
    client = make_client(recorder, default_headers={"Idempotency-Key": "shared"})
    client.text_to_speech.generate("hello", voice_id="v1")
    client.text_to_speech.generate("hello", voice_id="v1")
    assert len(set(keys(recorder))) == 2
    assert "shared" not in keys(recorder)


@pytest.mark.parametrize("key", ["", "   ", " padded", "tab\there", "line\nbreak", "مفتاح", 42])
def test_an_unusable_key_is_refused_before_sending(key: Any) -> None:
    recorder = sequence()
    with pytest.raises(UsageError, match="idempotency_key"):
        make_client(recorder).text_to_speech.generate("hello", voice_id="v1", idempotency_key=key)
    assert recorder.requests == []


# --- Retries with the key ------------------------------------------------------------------------

RETRIED = {
    "500": fail(500, "Something went wrong"),
    "502": fail(502, "Bad Gateway"),
    "502 not JSON": httpx.Response(502, text="bad gateway"),
    "503": fail(503, "Database unavailable"),
    "504": fail(504, "Database timed out"),
    "504 not JSON": httpx.Response(504, text="upstream request timeout"),
    "lost response": httpx.ReadTimeout,
    "connection reset": httpx.RemoteProtocolError,
    "malformed 200": httpx.Response(200, text="<html>proxy page</html>"),
}


@pytest.mark.parametrize("failure", RETRIED.values(), ids=RETRIED.keys())
@pytest.mark.parametrize("name", IDEMPOTENT)
def test_idempotent_calls_are_retried_with_the_same_key(name: str, failure: Any) -> None:
    time = FakeTime()
    recorder = sequence(failure)
    result = IDEMPOTENT[name](make_client(recorder, time=time))
    assert result.request_id == "req-ok"
    assert len(recorder.requests) == 2
    first, second = keys(recorder)
    assert first is not None
    assert first == second
    assert time.sleeps == [0.375]  # the usual backoff: min(8, 0.5 * 2^(n-1)) * U(0.5, 1), U = 0.75


@pytest.mark.parametrize("failure", [fail(500, "Something went wrong"), httpx.ReadTimeout], ids=["500", "lost"])
@pytest.mark.parametrize("name", CREATE)
def test_async_job_creation_is_still_not_retried(name: str, failure: Any) -> None:
    recorder = sequence(failure)
    with pytest.raises((ServerError, APIConnectionError)) as info:
        CREATE[name](make_client(recorder))
    assert len(recorder.requests) == 1
    assert info.value.idempotency_key is None


def test_retries_back_off_and_stop_at_max_retries() -> None:
    time = FakeTime()
    recorder = sequence(*[fail(500, "Something went wrong")] * 3)
    with pytest.raises(ServerError) as info:
        make_client(recorder, time=time).text_to_speech.generate("hello", voice_id="v1")
    assert len(recorder.requests) == 3
    assert time.sleeps == [0.375, 0.75]
    assert len(set(keys(recorder))) == 1
    assert info.value.idempotency_key == keys(recorder)[0]


def test_max_retries_zero_and_per_call_override() -> None:
    recorder = sequence(fail(500, "Something went wrong"))
    with pytest.raises(ServerError):
        make_client(recorder, max_retries=0).text_to_speech.generate("hello", voice_id="v1")
    assert len(recorder.requests) == 1
    recorder = sequence(*[fail(503, "Database unavailable")] * 3)
    make_client(recorder).speech_to_text.transcribe(WAV, language="ar", max_retries=3)
    assert len(recorder.requests) == 4


def test_the_deadline_stops_retries() -> None:
    time = FakeTime()
    recorder = sequence(fail(500, "Something went wrong"))
    with pytest.raises(ServerError):
        make_client(recorder, time=time).text_to_speech.generate("hello", voice_id="v1", deadline=0.3)
    assert len(recorder.requests) == 1  # the 0.375 s backoff would pass the deadline
    assert time.sleeps == []


def test_an_upload_is_read_again_for_every_attempt(tmp_path: Path) -> None:
    path = tmp_path / "call.wav"
    path.write_bytes(WAV)
    bodies: list[bytes] = []
    answers: list[Any] = [fail(500, "Something went wrong"), httpx.ReadTimeout]

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(multipart_fields(request)["file"][2])
        step = answers.pop(0) if answers else ok(RESULT)
        if isinstance(step, httpx.Response):
            return step
        raise step("lost", request=request)

    recorder = Recorder(handler)
    make_client(recorder).speech_to_text.transcribe(path)
    assert bodies == [WAV, WAV, WAV]
    assert len(set(keys(recorder))) == 1


class OneShot(io.RawIOBase):
    """A stream that can be read only once."""

    def __init__(self, data: bytes) -> None:
        self._data = io.BytesIO(data)

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def readinto(self, buffer: Any) -> int:
        chunk = self._data.read(len(buffer))
        buffer[: len(chunk)] = chunk
        return len(chunk)


def test_an_upload_that_cant_be_read_again_is_not_retried() -> None:
    recorder = sequence(httpx.ReadTimeout)
    with pytest.raises(APITimeoutError) as info:
        make_client(recorder).sound_cleaning.clean(("x.wav", OneShot(WAV)))  # type: ignore[arg-type]
    assert len(recorder.requests) == 1
    error = info.value
    assert error.retry_disabled_reason == "body_not_replayable"
    assert error.may_have_executed is True
    assert error.idempotency_key == keys(recorder)[0]
    assert "send it again with the same idempotency_key" in str(error)


# --- The idempotency 409s ------------------------------------------------------------------------


def test_key_reused_409_is_not_retried() -> None:
    recorder = sequence(fail(409, KEY_REUSED))
    with pytest.raises(InvalidRequestError) as info:
        make_client(recorder).speech_to_text.transcribe(WAV, idempotency_key="k-1")
    assert len(recorder.requests) == 1
    assert not isinstance(info.value, RequestInProgressError)
    assert info.value.rule == "idempotency_key_reused"
    assert info.value.idempotency_key == "k-1"


# --- A request that is still running is waited for -----------------------------------------------


@pytest.mark.parametrize("message", [IN_PROGRESS, STARTING], ids=["in progress", "starting"])
@pytest.mark.parametrize("name", IDEMPOTENT)
def test_in_progress_is_sent_again_every_5_s_outside_max_retries(name: str, message: str) -> None:
    time = FakeTime()
    recorder = sequence(*[fail(409, message)] * 4)
    result = IDEMPOTENT[name](make_client(recorder, time=time, max_retries=0))
    assert result.request_id == "req-ok"  # the first answer that isn't a 409 in progress decides
    assert len(recorder.requests) == 5
    assert time.sleeps == [5.0] * 4
    assert len(set(keys(recorder))) == 1


def test_in_progress_waits_retry_after_when_it_is_longer() -> None:
    time = FakeTime()
    recorder = sequence(
        fail(409, STARTING, headers={"Retry-After": "8"}), fail(409, IN_PROGRESS, headers={"Retry-After": "3"})
    )
    make_client(recorder, time=time).sound_cleaning.clean(("noisy.wav", WAV))
    assert time.sleeps == [8.0, 5.0]


def test_in_progress_past_the_wait_budget_raises_with_the_key() -> None:
    time = FakeTime()
    recorder = sequence(*[fail(409, IN_PROGRESS)] * 10)
    with pytest.raises(RequestInProgressError) as info:
        make_client(recorder, time=time).text_to_speech.generate("hello", voice_id="v1", wait_timeout=12)
    error = info.value
    assert len(recorder.requests) == 3  # at 0, 5 and 10 s: one more would land past 12 s
    assert time.sleeps == [5.0, 5.0]
    assert isinstance(error, APIStatusError)
    assert error.status_code == 409
    assert error.rule == "idempotency_in_progress"
    assert error.may_have_executed is True
    assert error.idempotency_key == keys(recorder)[0]


def test_in_progress_default_budget_is_20_minutes() -> None:
    time = FakeTime()

    def always(request: httpx.Request) -> httpx.Response:
        return fail(409, IN_PROGRESS)

    recorder = Recorder(always)
    with pytest.raises(RequestInProgressError):
        make_client(recorder, time=time).speech_to_text.transcribe(WAV)
    assert sum(time.sleeps) == 1195
    assert len(recorder.requests) == 240  # at 0, 5, ..., 1195 s


def test_in_progress_never_waits_past_the_deadline() -> None:
    time = FakeTime()
    recorder = sequence(*[fail(409, IN_PROGRESS)] * 10)
    with pytest.raises(RequestInProgressError):
        make_client(recorder, time=time, deadline=7).text_to_speech.generate("hello", voice_id="v1")
    assert len(recorder.requests) == 2
    assert sum(time.sleeps) <= 7


def test_after_in_progress_the_next_answer_decides() -> None:
    recorder = sequence(fail(409, IN_PROGRESS), fail(400, "text must be shorter than or equal to 500 characters"))
    with pytest.raises(InvalidRequestError) as info:
        make_client(recorder).text_to_speech.generate("hello", voice_id="v1")
    assert len(recorder.requests) == 2
    assert info.value.idempotency_key == keys(recorder)[0]
    # A server error after it is retried as usual, counted against max_retries.
    time = FakeTime()
    recorder = sequence(fail(409, IN_PROGRESS), fail(409, IN_PROGRESS), fail(500, "Something went wrong"))
    make_client(recorder, time=time, max_retries=1).text_to_speech.generate("hello", voice_id="v1")
    assert time.sleeps == [5.0, 5.0, 0.375]
    recorder = sequence(fail(409, IN_PROGRESS), fail(500, "Something went wrong"))
    with pytest.raises(ServerError):
        make_client(recorder, max_retries=0).text_to_speech.generate("hello", voice_id="v1")


def test_in_progress_then_202_share_one_wait_budget() -> None:
    time = FakeTime()
    accepted = {"jobId": JOB_ID, "status": "processing", "resultUrl": f"/v1/text-to-speech/jobs/{JOB_ID}"}
    posts = [fail(409, IN_PROGRESS), httpx.Response(202, json={**envelope_body(accepted), "statusCode": 202})]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return posts.pop(0)
        return ok({"id": JOB_ID, "status": "processing"})

    recorder = Recorder(handler)
    with pytest.raises(JobWaitTimeoutError) as info:
        make_client(recorder, time=time).text_to_speech.generate("hello", voice_id="v1", wait_timeout=20)
    assert info.value.job_id == JOB_ID
    assert time.sleeps[0] == 5.0
    assert sum(time.sleeps) <= 20  # the 409 wait and the job wait, together


def test_in_progress_with_an_upload_that_cant_be_read_again_is_raised() -> None:
    recorder = sequence(fail(409, IN_PROGRESS))
    with pytest.raises(RequestInProgressError) as info:
        make_client(recorder).sound_cleaning.clean(("x.wav", OneShot(WAV)))  # type: ignore[arg-type]
    assert len(recorder.requests) == 1
    assert info.value.retry_disabled_reason == "body_not_replayable"


def test_in_progress_on_the_async_client() -> None:
    time = FakeTime()
    recorder = sequence(fail(409, IN_PROGRESS), fail(409, STARTING))
    result = run_async(IDEMPOTENT["speech_to_text.transcribe"], make_async_client(recorder, time=time))
    assert result.request_id == "req-ok"
    assert time.sleeps == [5.0, 5.0]
    assert len(set(keys(recorder))) == 1
    time = FakeTime()
    recorder = sequence(*[fail(409, IN_PROGRESS)] * 10)
    with pytest.raises(RequestInProgressError) as info:
        run_async(IDEMPOTENT["text_to_speech.generate"], make_async_client(recorder, time=time), wait_timeout=7)
    assert len(recorder.requests) == 2
    assert info.value.idempotency_key == keys(recorder)[0]


@pytest.mark.parametrize(
    ("response", "error"),
    [
        (fail(400, "text must be shorter than or equal to 500 characters"), InvalidRequestError),
        (fail(401, "Unauthorized"), AuthenticationError),
        (fail(402, "Insufficient subscription balance"), InsufficientBalanceError),
    ],
)
def test_client_auth_and_billing_errors_are_not_retried(response: httpx.Response, error: type[Exception]) -> None:
    recorder = sequence(response)
    with pytest.raises(error):
        make_client(recorder).text_to_speech.generate("hello", voice_id="v1")
    assert len(recorder.requests) == 1


# --- Errors carry the key ------------------------------------------------------------------------


@pytest.mark.parametrize("name", IDEMPOTENT)
def test_status_errors_carry_the_key(name: str) -> None:
    recorder = sequence(fail(400, "Bad request"))
    with pytest.raises(InvalidRequestError) as info:
        IDEMPOTENT[name](make_client(recorder), idempotency_key="my-key")
    assert info.value.idempotency_key == "my-key"


def test_connection_errors_carry_the_key_and_say_how_to_resend() -> None:
    recorder = sequence(httpx.ReadTimeout, httpx.ReadTimeout, httpx.ReadTimeout)
    with pytest.raises(APITimeoutError) as info:
        make_client(recorder).text_to_speech.generate("hello", voice_id="v1")
    error = info.value
    assert len(recorder.requests) == 3
    assert error.may_have_executed is True
    assert error.idempotency_key == keys(recorder)[0]
    assert "send it again with the same idempotency_key" in str(error)
    assert error.idempotency_key not in str(error)  # the message never repeats the key


def test_gateway_errors_carry_the_key_after_retries() -> None:
    recorder = sequence(*[httpx.Response(504, text="upstream request timeout")] * 3)
    with pytest.raises(GatewayError) as info:
        make_client(recorder).sound_cleaning.clean(("noisy.wav", WAV), max_retries=2)
    assert info.value.idempotency_key == keys(recorder)[0]


def test_errors_from_other_calls_have_no_key() -> None:
    with pytest.raises(ServerError) as info:
        make_client(sequence(*[fail(500, "x")] * 3)).text_to_speech.jobs.get(JOB_ID)
    assert info.value.idempotency_key is None
    assert APIConnectionError("x").idempotency_key is None
    assert APIStatusError("x").idempotency_key is None


def test_sending_again_with_the_reported_key() -> None:
    recorder = sequence(*[httpx.ReadTimeout] * 3)
    client = make_client(recorder)
    with pytest.raises(APIConnectionError) as info:
        client.text_to_speech.generate("hello", voice_id="v1")
    key = info.value.idempotency_key
    assert key is not None
    result = client.text_to_speech.generate("hello", voice_id="v1", idempotency_key=key)
    assert result.job_id == JOB_ID
    assert set(keys(recorder)) == {key}


# --- Async client --------------------------------------------------------------------------------


@pytest.mark.parametrize("name", IDEMPOTENT)
def test_async_client_retries_with_the_same_key(name: str) -> None:
    recorder = sequence(fail(500, "Something went wrong"), httpx.ReadTimeout)
    result = run_async(IDEMPOTENT[name], make_async_client(recorder))
    assert result.request_id == "req-ok"
    assert len(recorder.requests) == 3
    assert len(set(keys(recorder))) == 1


def test_async_client_errors_carry_the_key_and_creation_is_not_retried() -> None:
    recorder = sequence(fail(409, KEY_REUSED))
    with pytest.raises(InvalidRequestError) as info:
        run_async(IDEMPOTENT["text_to_speech.generate"], make_async_client(recorder), idempotency_key="k-9")
    assert info.value.idempotency_key == "k-9"
    recorder = sequence(fail(500, "Something went wrong"))
    with pytest.raises(ServerError):
        run_async(CREATE["speech_to_text.jobs.create"], make_async_client(recorder))
    assert len(recorder.requests) == 1
