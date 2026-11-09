"""Speech to Text stream protocol (sans-IO).

``SttProtocol`` tracks one session: frames to send, events received, and how
the session ended. ``SegmentPlan`` is the bookkeeping ``transcribe_stream``
needs on top: where to cut segments, which audio is not yet cut (and so can be
replayed after a reconnect), and which cut segments are still waiting for a
result.
"""

from __future__ import annotations

import logging
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from ..errors import (
    APIStatusError,
    EchoNovaError,
    InsufficientBalanceError,
    SessionEndedError,
    SpendingLimitError,
    StreamClosedError,
    UpstreamError,
)
from ._errors import CloseInfo, close_error, error_from_frame
from ._link import encode_json
from ._pcm_framer import BYTES_PER_SAMPLE, PcmFramer
from ._types import (
    SegmentMark,
    SessionEnded,
    SessionSaved,
    SessionSummary,
    StreamErrorEvent,
    SttEvent,
    TerminologySet,
    Transcript,
    UnknownEvent,
)

logger = logging.getLogger("echonova.streaming")

SttState = Literal["await_started", "open", "stopping", "ended", "closed", "failed"]
MIN_RESULT_SECONDS = 0.05  # the SDK expects no transcript for shorter segments


def _number(value: Any, default: float = 0.0) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


class SttProtocol:
    def __init__(self, sample_rate: int, *, frame_ms: int = 100) -> None:
        self.sample_rate = sample_rate
        self.framer = PcmFramer(sample_rate, frame_ms=frame_ms)
        self.state: SttState = "await_started"
        self.events: deque[SttEvent] = deque()
        self.started = False
        self.started_at: float | None = None
        self.session_id: str | None = None
        self.job_id: str | None = None  # from session.started: the ID the job gets once it is saved
        self.language: str | None = None
        self.server_sample_rate: int | None = None
        self.max_session_seconds: float | None = None
        self.ended: SessionEnded | None = None
        self.saved: SessionSaved | None = None
        self.fatal: EchoNovaError | None = None
        self.closed = False
        self.close_info: CloseInfo | None = None
        self.stop_requested = False
        self.transcripts = 0
        self.terminology_waiting = False
        self.terminology_reply: TerminologySet | EchoNovaError | None = None
        self._last_error: Mapping[str, Any] | None = None
        self._segment_index = 0
        self._segment_start = 0

    # --- Outbound ------------------------------------------------------------------------------------

    def check_sendable(self) -> None:
        if self.fatal is not None:
            raise self.fatal
        if self.closed or self.ended is not None:
            reason = f" ({self.ended.reason})" if self.ended is not None else ""
            raise SessionEndedError(f"the Speech to Text session has ended{reason}")
        if self.stop_requested:
            raise SessionEndedError("stop() was called; this session takes no more audio")

    def push_audio(self, data: bytes | bytearray | memoryview) -> list[bytes]:
        """Frames ready to send for this audio (about 100 ms each, even-length, at most 64 KiB)."""
        self.check_sendable()
        return self.framer.push(data)

    def cut(self) -> tuple[list[bytes], SegmentMark]:
        """End the current segment: the frames to flush first, and where the cut falls."""
        self.check_sendable()
        frames = self.framer.flush()
        segment_bytes = self.framer.bytes_emitted - self._segment_start
        mark = SegmentMark(
            index=self._segment_index,
            audio_offset_s=self.framer.seconds_emitted,
            duration_s=segment_bytes / (self.sample_rate * BYTES_PER_SAMPLE),
            expect_result=segment_bytes >= self.min_result_bytes,
        )
        self._segment_start = self.framer.bytes_emitted
        self._segment_index += 1
        return frames, mark

    @property
    def min_result_bytes(self) -> int:
        return int(self.sample_rate * MIN_RESULT_SECONDS) * BYTES_PER_SAMPLE

    def begin_stop(self) -> tuple[list[bytes], int]:
        """The last frames before ``stop``, and how many odd trailing bytes were dropped."""
        self.check_sendable()
        frames, dropped = self.framer.finish()
        self.stop_requested = True
        if self.state == "open":
            self.state = "stopping"
        return frames, dropped

    def begin_terminology(self, terminology: Mapping[str, Any] | None) -> str:
        self.check_sendable()
        text = encode_json({"type": "terminology", "terminology": dict(terminology) if terminology else None})
        self.terminology_waiting = True
        self.terminology_reply = None
        return text

    # --- Inbound -------------------------------------------------------------------------------------

    def receive_event(self, event: Mapping[str, Any], now: float) -> None:
        kind = event.get("type")
        if kind == "session.started":
            if not self.started:
                self.started = True
                self.started_at = now
                self.session_id = _str(event.get("sessionId"))
                self.job_id = _str(event.get("jobId"))
                self.language = _str(event.get("language"))
                rate = event.get("sampleRate")
                self.server_sample_rate = rate if isinstance(rate, int) and not isinstance(rate, bool) else None
                limit = event.get("maxSessionSeconds")
                self.max_session_seconds = _number(limit) if _number(limit, -1) > 0 else None
                if self.state == "await_started":
                    self.state = "stopping" if self.stop_requested else "open"
        elif kind == "transcript":
            terminology = event.get("terminology")
            self.events.append(
                Transcript(
                    segment_id=_str(event.get("segmentId")) or "",
                    text=_str(event.get("text")) or "",
                    duration_seconds=_number(event.get("durationSeconds")),
                    credits_consumed=_number(event.get("creditsConsumed")),
                    index=self.transcripts,
                    terminology=dict(terminology) if isinstance(terminology, dict) else None,
                    language=_str(event.get("language")),
                    session_id=self.session_id,
                    raw=dict(event),
                )
            )
            self.transcripts += 1
        elif kind == "terminology.set":
            reply = TerminologySet(active=bool(event.get("active")), raw=dict(event))
            self.events.append(reply)
            if self.terminology_waiting:
                self.terminology_waiting = False
                self.terminology_reply = reply
        elif kind == "session.ended":
            ended = SessionEnded(
                reason=_str(event.get("reason")) or "unknown",
                total_seconds=_number(event.get("totalSeconds")),
                credits_consumed=_number(event.get("creditsConsumed")),
                raw=dict(event),
            )
            self.ended = ended
            self.events.append(ended)
            self.state = "ended"
        elif kind == "session.saved":
            if self.saved is None:
                saved = SessionSaved(
                    job_id=_str(event.get("jobId")) or self.job_id or "",
                    status=_str(event.get("status")) or "unknown",
                    session_id=self.session_id,
                    raw=dict(event),
                )
                self.saved = saved
                self.events.append(saved)
        elif kind == "error":
            error = error_from_frame(event, session_id=self.session_id)
            self._last_error = dict(event)
            if event.get("code") == "validation_failed" and self.terminology_waiting:
                self.terminology_waiting = False
                self.terminology_reply = error
                return
            self.events.append(
                StreamErrorEvent(
                    code=_str(event.get("code")) or "",
                    message=_str(event.get("message")) or "",
                    error=error,
                    raw=dict(event),
                )
            )
        elif kind == "pong":
            pass
        else:
            self.events.append(UnknownEvent(dict(event)))

    def receive_binary(self, data: bytes) -> None:
        logger.debug("ignoring a %d-byte binary frame on a Speech to Text stream", len(data))

    def connection_closed(self, info: CloseInfo) -> None:
        self.closed = True
        self.close_info = info
        error = close_error(
            info,
            ended_normally=self.ended is not None,
            last_error=self._last_error,
            session_id=self.session_id,
            may_have_executed=None,
        )
        if error is None and not self.started and not info.local:
            error = self._start_failure(info)
        if error is not None:
            self.fatal = error
            self.state = "failed"
        else:
            self.state = "closed"
        if self.terminology_waiting:
            self.terminology_waiting = False
            self.terminology_reply = error or SessionEndedError("the session closed before terminology was set")

    def _start_failure(self, info: CloseInfo) -> EchoNovaError:
        """The session ended before ``session.started``."""
        reason = self.ended.reason if self.ended is not None else None
        last = self._last_error or {}
        message = _str(last.get("message"))
        kwargs: dict[str, Any] = {
            "error_message": message,
            "error_code": _str(last.get("code")) or reason,
            "close_code": info.code,
            "transport": "websocket",
        }
        error_class: type[APIStatusError] | None = {
            "upstream_error": UpstreamError,
            "insufficient_balance": InsufficientBalanceError,
            "spending_limit": SpendingLimitError,
        }.get(reason or _str(last.get("code")) or "")
        if error_class is not None:
            kwargs["error_message"] = message or f"the session ended before it started ({reason})"
            return error_class(**kwargs)
        return StreamClosedError(
            f"the Speech to Text session ended before it started ({reason or info.code})",
            close_code=info.code,
            reason=info.reason or None,
        )

    def summary(self) -> SessionSummary | None:
        if self.ended is None:
            return None
        saved = self.saved
        return SessionSummary(
            reason=self.ended.reason,
            total_seconds=self.ended.total_seconds,
            credits_consumed=self.ended.credits_consumed,
            session_id=self.session_id,
            job_id=(saved.job_id or None) if saved is not None else None,
            saved_status=saved.status if saved is not None else None,
        )


# --- transcribe_stream bookkeeping -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Piece:
    data: bytes
    cut: bool  # end the segment after this piece


class SegmentPlan:
    """Cuts every ``segment_seconds`` of audio and tracks what a reconnect must replay.

    Audio is kept sample-aligned: an odd trailing byte waits for the next chunk.
    Offsets in the marks it returns count audio from the start of the stream,
    across sessions.
    """

    def __init__(self, sample_rate: int, segment_seconds: float) -> None:
        if segment_seconds <= 0:
            raise ValueError("segment_seconds must be positive")
        self.sample_rate = sample_rate
        self.segment_bytes = max(BYTES_PER_SAMPLE, int(sample_rate * segment_seconds) * BYTES_PER_SAMPLE)
        self.uncut = bytearray()  # sent (or being sent) since the last cut
        self.pending: deque[SegmentMark] = deque()  # cut, waiting for a result
        self._carry = b""
        self._fill = 0  # planned bytes in the current segment
        self._cut_offset = 0  # stream offset (bytes) of the last cut
        self._cuts = 0
        self.tail_answered = False

    def split(self, chunk: bytes | bytearray | memoryview) -> list[Piece]:
        data = self._carry + bytes(chunk)
        if len(data) % 2:
            self._carry, data = data[-1:], data[:-1]
        else:
            self._carry = b""
        pieces = []
        while data:
            room = self.segment_bytes - self._fill
            piece, data = data[:room], data[room:]
            self._fill += len(piece)
            cut = self._fill >= self.segment_bytes
            if cut:
                self._fill = 0
            pieces.append(Piece(piece, cut))
        return pieces

    def delivered(self, data: bytes) -> None:
        self.uncut += data

    def cut(self, session_mark: SegmentMark) -> SegmentMark:
        """Record a cut (after the uncut audio was sent). Returns the mark in stream terms."""
        end = self._cut_offset + len(self.uncut)
        mark = SegmentMark(
            index=self._cuts,
            audio_offset_s=end / (self.sample_rate * BYTES_PER_SAMPLE),
            duration_s=len(self.uncut) / (self.sample_rate * BYTES_PER_SAMPLE),
            expect_result=session_mark.expect_result,
        )
        self._cuts += 1
        self._cut_offset = end
        self.uncut.clear()
        self._fill = 0
        if mark.expect_result:
            self.pending.append(mark)
        return mark

    def result(self) -> None:
        """A transcript (or a per-segment error) arrived: it answers the oldest pending cut."""
        if self.pending:
            self.pending.popleft()
        else:
            self.tail_answered = True  # a result for audio this plan never cut (the final segment)

    def new_session(self) -> None:
        self.tail_answered = False

    def take_dropped(self) -> tuple[SegmentMark, ...]:
        marks = tuple(self.pending)
        self.pending.clear()
        return marks

    def replay(self) -> bytes:
        return bytes(self.uncut)

    def finish(self) -> int:
        """End of the source: returns how many odd trailing bytes were dropped (0 or 1)."""
        dropped = len(self._carry)
        self._carry = b""
        return dropped
