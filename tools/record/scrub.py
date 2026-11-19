"""Remove secrets and identifying data from recorded API traffic before it becomes a fixture.

Every recorded value passes through a Scrubber:
- API keys (ek_...) and webhook secrets (whsec_...) are replaced.
- Signed storage links lose their host, path and query string: only the file
  extension is kept (https://storage.example.com/files/1.wav). The path names the
  storage container and how files are laid out in it, which is not public.
- Stream links (ws:// and wss://) to a host other than the API lose host, path and query.
  On API links, query parameters with a sensitive name (token, ticket, ...) are replaced.
- JWTs (eyJ....eyJ....) and email addresses are replaced wherever they appear.
- 24-hex IDs (jobs, voices, keys, segments) and UUIDs (request and session IDs)
  become stable placeholders, so a fixture stays internally consistent
  (the same job ID maps to the same placeholder everywhere in one recording).
- Fields that can identify a customer or hold a credential are replaced: the names in
  SENSITIVE_FIELDS, and any name containing token, secret, ticket, password, email, apikey,
  api_key or authorization, in any case. Dict keys are scrubbed like values.
- Only allow-listed response headers are kept.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

API_KEY = re.compile(r"(?<![A-Za-z0-9_])ek_[A-Za-z0-9_\-]{8,}")
WEBHOOK_SECRET = re.compile(r"(?<![A-Za-z0-9_])whsec_[A-Za-z0-9_\-]{8,}")
OBJECT_ID = re.compile(r"\b[0-9a-f]{24}\b")
UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
URL = re.compile(r"(?:https?|wss?)://[^\s\"'<>]+")
JWT = re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*")
EMAIL = re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")

PLACEHOLDER_STORAGE_HOST = "storage.example.com"
PLACEHOLDER_STREAM_HOST = "stream.example.com"
PLACEHOLDER_EMAIL = "user@example.com"
PLACEHOLDER_JWT = "REDACTED_JWT"
# What placeholders look like, so scrubbing an already scrubbed fixture changes nothing.
PLACEHOLDER_OBJECT_ID = re.compile(r"0{12}[0-9a-f]{12}")
PLACEHOLDER_UUID = re.compile(r"00000000-0000-4000-8000-[0-9a-f]{12}")
PLACEHOLDER_FILE_PATH = re.compile(r"/files/\d+(\.[a-z0-9]{1,5})?")
FILE_EXTENSION = re.compile(r"\.[A-Za-z0-9]{1,5}$")
API_HOSTS = {"api.echonova.ai", "echonova.ai", "www.echonova.ai"}
# Field and query parameter names, compared in lower case.
SENSITIVE_FIELDS = {"apikeyname", "workspacename", "email", "username", "name_of_key", "token", "ticket"}
SENSITIVE_NAME = re.compile(r"token|secret|ticket|password|email|api[-_]?key|authorization", re.IGNORECASE)
# What the recorder itself writes in a request's "authorization" field: which credential it sent,
# never the credential. The replay tests read these.
RECORDER_MARKERS = {"none", "set", "test key", "other key", "REDACTED"}

KEEP_HEADERS = {
    "content-type",
    "content-disposition",
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-request-id",
    "x-sample-rate",
    "cache-control",
}


class Scrubber:
    def __init__(self) -> None:
        self._ids: dict[str, str] = {}
        self._uuids: dict[str, str] = {}
        self._paths: dict[str, int] = {}

    def _object_id(self, match: re.Match[str]) -> str:
        value = match.group(0)
        if PLACEHOLDER_OBJECT_ID.fullmatch(value):
            return value  # already a placeholder: scrubbing twice changes nothing
        if value not in self._ids:
            self._ids[value] = f"{len(self._ids) + 1:024x}"
        return self._ids[value]

    def _uuid(self, match: re.Match[str]) -> str:
        value = match.group(0).lower()
        if PLACEHOLDER_UUID.fullmatch(value):
            return value
        if value not in self._uuids:
            self._uuids[value] = f"00000000-0000-4000-8000-{len(self._uuids) + 1:012x}"
        return self._uuids[value]

    def _url(self, match: re.Match[str]) -> str:
        parts = urlsplit(match.group(0))
        host = (parts.hostname or "").lower()
        if host in API_HOSTS:
            return urlunsplit((parts.scheme, parts.netloc, parts.path, _scrub_query(parts.query), ""))
        if parts.scheme in ("ws", "wss"):
            # A stream on another host (a media server, say): its host, path and query are not public.
            return urlunsplit((parts.scheme, PLACEHOLDER_STREAM_HOST, "", "token=REDACTED" if parts.query else "", ""))
        # Anything else is a storage link: the host names the storage account, the path its container and
        # layout, and the query is the signature. Only the file extension survives.
        query = "signature=REDACTED" if parts.query else ""
        if host == PLACEHOLDER_STORAGE_HOST and PLACEHOLDER_FILE_PATH.fullmatch(parts.path):
            path = parts.path
        else:
            number = self._paths.setdefault(parts.path, len(self._paths) + 1)
            extension = FILE_EXTENSION.search(parts.path)
            path = f"/files/{number}{extension.group(0).lower() if extension else ''}"
        return urlunsplit(("https", PLACEHOLDER_STORAGE_HOST, path, query, ""))

    def text(self, value: str) -> str:
        value = API_KEY.sub("ek_REDACTED", value)
        value = WEBHOOK_SECRET.sub("whsec_REDACTED", value)
        value = URL.sub(self._url, value)
        value = JWT.sub(PLACEHOLDER_JWT, value)
        value = EMAIL.sub(PLACEHOLDER_EMAIL, value)
        value = UUID.sub(self._uuid, value)
        return OBJECT_ID.sub(self._object_id, value)

    def value(self, value: Any, *, key: str | None = None) -> Any:
        if key is not None and is_sensitive(key) and isinstance(value, str) and value not in RECORDER_MARKERS:
            return "REDACTED"
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, dict):
            return {self.text(k) if isinstance(k, str) else k: self.value(v, key=k) for k, v in value.items()}
        if isinstance(value, list):
            # A list under a sensitive name (secrets: [...]) is as sensitive as its name.
            return [self.value(v, key=key if key is not None and is_sensitive(key) else None) for v in value]
        return value

    def headers(self, headers: Any) -> dict[str, str]:
        kept = {}
        for name, value in headers.items():
            if name.lower() in KEEP_HEADERS:
                kept[name.lower()] = self.text(value)
        return kept


def is_sensitive(name: str) -> bool:
    """Does a field or query parameter with this name hold a credential or identify someone?"""
    return name.lower() in SENSITIVE_FIELDS or SENSITIVE_NAME.search(name) is not None


def _scrub_query(query: str) -> str:
    if not query:
        return query
    pairs = parse_qsl(query, keep_blank_values=True)
    if not any(is_sensitive(name) for name, _ in pairs):
        return query  # left exactly as recorded
    return urlencode([(name, "REDACTED" if is_sensitive(name) else value) for name, value in pairs], safe="/:")


def find_leaks(text: str, *, fixture: bool = False) -> list[str]:
    """Patterns that must never appear in a committed file.

    ``fixture=True`` also requires every storage link to have a placeholder path, as the scrubber
    writes it: a recorded path names the storage container and its layout. Documentation can use
    any example path. It also refuses email addresses outside example domains: recorded traffic
    has no business holding one, while the packages' own metadata names a maintainer address.
    """
    problems = []
    if fixture and re.search(r"https?://storage\.example\.com/(?!files/\d+(?:\.[a-z0-9]{1,5})?(?![\w./%-]))", text):
        problems.append("storage path")
    if fixture and any(
        not re.search(r"@(?:[\w-]+\.)*example\.(?:com|org|net)$", email, re.IGNORECASE) for email in EMAIL.findall(text)
    ):
        problems.append("email address")
    if JWT.search(text):
        problems.append("JWT")
    # Documentation examples on example.com/example.org are not real links.
    text = re.sub(r"https?://[^\s\"'<>]*\bexample\.(?:com|org)[^\s\"'<>]*", "", text)
    if re.search(r"(?<![A-Za-z0-9_])ek_(?!REDACTED)[A-Za-z0-9_\-]{8,}", text):
        problems.append("API key")
    if re.search(r"(?<![A-Za-z0-9_])whsec_(?!REDACTED|TEST)[A-Za-z0-9_\-]{8,}", text):
        problems.append("webhook secret")
    if re.search(r"(?i)[?&](sig|signature|se|sv|sp|skoid|X-Amz-Signature)=(?!REDACTED|\.\.\.|…)[^&\"\s]+", text):
        problems.append("signed URL query")
    if re.search(r"\.blob\.core\.windows\.net|\.s3[.-][a-z0-9-]*\.?amazonaws\.com", text):
        problems.append("storage hostname")
    if re.search(r"(?i)bearer\s+(?!ek_REDACTED)[A-Za-z0-9_\-.=]{20,}", text):
        problems.append("bearer token")
    return problems
