"""Live checks of the two streams: Text to Speech and Speech to Text, over both drivers.

The async client runs the full sessions; the blocking client runs ``speak`` and
``transcribe_stream``. Every stream waits up to ``SLOT_WAIT`` seconds for a free
slot, because other suites may be using the same workspace.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from live_support import (
    SLOT_WAIT,
    SPEAK_SENTENCE,
    STREAM_LONG,
    STREAM_SENTENCES,
    STREAM_SHORT,
    JobCleanup,
    SharedSpeech,
    StreamSynthesisCleanup,
    note,
    run_async,
    run_bounded,
)

from echonova import AsyncEchoNova, EchoNova
from echonova.types.streaming import SessionSaved, SessionSummary, StreamErrorEvent, SttEvent, Transcript

pytestmark = pytest.mark.live

SAVED_STATUSES = (None, "saved", "empty", "failed")


def test_tts_stream_synthesize_cancel_and_speak_stream(
    make_async_client: Callable[[], AsyncEchoNova], voice_id: str, stream_jobs: StreamSynthesisCleanup
) -> None:
    stream_jobs.add(STREAM_SHORT, STREAM_LONG, *STREAM_SENTENCES)

    async def scenario() -> None:
        async with (
            make_async_client() as client,
            client.text_to_speech.connect(voice_id=voice_id, wait_for_slot=SLOT_WAIT) as tts,
        ):
            # One synthesis, collected: the sample rate comes from the server's start message.
            synthesis = tts.synthesize(STREAM_SHORT)
            audio = await synthesis.collect()
            result = await synthesis.result()
            rate = synthesis.sample_rate
            assert rate is not None
            assert rate > 0
            assert audio.sample_rate == rate
            assert len(audio.pcm) > 0
            assert len(audio.pcm) % 2 == 0
            assert result.outcome == "completed"
            assert result.charged is True
            assert result.credits_consumed is not None
            assert result.credits_consumed >= 1
            note("tts stream: completed", credits=result.credits_consumed, ttfb=synthesis.metrics.ttfb)

            # A longer one, cancelled after its first audio: an outcome, not an exception.
            long = tts.synthesize(STREAM_LONG)
            first = b""
            async for chunk in long:
                first = chunk
                await long.cancel()
                break
            assert first
            cancelled = await long.result()
            assert cancelled.outcome == "cancelled"
            assert cancelled.charged is True  # its audio had started
            assert cancelled.credits_consumed is None or cancelled.credits_consumed >= 1
            note("tts stream: cancelled", credits=cancelled.credits_consumed)

            # Three sentences, queued in order, as one stream of audio.
            spoken = 0
            async for chunk in tts.speak_stream(list(STREAM_SENTENCES)):
                spoken += len(chunk)
            assert spoken > 0
            note("tts stream: speak_stream", audio_bytes=spoken)

    run_async(scenario, timeout=240)


def test_tts_speak_sync(client: EchoNova, voice_id: str, stream_jobs: StreamSynthesisCleanup) -> None:
    stream_jobs.add(SPEAK_SENTENCE)
    audio = run_bounded(
        lambda: client.text_to_speech.speak(SPEAK_SENTENCE, voice_id=voice_id, wait_for_slot=SLOT_WAIT), timeout=120
    )
    assert audio.sample_rate > 0
    assert len(audio.pcm) > 0
    assert audio.duration > 0
    note("tts speak (sync)", seconds=round(audio.duration, 2))


def test_stt_stream_session(
    make_async_client: Callable[[], AsyncEchoNova], speech: SharedSpeech, jobs: JobCleanup
) -> None:
    audio = speech.audio

    async def scenario() -> tuple[str | None, list[SttEvent], SessionSummary]:
        async with (
            make_async_client() as client,
            client.speech_to_text.connect(sample_rate=audio.sample_rate, language="en", wait_for_slot=SLOT_WAIT) as stt,
        ):
            jobs.add("stt", stt.job_id)  # the session is kept as this job when it is saved
            session_id = stt.session_id
            sending = stt.feed_from(audio.pcm)  # ~100 ms frames, then stop()
            events = [event async for event in stt]
            summary = await sending
            return session_id, events, summary

    session_id, events, summary = run_async(scenario, timeout=180)
    transcripts = [event for event in events if isinstance(event, Transcript)]
    errors = [event.code for event in events if isinstance(event, StreamErrorEvent)]
    assert session_id
    assert len(transcripts) >= 1, f"no transcript (stream errors: {errors})"
    assert any(t.text.strip() for t in transcripts)
    assert all(t.duration_seconds >= 0 and t.credits_consumed >= 0 for t in transcripts)
    assert summary.total_seconds > 0
    assert summary.reason
    assert summary.saved_status in SAVED_STATUSES
    if summary.saved_status == "saved":
        assert summary.job_id
    jobs.add("stt", summary.job_id)
    note("stt stream", transcripts=len(transcripts), seconds=summary.total_seconds, saved=summary.saved_status)


def test_stt_transcribe_stream_sync(client: EchoNova, speech: SharedSpeech, jobs: JobCleanup) -> None:
    audio = speech.audio
    events = run_bounded(
        lambda: list(
            client.speech_to_text.transcribe_stream(
                audio.pcm, sample_rate=audio.sample_rate, language="en", wait_for_slot=SLOT_WAIT
            )
        ),
        timeout=180,
    )
    saved = [event for event in events if isinstance(event, SessionSaved)]
    for event in saved:
        if event.status == "saved":
            jobs.add("stt", event.job_id)
    transcripts = [event for event in events if isinstance(event, Transcript)]
    errors = [event.code for event in events if isinstance(event, StreamErrorEvent)]
    assert len(transcripts) >= 1, f"no transcript (stream errors: {errors})"
    assert any(t.text.strip() for t in transcripts)
    assert all(event.status in SAVED_STATUSES for event in saved)
    note("stt transcribe_stream (sync)", transcripts=len(transcripts), sessions_saved=len(saved))
