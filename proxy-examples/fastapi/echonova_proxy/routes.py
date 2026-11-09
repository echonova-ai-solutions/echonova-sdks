"""The allow-list: the only EchoNova routes the proxy forwards.

These are the speech routes of the public API spec (Text to Speech, Speech to Text and
Sound Cleaning). A test checks this table against spec/openapi.json and spec/asyncapi.json.
Delete the rows your app doesn't use.

Deliberately left out: POST /v1/widgets/{publicId}/tickets. Minting a widget ticket is a
call your own backend makes directly with the API key, never something an app should reach.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

REST_ROUTES: tuple[tuple[str, str], ...] = (
    ("POST", "/v1/text-to-speech"),
    ("POST", "/v1/text-to-speech/sync"),
    ("GET", "/v1/text-to-speech/voices"),
    ("GET", "/v1/text-to-speech/jobs"),
    ("GET", "/v1/text-to-speech/jobs/{jobId}"),
    ("DELETE", "/v1/text-to-speech/jobs/{jobId}"),
    ("POST", "/v1/speech-to-text"),
    ("POST", "/v1/speech-to-text/sync"),
    ("GET", "/v1/speech-to-text/jobs"),
    ("GET", "/v1/speech-to-text/jobs/{jobId}"),
    ("DELETE", "/v1/speech-to-text/jobs/{jobId}"),
    ("GET", "/v1/speech-to-text/jobs/{jobId}/export"),
    ("POST", "/v1/sound-cleaning"),
    ("GET", "/v1/sound-cleaning/jobs"),
    ("GET", "/v1/sound-cleaning/jobs/{jobId}"),
    ("DELETE", "/v1/sound-cleaning/jobs/{jobId}"),
)

# WebSocket streams, with the query parameters forwarded upstream (everything else is dropped).
STREAM_ROUTES: dict[str, tuple[str, ...]] = {
    "/v1/text-to-speech/stream": (),
    "/v1/speech-to-text/stream": ("sample_rate", "language", "encoding"),
}

# A path parameter is one plain segment. Anything else (percent-encoding, dots, slashes)
# doesn't match, so a crafted ID can never steer the request to another upstream path.
_PARAM = r"[A-Za-z0-9_-]{1,128}"


def _compile(template: str) -> re.Pattern[str]:
    parts = re.split(r"(\{[A-Za-z]+\})", template)
    body = "".join(_PARAM if p.startswith("{") else re.escape(p) for p in parts)
    return re.compile(f"^{body}$")


@dataclass(frozen=True)
class RestMatch:
    template: str | None  # the matched route, e.g. /v1/text-to-speech/jobs/{jobId}
    allowed: tuple[str, ...]  # methods the path accepts; empty when the path is unknown

    @property
    def found(self) -> bool:
        return self.template is not None


_PATTERNS = [(method, template, _compile(template)) for method, template in REST_ROUTES]


def match_rest(method: str, path: str) -> RestMatch:
    """Match a raw (still percent-encoded) path such as /v1/text-to-speech/sync."""
    allowed: list[str] = []
    template = None
    for route_method, route_template, pattern in _PATTERNS:
        if pattern.match(path):
            allowed.append(route_method)
            if route_method == method:
                template = route_template
    return RestMatch(template, tuple(allowed))
