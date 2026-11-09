from __future__ import annotations

from typing import Any

import pytest

from _support import envelope, load_spec
from echonova import errors
from echonova._core._classifier import build_status_error, classify_response

RULES = load_spec("error-rules.json")
CATALOG = load_spec("fixtures/errors/catalog.json")["entries"]
CATCH_ALLS = {"client_error_other", "server_error_other", "rate_limited_other"}

# Which error family each documented status must land in.
FAMILY = {
    400: errors.InvalidRequestError,
    401: errors.AuthenticationError,
    402: errors.InsufficientBalanceError,
    403: errors.PermissionDeniedError,
    404: errors.NotFoundError,
    409: errors.InvalidRequestError,
    413: errors.InvalidRequestError,
    415: errors.InvalidRequestError,
    429: (errors.RateLimitError, errors.SpendingLimitError),
    500: errors.ServerError,
    503: errors.ServiceUnavailableError,
    504: errors.GatewayError,
}


def _response(vector: dict[str, Any]) -> tuple[dict[str, str], bytes]:
    headers = {"X-Request-Id": "req-123", "Content-Type": "application/json"}
    if vector["retry_after"]:
        headers["Retry-After"] = "30"
    if vector["json"]:
        body = envelope(vector["status"], vector["message"])
    else:
        headers["Content-Type"] = "text/plain"
        body = b"upstream request timeout"
    return headers, body


@pytest.mark.parametrize("vector", RULES["vectors"], ids=lambda v: f"{v['status']}-{v['expect_rule']}")
def test_rule_vectors(vector: dict[str, Any]) -> None:
    headers, body = _response(vector)
    rule, _ = classify_response(vector["status"], headers, body)
    assert rule.id == vector["expect_rule"]
    error = build_status_error(vector["status"], headers, body, method="POST")
    assert type(error).__name__ == vector["expect_error"]
    assert error.rule == vector["expect_rule"]
    assert error.request_id == "req-123"


@pytest.mark.parametrize("entry", CATALOG, ids=lambda e: f"{e['operation_id']}-{e['status']}-{e['example']}")
def test_every_documented_error_has_a_specific_rule(entry: dict[str, Any]) -> None:
    message = entry["error_message"]
    headers = {"X-Request-Id": "req-1"}
    if entry["status"] == 429 and message != "Monthly spending limit exhausted":
        headers["Retry-After"] = "12"  # the docs: a throttle 429 carries Retry-After, the spending 429 doesn't
    body = envelope(entry["status"], message, docs=entry["envelope"].get("docs"))
    rule, _ = classify_response(entry["status"], headers, body)
    assert rule.id not in CATCH_ALLS, f"documented error falls through to {rule.id}"
    error = build_status_error(entry["status"], headers, body, method=entry["method"])
    assert isinstance(error, FAMILY[entry["status"]])
    assert error.error_message == message  # kept verbatim, commas included
    assert error.docs_url == entry["envelope"].get("docs")


def test_error_code_and_message_are_surfaced() -> None:
    body = envelope(400, "The file is not valid.", errorCode="example_code")
    error = build_status_error(400, {"x-request-id": "r-9"}, body, method="POST")
    assert isinstance(error, errors.InvalidRequestError)
    assert error.error_code == "example_code"
    assert str(error) == "400 [example_code] The file is not valid. (request_id: r-9)"


def test_non_json_proxy_timeout_may_have_executed() -> None:
    error = build_status_error(504, {"content-type": "text/plain"}, b"upstream request timeout", method="POST")
    assert isinstance(error, errors.GatewayError)
    assert error.from_proxy is True
    assert error.may_have_executed is True
    assert error.error_message == "upstream request timeout"


@pytest.mark.parametrize(
    ("method", "expected"),
    [("POST", None), ("GET", False), ("DELETE", False)],
)
def test_may_have_executed_only_applies_to_post(method: str, expected: bool | None) -> None:
    error = build_status_error(500, {}, envelope(500, "Something went wrong"), method=method)
    assert error.may_have_executed is expected


def test_throttle_carries_retry_after() -> None:
    headers = {"Retry-After": "17"}
    error = build_status_error(429, headers, envelope(429, "ThrottlerException: Too Many Requests"), method="GET")
    assert isinstance(error, errors.RateLimitError)
    assert error.retry_after == 17.0


def test_empty_body_uses_reason_phrase() -> None:
    error = build_status_error(502, {}, b"", method="GET", reason_phrase="Bad Gateway")
    assert isinstance(error, errors.GatewayError)
    assert error.error_message == "Bad Gateway"
