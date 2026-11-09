"""Connection settings shared by every stream session."""

from __future__ import annotations

import inspect
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import TypeAlias
from urllib.parse import urlencode, urlsplit, urlunsplit

from .._core._retry import RetryPolicy
from ..errors import UsageError

TTS_PATH = "/v1/text-to-speech/stream"
STT_PATH = "/v1/speech-to-text/stream"

HeadersResult: TypeAlias = Mapping[str, str] | Awaitable[Mapping[str, str]]
HeadersProvider: TypeAlias = Callable[[], HeadersResult]


def _no_headers() -> Mapping[str, str]:
    return {}


@dataclass(frozen=True, slots=True)
class ReconnectPolicy:
    """How ``transcribe_stream`` reconnects after a dropped connection.

    ``max_attempts`` counts reconnects in a row without a transcript in between.
    """

    max_attempts: int = 3
    initial_delay: float = 0.5
    max_delay: float = 8.0

    def delay(self, attempt: int) -> float:
        """Seconds to wait before reconnect number ``attempt`` (1-based)."""
        return float(min(self.max_delay, self.initial_delay * 2 ** max(0, attempt - 1)))


@dataclass(frozen=True)
class StreamOptions:
    """Settings for opening stream sessions. The client builds one from its own configuration.

    ``headers`` is called before every connection attempt and returns the headers
    to send, including ``Authorization``; it may be a coroutine function when used
    with the async sessions. Times are in seconds.
    """

    ws_base_url: str = "wss://api.echonova.ai"
    headers: HeadersProvider = _no_headers
    user_agent: str | None = None
    open_timeout: float = 10.0
    close_timeout: float = 5.0
    keepalive: float | None = 30.0  # app-level ping after this long without sending; None turns it off
    pong_timeout: float = 15.0
    silence_timeout: float = 60.0  # nothing received for this long means the connection is dead
    retry_policy: RetryPolicy | None = None
    wait_for_slot: float | None = None  # keep retrying "Too many concurrent streams" for up to this long
    reconnect_slot_wait: float = 90.0  # the same, automatically, when reconnecting after a dropped connection
    max_connect_attempts: int = 6
    connect_window: float = 60.0
    session_start_timeout: float = 10.0  # Speech to Text: wait for session.started / terminology.set
    synthesis_start_timeout: float = 30.0  # Text to Speech: wait for start after sending
    cancel_ack_timeout: float = 5.0
    rotate_after: float = 28 * 60.0  # Text to Speech: reopen an idle socket before the server's session limit
    rollover_margin: float = 30.0  # transcribe_stream: hand over this long before the session limit
    clock: Callable[[], float] = field(default=time.monotonic, repr=False)

    def policy(self) -> RetryPolicy:
        return self.retry_policy or RetryPolicy()

    def url(self, path: str, query: Mapping[str, str | int] | None = None) -> str:
        parts = urlsplit(self.ws_base_url.strip())
        scheme = {"https": "wss", "http": "ws"}.get(parts.scheme, parts.scheme)
        if scheme not in ("ws", "wss") or not parts.netloc:
            raise UsageError(f"ws_base_url must be a wss:// (or https://) URL, got {self.ws_base_url!r}")
        base_path = parts.path.rstrip("/")
        if base_path.endswith("/v1") and path.startswith("/v1/"):
            base_path = base_path[: -len("/v1")]
        query_string = urlencode({k: str(v) for k, v in (query or {}).items()})
        return urlunsplit((scheme, parts.netloc, base_path + path, query_string, ""))


async def resolve_headers_async(options: StreamOptions) -> dict[str, str]:
    result = options.headers()
    if inspect.isawaitable(result):
        result = await result
    return dict(result)


def resolve_headers_sync(options: StreamOptions) -> dict[str, str]:
    result = options.headers()
    if inspect.isawaitable(result):
        close = getattr(result, "close", None)
        if callable(close):
            close()  # don't leave a never-awaited coroutine behind
        raise UsageError("the headers provider is async; use the async client for streaming")
    return dict(result)


def split_user_agent(headers: Mapping[str, str], user_agent: str | None) -> tuple[dict[str, str], str | None]:
    """Separate ``User-Agent`` from the other headers (websockets sends it on its own)."""
    rest = {k: v for k, v in headers.items() if k.lower() != "user-agent"}
    found = next((v for k, v in headers.items() if k.lower() == "user-agent"), None)
    return rest, user_agent or found
