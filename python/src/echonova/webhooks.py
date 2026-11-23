"""Verify and parse EchoNova webhook requests (Standard Webhooks v1).

    from echonova import webhooks

    event = webhooks.verify(raw_body, request.headers, secret=os.environ["ECHONOVA_WEBHOOK_SECRET"])

Pass the raw request body exactly as received. Parsing the JSON and
serialising it again changes the bytes, and the signature check then fails.
``request.headers`` can be passed as it is from FastAPI, Starlette, Flask,
Django, aiohttp or a plain dict: see ``HeadersLike``.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import math
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from .errors import WebhookVerificationError

__all__ = [
    "DEFAULT_TOLERANCE_SECONDS",
    "HeadersLike",
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
ID_HEADER = "webhook-id"
TIMESTAMP_HEADER = "webhook-timestamp"
SIGNATURE_HEADER = "webhook-signature"
SECRET_PREFIX = "whsec_"  # noqa: S105 - the prefix of every signing secret, not a secret
MAX_TIMESTAMP_DIGITS = 15  # Unix seconds have 10 digits for centuries; a longer value is refused before int()


class HeadersLike(Protocol):
    """The request headers ``verify()`` reads: anything with ``get(name)`` and ``items()``.

    A ``dict``, or the headers object of FastAPI and Starlette, Flask (Werkzeug),
    Django, aiohttp or httpx, as it is. Names are matched case-insensitively.
    """

    def get(self, key: str, /) -> str | None: ...

    def items(self) -> Iterable[tuple[str, str]]: ...


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
    webhook_id: str  # the delivery's webhook-id; the same on every retry
    event: str = "job.completed"

    @property
    def dedupe_key(self) -> str:
        return self.webhook_id


@dataclass(frozen=True, slots=True)
class JobFailed:
    job_id: str
    api_key_id: str | None
    service: str
    error: str | None
    timestamp: int
    raw: dict[str, Any]
    webhook_id: str
    event: str = "job.failed"

    @property
    def dedupe_key(self) -> str:
        return self.webhook_id


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
    webhook_id: str
    event: str = "spending.warning"

    @property
    def dedupe_key(self) -> str:
        return self.webhook_id


@dataclass(frozen=True, slots=True)
class SpendingExhausted:
    """The key reached its Credit Limit; paid calls with it now fail until the limit changes."""

    api_key_id: str
    api_key_name: str | None
    credits_used: float | None
    credit_limit: float | None
    timestamp: int
    raw: dict[str, Any]
    webhook_id: str
    event: str = "spending.exhausted"

    @property
    def dedupe_key(self) -> str:
        return self.webhook_id


@dataclass(frozen=True, slots=True)
class UnknownEvent:
    """An event this SDK version doesn't know yet. The signature was valid."""

    event: str
    timestamp: int
    raw: Any
    webhook_id: str

    @property
    def dedupe_key(self) -> str:
        return self.webhook_id


WebhookEvent = JobCompleted | JobFailed | SpendingWarning | SpendingExhausted | UnknownEvent


def verify(
    payload: bytes | bytearray | str,
    headers: HeadersLike,
    secret: str | Sequence[str],
    *,
    tolerance: float = DEFAULT_TOLERANCE_SECONDS,
    now: float | None = None,
) -> WebhookEvent:
    """Check a webhook's signature and timestamp, then parse it.

    ``headers`` is your framework's request headers object, or a ``dict``; names
    are matched case-insensitively. ``secret`` is the webhook's signing secret
    (``whsec_...``) as shown in the portal. It may be a list, so more than one
    secret can be valid at once. During a rotation in the portal the gateway signs
    with both the new and the previous secret, so passing only the new one works.
    Raises ``WebhookVerificationError`` with ``reason`` "headers", "timestamp",
    "signature" or "payload", and ``ValueError`` for a secret that isn't valid.
    """
    body = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
    secrets = [secret] if isinstance(secret, str) else list(secret)
    if not secrets or not all(isinstance(s, str) and s for s in secrets):
        raise ValueError("secret must be a non-empty string or a list of them")
    keys = [_signing_key(s) for s in secrets]

    event_name = _header(headers, EVENT_HEADER)
    webhook_id = _header(headers, ID_HEADER)
    timestamp_text = _header(headers, TIMESTAMP_HEADER)
    signature = _header(headers, SIGNATURE_HEADER)
    if not event_name or not webhook_id or not timestamp_text or not signature:
        raise WebhookVerificationError(
            f"missing {EVENT_HEADER}, {ID_HEADER}, {TIMESTAMP_HEADER} or {SIGNATURE_HEADER} header", reason="headers"
        )

    timestamp_text = timestamp_text.strip()
    if len(timestamp_text) > MAX_TIMESTAMP_DIGITS:
        raise WebhookVerificationError("webhook timestamp is too long", reason="timestamp")
    if not (timestamp_text.isascii() and timestamp_text.isdigit()):
        raise WebhookVerificationError("webhook timestamp is not a number", reason="timestamp")
    timestamp = int(timestamp_text)
    current = time.time() if now is None else now
    if not math.isfinite(current):
        raise ValueError("now must be a finite Unix timestamp")
    if abs(current - timestamp) > tolerance:
        raise WebhookVerificationError("webhook timestamp is outside the allowed tolerance", reason="timestamp")

    webhook_id = webhook_id.strip()
    message = webhook_id.encode("utf-8") + b"." + timestamp_text.encode("ascii") + b"." + body
    # One "v1,<base64>" per secret the gateway signed with, space-separated; other versions are ignored.
    received = [entry[3:].encode("ascii") for entry in signature.split() if entry.startswith("v1,") and entry.isascii()]
    valid = False
    for key in keys:
        expected = base64.b64encode(hmac.new(key, message, hashlib.sha256).digest())
        for candidate in received:
            # Check every pair, so timing doesn't reveal which one matched.
            if hmac.compare_digest(expected, candidate):
                valid = True
    if not valid:
        raise WebhookVerificationError("webhook signature does not match", reason="signature")

    try:
        data = json.loads(body)
    except ValueError:
        raise WebhookVerificationError("webhook body is not JSON", reason="payload") from None
    return _parse_event(event_name.strip(), data, timestamp, webhook_id)


def _signing_key(secret: str) -> bytes:
    """The HMAC key: the base64 after ``whsec_``, decoded. Either base64 alphabet, padding optional."""
    text = secret.strip().removeprefix(SECRET_PREFIX).replace("-", "+").replace("_", "/")
    try:
        key = base64.b64decode(text + "=" * (-len(text) % 4), validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("secret is not a webhook signing secret: expected whsec_ followed by base64") from None
    if not key:
        raise ValueError("secret is not a webhook signing secret: expected whsec_ followed by base64")
    return key


def _header(headers: HeadersLike, name: str) -> str | None:
    """Case-insensitive lookup: the exact name first, then any spelling of it."""
    value = headers.get(name)
    if value is not None:
        return value
    lowered = name.lower()
    for key, candidate in headers.items():
        if key.lower() == lowered:
            return candidate
    return None


def _parse_event(name: str, data: Any, timestamp: int, webhook_id: str) -> WebhookEvent:
    if not isinstance(data, dict):
        return UnknownEvent(event=name, timestamp=timestamp, raw=data, webhook_id=webhook_id)
    if name == "job.completed":
        job_id = _required_str(data, "jobId")
        service = _required_str(data, "service")
        # A completed job carries its result. Without it, the body may be a job.failed sent under this event name.
        if service == "tts":
            _required_str(data, "audioUrl")
        elif service == "stt":
            _required_str(data, "transcription")
        return JobCompleted(
            job_id=job_id,
            api_key_id=_str(data.get("apiKeyId")),
            service=service,
            duration_seconds=_number(data.get("durationSeconds")),
            text=_str(data.get("text")),
            audio_url=_str(data.get("audioUrl")),
            transcription=_str(data.get("transcription")),
            terminology=data.get("terminology") if isinstance(data.get("terminology"), dict) else None,
            timestamp=timestamp,
            raw=data,
            webhook_id=webhook_id,
        )
    if name == "job.failed":
        # A failed job has no result. With one, the body may be a job.completed sent under this event name.
        _refuse_keys(data, ("audioUrl", "transcription"))
        return JobFailed(
            job_id=_required_str(data, "jobId"),
            api_key_id=_str(data.get("apiKeyId")),
            service=_required_str(data, "service"),
            error=_str(data.get("error")),
            timestamp=timestamp,
            raw=data,
            webhook_id=webhook_id,
        )
    if name == "spending.warning":
        # A spending event carries its credits. Without them, the body may be a job event sent under this name.
        credits_used = _required_number(data, "creditsUsed")
        credit_limit = _required_number(data, "creditLimit")
        percentage = _number(data.get("percentageUsed"))
        return SpendingWarning(
            api_key_id=_required_str(data, "apiKeyId"),
            api_key_name=_str(data.get("apiKeyName")),
            credits_used=credits_used,
            credit_limit=credit_limit,
            percentage_used=round(percentage) if percentage is not None else None,
            timestamp=timestamp,
            raw=data,
            webhook_id=webhook_id,
        )
    if name == "spending.exhausted":
        credits_used = _required_number(data, "creditsUsed")
        credit_limit = _required_number(data, "creditLimit")
        return SpendingExhausted(
            api_key_id=_required_str(data, "apiKeyId"),
            api_key_name=_str(data.get("apiKeyName")),
            credits_used=credits_used,
            credit_limit=credit_limit,
            timestamp=timestamp,
            raw=data,
            webhook_id=webhook_id,
        )
    return UnknownEvent(event=name, timestamp=timestamp, raw=data, webhook_id=webhook_id)


def _required_str(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise WebhookVerificationError(f"webhook payload is missing {key}", reason="payload")
    return value


def _required_number(data: dict[str, Any], key: str) -> float:
    value = _number(data.get(key))
    if value is None:
        raise WebhookVerificationError(f"webhook payload is missing {key}", reason="payload")
    return value


def _refuse_keys(data: dict[str, Any], keys: tuple[str, ...]) -> None:
    """Refuses a body that carries any of these keys as a non-empty string (null or empty is allowed)."""
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value:
            raise WebhookVerificationError(f"webhook payload has an unexpected {key}", reason="payload")


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
