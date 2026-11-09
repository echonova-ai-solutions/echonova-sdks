"""transcribe_stream: segmentation, rollover, reconnect with replay. Each test runs async and sync."""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from mock_server import MockServer, SttAction
from stream_adapters import run_transcribe
from stream_helpers import options_for, pcm

from echonova import InsufficientBalanceError, ProtocolError, StreamConnectionLostError
from echonova._streaming import AudioDropped, Reconnected, ReconnectPolicy, StreamErrorEvent, Transcript

FAST = ReconnectPolicy(max_attempts=3, initial_delay=0.01)
SEGMENT = 32_000  # bytes in one 1-second segment at 16 kHz


def source(mode: str, data: bytes, chunk: int = 3_200, delay: float = 0.0) -> Any:
    pieces = [data[i : i + chunk] for i in range(0, len(data), chunk)]
    if mode == "async":

        async def agen() -> AsyncIterator[bytes]:
            for piece in pieces:
                if delay:
                    await asyncio.sleep(delay)
                yield piece

        return agen()

    def gen() -> Iterator[bytes]:
        for piece in pieces:
            if delay:
                time.sleep(delay)
            yield piece

    return gen()


def wait_for(predicate: Any, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        time.sleep(0.01)


def kinds(events: list[Any]) -> list[str]:
    return [type(e).__name__ for e in events]


def transcripts(events: list[Any]) -> list[Transcript]:
    return [e for e in events if isinstance(e, Transcript)]


def test_cuts_its_own_segments(server: MockServer, mode: str) -> None:
    audio = pcm(3.5)
    events, error = run_transcribe(
        mode, options_for(server), source(mode, audio), sample_rate=16_000, language="ar", segment_seconds=1.0
    )
    assert error is None
    assert [t.text for t in transcripts(events)] == ["segment 1", "segment 2", "segment 3", "segment 4"]
    assert [t.index for t in transcripts(events)] == [0, 1, 2, 3]
    conn = server.stt_conns[0]
    assert bytes(conn.audio) == audio
    assert [f["type"] for f in conn.received] == ["end_segment"] * 3 + ["stop"]
    assert len(server.stt_conns) == 1


def test_whole_buffer_source(server: MockServer, mode: str) -> None:
    audio = pcm(1.2)
    events, error = run_transcribe(
        mode, options_for(server), audio, sample_rate=16_000, language="en", segment_seconds=1.0
    )
    assert error is None
    assert len(transcripts(events)) == 2
    assert bytes(server.stt_conns[0].audio) == audio


def test_rollover_before_the_session_limit(server: MockServer, mode: str) -> None:
    server.stt.max_session_seconds = 2
    options = options_for(server, rollover_margin=1.6)  # hand over 0.4 s into each session
    audio = pcm(2.0)
    events, error = run_transcribe(
        mode,
        options,
        source(mode, audio, delay=0.04),  # 0.8 s of sending: at least one rollover
        sample_rate=16_000,
        language="ar",
        terminology={"keywords": ["KYC"]},
        segment_seconds=5.0,
        reconnect=FAST,
    )
    assert error is None
    rollovers = [e for e in events if isinstance(e, Reconnected)]
    assert rollovers
    assert all(r.reason == "rollover" for r in rollovers)
    assert len(server.stt_conns) == len(rollovers) + 1
    assert not any(isinstance(e, AudioDropped) for e in events)
    assert b"".join(bytes(c.audio) for c in server.stt_conns) == audio  # nothing lost, nothing sent twice
    wait_for(lambda: all(conn.close_code is not None for conn in server.stt_conns))
    for conn in server.stt_conns:
        assert conn.received[0] == {"type": "terminology", "terminology": {"keywords": ["KYC"]}}
        assert conn.close_code == 1000  # each session stopped cleanly
    assert sum(t.duration_seconds for t in transcripts(events)) == pytest.approx(2.0)
    assert [t.index for t in transcripts(events)] == list(range(len(transcripts(events))))


def test_reconnects_and_replays_only_uncut_audio(server: MockServer, mode: str) -> None:
    server.stt.actions.append(SttAction("abort", after_bytes=SEGMENT + 16_000))  # half-way through segment 2
    audio = pcm(3.0)
    events, error = run_transcribe(
        mode,
        options_for(server),
        source(mode, audio, delay=0.005),
        sample_rate=16_000,
        language="ar",
        terminology={"keywords": ["KYC"]},
        segment_seconds=1.0,
        reconnect=FAST,
    )
    assert error is None
    assert kinds(events)[:2] == ["Transcript", "Reconnected"]
    reconnected = events[1]
    assert reconnected.reason == "connection_lost"
    assert reconnected.attempt == 1
    first, second = server.stt_conns
    assert bytes(second.audio) == audio[SEGMENT:]  # replayed from the last cut, not from the start
    assert bytes(first.audio[:SEGMENT]) + bytes(second.audio) == audio
    assert second.received[0]["type"] == "terminology"  # terminology re-sent
    assert sum(t.duration_seconds for t in transcripts(events)) == pytest.approx(3.0)


def test_cut_segments_without_a_result_are_reported_dropped(server: MockServer, mode: str) -> None:
    server.stt.actions.append(SttAction("abort_on_cut", after_bytes=2))
    audio = pcm(3.0)
    events, error = run_transcribe(
        mode,
        options_for(server),
        source(mode, audio, delay=0.005),
        sample_rate=16_000,
        language="ar",
        segment_seconds=1.0,
        reconnect=FAST,
    )
    assert error is None
    dropped = [e for e in events if isinstance(e, AudioDropped)]
    assert len(dropped) == 1
    (mark,) = dropped[0].segment_marks
    assert (mark.index, mark.audio_offset_s, mark.duration_s) == (1, 2.0, 1.0)
    assert dropped[0].seconds == 1.0
    assert kinds(events).index("AudioDropped") < kinds(events).index("Reconnected")
    assert bytes(server.stt_conns[1].audio) == audio[2 * SEGMENT :]
    assert sum(t.duration_seconds for t in transcripts(events)) == pytest.approx(2.0)


@pytest.mark.parametrize(("kind", "reason"), [("restart", "server_restarting"), ("upstream", "upstream_error")])
def test_reconnects_after_restart_and_upstream_close(server: MockServer, mode: str, kind: str, reason: str) -> None:
    server.stt.actions.append(SttAction(kind, after_bytes=8_000))
    events, error = run_transcribe(
        mode,
        options_for(server),
        source(mode, pcm(1.5), delay=0.005),
        sample_rate=16_000,
        language="ar",
        segment_seconds=1.0,
        reconnect=FAST,
    )
    assert error is None
    assert [e.reason for e in events if isinstance(e, Reconnected)] == [reason]
    assert len(server.stt_conns) == 2


def test_never_reconnects_after_a_billing_close(server: MockServer, mode: str) -> None:
    server.stt.fail_after_segments = (1, "insufficient_balance")
    events, error = run_transcribe(
        mode,
        options_for(server),
        source(mode, pcm(3.0), delay=0.005),
        sample_rate=16_000,
        language="ar",
        segment_seconds=1.0,
        reconnect=FAST,
    )
    assert isinstance(error, InsufficientBalanceError)
    assert [t.text for t in transcripts(events)] == ["segment 1"]  # drained first
    assert isinstance(events[-1], StreamErrorEvent)
    assert len(server.stt_conns) == 1


def test_never_reconnects_after_a_protocol_close(server: MockServer, mode: str) -> None:
    closing: list[asyncio.Future[None]] = []

    def policy_close() -> None:
        closing.extend(asyncio.ensure_future(conn.close(1008, "invalid_message")) for conn in list(server._live))

    timer = threading.Timer(0.1, lambda: server.call(policy_close))
    timer.start()
    events, error = run_transcribe(
        mode,
        options_for(server),
        source(mode, pcm(2.0), delay=0.01),
        sample_rate=16_000,
        language="ar",
        segment_seconds=1.0,
        reconnect=FAST,
    )
    timer.join()
    assert isinstance(error, ProtocolError)
    assert error.close_code == 1008
    assert not any(isinstance(e, Reconnected) for e in events)
    assert len(server.stt_conns) == 1


def test_gives_up_after_max_attempts(server: MockServer, mode: str) -> None:
    server.stt.actions.extend(SttAction("abort", after_bytes=4_000) for _ in range(3))
    events, error = run_transcribe(
        mode,
        options_for(server),
        source(mode, pcm(3.0), delay=0.005),
        sample_rate=16_000,
        language="ar",
        segment_seconds=10.0,
        reconnect=ReconnectPolicy(max_attempts=2, initial_delay=0.01),
    )
    assert isinstance(error, StreamConnectionLostError)
    assert [e.attempt for e in events if isinstance(e, Reconnected)] == [1, 2]
    assert len(server.stt_conns) == 3


def test_server_max_duration_is_followed_by_a_new_session(server: MockServer, mode: str) -> None:
    server.stt.enforce_max_duration = 0.25
    audio = pcm(1.0)
    events, error = run_transcribe(
        mode,
        options_for(server),
        source(mode, audio, delay=0.05),  # 0.5 s of sending: outlives the first session
        sample_rate=16_000,
        language="ar",
        segment_seconds=5.0,
        reconnect=ReconnectPolicy(max_attempts=0, initial_delay=0.01),  # not counted as a failure
    )
    assert error is None
    reasons = [e.reason for e in events if isinstance(e, Reconnected)]
    assert reasons
    assert set(reasons) == {"max_duration"}
    # The open segment was dropped by the server uncharged; it is replayed into the next session.
    assert bytes(server.stt_conns[-1].audio).endswith(audio[-3_200:])


def test_sync_and_async_yield_the_same_events(server: MockServer) -> None:
    audio = pcm(2.5)
    outputs = []
    for mode in ("async", "sync"):
        events, error = run_transcribe(
            mode, options_for(server), source(mode, audio), sample_rate=16_000, language="ar", segment_seconds=1.0
        )
        assert error is None
        outputs.append([(type(e).__name__, getattr(e, "text", None), getattr(e, "index", None)) for e in events])
    assert outputs[0] == outputs[1]
    assert len(outputs[0]) == 3


def test_invalid_arguments_fail_before_connecting(server: MockServer, mode: str) -> None:
    from echonova import UsageError

    _, error = run_transcribe(mode, options_for(server), b"", sample_rate=16_000, language="ar", segment_seconds=0)
    assert isinstance(error, UsageError)
    _, error = run_transcribe(mode, options_for(server), b"", sample_rate=16_000.0, language="ar")
    assert isinstance(error, TypeError)
    assert server.attempts == []


def test_realtime_paces_sending_at_1x(server: MockServer, mode: str) -> None:
    audio = pcm(0.4)
    started = time.monotonic()
    events, error = run_transcribe(
        mode, options_for(server), source(mode, audio), sample_rate=16_000, language="ar", realtime=True
    )
    elapsed = time.monotonic() - started
    assert error is None
    assert elapsed >= 0.3  # a file is sent no faster than it would play
    assert bytes(server.stt_conns[0].audio) == audio
    assert len(transcripts(events)) == 1
