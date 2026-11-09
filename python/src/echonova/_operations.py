"""Every REST operation the SDK calls, with its default timeouts.

``name`` is the SDK method (as in ``spec/mapping.json``). It also names the
operation's rate-limit bucket: the API counts requests per key per endpoint.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Operation:
    name: str
    method: str
    path: str
    write_timeout: float
    read_timeout: float
    envelope: bool = True  # False when a 2xx body is the raw file (transcript export)
    secret_response: bool = False  # the 2xx body carries a secret: never copy it into an error's raw_body


def _op(
    name: str,
    method: str,
    path: str,
    write: float = 10.0,
    read: float = 30.0,
    *,
    envelope: bool = True,
    secret_response: bool = False,
) -> Operation:
    return Operation(name, method, path, write, read, envelope, secret_response)


TTS_GENERATE = _op("text_to_speech.generate", "POST", "/v1/text-to-speech/sync", read=120)
TTS_JOBS_CREATE = _op("text_to_speech.jobs.create", "POST", "/v1/text-to-speech")
TTS_VOICES_LIST = _op("text_to_speech.voices.list", "GET", "/v1/text-to-speech/voices")
TTS_JOBS_LIST = _op("text_to_speech.jobs.list", "GET", "/v1/text-to-speech/jobs")
TTS_JOBS_GET = _op("text_to_speech.jobs.get", "GET", "/v1/text-to-speech/jobs/{jobId}")
TTS_JOBS_DELETE = _op("text_to_speech.jobs.delete", "DELETE", "/v1/text-to-speech/jobs/{jobId}")

STT_TRANSCRIBE = _op("speech_to_text.transcribe", "POST", "/v1/speech-to-text/sync", write=60, read=600)
STT_JOBS_CREATE = _op("speech_to_text.jobs.create", "POST", "/v1/speech-to-text", write=60, read=120)
STT_JOBS_LIST = _op("speech_to_text.jobs.list", "GET", "/v1/speech-to-text/jobs")
STT_JOBS_GET = _op("speech_to_text.jobs.get", "GET", "/v1/speech-to-text/jobs/{jobId}")
STT_JOBS_DELETE = _op("speech_to_text.jobs.delete", "DELETE", "/v1/speech-to-text/jobs/{jobId}")
STT_JOBS_EXPORT = _op(
    "speech_to_text.jobs.export", "GET", "/v1/speech-to-text/jobs/{jobId}/export", read=60, envelope=False
)

CLEAN = _op("sound_cleaning.clean", "POST", "/v1/sound-cleaning", write=60, read=600)
CLEAN_JOBS_LIST = _op("sound_cleaning.jobs.list", "GET", "/v1/sound-cleaning/jobs")
CLEAN_JOBS_GET = _op("sound_cleaning.jobs.get", "GET", "/v1/sound-cleaning/jobs/{jobId}")
CLEAN_JOBS_DELETE = _op("sound_cleaning.jobs.delete", "DELETE", "/v1/sound-cleaning/jobs/{jobId}")

WIDGETS_CREATE_TICKET = _op("widgets.create_ticket", "POST", "/v1/widgets/{publicId}/tickets")

# A start is a POST, so it is never resent once it may have reached the server: a retried start opens a second session.
AGENT_SESSIONS_START = _op("agents.sessions.start", "POST", "/v1/agents/{agentId}/sessions", secret_response=True)
AGENT_SESSIONS_GET = _op("agents.sessions.get", "GET", "/v1/agents/{agentId}/sessions/{sessionId}")
AGENT_SESSIONS_END = _op("agents.sessions.end", "POST", "/v1/agents/{agentId}/sessions/{sessionId}/end")

ALL = (
    TTS_GENERATE,
    TTS_JOBS_CREATE,
    TTS_VOICES_LIST,
    TTS_JOBS_LIST,
    TTS_JOBS_GET,
    TTS_JOBS_DELETE,
    STT_TRANSCRIBE,
    STT_JOBS_CREATE,
    STT_JOBS_LIST,
    STT_JOBS_GET,
    STT_JOBS_DELETE,
    STT_JOBS_EXPORT,
    CLEAN,
    CLEAN_JOBS_LIST,
    CLEAN_JOBS_GET,
    CLEAN_JOBS_DELETE,
    WIDGETS_CREATE_TICKET,
    AGENT_SESSIONS_START,
    AGENT_SESSIONS_GET,
    AGENT_SESSIONS_END,
)

# Signed-URL downloads go to storage, not the API: no bucket, generous read timeout.
DOWNLOAD_WRITE_TIMEOUT = 10.0
DOWNLOAD_READ_TIMEOUT = 60.0
