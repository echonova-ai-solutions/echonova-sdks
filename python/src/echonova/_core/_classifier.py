"""Turn an HTTP error response (REST or WebSocket handshake) into an SDK exception."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime

from ..errors import ERROR_CLASSES, APIStatusError, Transport
from ._envelope import header, parse_error_body, parse_retry_after
from ._rules import Executed, Rule, RuleSet, load_rules


def executed_flag(value: Executed, method: str) -> bool | None:
    """``may_have_executed`` for an error: only a POST can have run and been charged."""
    if method.upper() != "POST":
        return False
    return {"no": False, "yes": True, "unknown": None}[value]


def classify_response(
    status: int,
    headers: Mapping[str, str],
    body: bytes,
    *,
    rules: RuleSet | None = None,
) -> tuple[Rule, float | None]:
    rules = rules or load_rules()
    parsed = parse_error_body(body)
    retry_after = parse_retry_after(header(headers, "retry-after"))
    rule = rules.classify(
        status,
        is_json=parsed.is_json,
        message=parsed.error_message if parsed.is_json else None,
        has_retry_after=retry_after is not None,
    )
    return rule, retry_after


def build_status_error(
    status: int,
    headers: Mapping[str, str],
    body: bytes,
    *,
    method: str,
    transport: Transport = "http",
    sent_at: datetime | None = None,
    reason_phrase: str | None = None,
    rules: RuleSet | None = None,
) -> APIStatusError:
    parsed = parse_error_body(body)
    rule, retry_after = classify_response(status, headers, body, rules=rules)
    error_class = ERROR_CLASSES[rule.error]
    if not issubclass(error_class, APIStatusError):
        raise TypeError(f"error rule {rule.id} maps to {rule.error}, which is not an APIStatusError")
    message = parsed.error_message or reason_phrase
    return error_class(
        status_code=status,
        error_message=message,
        error_code=parsed.error_code,
        request_id=header(headers, "x-request-id"),
        docs_url=parsed.docs_url,
        headers=dict(headers.items()),
        raw_body=parsed.raw_body,
        transport=transport,
        retry_after=retry_after,
        may_have_executed=executed_flag(rule.may_have_executed, method),
        rule=rule.id,
        sent_at=sent_at,
        from_proxy=rule.from_proxy,
    )
