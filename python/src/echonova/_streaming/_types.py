"""Public data types for the Text to Speech and Speech to Text streams."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, TypeAlias

from ..errors import APIStatusError

# --- Text to Speech -------------------------------------------------------------------------------

SynthesisState = Literal[
    "queued",  # not sent yet: waiting in the client queue or for a connection
    "sent",  # sent, no ``start`` yet
    "streaming",  # ``start`` arrived; audio is flowing
    "cancelling",  # a cancel (or a newer synthesis) was requested; waiting for the server to stop
    "completed",
    "cancelled",
    "superseded",
    "failed",
    "lost",  # the connection dropped while it was in flight
]
SynthesisOutcome = Literal["completed", "cancelled", "superseded"]
ChargeState = Literal["yes", "no", "unknown"]


@dataclass(frozen=True, slots=True)
class SynthesisMetrics:
    """Timings for one synthesis, in seconds (``None`` until known)."""

    ttfb: float | None  # from sending the request to the first audio frame
    time_to_start: float | None  # from sending the request to ``start``
    total: float | None  # from sending the request to its final state
    audio_bytes: int
    frames: int
    dropped_frames: int  # frames that arrived after a cancel was requested, and were discarded


@dataclass(frozen=True, slots=True)
class SynthesisResult:
    """How a synthesis ended.

    A synthesis is charged per character when it starts. One that stops after its
    audio started (a cancel, or a newer synthesis replacing it) costs only the share
    of audio sent, at least 1 credit, and the rest is refunded.

    ``credits_consumed`` is the final cost the server reported: on ``done`` for a
    completed synthesis, and on ``cancelled`` for a cancelled or superseded one. It
    is None when the server reported none.

    ``charged`` is True when the synthesis was billed (the server reported its cost,
    or its audio had started), and False when it was not: never sent, or cancelled
    before it was charged. It is None when the SDK ended it itself before its audio
    started, so it can't tell: a cancel the server never confirmed, or a lost
    connection.

    ``duration_seconds`` and ``characters`` come from ``done``, so only a completed
    synthesis has them. ``raw`` is the final frame (``done`` or ``cancelled``) as
    received.
    """

    request_id: str
    outcome: SynthesisOutcome
    charged: bool | None
    duration_seconds: float | None = None
    characters: int | None = None
    credits_consumed: float | None = None
    sample_rate: int | None = None
    raw: Mapping[str, Any] | None = None


# --- Speech to Text -------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SegmentMark:
    """Where ``end_segment()`` cut the audio.

    ``audio_offset_s`` is the end of the segment, in seconds of audio sent in this
    session. ``expect_result`` is False for an empty or very short segment, for
    which the SDK expects no transcript.
    """

    index: int
    audio_offset_s: float
    duration_s: float
    expect_result: bool


@dataclass(frozen=True, slots=True)
class SessionSummary:
    """Totals from ``session.ended``, and whether the session was kept as a job.

    ``job_id`` and ``saved_status`` come from ``session.saved``; both are None if it
    never arrived. ``saved_status`` is ``saved`` (get the job with
    ``speech_to_text.jobs.get(job_id)``), ``empty`` (nothing was transcribed, so
    nothing is kept) or ``failed`` (the session could not be kept).
    """

    reason: str
    total_seconds: float
    credits_consumed: float
    session_id: str | None = None
    job_id: str | None = None
    saved_status: str | None = None


@dataclass(frozen=True, slots=True)
class Transcript:
    """The final transcript of one segment.

    ``text`` is passed through unchanged: it can be empty or carry surrounding
    whitespace. ``index`` counts transcripts in arrival order, from 0.
    ``terminology`` is the server's terminology report for this segment, when
    terms are set. ``language`` is as the server reports it, which can be
    ``auto`` when the session was opened without one.
    """

    segment_id: str
    text: str
    duration_seconds: float
    credits_consumed: float
    index: int
    terminology: Mapping[str, Any] | None = None
    language: str | None = None
    session_id: str | None = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class TerminologySet:
    """The server accepted a terminology frame. ``active`` is False when terms were cleared."""

    active: bool
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class StreamErrorEvent:
    """A non-fatal error on the stream, such as one segment failing. The session continues."""

    code: str
    message: str
    error: APIStatusError = field(repr=False, compare=False)
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class SessionEnded:
    """The server ended the session. Only ``SessionSaved`` can follow it."""

    reason: str
    total_seconds: float
    credits_consumed: float
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class SessionSaved:
    """Whether the session was kept as a job. It usually follows ``SessionEnded``.

    ``status`` is ``saved`` (the job is in ``speech_to_text.jobs.get(job_id)``),
    ``empty`` (nothing was transcribed, so nothing is kept) or ``failed`` (the
    session could not be kept). ``session_id`` is the session it belongs to.
    """

    job_id: str
    status: str
    session_id: str | None = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class UnknownEvent:
    """An event type this SDK version doesn't know. Kept so nothing is silently lost."""

    raw: Mapping[str, Any]

    @property
    def type(self) -> str | None:
        value = self.raw.get("type")
        return value if isinstance(value, str) else None


@dataclass(frozen=True, slots=True)
class Reconnected:
    """``transcribe_stream`` opened a new session.

    ``reason`` is ``rollover`` for a planned handover before the session's time
    limit, or why the previous connection ended (``connection_lost``,
    ``server_restarting``, ``upstream_error``, ``session_expired``,
    ``max_duration`` or ``idle_timeout``).
    """

    reason: str
    session_id: str | None
    attempt: int = 0


@dataclass(frozen=True, slots=True)
class AudioDropped:
    """Segments that were cut but got no result before the connection dropped.

    Their audio was not transcribed and is not charged.
    """

    segment_marks: tuple[SegmentMark, ...]

    @property
    def seconds(self) -> float:
        return sum(mark.duration_s for mark in self.segment_marks)


SttEvent: TypeAlias = Transcript | TerminologySet | StreamErrorEvent | SessionEnded | SessionSaved | UnknownEvent
TranscribeEvent: TypeAlias = Transcript | StreamErrorEvent | SessionSaved | Reconnected | AudioDropped | UnknownEvent
