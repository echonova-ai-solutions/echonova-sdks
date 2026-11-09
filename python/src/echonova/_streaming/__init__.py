"""Streaming: WebSocket protocols for Text to Speech and Speech to Text.

The client exposes these through ``client.text_to_speech.connect()`` /
``speak()`` and ``client.speech_to_text.connect()`` / ``transcribe_stream()``.
"""

from ._api import (
    AsyncConnecting,
    connect_stt,
    connect_stt_sync,
    connect_tts,
    connect_tts_sync,
    speak,
    speak_sync,
)
from ._options import ReconnectPolicy, StreamOptions
from ._stt_session import AsyncSttSession, SttSession
from ._transcribe import transcribe_stream, transcribe_stream_sync
from ._tts_session import AsyncSynthesis, AsyncTtsSession, Synthesis, TtsSession
from ._types import (
    AudioDropped,
    ChargeState,
    Reconnected,
    SegmentMark,
    SessionEnded,
    SessionSaved,
    SessionSummary,
    StreamErrorEvent,
    SttEvent,
    SynthesisMetrics,
    SynthesisOutcome,
    SynthesisResult,
    SynthesisState,
    TerminologySet,
    TranscribeEvent,
    Transcript,
    UnknownEvent,
)

__all__ = [
    "AsyncConnecting",
    "AsyncSttSession",
    "AsyncSynthesis",
    "AsyncTtsSession",
    "AudioDropped",
    "ChargeState",
    "ReconnectPolicy",
    "Reconnected",
    "SegmentMark",
    "SessionEnded",
    "SessionSaved",
    "SessionSummary",
    "StreamErrorEvent",
    "StreamOptions",
    "SttEvent",
    "SttSession",
    "Synthesis",
    "SynthesisMetrics",
    "SynthesisOutcome",
    "SynthesisResult",
    "SynthesisState",
    "TerminologySet",
    "TranscribeEvent",
    "Transcript",
    "TtsSession",
    "UnknownEvent",
    "connect_stt",
    "connect_stt_sync",
    "connect_tts",
    "connect_tts_sync",
    "speak",
    "speak_sync",
    "transcribe_stream",
    "transcribe_stream_sync",
]
