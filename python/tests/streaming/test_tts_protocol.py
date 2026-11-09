"""TtsProtocol as a pure state machine, driven with a fake clock."""

from __future__ import annotations

import itertools
import json
from typing import Any

import pytest

from echonova import (
    APITimeoutError,
    InsufficientBalanceError,
    InvalidRequestError,
    ProtocolError,
    ServerRestartingError,
    SessionEndedError,
    SessionExpiredError,
    StreamConnectionLostError,
    UpstreamError,
    UsageError,
    VoiceNotFoundError,
)
from echonova._streaming._errors import CloseInfo, charge_state_of
from echonova._streaming._tts_protocol import SentenceSplitter, SynthesisCore, TtsProtocol

T0 = 100.0


class Harness:
    """A protocol plus a fake wire: frames the driver would send, and helpers to answer as the server."""

    def __init__(self, **kwargs: Any) -> None:
        ids = (f"r{i}" for i in itertools.count(1))
        self.p = TtsProtocol(voice_id="v1", new_request_id=lambda: next(ids), **kwargs)
        self.now = T0
        self.wire: list[dict[str, Any]] = []
        self.p.connection_opened(self.now)

    def flush(self) -> list[dict[str, Any]]:
        """Send everything the protocol has queued; return the frames sent."""
        sent = []
        while (item := self.p.next_outbound(self.now)) is not None:
            frame = json.loads(item.text)
            sent.append(frame)
            self.p.sent(item, self.now)
        self.wire += sent
        return sent

    def synth(self, text: str = "hello", **options: Any) -> SynthesisCore:
        core = self.p.synthesize(text, options, self.now)
        return core

    def event(self, kind: str, **fields: Any) -> None:
        self.p.receive_event({"type": kind, **fields}, self.now)

    def start(self, rid: str, rate: int = 24_000) -> None:
        self.event("start", requestId=rid, sampleRate=rate, encoding="pcm_s16le", channels=1)

    def audio(self, n: int = 1) -> None:
        for _ in range(n):
            self.p.receive_binary(b"\x00\x01" * 10, self.now)

    def done(self, rid: str) -> None:
        self.event("done", requestId=rid, durationSeconds=1.5, characters=5, creditsConsumed=5)

    def tick(self, seconds: float) -> None:
        self.now += seconds
        self.p.tick(self.now)


def test_happy_path() -> None:
    h = Harness()
    core = h.synth("hello", speed=1.2)
    assert core.state == "queued"
    assert h.flush() == [{"type": "synthesize", "requestId": "r1", "text": "hello", "voiceId": "v1", "speed": 1.2}]
    assert core.state == "sent"
    h.now += 0.2
    h.start("r1", rate=22_050)
    h.now += 0.05
    h.audio(3)
    h.done("r1")
    assert core.state == "completed"
    assert core.sample_rate == 22_050
    assert len(core.chunks) == 3
    result = core.result()
    assert (result.outcome, result.charged, result.credits_consumed, result.characters) == ("completed", True, 5.0, 5)
    metrics = core.metrics()
    assert metrics.time_to_start == pytest.approx(0.2)
    assert metrics.ttfb == pytest.approx(0.25)
    assert metrics.frames == 3


def test_only_set_options_are_sent_and_defaults_merge() -> None:
    ids = iter(["a", "b"])
    p = TtsProtocol(voice_id="v1", defaults={"speed": 0.9, "normalize": None}, new_request_id=lambda: next(ids))
    p.connection_opened(T0)
    p.synthesize("x", {"num_steps": 32, "tashkeel": None, "voice_id": "v2"}, T0)
    item = p.next_outbound(T0)
    assert item is not None
    assert json.loads(item.text) == {
        "type": "synthesize",
        "requestId": "a",
        "text": "x",
        "voiceId": "v2",
        "speed": 0.9,
        "numSteps": 32,
    }
    with pytest.raises(TypeError, match="pitch"):
        p.synthesize("x", {"pitch": 2}, T0)


def test_oversized_frame_is_a_usage_error_and_nothing_is_queued() -> None:
    h = Harness()
    with pytest.raises(UsageError):
        h.synth("x", extra_body={"blob": "y" * 70_000})
    assert h.flush() == []


def test_supersede_with_cancelled_ack() -> None:
    h = Harness()
    a = h.synth("first")
    h.flush()
    h.start("r1")
    h.audio(2)
    b = h.synth("second")
    assert a.state == "cancelling"
    assert [f["type"] for f in h.flush()] == ["synthesize"]  # the server cancels A itself: no cancel frame
    h.audio(2)  # A's audio still in flight: dropped
    assert a.dropped_frames == 2
    assert len(a.chunks) == 2
    h.event("cancelled", requestId="r1", creditsConsumed=2)
    assert a.state == "superseded"
    result = a.result()
    assert (result.charged, result.credits_consumed) == (True, 2.0)  # only the share of audio sent
    h.start("r2")
    h.audio(1)
    assert len(b.chunks) == 1
    assert b.state == "streaming"


def test_supersede_without_cancelled_ack() -> None:
    h = Harness()
    a = h.synth("first")
    h.flush()
    h.start("r1")
    h.synth("second")
    h.flush()
    h.start("r2")  # a newer start ends A even without cancelled
    assert a.state == "superseded"
    assert a.charged is True  # it had started
    h.event("cancelled", requestId="r1")  # late: ignored
    assert a.state == "superseded"


def test_supersede_of_unstarted_request_is_charge_unknown() -> None:
    h = Harness()
    a = h.synth("first")
    h.flush()
    h.synth("second")
    h.flush()
    h.start("r2")
    assert a.state == "superseded"
    assert a.charge_state == "unknown"


def test_orphan_frames_are_dropped_and_counted() -> None:
    h = Harness()
    h.audio(2)  # nothing started
    a = h.synth()
    h.flush()
    h.start("r1")
    h.done("r1")
    h.audio(1)  # after done
    h.start("zzz")  # a start for something we never sent
    h.audio(1)
    assert h.p.orphan_frames == 4
    assert len(a.chunks) == 0


def test_duplicate_and_unknown_done_are_ignored() -> None:
    h = Harness()
    a = h.synth()
    h.flush()
    h.start("r1")
    h.done("r1")
    h.done("r1")
    h.event("cancelled", requestId="r1")
    h.done("unknown")
    assert a.state == "completed"


def test_never_sends_cancel_when_nothing_is_in_flight() -> None:
    h = Harness()
    h.p.cancel_active(h.now)
    h.p.interrupt(h.now)
    assert h.flush() == []
    a = h.synth()
    h.flush()
    h.start("r1")
    h.done("r1")
    h.p.cancel(a, h.now)  # finished: nothing to cancel
    h.p.cancel_active(h.now)
    assert h.flush() == []


def test_cancelling_a_queued_request_drops_it_locally() -> None:
    h = Harness()
    a = h.synth()
    h.p.cancel(a, h.now)
    assert a.state == "cancelled"
    assert a.charged is False
    assert h.flush() == []


def test_cancel_in_flight_sends_one_cancel_and_waits_for_the_ack() -> None:
    h = Harness()
    a = h.synth()
    h.flush()
    h.start("r1")
    h.p.cancel(a, h.now)
    h.p.cancel(a, h.now)
    assert h.flush() == [{"type": "cancel"}]
    h.event("cancelled", requestId="r1", creditsConsumed=1)
    assert a.state == "cancelled"
    result = a.result()
    assert (result.outcome, result.charged, result.credits_consumed) == ("cancelled", True, 1.0)
    assert result.raw == {"type": "cancelled", "requestId": "r1", "creditsConsumed": 1}
    assert (result.duration_seconds, result.characters) == (None, None)  # only done carries them
    assert a.charge_state == "yes"


def test_cancelled_without_a_cost_was_not_charged() -> None:
    h = Harness()
    a = h.synth()
    h.flush()
    h.p.cancel(a, h.now)
    h.flush()
    h.event("cancelled", requestId="r1")  # cancelled before it was charged
    result = a.result()
    assert (result.outcome, result.charged, result.credits_consumed) == ("cancelled", False, None)
    assert a.charge_state == "no"


def test_cancelled_without_a_cost_after_audio_started_still_counts_as_charged() -> None:
    h = Harness()
    a = h.synth()
    h.flush()
    h.start("r1")
    h.audio(1)
    h.p.cancel(a, h.now)
    h.flush()
    h.event("cancelled", requestId="r1")  # a server that doesn't report the cost
    result = a.result()
    assert (result.charged, result.credits_consumed) == (True, None)
    assert a.charge_state == "yes"


def test_superseded_without_a_cost_before_start_was_not_charged() -> None:
    h = Harness()
    a = h.synth("first")
    h.flush()
    b = h.synth("second")
    h.flush()
    h.event("cancelled", requestId="r1")
    h.start("r2")
    assert (a.state, a.charged, a.charge_state) == ("superseded", False, "no")
    assert b.state == "streaming"


@pytest.mark.parametrize(("started", "charged"), [(True, True), (False, None)])
def test_cancel_ack_times_out_after_5_s(started: bool, charged: bool | None) -> None:
    h = Harness()
    a = h.synth()
    h.flush()
    if started:
        h.start("r1")
    h.p.cancel(a, h.now)
    h.flush()
    assert h.p.next_deadline() == pytest.approx(h.now + 5.0)
    h.tick(4.9)
    assert a.state == "cancelling"
    h.tick(0.2)
    assert a.state == "cancelled"
    assert a.charged is charged


def test_no_start_within_30_s_is_a_timeout_and_the_request_is_cancelled() -> None:
    h = Harness()
    a = h.synth()
    h.flush()
    h.tick(29.0)
    assert a.state == "sent"
    h.tick(1.0)
    assert a.state == "failed"
    assert isinstance(a.error, APITimeoutError)
    assert a.charge_state == "unknown"
    assert h.flush() == [{"type": "cancel"}]
    h.event("cancelled", requestId="r1")  # late ack: ignored


def test_charge_state_when_the_connection_drops() -> None:
    h = Harness()
    started = h.synth("a")
    h.flush()
    h.start("r1")
    queued = h.p.enqueue("b", {}, h.now)
    h.p.connection_closed(CloseInfo(1006), h.now)
    assert started.state == "lost"
    assert isinstance(started.error, StreamConnectionLostError)
    assert started.charge_state == "yes"
    assert charge_state_of(started.error) == "yes"
    assert started.error.may_have_executed is True
    assert queued.state == "queued"  # never sent: survives the reconnect
    assert queued.charge_state == "no"
    assert h.p.after_abnormal


def test_sent_but_unstarted_request_is_lost_not_resent() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.p.connection_closed(CloseInfo(1006), h.now)
    assert a.state == "lost"
    assert a.charge_state == "unknown"
    h.p.connection_opened(h.now)
    assert h.flush() == []  # probably charged: never sent again automatically


def test_pre_audio_upstream_error_is_resent_once() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.event("error", code="upstream_error", message="could not synthesize this text", requestId="r1")
    assert a.state == "queued"
    assert a.charge_state == "no"  # failed before any audio: counted as not charged
    assert [f["requestId"] for f in h.flush()] == ["r1"]
    h.event("error", code="upstream_error", message="could not synthesize this text", requestId="r1")
    assert a.state == "failed"
    assert isinstance(a.error, UpstreamError)
    assert a.charge_state == "no"
    assert h.flush() == []


def test_mid_stream_upstream_error_fails_and_is_charged() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.start("r1")
    h.audio(1)
    h.event("error", code="upstream_error", message="stopped during this synthesis", requestId="r1")
    assert a.state == "failed"
    assert a.charge_state == "yes"
    assert a.error is not None
    assert a.error.credits_consumed is None  # this server did not report the cost
    assert len(a.chunks) == 1  # audio already received is kept
    assert h.flush() == []


def test_mid_stream_upstream_error_reports_the_final_cost() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.start("r1")
    h.audio(1)
    h.event("error", code="upstream_error", message="stopped", requestId="r1", creditsConsumed=3)
    assert (a.state, a.charged, a.credits_consumed) == ("failed", True, 3.0)
    assert isinstance(a.error, UpstreamError)
    assert (a.error.charge_state, a.error.credits_consumed) == ("yes", 3.0)
    assert charge_state_of(a.error) == "yes"
    assert h.flush() == []  # charged: never resent


def test_upstream_error_with_a_cost_is_never_resent() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.event("error", code="upstream_error", message="stopped", requestId="r1", creditsConsumed=1)
    assert a.state == "failed"
    assert a.resends == 0
    assert a.charge_state == "yes"
    assert h.flush() == []


def test_upstream_error_on_a_cancelling_request_ends_it_as_cancelled() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.p.cancel(a, h.now)
    h.flush()
    h.event("error", code="upstream_error", message="stopped", requestId="r1", creditsConsumed=1)
    result = a.result()
    assert (result.outcome, result.charged, result.credits_consumed) == ("cancelled", True, 1.0)


def test_rejected_request_leaves_the_running_one_and_the_sdk_cancels_it() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.start("r1")
    b = h.synth("")
    h.flush()
    h.event("error", code="validation_failed", message="text must be 1 to 500 characters", requestId="r2")
    assert b.state == "failed"
    assert isinstance(b.error, InvalidRequestError)
    assert b.charge_state == "no"
    assert h.flush() == [{"type": "cancel"}]  # the caller asked for A to stop
    h.event("cancelled", requestId="r1")
    assert a.state == "superseded"


def test_rejected_request_does_not_cancel_when_a_newer_one_is_pending() -> None:
    h = Harness()
    h.synth("a")
    h.flush()
    h.start("r1")
    h.synth("")
    h.flush()
    h.synth("c")  # pending, will replace A on the server
    h.event("error", code="validation_failed", message="bad", requestId="r2")
    assert [f["type"] for f in h.flush()] == ["synthesize"]


def test_voice_not_found_fails_the_new_request() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.start("r1")
    b = h.synth("b", voice_id="missing")
    h.flush()
    h.event("cancelled", requestId="r1")
    h.event("error", code="voice_not_found", message="Voice not found", requestId="r2")
    assert a.state == "superseded"
    assert isinstance(b.error, VoiceNotFoundError)


def test_error_without_request_id_goes_to_the_only_request_in_flight() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.event("error", code="upstream_error", message="x")
    assert a.state == "queued"  # resent
    assert a.resends == 1


def test_unattributable_error_is_attached_to_the_next_close() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.event("error", code="invalid_message", message="frame is not valid JSON")
    assert a.state == "sent"
    h.p.connection_closed(CloseInfo(1008, "invalid_message"), h.now)
    assert isinstance(a.error, ProtocolError)
    assert a.error.error_message == "frame is not valid JSON"
    assert isinstance(h.p.fatal, ProtocolError)
    with pytest.raises(SessionEndedError):
        h.synth("again")


def test_held_error_expires_after_1_s() -> None:
    h = Harness()
    h.event("error", code="invalid_message", message="x")
    assert h.p.next_deadline() == pytest.approx(h.now + 1.0)
    h.tick(1.0)
    assert h.p.next_deadline() is None


def test_billing_close_fails_everything() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.start("r1")
    queued = h.p.enqueue("b", {}, h.now)
    h.p.connection_closed(CloseInfo(4002, "insufficient_balance"), h.now)
    assert isinstance(a.error, InsufficientBalanceError)
    assert a.state == "failed"
    assert isinstance(queued.error, InsufficientBalanceError)
    assert queued.charge_state == "no"
    assert h.p.next_outbound(h.now) is None


def test_session_expiry_and_restart_closes_are_lazy_reconnects() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.p.connection_closed(CloseInfo(4008, "max_duration"), h.now)
    assert isinstance(a.error, SessionExpiredError)
    assert h.p.fatal is None
    assert not h.p.after_abnormal
    h.p.connection_opened(h.now)
    b = h.synth("b")
    h.flush()
    h.p.connection_closed(CloseInfo(1001, "server_restarting"), h.now)
    assert isinstance(b.error, ServerRestartingError)
    assert h.p.after_abnormal


def test_local_close_ends_in_flight_requests_as_cancelled() -> None:
    h = Harness()
    a = h.synth("a")
    h.flush()
    h.start("r1")
    queued = h.p.enqueue("b", {}, h.now)
    h.p.close(h.now)
    assert queued.state == "cancelled"
    h.p.connection_closed(CloseInfo(1000, local=True), h.now)
    assert a.state == "cancelled"
    assert a.charged is True


def test_enqueue_sends_the_next_only_after_done() -> None:
    h = Harness()
    a = h.p.enqueue("a", {}, h.now)
    b = h.p.enqueue("b", {}, h.now)
    assert [f["text"] for f in h.flush()] == ["a"]
    h.start("r1")
    assert h.flush() == []
    h.done("r1")
    assert [f["text"] for f in h.flush()] == ["b"]
    assert a.state == "completed"
    assert b.state == "sent"


def test_synthesize_clears_the_queue() -> None:
    h = Harness()
    a = h.p.enqueue("a", {}, h.now)
    h.flush()
    b = h.p.enqueue("b", {}, h.now)
    c = h.synth("c")
    assert b.state == "superseded"
    assert b.charged is False
    assert a.state == "cancelling"
    assert [f["text"] for f in h.flush()] == ["c"]
    assert c.state == "sent"


def test_interrupt_cancels_and_drops_the_queue() -> None:
    h = Harness()
    a = h.p.enqueue("a", {}, h.now)
    b = h.p.enqueue("b", {}, h.now)
    h.flush()
    h.start("r1")
    h.p.interrupt(h.now)
    assert b.state == "cancelled"
    assert h.flush() == [{"type": "cancel"}]
    h.event("cancelled", requestId="r1")
    assert a.state == "cancelled"
    assert h.p.idle


def test_cancel_during_send_is_sent_after_the_request() -> None:
    h = Harness()
    a = h.synth("a")
    item = h.p.next_outbound(h.now)  # the driver is writing it...
    assert item is not None
    h.p.cancel(a, h.now)  # ...when the caller cancels
    h.p.sent(item, h.now)
    assert a.state == "cancelling"
    assert h.flush() == [{"type": "cancel"}]


def test_request_written_while_the_socket_closed_is_lost() -> None:
    h = Harness()
    a = h.synth("a")
    item = h.p.next_outbound(h.now)
    assert item is not None
    h.p.connection_closed(CloseInfo(1006), h.now)
    h.p.sent(item, h.now)
    assert a.state == "lost"
    assert a.charge_state == "unknown"


def test_requeue_sends_it_on_the_next_socket() -> None:
    h = Harness()
    a = h.synth("a")
    item = h.p.next_outbound(h.now)
    assert item is not None
    h.p.connection_closed(CloseInfo(1006), h.now)
    h.p.requeue(item, h.now)
    h.p.connection_opened(h.now)
    assert [f["requestId"] for f in h.flush()] == ["r1"]
    assert a.state == "sent"


def test_unknown_events_are_kept() -> None:
    h = Harness()
    h.event("brand.new", x=1)
    assert h.p.unknown_events[0].type == "brand.new"


# --- Sentence splitting -----------------------------------------------------------------------------


def test_sentence_splitter_marks() -> None:
    splitter = SentenceSplitter()
    text = "Hello there. It costs 3.5 dollars! Really? مرحبا، كيف حالك؟ تمام؛ شكرا\nnext line"
    assert splitter.push(text) + splitter.flush() == [
        "Hello there.",
        "It costs 3.5 dollars!",
        "Really?",
        "مرحبا،",
        "كيف حالك؟",
        "تمام؛",
        "شكرا",
        "next line",
    ]


def test_sentence_splitter_streams_deltas() -> None:
    splitter = SentenceSplitter()
    out = []
    for delta in ["Hel", "lo.", " How a", "re you", "? Fine", "..."]:
        out += splitter.push(delta)
    assert out == ["Hello.", "How are you?"]
    assert splitter.flush() == ["Fine..."]


def test_sentence_splitter_caps_length_and_skips_punctuation() -> None:
    splitter = SentenceSplitter(max_chars=500)
    long = ("word " * 150).strip() + "."
    pieces = splitter.push(long + " ... ") + splitter.flush()
    assert all(len(p) <= 500 for p in pieces)
    assert " ".join(pieces).split() == long.split()
    assert SentenceSplitter().push("! ? ") == []
    unbroken = "x" * 1200
    assert [len(p) for p in SentenceSplitter().push(unbroken)] == [500, 500]
