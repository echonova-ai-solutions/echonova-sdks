"""Proxy settings, read from environment variables."""

from __future__ import annotations

import os
import secrets
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit

DEFAULT_UPSTREAM = "https://api.echonova.ai"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class ConfigError(ValueError):
    """The proxy is misconfigured and refuses to start."""


@dataclass(frozen=True)
class Settings:
    # The EchoNova API key. Only ever sent to `upstream_url`; never logged, never returned.
    api_key: str = field(repr=False)
    # Where EchoNova lives. HTTPS only, except for local test servers.
    upstream_url: str = DEFAULT_UPSTREAM
    # Path the proxy is mounted under. Apps use base_url = "https://your.host" + prefix.
    prefix: str = "/echonova"
    # Web origins allowed to call the proxy from a browser (CORS and the cross-site check).
    allowed_origins: frozenset[str] = frozenset()
    # Demo end-user auth only: the one static token the demo hook accepts. Replace the hook.
    demo_token: str | None = field(default=None, repr=False)
    # Cookie the demo hook reads the session from (browsers can't set headers on a WebSocket).
    session_cookie: str = "session"
    # Signs the short-lived stream tokens used as ?access_token= on WebSocket URLs.
    stream_token_secret: bytes = field(default_factory=lambda: secrets.token_bytes(32), repr=False)
    stream_token_ttl: int = 60
    # Demo quota: per user. The EchoNova workspace allows 10 concurrent streams in total.
    requests_per_minute: int = 60
    max_streams_per_user: int = 2
    max_streams_total: int = 10
    # Upload cap. The API takes files up to 150 MiB; this leaves room for multipart overhead.
    max_upload_bytes: int = 160 * 1024 * 1024
    # Upstream timeouts. Long synchronous calls (STT, Sound Cleaning) can take minutes.
    connect_timeout: float = 10.0
    read_timeout: float = 600.0

    def __post_init__(self) -> None:
        key = self.api_key.strip()
        if not key:
            raise ConfigError("ECHONOVA_API_KEY is not set")
        object.__setattr__(self, "api_key", key)
        object.__setattr__(self, "upstream_url", _check_upstream(self.upstream_url))
        object.__setattr__(self, "prefix", _check_prefix(self.prefix))

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        secret = env.get("PROXY_STREAM_TOKEN_SECRET", "")
        origins = frozenset(o.strip().rstrip("/") for o in env.get("PROXY_ALLOWED_ORIGINS", "").split(",") if o.strip())
        return cls(
            api_key=env.get("ECHONOVA_API_KEY", ""),
            upstream_url=env.get("ECHONOVA_UPSTREAM_URL", DEFAULT_UPSTREAM),
            prefix=env.get("PROXY_PREFIX", "/echonova"),
            allowed_origins=origins,
            demo_token=env.get("PROXY_DEMO_TOKEN") or None,
            session_cookie=env.get("PROXY_SESSION_COOKIE", "session"),
            stream_token_secret=secret.encode() if secret else secrets.token_bytes(32),
            requests_per_minute=_int(env, "PROXY_REQUESTS_PER_MINUTE", 60),
            max_streams_per_user=_int(env, "PROXY_MAX_STREAMS_PER_USER", 2),
            max_streams_total=_int(env, "PROXY_MAX_STREAMS_TOTAL", 10),
            max_upload_bytes=_int(env, "PROXY_MAX_UPLOAD_BYTES", 160 * 1024 * 1024),
        )

    @property
    def upstream_ws_url(self) -> str:
        scheme, rest = self.upstream_url.split("://", 1)
        return ("wss" if scheme == "https" else "ws") + "://" + rest


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be an integer") from None
    if value < 0:
        raise ConfigError(f"{name} must not be negative")
    return value


def _check_upstream(url: str) -> str:
    url = url.strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise ConfigError("ECHONOVA_UPSTREAM_URL must be an absolute https:// URL")
    if parts.scheme == "http" and parts.hostname not in LOCAL_HOSTS:
        raise ConfigError("ECHONOVA_UPSTREAM_URL must use https:// (the API key would travel in clear text)")
    if parts.path or parts.query or parts.fragment:
        raise ConfigError("ECHONOVA_UPSTREAM_URL must be the host only, without a path (routes include /v1)")
    return url


def _check_prefix(prefix: str) -> str:
    prefix = prefix.strip().rstrip("/")
    if prefix and (not prefix.startswith("/") or "?" in prefix or "//" in prefix):
        raise ConfigError("PROXY_PREFIX must look like /echonova")
    return prefix
