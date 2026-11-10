"""Live checks that cost a few credits each: Text to Speech, Speech to Text, Sound Cleaning and agent sessions.

They share one short English sentence from Text to Speech as test audio (the
``speech`` fixture). Assertions check shapes and invariants, never exact text.
Values are copied out of results before asserting, so a failure message never
shows a result's repr (which can hold a signed link).
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from live_support import AGENT_ENV, JOB_SENTENCE, JOB_WAIT, JobCleanup, SharedSpeech, note, require_env, run_async

from echonova import AsyncEchoNova, EchoNova, JobNotFoundError
from echonova.types.models import TranscriptExport

pytestmark = pytest.mark.live

WAV_NAME = "live-test.wav"


def test_generate_and_download(speech: SharedSpeech) -> None:
    result = speech.result
    has_url = result.audio_url is not None
    duration, credits, status = result.duration_seconds, result.credits_consumed, result.status
    assert has_url
    assert status == "completed"
    assert duration is not None
    assert duration > 0
    assert credits is not None
    assert credits >= 1
    head = speech.wav[:4]
    assert head == b"RIFF"
    audio = speech.audio  # the SDK's WAV reader: PCM16 mono for the streams
    assert audio.sample_rate > 0
    assert audio.duration > 0


def test_tts_job_create_wait_download_delete(client: EchoNova, voice_id: str, jobs: JobCleanup) -> None:
    created = client.text_to_speech.jobs.create(JOB_SENTENCE, voice_id=voice_id)
    job_id = created.job_id
    jobs.add("tts", job_id)
    assert job_id

    done = client.text_to_speech.jobs.wait(job_id, timeout=JOB_WAIT)
    status, credits = done.status, done.credits_consumed
    assert status == "completed"
    assert credits is not None
    assert credits >= 1

    head = client.text_to_speech.jobs.download(job_id)[:4]  # gets the job again for a fresh link
    assert head == b"RIFF"

    deleted = client.text_to_speech.jobs.delete(job_id)
    assert deleted.deleted is True
    with pytest.raises(JobNotFoundError):
        client.text_to_speech.jobs.get(job_id)
    note("text_to_speech.jobs", request_id=created.request_id, credits=credits)


def test_stt_transcribe(client: EchoNova, speech: SharedSpeech, jobs: JobCleanup) -> None:
    result = client.speech_to_text.transcribe((WAV_NAME, speech.wav), language="en")
    jobs.add("stt", result.job_id)
    status, text, credits = result.status, (result.transcription or "").strip(), result.credits_consumed
    assert status == "completed"
    assert text
    assert credits is None or credits >= 0
    note("speech_to_text.transcribe", request_id=result.request_id, seconds=result.duration_seconds)


def test_stt_job_create_wait_export_delete(client: EchoNova, speech: SharedSpeech, jobs: JobCleanup) -> None:
    stt_jobs = client.speech_to_text.jobs
    created = stt_jobs.create((WAV_NAME, speech.wav), language="en")
    job_id = created.job_id
    jobs.add("stt", job_id)

    done = stt_jobs.wait(job_id, timeout=JOB_WAIT)
    status, text = done.status, (done.transcription or "").strip()
    assert status == "completed"
    assert text

    txt = stt_jobs.export(job_id, format="txt")
    assert isinstance(txt, str)
    assert txt.strip()
    srt = stt_jobs.export(job_id, format="srt")
    assert isinstance(srt, str)
    assert "-->" in srt  # SubRip cue timings
    exported = stt_jobs.export(job_id, format="json")
    assert isinstance(exported, TranscriptExport)
    assert (exported.text or "").strip()

    deleted = stt_jobs.delete(job_id)
    assert deleted.deleted is True
    note("speech_to_text.jobs", request_id=created.request_id)


def test_sound_cleaning_async(
    make_async_client: Callable[[], AsyncEchoNova], speech: SharedSpeech, jobs: JobCleanup
) -> None:
    async def scenario() -> None:
        async with make_async_client() as client:
            job = await client.sound_cleaning.clean((WAV_NAME, speech.wav))
            jobs.add("clean", job.id)
            status, url = job.status, job.output_url
            assert status == "completed"
            assert url is not None
            head = (await client.download(url))[:4]
            assert head == b"RIFF"

            fetched = await client.sound_cleaning.jobs.get(job.id)
            same_id, fetched_status = fetched.id == job.id, fetched.status
            assert same_id
            assert fetched_status == "completed"

            deleted = await client.sound_cleaning.jobs.delete(job.id)
            assert deleted.deleted is True
            note("sound_cleaning.clean (async)", request_id=job.request_id, credits=job.credits_consumed)

    run_async(scenario, timeout=300)


def test_agent_session_start_get_end(client: EchoNova) -> None:
    agent_id = require_env(AGENT_ENV, "the agent session test needs an agent in the test workspace")
    sessions = client.agents.sessions
    started = sessions.start(agent_id, channel="chat")  # chat is the cheaper channel
    session_id = started.id
    try:
        has_token = bool(started.token)  # a secret: never print it
        status, channel = started.status, started.channel
        assert session_id
        assert has_token
        assert status == "active"
        assert channel in (None, "chat")

        fetched = sessions.get(agent_id, session_id)
        same_id = fetched.id == session_id
        assert same_id
    finally:
        ended = sessions.end(agent_id, session_id)
    ended_status = ended.status
    assert ended_status != "active"
    note("agents.sessions", request_id=started.request_id, status=ended_status)
