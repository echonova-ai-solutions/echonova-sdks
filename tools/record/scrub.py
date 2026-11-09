"""Remove secrets and identifying data from recorded API traffic before it becomes a fixture.

Every recorded value passes through a Scrubber:
- API keys (ek_...) and webhook secrets (whsec_...) are replaced.
- Signed storage links lose their host and query string.
- 24-hex IDs (jobs, voices, keys, segments) and UUIDs (request and session IDs)
  become stable placeholders, so a fixture stays internally consistent
  (the same job ID maps to the same placeholder everywhere in one recording).
- Named fields that can identify a customer (key names, workspace names) are replaced.
- Only allow-listed response headers are kept.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit

API_KEY = re.compile(r"(?<![A-Za-z0-9_])ek_[A-Za-z0-9_\-]{8,}")
WEBHOOK_SECRET = re.compile(r"(?<![A-Za-z0-9_])whsec_[A-Za-z0-9_\-]{8,}")
OBJECT_ID = re.compile(r"\b[0-9a-f]{24}\b")
UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
URL = re.compile(r"https?://[^\s\"'<>]+")

PLACEHOLDER_STORAGE_HOST = "storage.example.com"
API_HOSTS = {"api.echonova.ai", "echonova.ai", "www.echonova.ai"}
SENSITIVE_FIELDS = {"apiKeyName", "workspaceName", "email", "userName", "name_of_key"}

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

    def _object_id(self, match: re.Match[str]) -> str:
        value = match.group(0)
        if value in self._ids.values():
            return value  # already a placeholder: scrubbing twice changes nothing
        if value not in self._ids:
            self._ids[value] = f"{len(self._ids) + 1:024x}"
        return self._ids[value]

    def _uuid(self, match: re.Match[str]) -> str:
        value = match.group(0).lower()
        if value in self._uuids.values():
            return value
        if value not in self._uuids:
            self._uuids[value] = f"00000000-0000-4000-8000-{len(self._uuids) + 1:012x}"
        return self._uuids[value]

    def _url(self, match: re.Match[str]) -> str:
        parts = urlsplit(match.group(0))
        host = (parts.hostname or "").lower()
        if host in API_HOSTS:
            return urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))
        # Anything else is a storage link: the host names the storage account and the query is the signature.
        query = "signature=REDACTED" if parts.query else ""
        return urlunsplit(("https", PLACEHOLDER_STORAGE_HOST, parts.path, query, ""))

    def text(self, value: str) -> str:
        value = API_KEY.sub("ek_REDACTED", value)
        value = WEBHOOK_SECRET.sub("whsec_REDACTED", value)
        value = URL.sub(self._url, value)
        value = UUID.sub(self._uuid, value)
        return OBJECT_ID.sub(self._object_id, value)

    def value(self, value: Any, *, key: str | None = None) -> Any:
        if key in SENSITIVE_FIELDS and isinstance(value, str):
            return "REDACTED"
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, dict):
            return {k: self.value(v, key=k) for k, v in value.items()}
        if isinstance(value, list):
            return [self.value(v) for v in value]
        return value

    def headers(self, headers: Any) -> dict[str, str]:
        kept = {}
        for name, value in headers.items():
            if name.lower() in KEEP_HEADERS:
                kept[name.lower()] = self.text(value)
        return kept


def find_leaks(text: str) -> list[str]:
    """Patterns that must never appear in a committed fixture."""
    problems = []
    # Documentation examples on example.com/example.org are not real links.
    text = re.sub(r"https?://[^\s\"'<>]*\bexample\.(?:com|org)[^\s\"'<>]*", "", text)
    if re.search(r"(?<![A-Za-z0-9_])ek_(?!REDACTED)[A-Za-z0-9_\-]{8,}", text):
        problems.append("API key")
    if re.search(r"(?<![A-Za-z0-9_])whsec_(?!REDACTED|TEST)[A-Za-z0-9_\-]{8,}", text):
        problems.append("webhook secret")
    if re.search(r"(?i)[?&](sig|signature|se|sv|sp|skoid|X-Amz-Signature)=(?!REDACTED)[^&\"\s]+", text):
        problems.append("signed URL query")
    if re.search(r"\.blob\.core\.windows\.net|\.s3[.-][a-z0-9-]*\.?amazonaws\.com", text):
        problems.append("storage hostname")
    if re.search(r"(?i)bearer\s+(?!ek_REDACTED)[A-Za-z0-9_\-.=]{20,}", text):
        problems.append("bearer token")
    return problems
