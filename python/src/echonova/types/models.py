"""Response models for the REST API.

Attribute names are snake_case versions of the API's fields; ``.raw`` keeps the
JSON exactly as received, including fields this SDK version doesn't know yet.
``status`` values are open: besides ``pending``, ``processing``, ``completed``
and ``failed``, treat any other value as "not finished".
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime

from ._base import (
    Model,
    api_field,
    to_bool,
    to_datetime,
    to_float,
    to_int,
    to_model,
    to_models,
    to_str,
)

__all__ = [
    "AgentSession",
    "CleanJob",
    "CleanJobOptions",
    "CleanMetrics",
    "DeleteResult",
    "JobInitiated",
    "StartedAgentSession",
    "SttJob",
    "SttJobStream",
    "SttResult",
    "SttSegment",
    "SttSpeaker",
    "TerminologyEdit",
    "TerminologyNearMiss",
    "TerminologyResult",
    "TerminologyWarning",
    "TranscriptExport",
    "TranscriptExportSegment",
    "TranscriptExportSpeaker",
    "TtsJob",
    "TtsJobStream",
    "TtsResult",
    "Voice",
    "VoiceList",
    "WidgetTicket",
]


# --- Shared -------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class JobInitiated(Model):
    """An async job was accepted. Poll it with ``jobs.wait()`` or wait for its webhook."""

    job_id: str = api_field("jobId", to_str, required=True)
    status: str = api_field("status", to_str, required=True)

    @property
    def id(self) -> str:
        return self.job_id


@dataclass(frozen=True, slots=True, kw_only=True)
class DeleteResult(Model):
    """``already_deleted`` is True when a retried delete found the job gone, because an earlier attempt removed it."""

    deleted: bool | None = api_field("deleted", to_bool)
    already_deleted: bool = False


# --- Text to Speech -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True, repr=False)  # Model.__repr__ redacts the link
class TtsResult(Model):
    """The result of ``text_to_speech.generate()``. ``audio_url`` is a signed WAV link that expires."""

    job_id: str = api_field("jobId", to_str, required=True)
    status: str = api_field("status", to_str, required=True)
    audio_url: str | None = api_field("audioUrl", to_str, link=True)
    duration_seconds: float | None = api_field("durationSeconds", to_float)
    credits_consumed: int | None = api_field("creditsConsumed", to_int)

    @property
    def id(self) -> str:
        return self.job_id


@dataclass(frozen=True, slots=True, kw_only=True, repr=False)  # Model.__repr__ redacts the link
class Voice(Model):
    id: str = api_field("id", to_str, required=True)
    name: str | None = api_field("name", to_str)
    display_name: str | None = api_field("displayName", to_str)
    language: str | None = api_field("language", to_str)
    gender: str | None = api_field("gender", to_str)
    preview_url: str | None = api_field("previewUrl", to_str, link=True)


@dataclass(frozen=True, slots=True, kw_only=True)
class VoiceList(Model):
    """Every voice you can use. Iterate it directly."""

    items: tuple[Voice, ...] = api_field("items", to_models(Voice))
    total: int | None = api_field("total", to_int)

    def __iter__(self) -> Iterator[Voice]:
        return iter(self.items or ())

    def __len__(self) -> int:
        return len(self.items or ())

    def __getitem__(self, index: int) -> Voice:
        return (self.items or ())[index]


@dataclass(frozen=True, slots=True, kw_only=True)
class TtsJobStream(Model):
    """Where a job made on the Text to Speech stream came from.

    ``session_id`` is shared by every synthesis on one socket. ``synthesis_request_id``
    is the API's ``requestId``: the ``request_id`` of the stream ``Synthesis``. It is
    renamed because ``.request_id`` holds the HTTP request ID on every result.
    ``cancelled`` is True when the synthesis stopped early, so the audio holds only
    what was sent; ``audio_dropped`` is True when the audio could not be saved.
    """

    session_id: str | None = api_field("sessionId", to_str)
    synthesis_request_id: str | None = api_field("requestId", to_str)
    cancelled: bool | None = api_field("cancelled", to_bool)
    audio_dropped: bool | None = api_field("audioDropped", to_bool)


@dataclass(frozen=True, slots=True, kw_only=True, repr=False)  # Model.__repr__ redacts the link
class TtsJob(Model):
    """A Text to Speech job. ``audio_url`` is re-signed on every get; it expires, so don't store it.

    ``stream`` is set only on a job made on the Text to Speech stream.
    """

    id: str = api_field("id", to_str, required=True)
    status: str = api_field("status", to_str, required=True)
    text: str | None = api_field("text", to_str)
    voice_id: str | None = api_field("voiceId", to_str)
    audio_url: str | None = api_field("audioUrl", to_str, link=True)
    duration_seconds: float | None = api_field("durationSeconds", to_float)
    credits_consumed: int | None = api_field("creditsConsumed", to_int)
    error: str | None = api_field("error", to_str)
    created_at: datetime | None = api_field("createdAt", to_datetime)
    stream: TtsJobStream | None = api_field("stream", to_model(TtsJobStream))


# --- Speech to Text -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class SttSegment(Model):
    start: float | None = api_field("start", to_float)
    end: float | None = api_field("end", to_float)
    text: str | None = api_field("text", to_str)
    speaker: str | None = api_field("speaker", to_str)


@dataclass(frozen=True, slots=True, kw_only=True)
class SttSpeaker(Model):
    id: str | None = api_field("id", to_str)
    talk_time: float | None = api_field("talkTime", to_float)


@dataclass(frozen=True, slots=True, kw_only=True)
class TerminologyEdit(Model):
    start: float | None = api_field("start", to_float)
    end: float | None = api_field("end", to_float)
    original: str | None = api_field("original", to_str)
    replacement: str | None = api_field("replacement", to_str)
    stage: str | None = api_field("stage", to_str)
    score: float | None = api_field("score", to_float)


@dataclass(frozen=True, slots=True, kw_only=True)
class TerminologyNearMiss(Model):
    start: float | None = api_field("start", to_float)
    end: float | None = api_field("end", to_float)
    original: str | None = api_field("original", to_str)
    candidate: str | None = api_field("candidate", to_str)
    score: float | None = api_field("score", to_float)


@dataclass(frozen=True, slots=True, kw_only=True)
class TerminologyWarning(Model):
    code: str | None = api_field("code", to_str)
    detail: str | None = api_field("detail", to_str)


@dataclass(frozen=True, slots=True, kw_only=True)
class TerminologyResult(Model):
    """How your terminology changed the transcript.

    ``raw_text`` is the API's ``raw`` field (the transcript before corrections);
    it is renamed because ``.raw`` holds the JSON on every model.
    """

    raw_text: str | None = api_field("raw", to_str)
    corrected: str | None = api_field("corrected", to_str)
    edits: tuple[TerminologyEdit, ...] | None = api_field("edits", to_models(TerminologyEdit))
    near_misses: tuple[TerminologyNearMiss, ...] | None = api_field("nearMisses", to_models(TerminologyNearMiss))
    warnings: tuple[TerminologyWarning, ...] | None = api_field("warnings", to_models(TerminologyWarning))
    mapper_status: str | None = api_field("mapperStatus", to_str)
    mapper_version: str | None = api_field("mapperVersion", to_str)


@dataclass(frozen=True, slots=True, kw_only=True)
class SttResult(Model):
    """The result of ``speech_to_text.transcribe()``.

    ``language`` is as the API reports it, which can be ``auto`` when the call left it out.
    """

    job_id: str = api_field("jobId", to_str, required=True)
    status: str = api_field("status", to_str, required=True)
    transcription: str | None = api_field("transcription", to_str)
    duration_seconds: float | None = api_field("durationSeconds", to_float)
    language: str | None = api_field("language", to_str)
    numbers_as_digits: bool | None = api_field("numbersAsDigits", to_bool)
    identify_speakers: bool | None = api_field("identifySpeakers", to_bool)
    segments: tuple[SttSegment, ...] | None = api_field("segments", to_models(SttSegment))
    speakers: tuple[SttSpeaker, ...] | None = api_field("speakers", to_models(SttSpeaker))
    terminology: TerminologyResult | None = api_field("terminology", to_model(TerminologyResult))
    credits_consumed: int | None = api_field("creditsConsumed", to_int)

    @property
    def id(self) -> str:
        return self.job_id


@dataclass(frozen=True, slots=True, kw_only=True)
class SttJobStream(Model):
    """The Speech to Text stream session a job came from (``SttSession.session_id``)."""

    session_id: str | None = api_field("sessionId", to_str)


@dataclass(frozen=True, slots=True, kw_only=True, repr=False)  # Model.__repr__ redacts the link
class SttJob(Model):
    """A Speech to Text job. ``transcription`` is missing until it completes.

    ``stream`` and ``audio_url`` are set only on a job saved from the Speech to Text
    stream. ``audio_url`` is a signed link to the recording; it expires, so get the
    job again for a fresh one.
    """

    id: str = api_field("id", to_str, required=True)
    status: str = api_field("status", to_str, required=True)
    transcription: str | None = api_field("transcription", to_str)
    duration_seconds: float | None = api_field("durationSeconds", to_float)
    language: str | None = api_field("language", to_str)
    numbers_as_digits: bool | None = api_field("numbersAsDigits", to_bool)
    identify_speakers: bool | None = api_field("identifySpeakers", to_bool)
    segments: tuple[SttSegment, ...] | None = api_field("segments", to_models(SttSegment))
    speakers: tuple[SttSpeaker, ...] | None = api_field("speakers", to_models(SttSpeaker))
    terminology: TerminologyResult | None = api_field("terminology", to_model(TerminologyResult))
    credits_consumed: int | None = api_field("creditsConsumed", to_int)
    error: str | None = api_field("error", to_str)
    created_at: datetime | None = api_field("createdAt", to_datetime)
    audio_url: str | None = api_field("audioUrl", to_str, link=True)
    stream: SttJobStream | None = api_field("stream", to_model(SttJobStream))


@dataclass(frozen=True, slots=True, kw_only=True)
class TranscriptExportSpeaker(Model):
    id: str | None = api_field("id", to_str)
    label: str | None = api_field("label", to_str)
    talk_time: float | None = api_field("talkTime", to_float)


@dataclass(frozen=True, slots=True, kw_only=True)
class TranscriptExportSegment(Model):
    start: float | None = api_field("start", to_float)
    end: float | None = api_field("end", to_float)
    speaker: str | None = api_field("speaker", to_str)
    speaker_label: str | None = api_field("speakerLabel", to_str)
    text: str | None = api_field("text", to_str)


@dataclass(frozen=True, slots=True, kw_only=True)
class TranscriptExport(Model):
    """``speech_to_text.jobs.export(..., format="json")``: text, speakers and timed segments."""

    id: str | None = api_field("id", to_str)
    file_name: str | None = api_field("fileName", to_str)
    duration_seconds: float | None = api_field("durationSeconds", to_float)
    language: str | None = api_field("language", to_str)
    text: str | None = api_field("text", to_str)
    speakers: tuple[TranscriptExportSpeaker, ...] | None = api_field("speakers", to_models(TranscriptExportSpeaker))
    segments: tuple[TranscriptExportSegment, ...] | None = api_field("segments", to_models(TranscriptExportSegment))


# --- Sound Cleaning -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class CleanJobOptions(Model):
    """The cleaning options recorded on the job. Options the API didn't return are ``None``."""

    cutoff_freq: float | None = api_field("cutoffFreq", to_float)
    q_factor: float | None = api_field("qFactor", to_float)
    target_lufs: float | None = api_field("targetLufs", to_float)
    true_peak_dbfs: float | None = api_field("truePeakDbfs", to_float)
    comp_thresh_db: float | None = api_field("compThreshDb", to_float)
    comp_ratio: float | None = api_field("compRatio", to_float)
    comp_attack_ms: float | None = api_field("compAttackMs", to_float)
    comp_release_ms: float | None = api_field("compReleaseMs", to_float)


@dataclass(frozen=True, slots=True, kw_only=True)
class CleanMetrics(Model):
    sample_rate: int | None = api_field("sampleRate", to_int)
    bit_depth: int | None = api_field("bitDepth", to_int)
    integrated_lufs: float | None = api_field("integratedLufs", to_float)
    true_peak_dbfs: float | None = api_field("truePeakDbfs", to_float)


@dataclass(frozen=True, slots=True, kw_only=True, repr=False)  # Model.__repr__ redacts the link
class CleanJob(Model):
    """A Sound Cleaning job. ``output_url`` is a signed link to the cleaned WAV; it expires."""

    id: str = api_field("id", to_str, required=True)
    status: str = api_field("status", to_str, required=True)
    file_name: str | None = api_field("fileName", to_str)
    output_url: str | None = api_field("outputUrl", to_str, link=True)
    duration_seconds: float | None = api_field("durationSeconds", to_float)
    credits_consumed: int | None = api_field("creditsConsumed", to_int)
    options: CleanJobOptions | None = api_field("options", to_model(CleanJobOptions))
    metrics: CleanMetrics | None = api_field("metrics", to_model(CleanMetrics))
    error: str | None = api_field("error", to_str)
    created_at: datetime | None = api_field("createdAt", to_datetime)


# --- Widgets ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class WidgetTicket(Model):
    """A short-lived ticket that lets one visitor open a private widget."""

    ticket: str = api_field("ticket", to_str, required=True)
    expires_at: datetime | None = api_field("expiresAt", to_datetime)


# --- Agents -------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class AgentSession(Model):
    """A live voice or chat session with an agent.

    ``channel`` is ``voice`` or ``chat``. ``status`` is ``active`` while the session
    is open, then ``ended``, or ``failed`` / ``out_of_credits`` when it stopped
    early; treat other values as "not active". ``ended_at`` is None while it is open.
    The session ID is also the conversation ID once it ends.
    """

    id: str = api_field("id", to_str, required=True)
    status: str = api_field("status", to_str, required=True)
    agent_id: str | None = api_field("agentId", to_str)
    channel: str | None = api_field("channel", to_str)
    started_at: datetime | None = api_field("startedAt", to_datetime)
    ended_at: datetime | None = api_field("endedAt", to_datetime)


@dataclass(frozen=True, slots=True, kw_only=True)
class StartedAgentSession(AgentSession):
    """The result of ``agents.sessions.start()``: the session, plus how a client joins it.

    ``token`` is a secret, sent only in this response and never again. Hand it
    only to the client that joins the room at ``ws_url``, and don't log or store
    it. It is left out of ``repr()``, but ``to_dict()`` and ``.raw`` include it.
    ``greeting`` is a chat session's first agent message (None for voice).
    """

    token: str = api_field("token", to_str, required=True, secret=True)
    ws_url: str | None = api_field("wsUrl", to_str)
    greeting: str | None = api_field("greeting", to_str)
