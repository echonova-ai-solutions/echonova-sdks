"""The nightly live suite: real calls to the EchoNova API, against a dedicated test workspace.

The suite is deselected by default (``-m 'not live'`` in pyproject.toml). Run it with::

    cd python && ECHONOVA_LIVE=1 uv run pytest -m live

Environment (the same names as tools/record/record.py):

- ``ECHONOVA_LIVE=1`` enables the suite. Without it every live test is skipped.
- ``ECHONOVA_API_KEY``: a full-access key from the test workspace, with a Credit Limit.
  Without it only the free tests that need no key run.
- ``ECHONOVA_TTS_ONLY_KEY`` (optional): a key limited to Text to Speech, for the 403 test.
- ``ECHONOVA_DISABLED_KEY`` (optional): a disabled key, for the 401 test.
- ``ECHONOVA_AGENT_ID`` (optional): an agent in the test workspace, for the agent session test.
- ``ECHONOVA_WIDGET_PUBLIC_ID`` (optional): a private widget, for the ticket test.
- ``ECHONOVA_BASE_URL`` (optional): defaults to the SDK's default.

A full run costs roughly 250 to 300 credits (about 400 at most), and never more than the key's
Credit Limit. Every job a test creates is deleted once it has finished. Tests print request IDs
and timings only, and live failures use short tracebacks, which don't print frame arguments.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from live_support import (
    ENGLISH_SENTENCE,
    KEY_ENV,
    LIVE_ENV,
    REST_DEADLINE,
    JobCleanup,
    SharedSpeech,
    StreamSynthesisCleanup,
    env,
    note,
    require_env,
)

from echonova import AsyncEchoNova, EchoNova
from echonova.types.models import VoiceList

HERE = Path(__file__).resolve().parent


def pytest_configure(config: pytest.Config) -> None:
    # Long tracebacks print the arguments of every frame, which can include signed links or a
    # result holding a token. Live failures use short tracebacks unless --tb was given.
    if env(LIVE_ENV) == "1" and config.option.tbstyle == "auto":
        config.option.tbstyle = "short"


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if env(LIVE_ENV) == "1":
        return
    skip = pytest.mark.skip(reason=f"live tests call the real API and can cost credits: set {LIVE_ENV}=1 to run them")
    for item in items:
        if item.path.is_relative_to(HERE):
            item.add_marker(skip)


# --- Clients --------------------------------------------------------------------------------------


@pytest.fixture(scope="session")
def api_key() -> str:
    return require_env(KEY_ENV, "this test needs a key from the test workspace (with a Credit Limit)")


@pytest.fixture(scope="session")
def client(api_key: str) -> Iterator[EchoNova]:
    with EchoNova(api_key=api_key, deadline=REST_DEADLINE) as sync_client:
        yield sync_client


@pytest.fixture(scope="session")
def make_async_client(api_key: str) -> Callable[[], AsyncEchoNova]:
    """An async client is bound to the event loop that uses it, so each test makes its own."""
    return lambda: AsyncEchoNova(api_key=api_key, deadline=REST_DEADLINE)


# --- Cleanup --------------------------------------------------------------------------------------


@pytest.fixture
def jobs(client: EchoNova) -> Iterator[JobCleanup]:
    """Jobs this test created, deleted when it ends."""
    cleanup = JobCleanup(client)
    yield cleanup
    cleanup.run()


@pytest.fixture(scope="session")
def session_jobs(client: EchoNova) -> Iterator[JobCleanup]:
    """Jobs behind session fixtures, deleted when the run ends."""
    cleanup = JobCleanup(client)
    yield cleanup
    cleanup.run()


@pytest.fixture
def stream_jobs(client: EchoNova) -> Iterator[StreamSynthesisCleanup]:
    """Texts this test synthesized on a stream; their jobs are deleted when it ends."""
    cleanup = StreamSynthesisCleanup(client)
    yield cleanup
    cleanup.run()


# --- Shared data ----------------------------------------------------------------------------------


@pytest.fixture(scope="session")
def voices(client: EchoNova) -> VoiceList:
    found = client.text_to_speech.voices.list()
    note("voices.list", request_id=found.request_id, count=len(found))
    return found


@pytest.fixture(scope="session")
def voice_id(voices: VoiceList) -> str:
    """An English voice, or the first voice when there is none."""
    if not len(voices):
        pytest.fail("voices.list returned no voices", pytrace=False)
    english = next((voice for voice in voices if (voice.language or "").lower().startswith("en")), None)
    return (english or voices[0]).id


@pytest.fixture(scope="session")
def speech(client: EchoNova, voice_id: str, session_jobs: JobCleanup) -> SharedSpeech:
    result = client.text_to_speech.generate(ENGLISH_SENTENCE, voice_id=voice_id)
    session_jobs.add("tts", result.job_id)
    note("text_to_speech.generate", request_id=result.request_id, seconds=result.duration_seconds)
    url = result.audio_url
    if url is None:
        pytest.fail("generate() returned no audio_url", pytrace=False)
    return SharedSpeech(result=result, wav=client.download(url))
