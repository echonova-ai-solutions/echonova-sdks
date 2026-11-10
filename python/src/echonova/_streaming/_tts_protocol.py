"""Text to Speech stream protocol (sans-IO).

A pure state machine: the drivers feed it user calls, inbound frames, socket
closes and clock ticks, and send whatever ``next_outbound()`` returns.

Correlation rules:
- The SDK generates every ``requestId``.
- Binary frames carry no ID. They belong to the synthesis whose ``start`` came
  last, and only while it is streaming; anything else is dropped and counted.
- ``start`` for a request ends every request sent before it (superseded).
- ``done`` and ``cancelled`` are matched by ID; duplicates and late frames for
  finished requests are ignored.
- ``cancel`` is only sent while a request is in flight on the current socket,
  and the SDK never depends on a reply to it: a cancel that is not
  acknowledged within ``cancel_ack_timeout`` is treated as done.

Billing: a synthesis is charged per character when it starts. One that stops
after its audio started (a cancel, a newer synthesis, or a speech service
failure) costs only the share of audio sent, at least 1 credit. ``cancelled``,
and ``error`` after audio started, carry that final ``creditsConsumed``; it is
absent from ``cancelled`` when the synthesis was cancelled before it was charged.

``charge_state`` is the SDK's conservative estimate: ``yes`` once ``start`` or
audio arrived, or the server reported a cost; ``unknown`` when a request was
sent but neither arrived; ``no`` when it was never sent, was rejected or failed
before any audio, or the server confirmed a cancel without a cost. A request in
the ``unknown`` state is never resent automatically, so it can't be paid for
twice, and neither is one the server reported a cost for.
"""

from __future__ import annotations

import logging
import uuid
from collections import OrderedDict, deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from ..errors import APIStatusError, APITimeoutError, EchoNovaError, SessionEndedError, StreamClosedError
from ._errors import FATAL_CLOSE_CODES, CloseInfo, attach_charge_state, close_error, error_from_frame
from ._link import encode_json
from ._types import (
    ChargeState,
    SynthesisMetrics,
    SynthesisOutcome,
    SynthesisResult,
    SynthesisState,
    UnknownEvent,
)

logger = logging.getLogger("echonova.streaming")

TERMINAL_STATES: frozenset[str] = frozenset({"completed", "cancelled", "superseded", "failed", "lost"})

# Keyword option -> wire field. Only options the caller set are sent: the server rejects unknown fields.
OPTION_FIELDS = {
    "speed": "speed",
    "cfg": "cfg",
    "num_steps": "numSteps",
    "tashkeel": "tashkeel",
    "normalize": "normalize",
}
MAX_RESENDS = 1
RECENT_LIMIT = 64


class SynthesisCore:
    """State of one synthesis request. Owned by ``TtsProtocol``; read by the handle classes."""

    def __init__(self, request_id: str, frame: dict[str, Any], frame_text: str, origin: str, now: float) -> None:
        self.request_id = request_id
        self.frame = frame
        self.frame_text = frame_text
        self.origin = origin  # "synthesize" or "queue"
        self.state: SynthesisState = "queued"
        self.chunks: deque[bytes] = deque()
        self.audio_bytes = 0
        self.frames = 0
        self.dropped_frames = 0
        self.sample_rate: int | None = None
        self.start_event: Mapping[str, Any] | None = None
        self.end_event: Mapping[str, Any] | None = None  # the done or cancelled frame that ended it
        self.credits_consumed: float | None = None  # the final cost, when the server reported it
        self.created_at = now
        self.sent_at: float | None = None
        self.started_at: float | None = None
        self.first_audio_at: float | None = None
        self.finished_at: float | None = None
        self.started = False  # start or audio arrived: the server is producing it
        self.sending = False  # handed to the driver; may be on the wire
        self.ever_sent = False
        self.cancel_reason: SynthesisOutcome | None = None
        self.cancel_requested_at: float | None = None
        self.cancel_sent = False
        self.timed_out = False
        self.supersedes: list[SynthesisCore] = []
        self.error: EchoNovaError | None = None
        self.charged: bool | None = None
        self.resends = 0
        self.conn_gen = -1
        self.send_seq = -1

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL_STATES

    @property
    def charge_state(self) -> ChargeState:
        """Whether this request has been charged: ``yes``, ``no`` or ``unknown``."""
        if self.terminal:
            if self.charged is None:
                return "unknown"
            return "yes" if self.charged else "no"
        if self.started:
            return "yes"
        return "unknown" if self.ever_sent else "no"

    @property
    def outcome(self) -> SynthesisOutcome | None:
        state = self.state
        if state == "completed" or state == "cancelled" or state == "superseded":
            return state
        return None

    def metrics(self) -> SynthesisMetrics:
        def since_sent(at: float | None) -> float | None:
            return at - self.sent_at if at is not None and self.sent_at is not None else None

        return SynthesisMetrics(
            ttfb=since_sent(self.first_audio_at),
            time_to_start=since_sent(self.started_at),
            total=since_sent(self.finished_at),
            audio_bytes=self.audio_bytes,
            frames=self.frames,
            dropped_frames=self.dropped_frames,
        )

    def result(self) -> SynthesisResult:
        outcome = self.outcome
        if outcome is None:
            raise RuntimeError("synthesis has not finished")  # callers check first
        end = self.end_event or {}
        return SynthesisResult(
            request_id=self.request_id,
            outcome=outcome,
            charged=self.charged,
            duration_seconds=_number(end.get("durationSeconds")),
            characters=_int(end.get("characters")),
            credits_consumed=self.credits_consumed,
            sample_rate=self.sample_rate,
            raw=self.end_event,
        )


@dataclass(frozen=True, slots=True)
class Outbound:
    kind: Literal["synthesize", "cancel"]
    core: SynthesisCore

    @property
    def text(self) -> str:
        return self.core.frame_text if self.kind == "synthesize" else '{"type":"cancel"}'


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _int(value: Any) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


class TtsProtocol:
    def __init__(
        self,
        *,
        voice_id: str,
        defaults: Mapping[str, Any] | None = None,
        start_timeout: float = 30.0,
        cancel_ack_timeout: float = 5.0,
        error_hold: float = 1.0,
        new_request_id: Callable[[], str] = lambda: str(uuid.uuid4()),
    ) -> None:
        self.voice_id = voice_id
        self.defaults = {k: v for k, v in (defaults or {}).items() if v is not None}
        self.start_timeout = start_timeout
        self.cancel_ack_timeout = cancel_ack_timeout
        self.error_hold = error_hold
        self._new_request_id = new_request_id
        self._pending: deque[Outbound] = deque()  # frames to send, in order
        self._queue: deque[SynthesisCore] = deque()  # enqueue() FIFO: sent one at a time
        self._in_flight: OrderedDict[str, SynthesisCore] = OrderedDict()  # sent and not finished, in send order
        self._recent: OrderedDict[str, SynthesisCore] = OrderedDict()
        self.active: SynthesisCore | None = None
        self._sending: SynthesisCore | None = None  # handed to the driver, not yet confirmed sent
        self._last_close: CloseInfo | None = None
        self.connected = False
        self.conn_gen = 0
        self._send_seq = 0
        self.fatal: EchoNovaError | None = None
        self.closed = False
        self.after_abnormal = False
        self.orphan_frames = 0
        self.interrupts = 0
        self.sample_rate: int | None = None  # from the latest start of a request this session tracks
        self.unknown_events: deque[UnknownEvent] = deque(maxlen=32)
        self._held_error: tuple[Mapping[str, Any], float] | None = None

    # --- User calls ----------------------------------------------------------------------------------

    def check_usable(self) -> None:
        if self.closed:
            raise SessionEndedError("the Text to Speech session is closed")
        if self.fatal is not None:
            raise SessionEndedError(f"the Text to Speech session failed: {self.fatal}") from self.fatal

    def new_core(self, text: str, options: Mapping[str, Any], *, origin: str, now: float) -> SynthesisCore:
        if not isinstance(text, str):
            raise TypeError("text must be a str")
        request_id = self._new_request_id()
        merged = {**self.defaults, **{k: v for k, v in options.items() if v is not None}}
        extra = merged.pop("extra_body", None) or {}
        voice_id = merged.pop("voice_id", None) or self.voice_id
        frame: dict[str, Any] = {"type": "synthesize", "requestId": request_id, "text": text, "voiceId": voice_id}
        for name, wire in OPTION_FIELDS.items():
            if merged.get(name) is not None:
                frame[wire] = merged[name]
        unknown = set(merged) - set(OPTION_FIELDS)
        if unknown:
            raise TypeError(f"unknown synthesis option(s): {', '.join(sorted(unknown))}")
        frame.update(extra)
        return SynthesisCore(request_id, frame, encode_json(frame), origin, now)

    def synthesize(self, text: str, options: Mapping[str, Any], now: float) -> SynthesisCore:
        """Start a synthesis now. Anything not yet sent is dropped; the running one is superseded."""
        self.check_usable()
        core = self.new_core(text, options, origin="synthesize", now=now)
        self._drop_unsent(now, outcome="superseded")
        for other in self._live_cores():
            if other.state in ("sent", "streaming", "queued"):
                other.state = "cancelling"
                other.cancel_reason = "superseded"
                core.supersedes.append(other)
        self._pending.append(Outbound("synthesize", core))
        return core

    def enqueue(self, text: str, options: Mapping[str, Any], now: float) -> SynthesisCore:
        """Add to the client FIFO. It is sent after everything before it has finished."""
        self.check_usable()
        core = self.new_core(text, options, origin="queue", now=now)
        self._queue.append(core)
        return core

    def cancel(self, core: SynthesisCore, now: float) -> None:
        if core.terminal or core.state == "cancelling":
            return
        if core.state == "queued" and not core.sending:
            self._remove_unsent(core)
            self._finish(core, "cancelled", charged=False, now=now)
            return
        core.state = "cancelling"
        core.cancel_reason = "cancelled"
        core.cancel_requested_at = now
        self._pending.append(Outbound("cancel", core))

    def cancel_active(self, now: float) -> None:
        """Cancel whatever is in flight. Does nothing (and sends nothing) when nothing is."""
        for core in self._live_cores():
            self.cancel(core, now)

    def interrupt(self, now: float) -> None:
        """Barge-in: cancel what is in flight and drop everything not yet sent."""
        self.interrupts += 1
        self._drop_unsent(now, outcome="cancelled")
        self.cancel_active(now)

    def close(self, now: float) -> None:
        """The user closed the session. In-flight requests end when the socket closes."""
        self.closed = True
        self._drop_unsent(now, outcome="cancelled")

    # --- Outbound ------------------------------------------------------------------------------------

    def next_outbound(self, now: float) -> Outbound | None:
        """The next frame to send, if any. The driver must call ``sent()`` or ``requeue()`` for it."""
        if self.fatal is not None:
            return None
        while self._pending:
            item = self._pending.popleft()
            core = item.core
            if item.kind == "synthesize":
                if core.state in ("queued", "cancelling") and not core.terminal and not core.ever_sent:
                    if core.state == "cancelling":  # cancelled before it was ever sent
                        self._finish(core, "cancelled", charged=False, now=now)
                        continue
                    core.sending = True
                    self._sending = core
                    return item
                continue
            # cancel: only for a request in flight on this socket, and only once
            if (
                self.connected
                and core.conn_gen == self.conn_gen
                and not core.cancel_sent
                and (core.state == "cancelling" or core.timed_out)
            ):
                core.cancel_sent = True
                return item
        if self._queue and not any(c.state in ("sent", "streaming") for c in self._in_flight.values()):
            core = self._queue.popleft()
            core.sending = True
            self._sending = core
            return Outbound("synthesize", core)
        return None

    def has_outbound(self) -> bool:
        return bool(self._pending) or (
            bool(self._queue) and not any(c.state in ("sent", "streaming") for c in self._in_flight.values())
        )

    def sent(self, item: Outbound, now: float) -> None:
        core = item.core
        if item.kind == "cancel":
            return
        core.sending = False
        if self._sending is core:
            self._sending = None
        core.ever_sent = True
        core.sent_at = now
        if not self.connected:  # the socket closed while this frame was being written
            info = self._last_close or CloseInfo(1006)
            error = close_error(info, may_have_executed=None) or StreamClosedError("the stream closed")
            attach_charge_state(error, "unknown")
            self._finish(core, "lost", error=error, charged=None, now=now)
            return
        core.conn_gen = self.conn_gen
        self._send_seq += 1
        core.send_seq = self._send_seq
        if core.state == "queued":
            core.state = "sent"
        self._in_flight[core.request_id] = core
        for other in core.supersedes:
            if other.state == "cancelling" and other.cancel_requested_at is None:
                other.cancel_requested_at = now

    def requeue(self, item: Outbound, now: float) -> None:
        """The frame could not be sent (the socket closed first). It will go out on the next socket."""
        core = item.core
        if item.kind == "cancel":
            core.cancel_sent = False
            return
        core.sending = False
        if self._sending is core:
            self._sending = None
        if core.state == "cancelling" or self.closed:
            self._finish(core, "cancelled", charged=False, now=now)
        elif core.state == "queued":
            self._pending.appendleft(item)

    def send_failed(self, item: Outbound, error: EchoNovaError, now: float) -> None:
        """No connection could be opened to send this request. It was never sent."""
        core = item.core
        core.sending = False
        if self._sending is core:
            self._sending = None
        if item.kind == "cancel" or core.terminal:
            return
        self._finish(core, "failed", error=attach_charge_state(error, "no"), charged=False, now=now)
        if isinstance(error, APIStatusError):  # the server refused the connection: the rest would fail too
            for other in self._unsent():
                self._remove_unsent(other)
                self._finish(other, "failed", error=error, charged=False, now=now)

    # --- Connection ----------------------------------------------------------------------------------

    def connection_opened(self, now: float) -> None:
        self.connected = True
        self.after_abnormal = False

    def connection_closed(self, info: CloseInfo, now: float) -> None:
        held = self._held_error[0] if self._held_error else None
        self._held_error = None
        self._last_close = info
        self.connected = False
        self.conn_gen += 1
        self.active = None
        self.after_abnormal = info.abnormal
        for core in self._in_flight_cores():
            core.sending = False
            if core.state == "cancelling" or (info.local and info.lost_reason is None):
                self._finish(core, core.cancel_reason or "cancelled", charged=True if core.started else None, now=now)
                continue
            error = close_error(info, last_error=held, may_have_executed=True if core.started else None)
            if error is None:  # pragma: no cover - close_error returns None only for local or STT-normal closes
                error = StreamClosedError("the stream closed", close_code=info.code, reason=info.reason or None)
            attach_charge_state(error, "yes" if core.started else "unknown")
            state: SynthesisState = "failed" if info.code in FATAL_CLOSE_CODES else "lost"
            self._finish(core, state, error=error, charged=True if core.started else None, now=now)
        if info.code in FATAL_CLOSE_CODES and not info.local and info.lost_reason is None:
            self.fatal = close_error(info, last_error=held)
            for core in self._unsent():
                self._remove_unsent(core)
                error = close_error(info, last_error=held)
                if error is not None:
                    attach_charge_state(error, "no")
                self._finish(core, "failed", error=error, charged=False, now=now)

    # --- Inbound -------------------------------------------------------------------------------------

    def receive_event(self, event: Mapping[str, Any], now: float) -> None:
        kind = event.get("type")
        if kind == "start":
            self._on_start(event, now)
        elif kind == "done":
            self._on_done(event, now)
        elif kind == "cancelled":
            self._on_cancelled(event, now)
        elif kind == "error":
            self._on_error(event, now)
        elif kind == "pong":
            pass
        else:
            self.unknown_events.append(UnknownEvent(dict(event)))
            logger.debug("ignoring unknown Text to Speech event type %r", kind)

    def receive_binary(self, data: bytes, now: float) -> None:
        core = self.active
        if core is not None and core.state == "streaming":
            if core.first_audio_at is None:
                core.first_audio_at = now
            core.chunks.append(data)
            core.audio_bytes += len(data)
            core.frames += 1
            return
        if core is not None:
            core.dropped_frames += 1
        self.orphan_frames += 1

    def _lookup(self, event: Mapping[str, Any]) -> SynthesisCore | None:
        rid = event.get("requestId")
        return self._in_flight.get(rid) if isinstance(rid, str) else None

    def _on_start(self, event: Mapping[str, Any], now: float) -> None:
        core = self._lookup(event)
        if core is None:
            self.active = None  # audio until the next start belongs to a request we no longer track
            return
        for other in self._in_flight_cores():
            if other is core:
                break
            outcome = other.cancel_reason if other.state == "cancelling" and other.cancel_reason else "superseded"
            self._finish(other, outcome, charged=True if other.started else None, now=now)
        core.started = True
        core.started_at = now
        core.start_event = dict(event)
        rate = event.get("sampleRate")
        if isinstance(rate, int) and not isinstance(rate, bool) and rate > 0:
            core.sample_rate = rate
            self.sample_rate = rate
        if core.state == "sent":
            core.state = "streaming"
        self.active = core

    def _on_done(self, event: Mapping[str, Any], now: float) -> None:
        core = self._lookup(event)
        if core is None:
            return
        core.end_event = dict(event)
        core.credits_consumed = _number(event.get("creditsConsumed"))
        if core.state == "cancelling":
            self._finish(core, core.cancel_reason or "cancelled", charged=True, now=now)
        else:
            self._finish(core, "completed", charged=True, now=now)

    def _on_cancelled(self, event: Mapping[str, Any], now: float) -> None:
        core = self._lookup(event)
        if core is None:
            return
        core.end_event = dict(event)
        core.credits_consumed = _number(event.get("creditsConsumed"))
        # No cost means it was cancelled before it was charged. Audio that had started was charged, though:
        # then a missing cost only means the server didn't report it.
        charged = core.credits_consumed is not None or core.started
        self._finish(core, core.cancel_reason or "cancelled", charged=charged, now=now)

    def _on_error(self, event: Mapping[str, Any], now: float) -> None:
        code = event.get("code")
        rid = event.get("requestId")
        if code in ("invalid_message", "frame_too_large"):
            self._held_error = (event, now)  # a policy close follows; it decides what fails
            return
        if isinstance(rid, str):
            core = self._in_flight.get(rid)
            if core is None:
                if rid not in self._recent:
                    self._held_error = (event, now)
                return
        else:
            candidates = self._in_flight_cores()
            if len(candidates) != 1:
                self._held_error = (event, now)
                return
            core = candidates[0]
        error = error_from_frame(event)
        credits = _number(event.get("creditsConsumed"))  # the final cost, when the synthesis was charged
        if credits is not None:
            core.credits_consumed = credits
        if code == "upstream_error":
            if core.state == "cancelling" and not core.started:
                self._finish(core, core.cancel_reason or "cancelled", charged=credits is not None, now=now)
            elif core.started or credits is not None:
                # Charged (audio already flowed, or the server reports a cost), so never resent; no done follows.
                charged_error = attach_charge_state(error, "yes", credits_consumed=credits)
                self._finish(core, "failed", error=charged_error, charged=True, now=now)
            elif core.resends < MAX_RESENDS:  # failed before any audio: the one case the SDK resends
                core.resends += 1
                self._in_flight.pop(core.request_id, None)
                core.state = "queued"
                core.sending = False
                core.ever_sent = False
                self._pending.appendleft(Outbound("synthesize", core))
                logger.info("resending a synthesis that failed before any audio")
            else:
                self._finish(core, "failed", error=attach_charge_state(error, "no"), charged=False, now=now)
            return
        charged = credits is not None
        attach_charge_state(error, "yes" if charged else "no", credits_consumed=credits)
        self._finish(core, "failed", error=error, charged=charged, now=now)
        if code == "validation_failed":
            # A rejected request may leave the running one going. The caller asked for it to stop,
            # so cancel it explicitly, unless a newer request is on its way (that one replaces it).
            newer_pending = any(item.kind == "synthesize" for item in self._pending)
            if core.send_seq == self._send_seq and not newer_pending:
                for other in core.supersedes:
                    if other.state == "cancelling" and not other.cancel_sent and other.conn_gen == self.conn_gen:
                        other.cancel_requested_at = now
                        self._pending.append(Outbound("cancel", other))

    # --- Clock ---------------------------------------------------------------------------------------

    def tick(self, now: float) -> None:
        for core in self._in_flight_cores():
            if core.state == "sent" and core.sent_at is not None and now - core.sent_at >= self.start_timeout:
                error = APITimeoutError(
                    f"no audio started within {self.start_timeout:g} s; the request may have been charged",
                    kind="read",
                    may_have_executed=None,
                )
                core.timed_out = True
                self._finish(core, "failed", error=attach_charge_state(error, "unknown"), charged=None, now=now)
                if self.connected:
                    self._pending.append(Outbound("cancel", core))
            elif (
                core.state == "cancelling"
                and core.cancel_requested_at is not None
                and now - core.cancel_requested_at >= self.cancel_ack_timeout
            ):
                charged = True if core.started else None
                self._finish(core, core.cancel_reason or "cancelled", charged=charged, now=now)
        if self._held_error is not None and now - self._held_error[1] >= self.error_hold:
            event = self._held_error[0]
            self._held_error = None
            logger.warning("unmatched Text to Speech error frame: %s", event.get("code"))

    def next_deadline(self) -> float | None:
        deadlines = []
        for core in self._in_flight.values():
            if core.state == "sent" and core.sent_at is not None:
                deadlines.append(core.sent_at + self.start_timeout)
            elif core.state == "cancelling" and core.cancel_requested_at is not None:
                deadlines.append(core.cancel_requested_at + self.cancel_ack_timeout)
        if self._held_error is not None:
            deadlines.append(self._held_error[1] + self.error_hold)
        return min(deadlines) if deadlines else None

    # --- Introspection -------------------------------------------------------------------------------

    @property
    def idle(self) -> bool:
        """Nothing in flight and nothing waiting to be sent."""
        return (
            not self._in_flight
            and self._sending is None
            and not self._queue
            and not any(i.kind == "synthesize" for i in self._pending)
        )

    @property
    def needs_connection(self) -> bool:
        """A request is waiting to be sent."""
        return self.fatal is None and self.has_outbound()

    def in_flight(self) -> list[SynthesisCore]:
        return list(self._in_flight.values())

    # --- Internals -----------------------------------------------------------------------------------

    def _in_flight_cores(self) -> list[SynthesisCore]:
        return list(self._in_flight.values())

    def _live_cores(self) -> list[SynthesisCore]:
        """In flight, plus the one being written right now."""
        cores = list(self._in_flight.values())
        if self._sending is not None and not self._sending.terminal:
            cores.append(self._sending)
        return cores

    def _unsent(self) -> list[SynthesisCore]:
        cores = [i.core for i in self._pending if i.kind == "synthesize" and i.core.state == "queued"]
        return cores + [c for c in self._queue if c.state == "queued"]

    def _remove_unsent(self, core: SynthesisCore) -> None:
        if core in self._queue:
            self._queue.remove(core)
        self._pending = deque(i for i in self._pending if not (i.kind == "synthesize" and i.core is core))

    def _drop_unsent(self, now: float, *, outcome: SynthesisOutcome) -> None:
        for core in self._unsent():
            if core.sending:
                continue
            self._remove_unsent(core)
            self._finish(core, outcome, charged=False, now=now)

    def _finish(
        self,
        core: SynthesisCore,
        state: SynthesisState,
        *,
        charged: bool | None,
        now: float,
        error: EchoNovaError | None = None,
    ) -> None:
        if core.terminal:
            return
        core.state = state
        core.charged = charged
        core.error = error
        core.finished_at = now
        core.sending = False
        self._in_flight.pop(core.request_id, None)
        if self.active is core:
            self.active = None
        self._recent[core.request_id] = core
        while len(self._recent) > RECENT_LIMIT:
            self._recent.popitem(last=False)


# --- Sentence splitting for speak_stream ----------------------------------------------------------

SENTENCE_MARKS = frozenset(".!?؟،؛\n")
MAX_SENTENCE_CHARS = 500


class SentenceSplitter:
    """Split streamed text into sentences of at most 500 characters.

    A sentence ends at ``. ! ? ؟ ، ؛`` followed by whitespace, or at a newline.
    Waiting for the whitespace keeps numbers like ``3.5`` whole. Pieces with no
    letters or digits are skipped, because they produce no speech.
    """

    def __init__(self, max_chars: int = MAX_SENTENCE_CHARS) -> None:
        self.max_chars = max_chars
        self._buffer = ""

    def push(self, delta: str) -> list[str]:
        self._buffer += delta
        out: list[str] = []
        start = 0
        text = self._buffer
        for i, ch in enumerate(text):
            if ch not in SENTENCE_MARKS:
                continue
            if ch == "\n" or (i + 1 < len(text) and text[i + 1].isspace()):
                out += self._emit(text[start : i + 1])
                start = i + 1
        self._buffer = text[start:]
        while len(self._buffer) > self.max_chars:
            piece, self._buffer = self._cut(self._buffer)
            out += self._emit(piece)
        return out

    def flush(self) -> list[str]:
        rest, self._buffer = self._buffer, ""
        return self._emit(rest)

    def _cut(self, text: str) -> tuple[str, str]:
        window = text[: self.max_chars + 1]
        at = max(window.rfind(" "), window.rfind("\t"))
        if at <= 0:
            at = self.max_chars
        return text[:at], text[at:]

    def _emit(self, piece: str) -> list[str]:
        out = []
        piece = piece.strip()
        while len(piece) > self.max_chars:
            head, piece = self._cut(piece)
            out.append(head.strip())
            piece = piece.strip()
        out.append(piece)
        return [p for p in out if any(ch.isalnum() for ch in p)]
