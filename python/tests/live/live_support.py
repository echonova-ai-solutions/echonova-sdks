"""Shared pieces of the live suite: environment, bounded runs, test texts and job cleanup.

Nothing here prints keys, tickets, tokens, signed links or bodies. Request IDs
and timings are fine to print.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import itertools
import os
import secrets
import threading
import time
import warnings
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, TypeVar

import pytest

from echonova import Audio, EchoNova, EchoNovaError, NotFoundError
from echonova.audio import read_wav
from echonova.types.models import TtsResult

T = TypeVar("T")

# --- Environment ----------------------------------------------------------------------------------

LIVE_ENV = "ECHONOVA_LIVE"
KEY_ENV = "ECHONOVA_API_KEY"
TTS_ONLY_KEY_ENV = "ECHONOVA_TTS_ONLY_KEY"
DISABLED_KEY_ENV = "ECHONOVA_DISABLED_KEY"
AGENT_ENV = "ECHONOVA_AGENT_ID"
WIDGET_ENV = "ECHONOVA_WIDGET_PUBLIC_ID"


def env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def require_env(name: str, why: str) -> str:
    """The variable's value, or skip the test with a reason that says what it is for."""
    value = env(name)
    if value is None:
        pytest.skip(f"{name} is not set: {why}")
    return value


# --- Limits ---------------------------------------------------------------------------------------

REST_DEADLINE = 120.0  # seconds for one REST call, retries included (the client's ``deadline``)
JOB_WAIT = 300.0  # seconds for jobs.wait()
SLOT_WAIT = 60.0  # seconds to wait for a free stream slot (other suites may share the workspace)

# --- Test data ------------------------------------------------------------------------------------

MADE_UP_KEY = "ek_REDACTED0made0up0key0for0the0live0suite"  # never valid, so it is rejected for free
MISSING_JOB_ID = "0" * 24
TOO_LONG_TEXT = "a" * 501  # one over the 500-character limit
ENGLISH_SENTENCE = "Hello from the EchoNova Python live test."  # about 40 characters: the shared audio
JOB_SENTENCE = "This sentence was made by an async job."

# Syntheses on a stream are kept as jobs too, and the stream doesn't return their IDs. They are
# found again by their text, so every stream text carries this run's tag: other suites using the
# same workspace at the same time never match.
RUN_TAG = str(1000 + secrets.randbelow(9000))
STREAM_SHORT = f"Streaming check {RUN_TAG}."
STREAM_LONG = (
    f"This longer passage, number {RUN_TAG}, is cancelled as soon as its first audio arrives, "
    "so only the share of audio already sent is charged and the rest is refunded."
)
STREAM_SENTENCES = (f"First sentence {RUN_TAG}.", f"Second sentence {RUN_TAG}.", f"Third sentence {RUN_TAG}.")
SPEAK_SENTENCE = f"Blocking speak check {RUN_TAG}."


@dataclass(frozen=True, repr=False)
class SharedSpeech:
    """A short English sentence from Text to Speech: the test audio for Speech to Text and Sound Cleaning."""

    result: TtsResult
    wav: bytes

    @property
    def audio(self) -> Audio:
        """The PCM16 mono samples and their rate, for the streams (read with the SDK's WAV reader)."""
        return read_wav(io.BytesIO(self.wav))

    def __repr__(self) -> str:  # the result's repr holds a signed link
        return f"SharedSpeech(job_id={self.result.job_id!r}, wav_bytes={len(self.wav)})"


def note(what: str, **values: object) -> None:
    """Print a progress line (shown with ``-s`` or on failure). Pass only IDs, counts and timings."""
    details = " ".join(f"{key}={value}" for key, value in values.items())
    print(f"[live] {what} {details}".rstrip())


# --- Bounded runs ---------------------------------------------------------------------------------


def run_async(factory: Callable[[], Awaitable[T]], *, timeout: float) -> T:
    """Run a coroutine on a fresh event loop. It is cancelled, and the test fails, after ``timeout`` seconds."""

    async def bounded() -> T:
        async with asyncio.timeout(timeout):
            return await factory()

    return asyncio.run(bounded())


def run_bounded(fn: Callable[[], T], *, timeout: float) -> T:
    """Run blocking ``fn`` on a daemon thread, and fail the test if it hasn't returned after ``timeout`` seconds."""
    results: list[T] = []
    errors: list[BaseException] = []

    def target() -> None:
        try:
            results.append(fn())
        except BaseException as exc:
            errors.append(exc)

    thread = threading.Thread(target=target, name="echonova-live-test", daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        pytest.fail(f"still running after {timeout:g} s", pytrace=False)
    if errors:
        raise errors[0]
    return results[0]


# --- Cleanup --------------------------------------------------------------------------------------

Service = Literal["tts", "stt", "clean"]
FINISHED = ("completed", "failed")


class JobCleanup:
    """Deletes the jobs a test created, once they have finished. A job the test deleted itself is skipped."""

    def __init__(self, client: EchoNova) -> None:
        self._client = client
        self._jobs: list[tuple[Service, str]] = []

    def add(self, service: Service, job_id: str | None) -> None:
        if job_id and (service, job_id) not in self._jobs:
            self._jobs.append((service, job_id))

    def run(self) -> None:
        problems = []
        for service, job_id in self._jobs:
            try:
                self._delete(service, job_id)
            except NotFoundError:
                pass  # already deleted
            except EchoNovaError as exc:
                problems.append(f"a {service} job: {type(exc).__name__} (request {getattr(exc, 'request_id', None)})")
        self._jobs.clear()
        if problems:
            pytest.fail("cleanup could not delete " + "; ".join(problems), pytrace=False)

    def _delete(self, service: Service, job_id: str) -> None:
        client = self._client
        if service == "tts":
            client.text_to_speech.jobs.wait(job_id, timeout=JOB_WAIT, raise_on_failure=False)
            client.text_to_speech.jobs.delete(job_id)
        elif service == "stt":
            client.speech_to_text.jobs.wait(job_id, timeout=JOB_WAIT, raise_on_failure=False)
            client.speech_to_text.jobs.delete(job_id)
        else:
            client.sound_cleaning.jobs.delete(job_id)


class StreamSynthesisCleanup:
    """Deletes the jobs kept for Text to Speech stream syntheses, found by their tagged texts.

    Best effort: a job that doesn't show up, or doesn't finish within ``wait`` seconds,
    is left behind with a warning rather than failing the test.
    """

    def __init__(self, client: EchoNova, *, wait: float = 60.0) -> None:
        self._client = client
        self._wait = wait
        self._since = datetime.now(UTC) - timedelta(minutes=5)
        self.texts: set[str] = set()

    def add(self, *texts: str) -> None:
        self.texts.update(text.strip() for text in texts)

    def _find(self) -> list[tuple[str, str]]:
        found = []
        for job in itertools.islice(self._client.text_to_speech.jobs.list(limit=50), 100):
            if job.created_at is not None and job.created_at < self._since:
                break  # newest first: the rest are older than this run
            if job.stream is not None and (job.text or "").strip() in self.texts:
                found.append((job.id, job.status))
        return found

    def run(self) -> None:
        if not self.texts:
            return
        deadline = time.monotonic() + self._wait
        deleted: set[str] = set()
        while True:
            found = [(job_id, status) for job_id, status in self._find() if job_id not in deleted]
            for job_id, status in found:
                if status in FINISHED:
                    with contextlib.suppress(NotFoundError):
                        self._client.text_to_speech.jobs.delete(job_id)
                    deleted.add(job_id)
            waiting = [job_id for job_id, status in found if status not in FINISHED]
            if (not waiting and len(deleted) >= len(self.texts)) or time.monotonic() >= deadline:
                break
            time.sleep(3)
        if len(deleted) < len(self.texts):
            warnings.warn(
                f"deleted {len(deleted)} of {len(self.texts)} Text to Speech stream jobs; the rest may be left behind",
                stacklevel=1,
            )
        self.texts.clear()
