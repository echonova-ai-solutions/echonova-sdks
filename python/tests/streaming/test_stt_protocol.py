"""SttProtocol and SegmentPlan as pure state machines."""

from __future__ import annotations

from typing import Any

import pytest

from echonova import (
    InsufficientBalanceError,
    InvalidRequestError,
    SessionEndedError,
    SessionExpiredError,
    SpendingLimitError,
    StreamConnectionLostError,
    UpstreamError,
    UsageError,
)
from echonova._streaming import (
    SessionEnded,
    SessionSummary,
    StreamErrorEvent,
    TerminologySet,
    Transcript,
    UnknownEvent,
)
from echonova._streaming._errors import CloseInfo
from echonova._streaming._pcm_framer import MAX_FRAME_BYTES
from echonova._streaming._stt_protocol import SegmentPlan, SttProtocol

STARTED = {
    "type": "session.started",
    "sessionId": "s1",
    "language": "ar",
    "sampleRate": 16000,
    "maxSessionSeconds": 1500,
}


def started(sample_rate: int = 16_000) -> SttProtocol:
    p = SttProtocol(sample_rate)
    p.receive_event(STARTED, 5.0)
    return p


def transcript(text: str = "hi", **extra: Any) -> dict[str, Any]:
    return {
        "type": "transcript",
        "segmentId": "a" * 24,
        "text": text,
        "durationSeconds": 1.0,
        "creditsConsumed": 3.33,
        "isFinal": True,
        **extra,
    }


def test_session_started() -> None:
    p = started()
    assert (p.state, p.session_id, p.language, p.max_session_seconds, p.started_at) == ("open", "s1", "ar", 1500, 5.0)


def test_audio_is_framed_even_and_at_most_64_kib() -> None:
    p = started(48_000)
    frames = p.push_audio(b"\x00" * 300_001)
    assert all(len(f) % 2 == 0 and len(f) <= MAX_FRAME_BYTES for f in frames)
    flushed, mark = p.cut()
    assert sum(map(len, frames + flushed)) == 300_000  # the odd byte waits
    assert mark.audio_offset_s == pytest.approx(300_000 / 96_000)


def test_segment_marks() -> None:
    p = started()
    p.push_audio(b"\x00" * 32_000)
    _, first = p.cut()
    assert (first.index, first.audio_offset_s, first.duration_s, first.expect_result) == (0, 1.0, 1.0, True)
    _, empty = p.cut()
    assert (empty.index, empty.expect_result) == (1, False)
    p.push_audio(b"\x00" * 1_598)  # 49.9 ms
    _, short = p.cut()
    assert not short.expect_result
    p.push_audio(b"\x00" * 1_600)  # 50 ms
    _, enough = p.cut()
    assert enough.expect_result
    assert enough.audio_offset_s == pytest.approx((32_000 + 1_598 + 1_600) / 32_000)


def test_events_in_order() -> None:
    p = started()
    p.receive_event(transcript("  "), 6.0)
    p.receive_event({"type": "terminology.set", "active": True}, 6.0)
    p.receive_event({"type": "error", "code": "upstream_error", "message": "segment failed"}, 6.0)
    p.receive_event(transcript("two", terminology={"corrected": "TWO"}), 6.0)
    p.receive_event({"type": "mystery", "x": 1}, 6.0)
    p.receive_event({"type": "session.ended", "reason": "stopped", "totalSeconds": 2, "creditsConsumed": 6.7}, 6.0)
    events = list(p.events)
    assert [type(e) for e in events] == [
        Transcript,
        TerminologySet,
        StreamErrorEvent,
        Transcript,
        UnknownEvent,
        SessionEnded,
    ]
    first, _, error, second, *_ = events
    assert isinstance(first, Transcript)
    assert first.text == "  "
    assert isinstance(second, Transcript)
    assert (second.index, second.terminology, second.session_id) == (1, {"corrected": "TWO"}, "s1")
    assert isinstance(error, StreamErrorEvent)
    assert isinstance(error.error, UpstreamError)
    assert p.summary() == SessionSummary("stopped", 2.0, 6.7, "s1")


def test_terminology_reply_and_rejection() -> None:
    p = started()
    p.begin_terminology({"keywords": ["KYC"]})
    p.receive_event({"type": "terminology.set", "active": True}, 6.0)
    assert p.terminology_reply == TerminologySet(True)
    p.begin_terminology({"keywords": "nope"})
    p.receive_event({"type": "error", "code": "validation_failed", "message": "keywords must be a list"}, 6.0)
    assert isinstance(p.terminology_reply, InvalidRequestError)
    assert not any(isinstance(e, StreamErrorEvent) for e in p.events)  # it was the reply, not a stream event
    with pytest.raises(UsageError):
        p.begin_terminology({"keywords": ["x" * 70_000]})


def test_normal_stop() -> None:
    p = started()
    p.push_audio(b"\x00" * 101)
    frames, dropped = p.begin_stop()
    assert (sum(map(len, frames)), dropped) == (100, 1)
    with pytest.raises(SessionEndedError, match="stop"):
        p.push_audio(b"\x00\x00")
    p.receive_event({"type": "session.ended", "reason": "stopped", "totalSeconds": 0, "creditsConsumed": 0}, 7.0)
    p.connection_closed(CloseInfo(1000, "stopped"))
    assert p.fatal is None
    assert p.state == "closed"


@pytest.mark.parametrize(
    ("code", "reason", "error"),
    [(4002, "insufficient_balance", InsufficientBalanceError), (4029, "spending_limit", SpendingLimitError)],
)
def test_billing_close_after_session_ended_is_fatal_but_events_are_kept(
    code: int, reason: str, error: type[Exception]
) -> None:
    p = started()
    p.receive_event(transcript("paid for"), 6.0)
    p.receive_event({"type": "error", "code": reason, "message": reason.replace("_", " ")}, 6.0)
    p.receive_event({"type": "session.ended", "reason": reason, "totalSeconds": 1, "creditsConsumed": 3}, 6.0)
    p.connection_closed(CloseInfo(code, reason))
    assert isinstance(p.fatal, error)
    assert p.fatal.error_message == reason.replace("_", " ")  # type: ignore[attr-defined]
    assert isinstance(p.events[0], Transcript)  # drained before the error is raised
    with pytest.raises(error):
        p.push_audio(b"\x00\x00")


def test_max_duration_is_a_normal_end() -> None:
    p = started()
    p.receive_event({"type": "session.ended", "reason": "max_duration", "totalSeconds": 1, "creditsConsumed": 3}, 6.0)
    p.connection_closed(CloseInfo(4008, "max_duration"))
    assert p.fatal is None
    with pytest.raises(SessionEndedError, match="max_duration"):
        p.push_audio(b"\x00\x00")


def test_4008_without_session_ended_is_expired() -> None:
    p = started()
    p.connection_closed(CloseInfo(4008, "idle_timeout"))
    assert isinstance(p.fatal, SessionExpiredError)


def test_drop_is_connection_lost() -> None:
    p = started()
    p.connection_closed(CloseInfo(1006))
    assert isinstance(p.fatal, StreamConnectionLostError)


@pytest.mark.parametrize("close_code", [1011, 1000])
def test_session_ended_before_started_is_an_upstream_error(close_code: int) -> None:
    p = SttProtocol(16_000)
    p.receive_event({"type": "error", "code": "upstream_error", "message": "speech service unavailable"}, 1.0)
    p.receive_event({"type": "session.ended", "reason": "upstream_error", "totalSeconds": 0, "creditsConsumed": 0}, 1.0)
    p.connection_closed(CloseInfo(close_code, "upstream_error"))
    assert isinstance(p.fatal, UpstreamError)
    assert p.fatal.error_message == "speech service unavailable"
    assert p.fatal.close_code == close_code


def test_waiting_terminology_is_answered_by_a_close() -> None:
    p = started()
    p.begin_terminology(None)
    p.connection_closed(CloseInfo(1006))
    assert isinstance(p.terminology_reply, StreamConnectionLostError)


# --- SegmentPlan ------------------------------------------------------------------------------------


def test_plan_cuts_every_segment_across_chunks() -> None:
    plan = SegmentPlan(8_000, 1.0)  # 16,000 bytes per segment
    pieces = plan.split(b"\x00" * 10_000) + plan.split(b"\x00" * 10_000) + plan.split(b"\x00" * 13_000)
    assert [(len(p.data), p.cut) for p in pieces] == [
        (10_000, False),
        (6_000, True),
        (4_000, False),
        (12_000, True),
        (1_000, False),
    ]


def test_plan_keeps_samples_aligned() -> None:
    plan = SegmentPlan(8_000, 1.0)
    pieces = plan.split(b"\x01\x02\x03") + plan.split(b"\x04")
    assert b"".join(p.data for p in pieces) == b"\x01\x02\x03\x04"
    assert all(len(p.data) % 2 == 0 for p in pieces)
    plan.split(b"\x05")
    assert plan.finish() == 1


def test_plan_replays_only_uncut_audio_and_reports_dropped_segments() -> None:
    plan = SegmentPlan(8_000, 1.0)
    for piece in plan.split(b"A" * 16_000 + b"B" * 16_000 + b"C" * 3_000):
        plan.delivered(piece.data)
        if piece.cut:
            plan.cut(_session_mark(True))
    assert plan.replay() == b"C" * 3_000
    assert [m.index for m in plan.pending] == [0, 1]
    plan.result()  # segment 0 answered
    dropped = plan.take_dropped()
    assert [(m.index, m.audio_offset_s, m.duration_s) for m in dropped] == [(1, 2.0, 1.0)]
    assert plan.take_dropped() == ()


def test_plan_ignores_cuts_that_expect_no_result() -> None:
    plan = SegmentPlan(8_000, 1.0)
    mark = plan.cut(_session_mark(False))
    assert not mark.expect_result
    assert not plan.pending


def _session_mark(expect: bool) -> Any:
    from echonova._streaming import SegmentMark

    return SegmentMark(index=0, audio_offset_s=0.0, duration_s=0.0, expect_result=expect)


def test_plan_knows_when_the_final_segment_was_answered() -> None:
    plan = SegmentPlan(8_000, 1.0)
    plan.cut(_session_mark(True))
    plan.result()  # answers the cut
    assert not plan.tail_answered
    plan.result()  # a result beyond every cut: the final segment from stop()
    assert plan.tail_answered
    plan.new_session()
    assert not plan.tail_answered
