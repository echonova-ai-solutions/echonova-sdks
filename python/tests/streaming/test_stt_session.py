"""Speech to Text sessions against the mock server. Each test runs on the async and the sync session."""

from __future__ import annotations

import logging
import time

import pytest
from mock_server import MockServer, Rejection, SttAction
from stream_adapters import Bridge, open_stt
from stream_helpers import options_for, pcm

from echonova import (
    APITimeoutError,
    InsufficientBalanceError,
    InvalidRequestError,
    PermissionDeniedError,
    SessionEndedError,
    SpendingLimitError,
    StreamConnectionLostError,
    UpstreamError,
)
from echonova._streaming import (
    SessionEnded,
    SessionSummary,
    StreamErrorEvent,
    StreamOptions,
    TerminologySet,
    Transcript,
)
from echonova._streaming._pcm_framer import MAX_FRAME_BYTES


def wait_for(predicate: object, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():  # type: ignore[operator]
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        time.sleep(0.01)


def texts(events: list[object]) -> list[str]:
    return [e.text for e in events if isinstance(e, Transcript)]


def test_connect_waits_for_session_started(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    server.stt.started_delay = 0.2
    stt = open_stt(mode, opts, bridge, sample_rate=16_000, language="ar")
    try:
        assert stt.session_id == server.stt_conns[0].session_id
        assert stt.max_session_seconds == 1500
        assert stt.state == "open"
        assert server.stt_conns[0].query == {"sample_rate": "16000", "language": "ar", "encoding": "pcm_s16le"}
    finally:
        stt.close()


def test_transcribes_segments_and_stops(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    stt = open_stt(mode, opts, bridge, sample_rate=16_000, language="en")
    stt.send_audio(pcm(1.0))
    first = stt.end_segment()
    empty = stt.end_segment()
    stt.send_audio(pcm(0.02))  # 20 ms: too short for a transcript
    short = stt.end_segment()
    stt.send_audio(pcm(0.5))
    summary = stt.stop()
    events, error = stt.events()
    assert error is None
    assert (first.index, first.audio_offset_s, first.expect_result) == (0, 1.0, True)
    assert not empty.expect_result
    assert not short.expect_result
    assert texts(events) == ["segment 1", "segment 2"]
    assert [e.index for e in events if isinstance(e, Transcript)] == [0, 1]
    assert isinstance(events[-1], SessionEnded)
    assert summary == SessionSummary("stopped", 1.5, summary.credits_consumed, stt.session_id)
    assert stt.closed


def test_frames_are_split_to_fit_the_limit(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    stt = open_stt(mode, opts, bridge, sample_rate=48_000, language="ar")
    big = pcm(2.0, 48_000)  # 192 KB in one call
    stt.send_audio(big)
    stt.stop()
    assert bytes(server.stt_conns[0].audio) == big
    wait_for(lambda: server.stt_conns[0].close_code is not None)
    assert server.stt_conns[0].close_code == 1000  # never closed for a frame over 64 KiB
    assert MAX_FRAME_BYTES == 65_536


def test_terminology_at_connect_and_later(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    stt = open_stt(mode, opts, bridge, sample_rate=16_000, language="ar", terminology={"keywords": ["KYC"]})
    try:
        stt.send_audio(pcm(0.5))
        stt.end_segment()
        cleared = stt.set_terminology(None)
        assert cleared == TerminologySet(False)
        with pytest.raises(InvalidRequestError):
            stt.set_terminology({"keywords": "KYC"})
        stt.send_audio(pcm(0.5))
        stt.stop()
        events, _ = stt.events()
    finally:
        stt.close()
    transcripts = [e for e in events if isinstance(e, Transcript)]
    assert transcripts[0].terminology is not None
    assert transcripts[1].terminology is None
    received = server.stt_conns[0].received
    assert received[0] == {"type": "terminology", "terminology": {"keywords": ["KYC"]}}


def test_invalid_terminology_fails_connect(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    with pytest.raises(InvalidRequestError, match="keywords"):
        open_stt(mode, opts, bridge, sample_rate=16_000, language="ar", terminology={"keywords": "KYC"})
    wait_for(lambda: server.stt_conns[0].close_code is not None)
    assert server.stt_conns[0].close_code == 1000  # the SDK closed the half-configured session


def test_unreachable_speech_service_fails_connect(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    server.stt.upstream_unreachable = True
    with pytest.raises(UpstreamError) as info:
        open_stt(mode, opts, bridge, sample_rate=16_000, language="ar")
    assert info.value.error_message == "speech service unavailable"
    assert info.value.close_code == 1011


def test_handshake_rejection(server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None) -> None:
    server.rejections.append(Rejection(403, "This API key does not have access to Speech-to-Text services"))
    with pytest.raises(PermissionDeniedError):
        open_stt(mode, opts, bridge, sample_rate=16_000, language="ar")


@pytest.mark.parametrize(
    ("reason", "error"),
    [
        ("insufficient_balance", InsufficientBalanceError),
        ("spending_limit", SpendingLimitError),
        ("upstream_error", UpstreamError),
    ],
)
def test_fatal_end_drains_events_then_raises(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None, reason: str, error: type[Exception]
) -> None:
    server.stt.fail_after_segments = (2, reason)
    stt = open_stt(mode, opts, bridge, sample_rate=16_000, language="ar")
    for _ in range(3):
        try:
            stt.send_audio(pcm(0.5))
            stt.end_segment()
        except error:
            break
    events, raised = stt.events()
    assert texts(events) == ["segment 1", "segment 2"]  # paid for: never lost
    assert isinstance(events[-1], SessionEnded)
    assert events[-1].reason == reason
    assert isinstance(raised, error)
    with pytest.raises(error):
        stt.stop()


def test_segment_failure_is_a_non_fatal_event(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    server.stt.segment_errors = {1}
    stt = open_stt(mode, opts, bridge, sample_rate=16_000, language="ar")
    stt.send_audio(pcm(0.5))
    stt.end_segment()
    stt.send_audio(pcm(0.5))
    stt.stop()
    events, error = stt.events()
    assert error is None
    assert isinstance(events[0], StreamErrorEvent)
    assert events[0].code == "upstream_error"
    assert texts(events) == ["segment 2"]


def test_max_duration_is_a_normal_end(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    server.stt.enforce_max_duration = 0.2
    stt = open_stt(mode, opts, bridge, sample_rate=16_000, language="ar")
    stt.send_audio(pcm(0.5))
    events, error = stt.events()
    assert error is None
    assert isinstance(events[-1], SessionEnded)
    assert events[-1].reason == "max_duration"
    with pytest.raises(SessionEndedError, match="max_duration"):
        stt.send_audio(pcm(0.1))


def test_dropped_connection_drains_then_raises(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    server.stt.actions.append(SttAction("abort", after_bytes=20_000))
    stt = open_stt(mode, opts, bridge, sample_rate=16_000, language="ar")
    stt.send_audio(pcm(0.5))
    stt.end_segment()

    def keep_sending() -> None:
        for _ in range(20):
            stt.send_audio(pcm(0.1))
            time.sleep(0.01)

    with pytest.raises((StreamConnectionLostError, SessionEndedError)):
        keep_sending()
    events, raised = stt.events()
    assert texts(events) == ["segment 1"]
    assert isinstance(raised, StreamConnectionLostError)


def test_stop_timeout(server: MockServer, mode: str, bridge: Bridge | None) -> None:
    server.stt.drain_delay = 1.0
    stt = open_stt(mode, options_for(server), bridge, sample_rate=16_000, language="ar")
    stt.send_audio(pcm(0.2))
    with pytest.raises(APITimeoutError) as info:
        stt.stop(timeout=0.2)
    assert info.value.kind == "stop_drain"


def test_close_without_stop_warns(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None, caplog: pytest.LogCaptureFixture
) -> None:
    stt = open_stt(mode, opts, bridge, sample_rate=16_000, language="ar")
    stt.send_audio(pcm(0.2))
    with caplog.at_level(logging.WARNING, logger="echonova.streaming"):
        stt.close()
    assert "without stop()" in caplog.text
    with pytest.raises(SessionEndedError):
        stt.send_audio(pcm(0.1))


def test_feed_from(server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None) -> None:
    stt = open_stt(mode, opts, bridge, sample_rate=16_000, language="ar")
    chunks = [pcm(0.3)[:9_601], pcm(0.3)]  # odd-length chunk: one byte carried, then dropped at the end
    summary = stt.feed_from(chunks)
    events, error = stt.events()
    assert error is None
    assert summary.reason == "stopped"
    assert len(server.stt_conns[0].audio) == 9_600 + 9_600
    assert texts(events) == ["segment 1"]
