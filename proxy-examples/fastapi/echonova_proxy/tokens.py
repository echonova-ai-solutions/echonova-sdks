"""Short-lived stream tokens for browser WebSockets.

Browsers can't set an Authorization header on a WebSocket. A web app that doesn't rely on
cookies first calls POST {prefix}/stream-token with its normal credentials, then opens
wss://.../v1/...stream?access_token=<token> within the token's lifetime (60 s by default).
The proxy removes access_token from the URL before forwarding or logging it.

Format: base64url(user id) "." expiry (Unix seconds) "." base64url(HMAC-SHA256 of the first two).
The Express proxy uses the same format, so either proxy accepts the other's tokens when they
share PROXY_STREAM_TOKEN_SECRET.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import time


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(secret: bytes, payload: str) -> str:
    return _b64(hmac.new(secret, payload.encode("ascii"), hashlib.sha256).digest())


def mint_stream_token(user_id: str, secret: bytes, ttl: int, now: float | None = None) -> str:
    expires = int(now if now is not None else time.time()) + ttl
    payload = f"{_b64(user_id.encode('utf-8'))}.{expires}"
    return f"{payload}.{_sign(secret, payload)}"


def verify_stream_token(token: str, secret: bytes, now: float | None = None) -> str | None:
    """Return the user id, or None when the token is forged, malformed or expired."""
    parts = token.split(".")
    if len(parts) != 3 or not parts[1].isdigit() or len(token) > 512:
        return None
    payload = f"{parts[0]}.{parts[1]}"
    if not hmac.compare_digest(_sign(secret, payload), parts[2]):
        return None
    if int(parts[1]) <= (now if now is not None else time.time()):
        return None
    try:
        return _unb64(parts[0]).decode("utf-8") or None
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
