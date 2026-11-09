"""Parse EchoNova's response envelope: ``{data, success, statusCode, errorMessage}``.

Success responses carry ``success: true`` and ``data``. Errors carry
``errorMessage``, usually ``docs``, and may carry an ``errorCode``.
Responses from the hosting proxy (for example an ingress 504) are not JSON.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

RAW_BODY_LIMIT = 4096
NON_JSON_MESSAGE_LIMIT = 500


class MalformedEnvelopeError(Exception):
    """A 2xx body that isn't a valid success envelope (internal; surfaced as ProtocolError)."""


@dataclass(frozen=True, slots=True)
class ErrorBody:
    is_json: bool
    error_message: str | None
    error_code: str | None
    docs_url: str | None
    raw_body: str | None


def header(headers: Mapping[str, str], name: str) -> str | None:
    """Case-insensitive header lookup that works for any mapping."""
    value = headers.get(name)
    if value is not None:
        return value
    lowered = name.lower()
    for key, candidate in headers.items():
        if key.lower() == lowered:
            return candidate
    return None


def _decode_preview(body: bytes) -> str | None:
    if not body:
        return None
    return body[:RAW_BODY_LIMIT].decode("utf-8", errors="replace")


def parse_error_body(body: bytes) -> ErrorBody:
    preview = _decode_preview(body)
    try:
        parsed = json.loads(body) if body else None
    except (ValueError, UnicodeDecodeError):
        parsed = None
    if isinstance(parsed, dict) and ("errorMessage" in parsed or "success" in parsed):
        message = parsed.get("errorMessage")
        code = parsed.get("errorCode")
        docs = parsed.get("docs")
        return ErrorBody(
            is_json=True,
            error_message=message if isinstance(message, str) else None,
            error_code=code if isinstance(code, str) else None,
            docs_url=docs if isinstance(docs, str) else None,
            raw_body=preview,
        )
    text = preview.strip()[:NON_JSON_MESSAGE_LIMIT] if preview else None
    return ErrorBody(is_json=False, error_message=text or None, error_code=None, docs_url=None, raw_body=preview)


def unwrap_success(body: bytes) -> Any:
    """Return ``data`` from a success envelope."""
    try:
        parsed = json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise MalformedEnvelopeError("response body is not JSON") from exc
    if not isinstance(parsed, dict) or "data" not in parsed:
        raise MalformedEnvelopeError("response body is not an EchoNova envelope")
    if parsed.get("success") is False:
        raise MalformedEnvelopeError("2xx response with success=false")
    return parsed["data"]


def parse_retry_after(value: str | None, *, now: datetime | None = None) -> float | None:
    """Parse Retry-After: delta-seconds (what EchoNova sends) or an HTTP date."""
    if value is None:
        return None
    value = value.strip()
    try:
        seconds = float(value)
    except ValueError:
        try:
            when = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        seconds = (when - (now or datetime.now(UTC))).total_seconds()
    return max(0.0, seconds)
