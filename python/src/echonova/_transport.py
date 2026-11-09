"""Actions exchanged between the shared request logic and the sync/async drivers.

Request logic is written once, as generators that ``yield`` actions (send this
request, sleep this long, call this function) and receive the outcome. The
blocking client and the asyncio client each run the same generators with their
own I/O, so retries, rate limits and polling behave identically in both.
"""

from __future__ import annotations

from collections.abc import Callable, Generator
from dataclasses import dataclass
from typing import IO, Any, TypeVar

import httpx

from .errors import EchoNovaError, TimeoutKind, UsageError

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class Sleep:
    seconds: float


@dataclass(frozen=True, slots=True)
class Send:
    """Send ``request``. The driver answers with the ``httpx.Response`` (body read) or the ``httpx`` exception.

    With ``download`` set, it goes through the download client, which has no API
    credentials. With ``sink`` set, a 2xx body is streamed into it.
    """

    request: httpx.Request
    download: bool = False
    sink: IO[bytes] | None = None


@dataclass(frozen=True, slots=True)
class Authenticate:
    """The driver answers with the auth headers for one attempt."""


@dataclass(frozen=True, slots=True)
class Call:
    """Call ``fn`` (awaiting the result on the async client); the driver answers with the value or a ``Failure``."""

    fn: Callable[[], Any]


@dataclass(frozen=True, slots=True)
class Failure:
    error: EchoNovaError


Action = Sleep | Send | Authenticate | Call
Flow = Generator[Action, Any, T]


def classify_exception(exc: Exception) -> tuple[str | None, TimeoutKind | None]:
    """Map an ``httpx`` exception to a retry phase and timeout kind.

    Phases: ``connect`` (nothing sent), ``send_incomplete`` (the body was not fully
    written, so the request can't have run), ``no_response`` (fully sent, no
    answer: it may have run). ``None`` means a local error that retrying won't fix.
    """
    if isinstance(exc, httpx.UnsupportedProtocol):
        raise UsageError(f"unsupported URL: {exc}") from exc
    if isinstance(exc, httpx.ConnectTimeout):
        return "connect", "connect"
    if isinstance(exc, httpx.PoolTimeout):
        return "connect", "pool"
    if isinstance(exc, (httpx.ConnectError, httpx.ProxyError)):
        return "connect", None
    if isinstance(exc, httpx.WriteTimeout):
        return "send_incomplete", "write"
    if isinstance(exc, httpx.WriteError):
        return "send_incomplete", None
    if isinstance(exc, httpx.LocalProtocolError):
        return None, None
    if isinstance(exc, httpx.TimeoutException):
        return "no_response", "read"
    return "no_response", None  # read errors, resets, RemoteProtocolError, anything unknown: assume it was sent


PHASE_MESSAGES = {
    "connect": "Could not connect to {target}",
    "send_incomplete": "The connection failed while sending the request to {target}; it did not run",
    "no_response": "No response from {target} after the request was sent",
}
