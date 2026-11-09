"""Load the shared error-classification and retry rules (``spec/error-rules.json``).

The JSON file is the same in every EchoNova SDK. This module only parses it and
answers "which rule matches this response?"; deciding whether to retry is in
``_retry``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache
from importlib import resources
from typing import Any, Literal

RetryFlag = bool | Literal["once", "opt_in"]
Delay = Literal["none", "backoff", "retry_after", "retry_after_or_backoff"]
Executed = Literal["no", "yes", "unknown"]

_COLUMNS = ("GET", "DELETE", "POST", "WS")


@dataclass(frozen=True, slots=True)
class RetryColumns:
    get: RetryFlag
    delete: RetryFlag
    post: RetryFlag
    ws: RetryFlag
    delay: Delay

    def for_method(self, method: str) -> RetryFlag:
        method = method.upper()
        if method in ("GET", "HEAD"):
            return self.get
        if method == "DELETE":
            return self.delete
        if method == "WS":
            return self.ws
        return self.post  # POST, and any other method, is treated as non-idempotent

    @classmethod
    def parse(cls, data: dict[str, Any]) -> RetryColumns:
        missing = [c for c in (*_COLUMNS, "delay") if c not in data]
        if missing:
            raise ValueError(f"retry columns missing {missing}")
        return cls(get=data["GET"], delete=data["DELETE"], post=data["POST"], ws=data["WS"], delay=data["delay"])


@dataclass(frozen=True, slots=True)
class Rule:
    id: str
    row: str
    error: str
    retry: RetryColumns
    may_have_executed: Executed
    statuses: frozenset[int] | None = None
    status_range: tuple[int, int] | None = None
    message_equals: str | None = None
    message_prefix: str | None = None
    message_suffix: str | None = None
    message_contains: str | None = None
    json: bool | None = None
    retry_after: bool | None = None
    blocks_bucket: bool = False
    from_proxy: bool = False

    def matches(self, status: int, *, is_json: bool, message: str | None, has_retry_after: bool) -> bool:
        if self.statuses is not None and status not in self.statuses:
            return False
        if self.status_range is not None and not self.status_range[0] <= status <= self.status_range[1]:
            return False
        if self.json is not None and self.json != is_json:
            return False
        if self.retry_after is not None and self.retry_after != has_retry_after:
            return False
        text = message.strip() if message is not None else None
        checks = (
            (self.message_equals, lambda t, v: t == v),
            (self.message_prefix, lambda t, v: t.startswith(v)),
            (self.message_suffix, lambda t, v: t.endswith(v)),
            (self.message_contains, lambda t, v: v in t),
        )
        for expected, check in checks:
            if expected is not None and (text is None or not check(text, expected)):
                return False
        return True

    @classmethod
    def parse(cls, data: dict[str, Any]) -> Rule:
        match = data["match"]
        status = match.get("status")
        statuses = None if status is None else frozenset(status if isinstance(status, list) else [status])
        bounds = match.get("status_range")
        status_range = (int(bounds[0]), int(bounds[1])) if bounds else None
        return cls(
            id=data["id"],
            row=data["row"],
            error=data["error"],
            retry=RetryColumns.parse(data["retry"]),
            may_have_executed=data["may_have_executed"],
            statuses=statuses,
            status_range=status_range,
            message_equals=match.get("message_equals"),
            message_prefix=match.get("message_prefix"),
            message_suffix=match.get("message_suffix"),
            message_contains=match.get("message_contains"),
            json=match.get("json"),
            retry_after=match.get("retry_after"),
            blocks_bucket=bool(data.get("blocks_bucket", False)),
            from_proxy=bool(data.get("from_proxy", False)),
        )


@dataclass(frozen=True, slots=True)
class TransportRule:
    row: str
    phase: str
    error: str
    retry: RetryColumns
    may_have_executed: Executed


@dataclass(frozen=True, slots=True)
class Defaults:
    max_retries: int
    backoff_initial: float
    backoff_multiplier: float
    backoff_max: float
    backoff_jitter: tuple[float, float]
    retry_after_jitter: tuple[float, float]
    max_retry_after: float
    ws_max_retry_after: float


@dataclass(frozen=True, slots=True)
class RuleSet:
    version: int
    taxonomy: dict[str, str | None]
    rules: tuple[Rule, ...]
    transport: dict[str, TransportRule]
    defaults: Defaults

    def classify(self, status: int, *, is_json: bool, message: str | None, has_retry_after: bool) -> Rule:
        for rule in self.rules:
            if rule.matches(status, is_json=is_json, message=message, has_retry_after=has_retry_after):
                return rule
        raise LookupError(f"no error rule matches status {status}")  # the rules end with catch-alls


def parse_rules(data: dict[str, Any]) -> RuleSet:
    defaults = data["defaults"]
    backoff = defaults["backoff"]
    transport = {
        row["phase"]: TransportRule(
            row=row["row"],
            phase=row["phase"],
            error=row["error"],
            retry=RetryColumns.parse(row["retry"]),
            may_have_executed=row["may_have_executed"],
        )
        for row in data["transport"]
    }
    return RuleSet(
        version=int(data["version"]),
        taxonomy=dict(data["taxonomy"]),
        rules=tuple(Rule.parse(rule) for rule in data["rules"]),
        transport=transport,
        defaults=Defaults(
            max_retries=int(defaults["max_retries"]),
            backoff_initial=float(backoff["initial_seconds"]),
            backoff_multiplier=float(backoff["multiplier"]),
            backoff_max=float(backoff["max_seconds"]),
            backoff_jitter=(float(backoff["jitter"][0]), float(backoff["jitter"][1])),
            retry_after_jitter=(
                float(defaults["retry_after_jitter_seconds"][0]),
                float(defaults["retry_after_jitter_seconds"][1]),
            ),
            max_retry_after=float(defaults["max_retry_after_seconds"]),
            ws_max_retry_after=float(defaults["ws_handshake_max_retry_after_seconds"]),
        ),
    )


@cache
def load_rules() -> RuleSet:
    text = resources.files("echonova").joinpath("_data").joinpath("error-rules.json").read_text(encoding="utf-8")
    return parse_rules(json.loads(text))
