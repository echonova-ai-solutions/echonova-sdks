"""Client configuration: defaults, environment variables, timeouts and redaction."""

from __future__ import annotations

import os
import platform
import random
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from ._version import __version__
from .errors import UsageError

DEFAULT_BASE_URL = "https://api.echonova.ai"
DEFAULT_MAX_RETRIES = 2
DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_STREAM_KEEPALIVE = 30.0  # seconds without sending before a stream sends a ping
API_KEY_ENV = "ECHONOVA_API_KEY"
BASE_URL_ENV = "ECHONOVA_BASE_URL"


@dataclass(frozen=True, slots=True)
class Timeout:
    """Per-phase timeouts in seconds. ``None`` keeps the SDK's default for each operation.

    ``connect`` covers opening the connection, ``write`` each write of the request
    body, ``read`` each wait for response bytes, and ``pool`` waiting for a free
    connection. Passing a plain number as ``timeout`` sets all four.
    """

    connect: float | None = None
    read: float | None = None
    write: float | None = None
    pool: float | None = None

    @classmethod
    def coerce(cls, value: float | Timeout | None) -> Timeout | None:
        if value is None or isinstance(value, Timeout):
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise UsageError(f"timeout must be a number of seconds or a Timeout, not {type(value).__name__}")
        seconds = float(value)
        return cls(connect=seconds, read=seconds, write=seconds, pool=seconds)

    def overlay(self, other: Timeout | None) -> Timeout:
        if other is None:
            return self
        return Timeout(
            connect=self.connect if other.connect is None else other.connect,
            read=self.read if other.read is None else other.read,
            write=self.write if other.write is None else other.write,
            pool=self.pool if other.pool is None else other.pool,
        )


@dataclass(frozen=True, slots=True)
class Runtime:
    """Clocks and sleeps used by the client. Tests replace them to run without real waiting."""

    clock: Callable[[], float] = time.monotonic
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    sleep: Callable[[float], Any] = time.sleep
    async_sleep: Callable[[float], Any] | None = None  # asyncio.sleep when None
    random: Callable[[], float] = random.random


def resolve_api_key(api_key: str | None, *, use_env: bool) -> str | None:
    if api_key is None and use_env:
        api_key = os.environ.get(API_KEY_ENV)
    if api_key is None:
        return None
    if not isinstance(api_key, str):
        raise UsageError("api_key must be a string")
    return api_key.strip() or None


def resolve_base_url(base_url: str | None) -> str:
    url = base_url or os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise UsageError(f"base_url must be an http(s) URL, got {url!r}")
    if parts.query or parts.fragment:
        raise UsageError("base_url must not have a query string or fragment")
    return urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))


def ws_base_url(base_url: str) -> str:
    """The WebSocket base for ``base_url``: ``https`` becomes ``wss`` and ``http`` becomes ``ws``."""
    parts = urlsplit(base_url)
    scheme = "wss" if parts.scheme == "https" else "ws"
    return urlunsplit((scheme, parts.netloc, parts.path, "", ""))


def is_default_host(base_url: str) -> bool:
    return urlsplit(base_url).netloc == urlsplit(DEFAULT_BASE_URL).netloc


def redact_key(api_key: str | None) -> str | None:
    """Show an API key as ``ek_…c21d``: enough to tell keys apart, useless to an attacker."""
    if not api_key:
        return None
    if len(api_key) < 12:
        return "…"
    prefix = "ek_" if api_key.startswith("ek_") else ""
    return f"{prefix}…{api_key[-4:]}"


def user_agent() -> str:
    system = platform.system().lower() or "unknown"
    return f"echonova-python/{__version__} (python/{platform.python_version()}; {system})"


def merge_headers(*sources: Mapping[str, str] | None) -> dict[str, str]:
    """Merge header mappings; later ones win, compared case-insensitively."""
    merged: dict[str, str] = {}
    names: dict[str, str] = {}
    for source in sources:
        for name, value in (source or {}).items():
            previous = names.get(name.lower())
            if previous is not None:
                del merged[previous]
            names[name.lower()] = name
            merged[name] = value
    return merged
