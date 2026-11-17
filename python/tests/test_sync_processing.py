"""A synchronous call answered ``202 Processing`` waits for its job and returns what a 200 returns (ADR 0014)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx
import pytest

from _support import (
    JOB_ID,
    SIGNED_URL,
    WAV,
    FakeTime,
    Recorder,
    envelope_body,
    fail,
    make_async_client,
    make_client,
    ok,
)
from echonova import (
    AuthenticationError,
    JobFailedError,
    JobWaitTimeoutError,
    ProtocolError,
    RawResponse,
    UsageError,
)
from echonova.types import CleanJob, SttResult, TtsResult


@dataclass
class Service:
    name: str
    call: Callable[..., Any]
    raw_call: Callable[..., Any]
    post: str
    jobs: str  # the job GET's path prefix
    interval: float
    result: type
    job: dict[str, Any]  # the completed job, as its GET returns it


SERVICES = [
    Service(
        "tts",
        lambda c, **kw: c.text_to_speech.generate("hello", voice_id="v1", **kw),
        lambda c, **kw: c.with_raw_response.text_to_speech.generate("hello", voice_id="v1", **kw),
        "/v1/text-to-speech/sync",
        "/v1/text-to-speech/jobs/",
        3.0,
        TtsResult,
        {
            "id": JOB_ID,
            "status": "completed",
            "text": "hello",
            "voiceId": "v1",
            "audioUrl": SIGNED_URL,
            "durationSeconds": 1.25,
            "creditsConsumed": 5,
            "createdAt": "2026-11-17T10:00:00.000Z",
        },
    ),
    Service(
        "stt",
        lambda c, **kw: c.speech_to_text.transcribe(WAV, **kw),
        lambda c, **kw: c.with_raw_response.speech_to_text.transcribe(WAV, **kw),
        "/v1/speech-to-text/sync",
        "/v1/speech-to-text/jobs/",
        5.0,
        SttResult,
        {
            "id": JOB_ID,
            "status": "completed",
            "transcription": "مرحبا",
            "language": "auto",
            "durationSeconds": 2.5,
            "segments": [{"start": 0, "end": 2.5, "text": "مرحبا", "speaker": "1"}],
            "creditsConsumed": 9,
        },
    ),
    Service(
        "clean",
        lambda c, **kw: c.sound_cleaning.clean(("noisy.wav", WAV), **kw),
        lambda c, **kw: c.with_raw_response.sound_cleaning.clean(("noisy.wav", WAV), **kw),
        "/v1/sound-cleaning",
        "/v1/sound-cleaning/jobs/",
        5.0,
        CleanJob,
        {
            "id": JOB_ID,
            "status": "completed",
            "fileName": "noisy.wav",
            "outputUrl": SIGNED_URL,
            "creditsConsumed": 3,
            "metrics": {"sampleRate": 48000, "integratedLufs": -16.0},
        },
    ),
]
BY_NAME = {service.name: service for service in SERVICES}


def processing(service: Service) -> httpx.Response:
    data = {"jobId": JOB_ID, "status": "processing", "resultUrl": f"{service.jobs}{JOB_ID}"}
    body = {**envelope_body(data), "statusCode": 202}
    return httpx.Response(202, json=body, headers={"X-Request-Id": "req-202"})


class Server:
    """The POST answers 202 (or the scripted answers); each job GET returns the next status (the last repeats)."""

    def __init__(self, service: Service, *statuses: str, posts: list[Any] | None = None, error: str | None = None):
        self.service = service
        self.statuses = list(statuses)
        self.posts = list(posts) if posts is not None else [processing(service)]
        self.error = error
        self.polls = 0
        self.recorder = Recorder(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            assert request.url.path == self.service.post
            step = self.posts.pop(0) if len(self.posts) > 1 else self.posts[0]
            return step if isinstance(step, httpx.Response) else step(request)
        assert request.method == "GET"
        assert request.url.path == f"{self.service.jobs}{JOB_ID}"
        self.polls += 1
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        if status == "completed":
            return ok(self.service.job, request_id=f"req-poll-{self.polls}")
        job: dict[str, Any] = {"id": JOB_ID, "status": status}
        if status == "failed":
            job["error"] = self.error
        return ok(job, request_id=f"req-poll-{self.polls}")

    @property
    def posted(self) -> list[httpx.Request]:
        return [r for r in self.recorder.requests if r.method == "POST"]


def check_result(result: Any, service: Service, request_id: str) -> None:
    assert type(result) is service.result
    assert result.id == JOB_ID
    assert result.status == "completed"
    assert result.request_id == request_id  # the last poll's
    assert result.raw == {**service.job, "jobId": JOB_ID}  # the job's JSON, plus jobId
    if service.result is not CleanJob:
        assert result.job_id == JOB_ID
    assert result.credits_consumed == service.job["creditsConsumed"]


@pytest.mark.parametrize("service", SERVICES, ids=lambda s: s.name)
def test_202_polls_the_job_and_returns_the_200_result_type(service: Service) -> None:
    time = FakeTime()
    server = Server(service, "processing", "processing", "completed")
    result = service.call(make_client(server.recorder, time=time))
    check_result(result, service, "req-poll-3")
    assert len(server.posted) == 1  # the upload is never sent again
    assert server.polls == 3
    assert time.sleeps == [service.interval, service.interval]


@pytest.mark.parametrize("service", SERVICES, ids=lambda s: s.name)
def test_async_client_202_polls_the_job(service: Service) -> None:
    time = FakeTime()
    server = Server(service, "pending", "completed")
    client = make_async_client(server.recorder, time=time)

    async def run() -> Any:
        return await service.call(client)

    check_result(asyncio.run(run()), service, "req-poll-2")
    assert len(server.posted) == 1
    assert time.sleeps == [service.interval]


def test_stt_result_from_the_job() -> None:
    server = Server(BY_NAME["stt"], "completed")
    result = BY_NAME["stt"].call(make_client(server.recorder))
    assert isinstance(result, SttResult)
    assert result.language == "auto"
    assert result.transcription == "مرحبا"
    assert result.segments is not None
    assert result.segments[0].speaker == "1"


@pytest.mark.parametrize("service", SERVICES, ids=lambda s: s.name)
def test_202_then_a_failed_job_raises_job_failed(service: Service) -> None:
    server = Server(service, "processing", "failed", error="Audio could not be decoded")
    with pytest.raises(JobFailedError, match="Audio could not be decoded") as info:
        service.call(make_client(server.recorder))
    assert info.value.job.id == JOB_ID
    assert info.value.job.status == "failed"


@pytest.mark.parametrize("service", SERVICES, ids=lambda s: s.name)
def test_202_still_processing_past_wait_timeout(service: Service) -> None:
    time = FakeTime()
    server = Server(service, "processing")
    with pytest.raises(JobWaitTimeoutError) as info:
        service.call(make_client(server.recorder, time=time), wait_timeout=30)
    error = info.value
    assert error.job_id == JOB_ID
    assert error.last_job.status == "processing"
    assert error.last_job.id == JOB_ID
    assert sum(time.sleeps) <= 30
    assert len(server.posted) == 1


def test_the_default_wait_is_20_minutes() -> None:
    time = FakeTime()
    server = Server(BY_NAME["stt"], "processing")
    with pytest.raises(JobWaitTimeoutError):
        BY_NAME["stt"].call(make_client(server.recorder, time=time))
    assert 1195 <= sum(time.sleeps) <= 1200
    assert server.polls == 241  # at 0, 5, ..., 1200 s, as jobs.wait()


def test_wait_timeout_zero_polls_once() -> None:
    server = Server(BY_NAME["tts"], "processing")
    with pytest.raises(JobWaitTimeoutError):
        BY_NAME["tts"].call(make_client(server.recorder), wait_timeout=0)
    assert server.polls == 1


@pytest.mark.parametrize("wait_timeout", [-1, True, "60", float("nan")])
def test_an_invalid_wait_timeout_is_refused_before_sending(wait_timeout: Any) -> None:
    server = Server(BY_NAME["clean"], "completed")
    with pytest.raises(UsageError, match="wait_timeout"):
        BY_NAME["clean"].call(make_client(server.recorder), wait_timeout=wait_timeout)
    assert server.recorder.requests == []


def test_the_calls_deadline_caps_the_wait() -> None:
    time = FakeTime()
    server = Server(BY_NAME["tts"], "processing")
    with pytest.raises(JobWaitTimeoutError):
        BY_NAME["tts"].call(make_client(server.recorder, time=time), deadline=10)
    assert sum(time.sleeps) <= 10


def test_polls_share_the_clients_poll_limiter() -> None:
    time = FakeTime()
    server = Server(BY_NAME["tts"], "completed")
    client = make_client(server.recorder, time=time)
    for _ in range(80):  # as if other wait() calls had used this minute's budget for the endpoint
        client._limits.limiter.reserve("text_to_speech.jobs.get")
    BY_NAME["tts"].call(client)
    assert time.sleeps == [pytest.approx(60.0)]


def test_transient_poll_errors_keep_polling() -> None:
    server = Server(BY_NAME["clean"], "completed")
    answers: list[Any] = [fail(503, "Database unavailable")] * 3

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and answers:
            return answers.pop(0)
        return server.handle(request)

    result = BY_NAME["clean"].call(make_client(Recorder(handler), max_retries=0))
    assert result.status == "completed"


def test_polls_send_the_callers_extra_headers_but_not_the_key() -> None:
    server = Server(BY_NAME["clean"], "processing", "completed")
    headers = {"X-Trace": "t-1", "Idempotency-Key": "k-headers"}
    BY_NAME["clean"].call(make_client(server.recorder), extra_headers=headers)
    post, *polls = server.recorder.requests
    assert post.headers["idempotency-key"] == "k-headers"
    assert post.headers["x-trace"] == "t-1"
    assert len(polls) == 2
    for poll in polls:
        assert poll.headers["x-trace"] == "t-1"
        assert "idempotency-key" not in poll.headers


def test_a_permanent_poll_error_is_raised_with_the_calls_key() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return processing(BY_NAME["tts"])
        return fail(401, "Unauthorized")

    with pytest.raises(AuthenticationError) as info:
        BY_NAME["tts"].call(make_client(handler), idempotency_key="k-202")
    assert info.value.idempotency_key == "k-202"


def test_a_202_without_a_job_id_is_retried_once_with_the_same_key() -> None:
    bad = httpx.Response(202, json={**envelope_body({"status": "processing"}), "statusCode": 202})
    server = Server(BY_NAME["stt"], "completed", posts=[bad])
    with pytest.raises(ProtocolError) as info:
        BY_NAME["stt"].call(make_client(server.recorder))
    assert len(server.posted) == 2
    assert len({r.headers["idempotency-key"] for r in server.posted}) == 1
    assert info.value.may_have_executed is True
    assert info.value.idempotency_key == server.posted[0].headers["idempotency-key"]


def test_a_200_is_returned_without_polling() -> None:
    service = BY_NAME["tts"]
    result_200 = {"jobId": JOB_ID, "status": "completed", "audioUrl": SIGNED_URL, "creditsConsumed": 5}
    server = Server(service, "completed", posts=[ok(result_200, request_id="req-200")])
    result = service.call(make_client(server.recorder))
    assert result.request_id == "req-200"
    assert server.polls == 0


@pytest.mark.parametrize("asynchronous", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("service", SERVICES, ids=lambda s: s.name)
def test_with_raw_response_returns_the_last_poll(service: Service, asynchronous: bool) -> None:
    server = Server(service, "processing", "completed")
    if asynchronous:
        client = make_async_client(server.recorder)

        async def run() -> Any:
            return await service.raw_call(client)

        raw = asyncio.run(run())
    else:
        raw = service.raw_call(make_client(server.recorder))
    assert isinstance(raw, RawResponse)
    assert raw.status_code == 200
    assert raw.request_id == "req-poll-2"
    check_result(raw.parse(), service, "req-poll-2")


def test_logs_say_which_job_it_waits_for_without_bodies_or_keys(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="echonova")
    server = Server(BY_NAME["stt"], "processing", "completed")
    BY_NAME["stt"].call(make_client(server.recorder), idempotency_key="secret-ish-key-123")
    assert f"POST /v1/speech-to-text/sync is still processing; waiting for job {JOB_ID}" in caplog.text
    assert "secret-ish-key-123" not in caplog.text
    assert "مرحبا" not in caplog.text
    assert "sig=" not in caplog.text
