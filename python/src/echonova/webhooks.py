"""Verify and parse EchoNova webhook requests.

    from echonova import webhooks

    event = webhooks.verify(raw_body, request.headers, secret=os.environ["ECHONOVA_WEBHOOK_SECRET"])

Pass the raw request body exactly as received. Parsing the JSON and
serialising it again changes the bytes, and the signature check then fails.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ._core._envelope import header
from .errors import WebhookVerificationError

__all__ = [
    "DEFAULT_TOLERANCE_SECONDS",
    "JobCompleted",
    "JobFailed",
    "SpendingExhausted",
    "SpendingWarning",
    "UnknownEvent",
    "WebhookEvent",
    "verify",
]

DEFAULT_TOLERANCE_SECONDS = 300
EVENT_HEADER = "X-Webhook-Event"
TIMESTAMP_HEADER = "X-Webhook-Timestamp"
SIGNATURE_HEADER = "X-Webhook-Signature"


@dataclass(frozen=True, slots=True)
class JobCompleted:
    """An async Text to Speech or Speech to Text job finished. Check ``service``."""

    job_id: str
    api_key_id: str | None
    service: str  # "tts" or "stt"
    duration_seconds: float | None
    text: str | None  # tts
    audio_url: str | None  # tts: a signed link that expires; get the job again for a fresh one
    transcription: str | None  # stt
    terminology: dict[str, Any] | None  # stt, when terminology was sent
    timestamp: int
    raw: dict[str, Any]
    event: str = "job.completed"

    @property
    def dedupe_key(self) -> str:
        return f"{self.event}:{self.job_id}"


@dataclass(frozen=True, slots=True)
class JobFailed:
    job_id: str
    api_key_id: str | None
    service: str
    error: str | None
    timestamp: int
    raw: dict[str, Any]
    event: str = "job.failed"

    @property
    def dedupe_key(self) -> str:
        return f"{self.event}:{self.job_id}"


@dataclass(frozen=True, slots=True)
class SpendingWarning:
    """The key is close to its Credit Limit for this billing cycle."""

    api_key_id: str
    api_key_name: str | None
    credits_used: float | None
    credit_limit: float | None
    percentage_used: int | None
    timestamp: int
    raw: dict[str, Any]
    event: str = "spending.warning"

    @property
    def dedupe_key(self) -> str:
        return f"{self.event}:{self.api_key_id}:{_num_key(self.credits_used)}:{_num_key(self.credit_limit)}"


@dataclass(frozen=True, slots=True)
class SpendingExhausted:
    """The key reached its Credit Limit; paid calls with it now fail until the limit changes."""

    api_key_id: str
    api_key_name: str | None
    credits_used: float | None
    credit_limit: float | None
    timestamp: int
    raw: dict[str, Any]
    event: str = "spending.exhausted"

    @property
    def dedupe_key(self) -> str:
        return f"{self.event}:{self.api_key_id}:{_num_key(self.credits_used)}:{_num_key(self.credit_limit)}"


@dataclass(frozen=True, slots=True)
class UnknownEvent:
    """An event this SDK version doesn't know yet. The signature was valid."""

    event: str
    timestamp: int
    raw: Any

    @property
    def dedupe_key(self) -> str | None:
        return None


WebhookEvent = JobCompleted | JobFailed | SpendingWarning | SpendingExhausted | UnknownEvent


def verify(
    payload: bytes | bytearray | str,
    headers: Mapping[str, str],
    secret: str | Sequence[str],
    *,
    tolerance: float = DEFAULT_TOLERANCE_SECONDS,
    now: float | None = None,
) -> WebhookEvent:
    """Check a webhook's signature and timestamp, then parse it.

    ``secret`` may be a list, so two secrets can be valid at once (for example during a switch-over).
    Raises ``WebhookVerificationError`` with ``reason`` "headers", "timestamp",
    "signature" or "payload".
    """
    body = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
    secrets = [secret] if isinstance(secret, str) else list(secret)
    if not secrets or not all(isinstance(s, str) and s for s in secrets):
        raise ValueError("secret must be a non-empty string or a list of them")

    event_name = header(headers, EVENT_HEADER)
    timestamp_text = header(headers, TIMESTAMP_HEADER)
    signature = header(headers, SIGNATURE_HEADER)
    if not event_name or not timestamp_text or not signature:
        raise WebhookVerificationError(
            f"missing {EVENT_HEADER}, {TIMESTAMP_HEADER} or {SIGNATURE_HEADER} header", reason="headers"
        )

    timestamp_text = timestamp_text.strip()
    if not (timestamp_text.isascii() and timestamp_text.isdigit()):
        raise WebhookVerificationError("webhook timestamp is not a number", reason="timestamp")
    timestamp = int(timestamp_text)
    current = time.time() if now is None else now
    if not math.isfinite(current):
        raise ValueError("now must be a finite Unix timestamp")
    if abs(current - timestamp) > tolerance:
        raise WebhookVerificationError("webhook timestamp is outside the allowed tolerance", reason="timestamp")

    message = timestamp_text.encode("ascii") + b"." + body
    received = signature.strip().lower()
    if not received.isascii():
        raise WebhookVerificationError("webhook signature does not match", reason="signature")
    valid = False
    for candidate in secrets:
        expected = hmac.new(candidate.encode("utf-8"), message, hashlib.sha256).hexdigest()
        if hmac.compare_digest(expected, received):
            valid = True
    if not valid:
        raise WebhookVerificationError("webhook signature does not match", reason="signature")

    try:
        data = json.loads(body)
    except ValueError:
        raise WebhookVerificationError("webhook body is not JSON", reason="payload") from None
    return _parse_event(event_name.strip(), data, timestamp)


def _parse_event(name: str, data: Any, timestamp: int) -> WebhookEvent:
    if not isinstance(data, dict):
        return UnknownEvent(event=name, timestamp=timestamp, raw=data)
    if name == "job.completed":
        return JobCompleted(
            job_id=_required_str(data, "jobId"),
            api_key_id=_str(data.get("apiKeyId")),
            service=_required_str(data, "service"),
            duration_seconds=_number(data.get("durationSeconds")),
            text=_str(data.get("text")),
            audio_url=_str(data.get("audioUrl")),
            transcription=_str(data.get("transcription")),
            terminology=data.get("terminology") if isinstance(data.get("terminology"), dict) else None,
            timestamp=timestamp,
            raw=data,
        )
    if name == "job.failed":
        return JobFailed(
            job_id=_required_str(data, "jobId"),
            api_key_id=_str(data.get("apiKeyId")),
            service=_required_str(data, "service"),
            error=_str(data.get("error")),
            timestamp=timestamp,
            raw=data,
        )
    if name == "spending.warning":
        percentage = _number(data.get("percentageUsed"))
        return SpendingWarning(
            api_key_id=_required_str(data, "apiKeyId"),
            api_key_name=_str(data.get("apiKeyName")),
            credits_used=_number(data.get("creditsUsed")),
            credit_limit=_number(data.get("creditLimit")),
            percentage_used=round(percentage) if percentage is not None else None,
            timestamp=timestamp,
            raw=data,
        )
    if name == "spending.exhausted":
        return SpendingExhausted(
            api_key_id=_required_str(data, "apiKeyId"),
            api_key_name=_str(data.get("apiKeyName")),
            credits_used=_number(data.get("creditsUsed")),
            credit_limit=_number(data.get("creditLimit")),
            timestamp=timestamp,
            raw=data,
        )
    return UnknownEvent(event=name, timestamp=timestamp, raw=data)


def _required_str(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise WebhookVerificationError(f"webhook payload is missing {key}", reason="payload")
    return value


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _number(value: Any) -> float | None:
    """A finite number from a JSON number or numeric string; anything else (including inf/nan) is None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def _num_key(value: float | None) -> str:
    if value is None:
        return "-"
    return str(int(value)) if value == int(value) else repr(value)
