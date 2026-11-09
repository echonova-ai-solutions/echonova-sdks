"""Map stream error frames and close codes to SDK exceptions.

The close frame decides whether a stream is over. An ``error`` frame on its
own is never fatal; when one arrives just before a close, its code and message
are attached to the error raised for that close.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from ..errors import (
    APIStatusError,
    EchoNovaError,
    InsufficientBalanceError,
    InvalidRequestError,
    ProtocolError,
    ServerRestartingError,
    SessionExpiredError,
    SpendingLimitError,
    StreamClosedError,
    StreamConnectionLostError,
    UpstreamError,
    VoiceNotFoundError,
)
from ._types import ChargeState

ERROR_FRAME_CLASSES: dict[str, type[APIStatusError]] = {
    "validation_failed": InvalidRequestError,
    "voice_not_found": VoiceNotFoundError,
    "insufficient_balance": InsufficientBalanceError,
    "spending_limit": SpendingLimitError,
    "upstream_error": UpstreamError,
    "invalid_message": ProtocolError,
    "frame_too_large": ProtocolError,
}

# Closes after which the session can't continue and reconnecting won't help.
FATAL_CLOSE_CODES = frozenset({1002, 1007, 1008, 1009, 4002, 4029})
# Closes after which transcribe_stream reconnects.
RECONNECT_CLOSE_CODES = frozenset({1001, 1006, 1011})

_RAW_LIMIT = 4096


@dataclass(frozen=True, slots=True)
class CloseInfo:
    """How a socket ended. ``lost_reason`` is set when the SDK gave up on an unresponsive connection."""

    code: int
    reason: str = ""
    local: bool = False  # the SDK closed it (close(), rotation)
    lost_reason: str | None = None

    @property
    def abnormal(self) -> bool:
        """No clean close: the connection dropped, timed out, or the server is restarting."""
        return self.lost_reason is not None or self.code in (1001, 1006)


def _raw(event: Mapping[str, Any]) -> str:
    return json.dumps(event, ensure_ascii=False, default=str)[:_RAW_LIMIT]


def error_from_frame(event: Mapping[str, Any], *, session_id: str | None = None) -> APIStatusError:
    """Build the exception for an ``error`` frame (``{type, code, message, requestId?}``)."""
    code = event.get("code")
    code = code if isinstance(code, str) and code else None
    message = event.get("message")
    request_id = event.get("requestId")
    error_class = ERROR_FRAME_CLASSES.get(code or "", APIStatusError)
    return error_class(
        error_message=message if isinstance(message, str) else None,
        error_code=code,
        request_id=request_id if isinstance(request_id, str) else None,
        session_id=session_id,
        raw_body=_raw(event),
        transport="websocket",
    )


def close_error(
    info: CloseInfo,
    *,
    ended_normally: bool = False,
    last_error: Mapping[str, Any] | None = None,
    session_id: str | None = None,
    may_have_executed: bool | None = None,
) -> EchoNovaError | None:
    """The exception for a close, or None when the close is a normal end.

    ``ended_normally`` is True when Speech to Text sent ``session.ended`` first.
    ``last_error`` is an ``error`` frame that arrived just before the close.
    """
    code, reason = info.code, info.reason
    error_message = last_error.get("message") if last_error else None
    error_message = error_message if isinstance(error_message, str) else None
    error_code = last_error.get("code") if last_error else None
    error_code = error_code if isinstance(error_code, str) else None
    request_id = last_error.get("requestId") if last_error else None
    request_id = request_id if isinstance(request_id, str) else None

    def status(error_class: type[APIStatusError], default: str) -> APIStatusError:
        return error_class(
            error_message=error_message or reason or default,
            error_code=error_code,
            close_code=code,
            request_id=request_id,
            session_id=session_id,
            raw_body=_raw(last_error) if last_error else None,
            transport="websocket",
        )

    if info.lost_reason is not None or code == 1006:
        detail = info.lost_reason or "closed without a close frame (1006)"
        return StreamConnectionLostError(f"stream connection lost: {detail}", may_have_executed=may_have_executed)
    if info.local:
        return None
    if code == 1000:
        if ended_normally:
            return None
        return StreamClosedError(
            f"the server closed the stream (1000{': ' + reason if reason else ''})",
            close_code=code,
            reason=reason or None,
            session_id=session_id,
        )
    if code == 1001:
        return ServerRestartingError(
            "the server is restarting (1001); reconnect", close_code=code, reason=reason or None, session_id=session_id
        )
    if code in (1002, 1007, 1008, 1009):
        defaults = {1002: "protocol error", 1007: "invalid frame data", 1008: "policy violation", 1009: "frame too big"}
        return status(ProtocolError, defaults[code])
    if code == 1011:
        return status(UpstreamError, "the speech service failed")
    if code == 4002:
        return status(InsufficientBalanceError, "insufficient balance")
    if code == 4029:
        return status(SpendingLimitError, "spending limit reached")
    if code == 4008:
        if ended_normally:
            return None
        return SessionExpiredError(
            f"the stream session expired ({reason or 'timeout'})",
            close_code=code,
            reason=reason or None,
            session_id=session_id,
        )
    return StreamClosedError(
        f"the stream closed with code {code}{': ' + reason if reason else ''}",
        close_code=code,
        reason=reason or None,
        session_id=session_id,
    )


def attach_charge_state(error: EchoNovaError, state: ChargeState) -> EchoNovaError:
    """Record whether a lost or failed synthesis was charged on its exception (``error.charge_state``)."""
    vars(error)["charge_state"] = state
    return error


def charge_state_of(error: BaseException) -> ChargeState | None:
    value = vars(error).get("charge_state")
    return value if value in ("yes", "no", "unknown") else None
