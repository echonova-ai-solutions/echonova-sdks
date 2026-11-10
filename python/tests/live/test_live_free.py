"""Live checks that cost nothing: rejected requests, listings and lookups.

The first three need no key at all: a made-up key is rejected by the REST API and
by both stream handshakes.
"""

from __future__ import annotations

import itertools
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import pytest
from live_support import (
    DISABLED_KEY_ENV,
    MADE_UP_KEY,
    MISSING_JOB_ID,
    TOO_LONG_TEXT,
    TTS_ONLY_KEY_ENV,
    WIDGET_ENV,
    JobCleanup,
    note,
    require_env,
    run_async,
)

from echonova import (
    APIStatusError,
    AsyncEchoNova,
    AuthenticationError,
    EchoNova,
    InvalidRequestError,
    JobNotFoundError,
    PermissionDeniedError,
)
from echonova.types.models import VoiceList

pytestmark = pytest.mark.live


def check_rejected(error: APIStatusError, *, status: int, transport: str) -> None:
    status_code, request_id, error_transport = error.status_code, error.request_id, error.transport
    assert status_code == status
    assert error_transport == transport
    assert request_id, "the error should carry the request ID"


# --- A. No key needed -----------------------------------------------------------------------------


def test_rest_call_with_made_up_key_is_rejected() -> None:
    with EchoNova(api_key=MADE_UP_KEY) as client, pytest.raises(AuthenticationError) as caught:
        client.text_to_speech.voices.list()
    check_rejected(caught.value, status=401, transport="http")
    note("401 over REST", request_id=caught.value.request_id)


def test_tts_stream_handshake_with_made_up_key_is_rejected() -> None:
    async def scenario() -> AuthenticationError:
        async with AsyncEchoNova(api_key=MADE_UP_KEY) as client:
            with pytest.raises(AuthenticationError) as caught:
                async with client.text_to_speech.connect(voice_id="unused"):  # the voice is sent per synthesis
                    pass
            return caught.value

    error = run_async(scenario, timeout=60)
    check_rejected(error, status=401, transport="websocket")
    note("401 on the Text to Speech handshake (async)", request_id=error.request_id)


def test_stt_stream_handshake_with_made_up_key_is_rejected() -> None:
    with EchoNova(api_key=MADE_UP_KEY) as client, pytest.raises(AuthenticationError) as caught:
        client.speech_to_text.connect(sample_rate=16000, language="en").close()
    check_rejected(caught.value, status=401, transport="websocket")
    note("401 on the Speech to Text handshake (sync)", request_id=caught.value.request_id)


# --- B. Free, with a key --------------------------------------------------------------------------


def test_voices_list(voices: VoiceList, voice_id: str) -> None:
    count = len(voices)
    ids = [voice.id for voice in voices]
    assert count >= 1
    assert all(ids)
    assert voice_id in ids


SERVICES = ["text_to_speech", "speech_to_text", "sound_cleaning"]


@pytest.mark.parametrize("service", SERVICES)
def test_jobs_list_and_auto_paging(client: EchoNova, service: str) -> None:
    resource: Any = getattr(client, service).jobs
    page = resource.list(limit=1)
    total, count = page.total, len(page.items)
    assert total is not None
    assert total >= 0
    assert count <= 1
    assert page.request_id
    walked = list(itertools.islice(page, 2))  # continues onto the next page, and stops after two items
    ids = [job.id for job in walked]
    assert len(ids) <= 2
    assert len(set(ids)) == len(ids)
    assert all(job.status for job in walked)
    note(f"{service}.jobs.list", request_id=page.request_id, total=total)


def test_jobs_list_async(make_async_client: Callable[[], AsyncEchoNova]) -> None:
    async def scenario() -> tuple[int | None, list[str], str | None]:
        async with make_async_client() as client:
            page = await client.text_to_speech.jobs.list(limit=1)
            walked: list[str] = []
            async for job in client.text_to_speech.jobs.list(limit=1):
                walked.append(job.id)
                if len(walked) == 2:
                    break
            return page.total, walked, page.request_id

    total, walked, request_id = run_async(scenario, timeout=120)
    assert total is not None
    assert total >= 0
    assert len(walked) <= 2
    assert len(set(walked)) == len(walked)
    note("text_to_speech.jobs.list (async)", request_id=request_id, total=total)


@pytest.mark.parametrize("service", SERVICES)
def test_missing_job_is_not_found(client: EchoNova, service: str) -> None:
    resource: Any = getattr(client, service).jobs
    with pytest.raises(JobNotFoundError) as caught:
        resource.get(MISSING_JOB_ID)
    check_rejected(caught.value, status=404, transport="http")


def test_text_over_500_characters_is_invalid(client: EchoNova, voice_id: str, jobs: JobCleanup) -> None:
    try:
        result = client.text_to_speech.generate(TOO_LONG_TEXT, voice_id=voice_id)
    except InvalidRequestError as error:
        check_rejected(error, status=400, transport="http")
        return
    jobs.add("tts", result.job_id)  # it should never run, but if it did, don't leave the job behind
    pytest.fail("generate() accepted 501 characters", pytrace=False)


def test_key_without_speech_to_text_is_denied() -> None:
    key = require_env(TTS_ONLY_KEY_ENV, "the 403 test needs a key limited to Text to Speech")
    with EchoNova(api_key=key) as client, pytest.raises(PermissionDeniedError) as caught:
        client.speech_to_text.jobs.list(limit=1)
    check_rejected(caught.value, status=403, transport="http")


def test_disabled_key_is_rejected() -> None:
    key = require_env(DISABLED_KEY_ENV, "the disabled-key test needs a disabled key from the test workspace")
    with EchoNova(api_key=key) as client, pytest.raises(AuthenticationError) as caught:
        client.text_to_speech.voices.list()
    check_rejected(caught.value, status=401, transport="http")


def test_widget_ticket(client: EchoNova) -> None:
    public_id = require_env(WIDGET_ENV, "the ticket test needs a private widget in the test workspace")
    minted = client.widgets.create_ticket(public_id, ttl_seconds=60)
    has_ticket = isinstance(minted.ticket, str) and len(minted.ticket) > 0  # never print the ticket itself
    expires_at, request_id = minted.expires_at, minted.request_id
    assert has_ticket
    assert expires_at is not None
    assert expires_at > datetime.now(UTC)
    note("widgets.create_ticket", request_id=request_id)
