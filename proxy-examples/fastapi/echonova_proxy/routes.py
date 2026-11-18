"""The allow-list: the only EchoNova routes the proxy forwards.

These are the speech routes of the public API spec (Text to Speech, Speech to Text and
Sound Cleaning). A test checks this table against spec/openapi.json and spec/asyncapi.json.
Delete the rows your app doesn't use.

Deliberately left out: POST /v1/widgets/{publicId}/tickets. Minting a widget ticket is a
call your own backend makes directly with the API key, never something an app should reach.

Also left out: the three job lists (GET /v1/{text-to-speech,speech-to-text,sound-cleaning}/jobs).
Every user's calls go upstream with the same workspace key, so a list would show each user every
other user's jobs. To offer a list in your app, list the jobs your own database records for the
user (see JobOwners in hooks.py). The single-job routes below are checked against the job's owner.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

REST_ROUTES: tuple[tuple[str, str], ...] = (
    ("POST", "/v1/text-to-speech"),
    ("POST", "/v1/text-to-speech/sync"),
    ("GET", "/v1/text-to-speech/voices"),
    ("GET", "/v1/text-to-speech/jobs/{jobId}"),
    ("DELETE", "/v1/text-to-speech/jobs/{jobId}"),
    ("POST", "/v1/speech-to-text"),
    ("POST", "/v1/speech-to-text/sync"),
    ("GET", "/v1/speech-to-text/jobs/{jobId}"),
    ("DELETE", "/v1/speech-to-text/jobs/{jobId}"),
    ("GET", "/v1/speech-to-text/jobs/{jobId}/export"),
    ("POST", "/v1/sound-cleaning"),
    ("GET", "/v1/sound-cleaning/jobs/{jobId}"),
    ("DELETE", "/v1/sound-cleaning/jobs/{jobId}"),
)

# Routes whose successful answer creates a job (data.jobId, or data.id for a Sound Cleaning job that
# finished in the call). The proxy records the job as the calling user's.
JOB_CREATING_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {
        ("POST", "/v1/text-to-speech"),
        ("POST", "/v1/text-to-speech/sync"),
        ("POST", "/v1/speech-to-text"),
        ("POST", "/v1/speech-to-text/sync"),
        ("POST", "/v1/sound-cleaning"),
    }
)

# The stream whose session.started and session.saved messages carry the job id of the session.
JOB_CREATING_STREAM = "/v1/speech-to-text/stream"

# What the API answers for an unknown job. The proxy answers the same for another user's job, so a
# caller can't tell whether the id exists.
JOB_NOT_FOUND = {
    "text-to-speech": "TTS Job not found",
    "speech-to-text": "STT Job not found",
    "sound-cleaning": "Clean Job not found",
}

# WebSocket streams, with the query parameters forwarded upstream (everything else is dropped).
STREAM_ROUTES: dict[str, tuple[str, ...]] = {
    "/v1/text-to-speech/stream": (),
    "/v1/speech-to-text/stream": ("sample_rate", "language", "encoding"),
}

# A path parameter is one plain segment. Anything else (percent-encoding, dots, slashes)
# doesn't match, so a crafted ID can never steer the request to another upstream path.
_PARAM = r"[A-Za-z0-9_-]{1,128}"
_JOB_ID = re.compile(f"^{_PARAM}$")


def product_of(path: str) -> str:
    """The product of a speech route: 'text-to-speech' for /v1/text-to-speech/jobs/{jobId}."""
    parts = path.split("/")
    return parts[2] if len(parts) > 2 else ""


def job_id_of(template: str, path: str) -> str | None:
    """The job a matched route acts on, or None for a route that isn't about one job."""
    parts = path.split("/")
    return parts[4] if "{jobId}" in template and len(parts) > 4 else None


def is_job_id(value: object) -> bool:
    """A job id the proxy can record: one that its job routes would match."""
    return isinstance(value, str) and _JOB_ID.match(value) is not None


def created_job_id(body: bytes) -> str | None:
    """The job a job-creating answer names, or None."""
    try:
        data = json.loads(body).get("data")
    except (ValueError, AttributeError):
        return None
    if not isinstance(data, dict):
        return None
    job_id = data.get("jobId")
    if job_id is None:
        job_id = data.get("id")
    return job_id if is_job_id(job_id) else None


def session_job_id(frame: str) -> str | None:
    """The job id in a Speech to Text stream's session.started or session.saved message, or None."""
    if len(frame) > 64 * 1024 or '"session.' not in frame:
        return None
    try:
        message = json.loads(frame)
    except ValueError:
        return None
    if not isinstance(message, dict) or message.get("type") not in ("session.started", "session.saved"):
        return None
    job_id = message.get("jobId")
    return job_id if is_job_id(job_id) else None


def _compile(template: str) -> re.Pattern[str]:
    parts = re.split(r"(\{[A-Za-z]+\})", template)
    body = "".join(_PARAM if p.startswith("{") else re.escape(p) for p in parts)
    return re.compile(f"^{body}$")


@dataclass(frozen=True)
class RestMatch:
    template: str | None  # the matched route, e.g. /v1/text-to-speech/jobs/{jobId}
    allowed: tuple[str, ...]  # methods the path accepts; empty when the path is unknown

    @property
    def found(self) -> bool:
        return self.template is not None


_PATTERNS = [(method, template, _compile(template)) for method, template in REST_ROUTES]


def match_rest(method: str, path: str) -> RestMatch:
    """Match a raw (still percent-encoded) path such as /v1/text-to-speech/sync."""
    allowed: list[str] = []
    template = None
    for route_method, route_template, pattern in _PATTERNS:
        if pattern.match(path):
            allowed.append(route_method)
            if route_method == method:
                template = route_template
    return RestMatch(template, tuple(allowed))
