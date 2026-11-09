"""Exceptions raised by the EchoNova SDK.

Errors are grouped by what went wrong, not by transport. For example,
``InsufficientBalanceError`` covers a REST 402, a WebSocket handshake 402 and a
stream closed with code 4002. The class tree matches ``spec/error-rules.json``
and is the same in every EchoNova SDK.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Literal

__all__ = [
    "APIConnectionError",
    "APIStatusError",
    "APITimeoutError",
    "AuthenticationError",
    "BillingError",
    "ConcurrencyLimitError",
    "DownloadExpiredError",
    "EchoNovaError",
    "FeatureNotEnabledError",
    "GatewayError",
    "InsufficientBalanceError",
    "InvalidRequestError",
    "JobFailedError",
    "JobNotFoundError",
    "JobWaitTimeoutError",
    "NotFoundError",
    "PermissionDeniedError",
    "ProtocolError",
    "RateLimitError",
    "RequestTimeoutError",
    "ServerError",
    "ServerRestartingError",
    "ServiceUnavailableError",
    "SessionEndedError",
    "SessionExpiredError",
    "SpendingLimitError",
    "StreamClosedError",
    "StreamConnectionLostError",
    "UnsupportedEnvironmentError",
    "UpstreamError",
    "UsageError",
    "VoiceNotFoundError",
    "WebhookVerificationError",
]

Transport = Literal["http", "websocket"]
TimeoutKind = Literal["connect", "write", "read", "pool", "total", "session_start", "stop_drain"]
WebhookFailure = Literal["headers", "timestamp", "signature", "payload"]
ChargeState = Literal["yes", "no", "unknown"]


class EchoNovaError(Exception):
    """Base class for every exception raised by this SDK."""

    charge_state: ChargeState | None = None
    """For a failed or lost Text to Speech synthesis: whether it was charged ("yes", "no" or "unknown")."""

    credits_consumed: float | None = None
    """For a Text to Speech synthesis that failed after its audio started: what it finally cost (the share
    of audio sent, at least 1 credit), when the server reported it."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


# --- Local misuse: nothing was sent -------------------------------------------------------------


class UsageError(EchoNovaError):
    """The SDK was called incorrectly. Nothing was sent to EchoNova."""


class SessionEndedError(UsageError):
    """A stream session was used after it ended."""


class UnsupportedEnvironmentError(EchoNovaError):
    """The runtime can't do this safely, such as sending an API key from a browser."""


# --- No HTTP response ---------------------------------------------------------------------------


class APIConnectionError(EchoNovaError):
    """No response was received from EchoNova.

    ``may_have_executed`` matters for POST requests. ``True`` means the request was
    fully sent, so it may have run and been charged: list recent jobs before sending
    it again. ``False`` means it definitely did not run. ``None`` means unknown.
    """

    def __init__(
        self,
        message: str,
        *,
        may_have_executed: bool | None = False,
        sent_at: datetime | None = None,
        retry_disabled_reason: str | None = None,
    ) -> None:
        super().__init__(message)
        self.may_have_executed = may_have_executed
        self.sent_at = sent_at
        self.retry_disabled_reason = retry_disabled_reason


class APITimeoutError(APIConnectionError):
    """A timeout expired. ``kind`` says which one."""

    def __init__(self, message: str, *, kind: TimeoutKind, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.kind = kind


class StreamConnectionLostError(APIConnectionError):
    """A stream's connection dropped without a close frame (1006, pong timeout or reset)."""


# --- The server answered ------------------------------------------------------------------------


class APIStatusError(EchoNovaError):
    """EchoNova answered with an error: a REST status, a WebSocket handshake
    rejection, or an error event or close on a stream.

    ``error_message`` is the server's text, unmodified. It is never split on
    commas, because single messages can contain them.
    """

    def __init__(
        self,
        message: str | None = None,
        *,
        status_code: int | None = None,
        error_message: str | None = None,
        error_code: str | None = None,
        request_id: str | None = None,
        docs_url: str | None = None,
        headers: Mapping[str, str] | None = None,
        raw_body: str | None = None,
        transport: Transport = "http",
        retry_after: float | None = None,
        may_have_executed: bool | None = False,
        rule: str | None = None,
        close_code: int | None = None,
        session_id: str | None = None,
        sent_at: datetime | None = None,
        from_proxy: bool = False,
    ) -> None:
        if message is None:
            message = _describe(status_code, error_code, close_code, error_message, request_id)
        super().__init__(message)
        self.status_code = status_code
        self.error_message = error_message
        self.error_code = error_code
        self.request_id = request_id
        self.docs_url = docs_url
        self.headers: Mapping[str, str] = dict(headers or {})
        self.raw_body = raw_body
        self.transport = transport
        self.retry_after = retry_after
        self.may_have_executed = may_have_executed
        self.rule = rule
        self.close_code = close_code
        self.session_id = session_id
        self.sent_at = sent_at
        self.from_proxy = from_proxy
        self.retry_disabled_reason: str | None = None  # set when a retry was ruled out, e.g. "body_not_replayable"


def _describe(
    status_code: int | None,
    error_code: str | None,
    close_code: int | None,
    error_message: str | None,
    request_id: str | None,
) -> str:
    parts = []
    if status_code is not None:
        parts.append(str(status_code))
    if close_code is not None:
        parts.append(f"close {close_code}")
    if error_code:
        parts.append(f"[{error_code}]")
    parts.append(error_message or "no error message")
    text = " ".join(parts)
    return f"{text} (request_id: {request_id})" if request_id else text


class InvalidRequestError(APIStatusError):
    """The request was rejected as invalid (400, 405, 409, 413, 415, 422, or a stream ``validation_failed``)."""


class AuthenticationError(APIStatusError):
    """401: the API key is missing, wrong, disabled or deleted."""


class PermissionDeniedError(APIStatusError):
    """403: no active subscription, or the key lacks access to this service."""


class FeatureNotEnabledError(PermissionDeniedError):
    """The feature is not enabled for this account (for example ``Streaming is not enabled``)."""


class NotFoundError(APIStatusError):
    """404: the resource doesn't exist or belongs to another workspace."""


class VoiceNotFoundError(NotFoundError):
    """The voice ID is unknown, inactive or not available to this workspace."""


class JobNotFoundError(NotFoundError):
    """The job ID is unknown or belongs to another workspace."""


class RequestTimeoutError(APIStatusError):
    """408: the server stopped waiting for the request body. The request did not run."""


class BillingError(APIStatusError):
    """The account can't pay for this request. Retrying won't help."""


class InsufficientBalanceError(BillingError):
    """402 or stream close 4002: not enough credits."""


class SpendingLimitError(BillingError):
    """429 ``Monthly spending limit exhausted`` or stream close 4029: the key reached its Credit Limit."""


class RateLimitError(APIStatusError):
    """429: too many requests. ``retry_after`` holds the seconds to wait, when the server sent it.

    This is deliberately not the parent of ``SpendingLimitError``: a rate limit
    clears by waiting, a spending limit doesn't.
    """


class ConcurrencyLimitError(APIStatusError):
    """429 ``Too many concurrent streams``: the workspace has no free stream slot."""


class ServerError(APIStatusError):
    """5xx: EchoNova failed to handle the request."""


class ServiceUnavailableError(ServerError):
    """503: a service is temporarily unavailable."""


class GatewayError(ServerError):
    """502 or 504. ``from_proxy`` is True when the response came from the hosting proxy, not the API."""


class UpstreamError(ServerError):
    """A speech service failed during a stream (``upstream_error`` or close 1011)."""


class ProtocolError(APIStatusError):
    """The server sent something that breaks the documented contract, or closed with 1008 or 1009."""


# --- Streams ------------------------------------------------------------------------------------


class StreamClosedError(EchoNovaError):
    """A stream closed in a way that is not covered by a more specific error."""

    def __init__(
        self,
        message: str,
        *,
        close_code: int | None = None,
        reason: str | None = None,
        session_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.close_code = close_code
        self.reason = reason
        self.session_id = session_id


class ServerRestartingError(StreamClosedError):
    """Close 1001: the server is restarting. Reconnect."""


class SessionExpiredError(StreamClosedError):
    """Close 4008: the session hit its idle timeout or maximum length."""


# --- Jobs, downloads, webhooks ------------------------------------------------------------------


class JobFailedError(EchoNovaError):
    """A job finished with status ``failed``. ``job`` holds the failed job."""

    def __init__(self, message: str, *, job: Any) -> None:
        super().__init__(message)
        self.job = job


class JobWaitTimeoutError(EchoNovaError):
    """``wait()`` gave up before the job finished. Calling ``wait()`` again is safe."""

    def __init__(self, message: str, *, job_id: str, last_job: Any = None) -> None:
        super().__init__(message)
        self.job_id = job_id
        self.last_job = last_job


class DownloadExpiredError(EchoNovaError):
    """A signed download link expired. Get the job again for a fresh link."""

    def __init__(self, message: str, *, url: str | None = None) -> None:
        super().__init__(message)
        self.url = url  # without its query string, which carries the signature


class WebhookVerificationError(EchoNovaError):
    """A webhook request failed verification. ``reason`` says which check failed."""

    def __init__(self, message: str, *, reason: WebhookFailure) -> None:
        super().__init__(message)
        self.reason = reason


ERROR_CLASSES: dict[str, type[EchoNovaError]] = {
    name: obj for name, obj in globals().items() if isinstance(obj, type) and issubclass(obj, EchoNovaError)
}
