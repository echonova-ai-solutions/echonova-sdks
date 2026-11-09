"""The API key, bodies and signed-link signatures never reach logs, reprs or error messages."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from _support import JOB_ID, SIGNED_URL, TEST_KEY, WAV, fail, make_async_client, make_client, ok
from echonova import EchoNovaError

SECRET_TEXT = "my private transcript text"


def everything(request: httpx.Request) -> httpx.Response:
    """A mix of outcomes so that every log and error path runs."""
    path = request.url.path
    if path.endswith("/sync") and request.method == "POST":
        if "text-to-speech" in path:
            raise httpx.ReadTimeout("timed out", request=request)
        return fail(400, "Unsupported audio format")
    if path.endswith("/voices"):
        return fail(429, "ThrottlerException: Too Many Requests", headers={"Retry-After": "1"})
    if request.method == "DELETE":
        return fail(500, "Something went wrong")
    return ok({"id": JOB_ID, "status": "completed", "text": SECRET_TEXT, "audioUrl": SIGNED_URL})


def exercise(client: Any) -> list[EchoNovaError]:
    errors: list[EchoNovaError] = []
    calls: list[Callable[[], Any]] = [
        lambda: client.text_to_speech.generate(SECRET_TEXT, voice_id="v"),
        lambda: client.speech_to_text.transcribe(WAV, language="ar", terminology={"keywords": [SECRET_TEXT]}),
        lambda: client.text_to_speech.voices.list(),
        lambda: client.text_to_speech.jobs.delete(JOB_ID),
        lambda: client.text_to_speech.jobs.get(JOB_ID),
        lambda: client.text_to_speech.jobs.download(JOB_ID),
        lambda: client.download(SIGNED_URL),
    ]
    for call in calls:
        try:
            call()
        except EchoNovaError as exc:
            errors.append(exc)
    return errors


def assert_clean(text: str) -> None:
    assert TEST_KEY not in text
    assert TEST_KEY[3:20] not in text
    assert "sig=" not in text
    assert "REDACTED-secret-signature" not in text
    assert SECRET_TEXT not in text


def download_404(request: httpx.Request) -> httpx.Response:
    return httpx.Response(403, text=f"<Error>{request.url}</Error>")


def test_sync_client_leaks_nothing(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="echonova")
    client = make_client(everything, download=download_404)
    errors = exercise(client)
    assert len(errors) == 6
    assert caplog.records, "debug logging should have produced records"
    assert_clean(caplog.text)
    assert_clean(repr(client))
    for error in errors:
        assert_clean(str(error))
        assert_clean(repr(error))
        assert_clean(repr(vars(error)))


def test_async_client_leaks_nothing(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="echonova")
    client = make_async_client(everything, download=download_404)

    async def run() -> list[EchoNovaError]:
        errors: list[EchoNovaError] = []
        calls = [
            client.text_to_speech.generate(SECRET_TEXT, voice_id="v"),
            client.text_to_speech.voices.list(),
            client.text_to_speech.jobs.download(JOB_ID),
        ]
        for call in calls:
            try:
                await call
            except EchoNovaError as exc:
                errors.append(exc)
        return errors

    errors = asyncio.run(run())
    assert len(errors) == 3
    assert_clean(caplog.text)
    for error in errors:
        assert_clean(str(error))


def test_logged_fields() -> None:
    records: list[logging.LogRecord] = []

    class Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    logger = logging.getLogger("echonova")
    handler = Collect(level=logging.DEBUG)
    logger.addHandler(handler)
    previous = logger.level
    logger.setLevel(logging.DEBUG)
    try:
        make_client(lambda r: ok({"id": JOB_ID, "status": "completed"}, request_id="req-5")).text_to_speech.jobs.get(
            JOB_ID
        )
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous)
    message = records[-1].getMessage()
    assert message.startswith("GET /v1/text-to-speech/jobs/{jobId} -> 200 (request_id=req-5, attempt 1,")
    assert JOB_ID not in message  # the route template, not the ID
