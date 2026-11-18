"""Pieces shared by the REST and WebSocket relays."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass

import httpx

from .config import Settings
from .hooks import Authenticate, JobOwners, Quota

PROXY_USER_AGENT = "echonova-proxy/0.1 (fastapi)"

# Request headers copied from the app's request. Everything else is dropped, including
# Authorization, Cookie, hop-by-hop headers and X-Forwarded-*. The proxy sets its own
# Authorization (the API key) and X-Request-Id.
# Idempotency-Key makes a retried synthesis, transcription or cleaning return the first result
# instead of running (and charging) twice. It is forwarded scoped to the user (scoped_idempotency_key).
FORWARDED_REQUEST_HEADERS = ("accept", "content-type", "idempotency-key")

# What the API accepts as an Idempotency-Key: 1 to 200 printable ASCII characters, no spaces.
_IDEMPOTENCY_KEY = re.compile(r"[\x21-\x7e]{1,200}")

# Response headers copied from EchoNova's response. Everything else is dropped
# (Set-Cookie, Server, upstream CORS headers, ...).
SAFE_RESPONSE_HEADERS = frozenset({"content-type", "content-disposition", "retry-after", "x-request-id"})
SAFE_RESPONSE_PREFIXES = ("x-ratelimit-",)

EXPOSED_HEADERS = (
    "Content-Disposition, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Request-Id"
)

# Where the origin middleware leaves a WebSocket's ?access_token= after removing it from the URL.
STREAM_TOKEN_SCOPE_KEY = "echonova_proxy.stream_token"  # noqa: S105 (a name, not a secret)
STREAM_TOKEN_PARAM = "access_token"  # noqa: S105 (a name, not a secret)

_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


@dataclass
class Proxy:
    settings: Settings
    authenticate: Authenticate
    quota: Quota
    jobs: JobOwners
    client: httpx.AsyncClient


def request_id(incoming: str | None) -> str:
    """The app's X-Request-Id when it is a plain token, otherwise a fresh one."""
    if incoming and _REQUEST_ID.match(incoming):
        return incoming
    return str(uuid.uuid4())


def scoped_idempotency_key(key: str, user_id: str, secret: bytes) -> str:
    """The Idempotency-Key sent upstream for the app's key: hex HMAC-SHA256(secret, user_id + "\\0" + key).

    The API keeps one set of keys per workspace, and every user of the proxy shares the workspace.
    Forwarded as-is, a key another user sent first would return that user's job. Scoped, the same
    user always gets the same upstream key (so retries stay safe) and different users never share
    one. The secret must be the same on every instance and across restarts, or a retry after a
    restart runs (and charges) again: set PROXY_STREAM_TOKEN_SECRET.
    A key the API would refuse is forwarded unchanged, so the app gets the API's own 400.
    """
    if not _IDEMPOTENCY_KEY.fullmatch(key):
        return key
    return hmac.new(secret, f"{user_id}\0{key}".encode(), hashlib.sha256).hexdigest()


def strip_prefix(raw_path: str, prefix: str) -> str | None:
    """'/echonova/v1/x' -> '/v1/x'; None when the path is outside the prefix."""
    if not prefix:
        return raw_path
    if raw_path.startswith(prefix + "/"):
        return raw_path[len(prefix) :]
    return None


def is_safe_response_header(name: str) -> bool:
    name = name.lower()
    return name in SAFE_RESPONSE_HEADERS or name.startswith(SAFE_RESPONSE_PREFIXES)


def safe_response_headers(headers: Iterable[tuple[str, str]]) -> list[tuple[str, str]]:
    return [(name.lower(), value) for name, value in headers if is_safe_response_header(name)]


def user_agent(incoming: str | None) -> str:
    return f"{incoming} {PROXY_USER_AGENT}" if incoming else PROXY_USER_AGENT


def error_body(status: int, message: str) -> bytes:
    """The EchoNova error envelope, so the SDKs map proxy errors like API errors."""
    return json.dumps({"data": None, "success": False, "statusCode": status, "errorMessage": message}).encode()


# Messages the SDKs already understand: 429 + Retry-After is a rate limit to wait out,
# 429 "Too many concurrent streams" is a concurrency limit, 503 "...temporarily unavailable"
# means nothing reached EchoNova, so retrying is safe.
MESSAGES = {
    401: "Unauthorized",
    403: "Origin not allowed",
    404: "Route not found",
    405: "Method not allowed",
    413: "Request body too large",
    426: "This route needs a WebSocket upgrade",
    429: "Too many requests",
    502: "Bad gateway: the EchoNova API connection failed",
    503: "The EchoNova API is temporarily unavailable. Try again.",
    504: "Gateway timeout: the EchoNova API did not answer in time",
}
TOO_MANY_STREAMS = "Too many concurrent streams"
UNEXPECTED_REDIRECT = "Bad gateway: unexpected redirect from the EchoNova API"
