"""Transport rules shared by the async and sync WebSocket drivers (sans-IO).

- ``encode_json`` checks the 64 KiB frame limit locally, so an oversized frame
  raises ``UsageError`` instead of the server closing the socket.
- ``Liveness`` decides when to send an app-level ping and when to give up on a
  silent connection.
- ``AttemptLimiter`` caps connection attempts per session object.
- ``HandshakeRetry`` decides whether a failed handshake is retried.
"""

from __future__ import annotations

import inspect
import json
from collections import deque
from collections.abc import Mapping
from typing import Any, Literal

from .._core._classifier import build_status_error, classify_response
from .._core._envelope import header
from .._core._retry import RetryPolicy
from .._logging import redact_url
from ..errors import APIConnectionError, APITimeoutError, EchoNovaError, ProtocolError, UsageError
from ._options import StreamOptions

MAX_JSON_FRAME_BYTES = 65_536
MAX_INBOUND_BYTES = 16 * 1024 * 1024

PING_FRAME = '{"type":"ping"}'

LinkAction = Literal["ping", "lost_pong", "lost_silence"]


def encode_json(payload: Mapping[str, Any]) -> str:
    """Serialize a JSON frame; raise ``UsageError`` if it is over the 64 KiB frame limit."""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    size = len(text.encode("utf-8"))
    if size > MAX_JSON_FRAME_BYTES:
        kind = payload.get("type", "frame")
        raise UsageError(
            f"the {kind} frame is {size:,} bytes; stream frames are limited to {MAX_JSON_FRAME_BYTES:,} bytes. "
            "Nothing was sent."
        )
    return text


def decode_event(text: str) -> dict[str, Any]:
    """Parse an inbound text frame. Anything that isn't a JSON object comes back without a ``type``."""
    try:
        value = json.loads(text)
    except ValueError:
        return {"raw_text": text[:4096]}
    if isinstance(value, dict):
        return value
    return {"raw_value": value}


class Liveness:
    """Keepalive and liveness timers for one socket.

    The SDK sends ``{"type":"ping"}`` when it hasn't sent a data frame for
    ``keepalive`` seconds, so an open socket never reaches the stream's idle
    timeout. The connection counts as lost when a ping gets no ``pong``
    within ``pong_timeout``, or nothing at all arrives for ``silence_timeout``.
    ``keepalive=None`` turns all of this off.
    """

    def __init__(self, now: float, *, keepalive: float | None, pong_timeout: float, silence_timeout: float) -> None:
        self.keepalive = keepalive
        self.pong_timeout = pong_timeout
        self.silence_timeout = silence_timeout
        self.last_sent = now
        self.last_received = now
        self.ping_sent_at: float | None = None

    def sent(self, now: float) -> None:
        self.last_sent = now

    def ping_sent(self, now: float) -> None:
        self.last_sent = now
        if self.ping_sent_at is None:
            self.ping_sent_at = now

    def received(self, now: float) -> None:
        self.last_received = now

    def pong(self, now: float) -> None:
        self.last_received = now
        self.ping_sent_at = None

    def poll(self, now: float) -> LinkAction | None:
        if self.keepalive is None:
            return None
        if self.ping_sent_at is not None and now - self.ping_sent_at >= self.pong_timeout:
            return "lost_pong"
        if now - self.last_received >= self.silence_timeout:
            return "lost_silence"
        if self.ping_sent_at is None and now - self.last_sent >= self.keepalive:
            return "ping"
        return None

    def next_deadline(self) -> float | None:
        if self.keepalive is None:
            return None
        deadlines = [self.last_received + self.silence_timeout]
        if self.ping_sent_at is not None:
            deadlines.append(self.ping_sent_at + self.pong_timeout)
        else:
            deadlines.append(self.last_sent + self.keepalive)
        return min(deadlines)

    def describe(self, action: LinkAction) -> str:
        if action == "lost_pong":
            return f"no pong within {self.pong_timeout:g} s of a ping"
        return f"nothing received for {self.silence_timeout:g} s"


class AttemptLimiter:
    """At most ``max_attempts`` connection attempts per ``window`` seconds, per session object.

    This protects the API key's connection budget when something keeps failing.
    """

    def __init__(self, max_attempts: int = 6, window: float = 60.0) -> None:
        self.max_attempts = max_attempts
        self.window = window
        self._attempts: deque[float] = deque()

    def wait_time(self, now: float) -> float:
        while self._attempts and now - self._attempts[0] >= self.window:
            self._attempts.popleft()
        if len(self._attempts) < self.max_attempts:
            return 0.0
        return self._attempts[0] + self.window - now

    def record(self, now: float) -> None:
        self._attempts.append(now)

    def error(self) -> APIConnectionError:
        return APIConnectionError(
            f"not connecting: this session already made {self.max_attempts} connection attempts "
            f"in the last {self.window:g} s",
            may_have_executed=False,
            retry_disabled_reason="attempt_limit",
        )


class HandshakeRetry:
    """Retry decisions for one connect call.

    Status errors follow the shared retry table's WS column. "Too many concurrent
    streams" is retried only with ``wait_for_slot``, or automatically for up to
    ``slot_wait_after_loss`` seconds when reconnecting after a dropped
    connection, in case the dropped connection still counts against the limit
    for a while.
    """

    def __init__(
        self,
        policy: RetryPolicy,
        *,
        now: float,
        wait_for_slot: float | None,
        after_abnormal: bool,
        slot_wait_after_loss: float,
    ) -> None:
        self.policy = policy
        self.started = now
        self.retries = 0
        budgets = [b for b in (wait_for_slot, slot_wait_after_loss if after_abnormal else None) if b]
        self.slot_budget: float | None = max(budgets) if budgets else None
        self._waiting_for_slot = False

    def may_wait(self, now: float, delay: float) -> bool:
        """Whether a wait (for the attempt limiter) fits in the slot-wait budget."""
        return (
            self._waiting_for_slot and self.slot_budget is not None and now + delay - self.started <= self.slot_budget
        )

    def on_status(self, status: int, headers: Mapping[str, str], body: bytes, now: float) -> float:
        """Return the delay before the next attempt, or raise the handshake's error."""
        if not 400 <= status <= 599:  # a redirect (never followed) or another unexpected status: not retried
            raise ProtocolError(
                status_code=status,
                error_message=f"unexpected HTTP {status} answer to the stream handshake; redirects are not followed",
                request_id=header(headers, "x-request-id"),
                headers=dict(headers.items()),
                transport="websocket",
                may_have_executed=False,
            )
        error = build_status_error(status, headers, body, method="WS", transport="websocket")
        rule, retry_after = classify_response(status, headers, body)
        decision = self.policy.decide_status(
            "WS",
            rule,
            retries_done=self.retries,
            retry_after=retry_after,
            wait_for_slot=self.slot_budget is not None,
        )
        if rule.id == "concurrent_streams" and self.slot_budget is not None:
            if decision.reason in ("retry", "max_retries"):
                delay = self.policy.backoff(min(self.retries + 1, 6))
                if now + delay - self.started <= self.slot_budget:
                    self.retries += 1
                    self._waiting_for_slot = True
                    return delay
            raise error
        self._waiting_for_slot = False
        if decision.retry:
            self.retries += 1
            return decision.delay
        raise error

    def on_network(self, exc: BaseException, url: str) -> float:
        """Return the delay before the next attempt, or raise a connection error."""
        self._waiting_for_slot = False
        decision = self.policy.decide_transport("WS", "connect", retries_done=self.retries)
        if decision.retry:
            self.retries += 1
            return decision.delay
        raise network_error(exc, url) from exc


def network_error(exc: BaseException, url: str) -> EchoNovaError:
    where = redact_url(url)
    if isinstance(exc, TimeoutError) or type(exc).__name__ == "TimeoutError":
        return APITimeoutError(f"timed out opening the stream at {where}", kind="connect", may_have_executed=False)
    return APIConnectionError(f"could not open the stream at {where}: {exc or type(exc).__name__}")


def supports_kwarg(function: Any, name: str) -> bool:
    """Whether a websockets connect function accepts ``name`` (the API grew across versions)."""
    try:
        return name in inspect.signature(function).parameters
    except (TypeError, ValueError):
        return False


def connect_kwargs(
    options: StreamOptions, function: Any, headers: Mapping[str, str], user_agent: str | None
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "additional_headers": dict(headers),
        "open_timeout": options.open_timeout,
        "close_timeout": options.close_timeout,
        "max_size": MAX_INBOUND_BYTES,
        "compression": None,
    }
    if user_agent is not None:
        kwargs["user_agent_header"] = user_agent
    # The library still answers the server's pings; the SDK sends its own app-level pings.
    for name in ("ping_interval", "ping_timeout"):
        if supports_kwarg(function, name):
            kwargs[name] = None
    if supports_kwarg(function, "legacy"):  # newer sync clients: return the connection itself
        kwargs["legacy"] = True
    return kwargs
