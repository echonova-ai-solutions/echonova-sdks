from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from echonova._core._envelope import (
    MalformedEnvelopeError,
    header,
    parse_error_body,
    parse_retry_after,
    unwrap_success,
)
from echonova._core._ratelimit import RateLimitTracker, parse_rate_limit


def test_unwrap_success() -> None:
    body = json.dumps({"data": {"jobId": "a1"}, "success": True, "statusCode": 200, "errorMessage": None}).encode()
    assert unwrap_success(body) == {"jobId": "a1"}


@pytest.mark.parametrize(
    "body",
    [b"<html>oops</html>", b"[1, 2]", b'{"jobId": "a1"}', b'{"data": null, "success": false}', b""],
)
def test_unwrap_rejects_non_envelopes(body: bytes) -> None:
    with pytest.raises(MalformedEnvelopeError):
        unwrap_success(body)


def test_parse_error_body_keeps_unknown_fields_out_of_the_way() -> None:
    body = json.dumps(
        {"data": None, "success": False, "statusCode": 400, "errorMessage": "a, b", "docs": "d", "newField": 1}
    ).encode()
    parsed = parse_error_body(body)
    assert parsed.is_json
    assert parsed.error_message == "a, b"
    assert parsed.docs_url == "d"


def test_parse_error_body_non_json() -> None:
    parsed = parse_error_body(b"  no healthy upstream  ")
    assert not parsed.is_json
    assert parsed.error_message == "no healthy upstream"


@pytest.mark.parametrize(
    ("value", "expected"),
    [("30", 30.0), ("0", 0.0), ("1.5", 1.5), (None, None), ("soon", None), ("-4", 0.0)],
)
def test_parse_retry_after(value: str | None, expected: float | None) -> None:
    assert parse_retry_after(value) == expected


def test_parse_retry_after_http_date() -> None:
    now = datetime(2026, 11, 5, 12, 0, 0, tzinfo=timezone.utc)
    assert parse_retry_after("Thu, 05 Nov 2026 12:00:45 GMT", now=now) == 45.0


def test_header_lookup_is_case_insensitive() -> None:
    assert header({"X-Request-Id": "abc"}, "x-request-id") == "abc"
    assert header({}, "x-request-id") is None


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_rate_limit_headers() -> None:
    info = parse_rate_limit({"X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "7", "X-RateLimit-Reset": "42"})
    assert info is not None
    assert (info.limit, info.remaining, info.reset_seconds) == (100, 7, 42.0)
    assert parse_rate_limit({}) is None


def test_preflight_waits_for_the_window_when_nothing_remains() -> None:
    clock = FakeClock()
    tracker = RateLimitTracker(clock=clock)
    tracker.observe(
        "tts.jobs.get", {"X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "20"}
    )
    assert tracker.wait_time("tts.jobs.get") == 20.0
    assert tracker.wait_time("tts.jobs.get", preflight=False) == 0.0
    assert tracker.wait_time("tts.jobs.list") == 0.0  # other endpoints have their own bucket
    clock.now += 21
    assert tracker.wait_time("tts.jobs.get") == 0.0


def test_throttle_block_applies_even_without_preflight() -> None:
    clock = FakeClock()
    tracker = RateLimitTracker(clock=clock)
    tracker.block("stt.transcribe", 60)
    clock.now += 15
    assert tracker.wait_time("stt.transcribe", preflight=False) == 45.0
    tracker.block("stt.transcribe", 10)  # a shorter block never shortens the current one
    assert tracker.wait_time("stt.transcribe") == 45.0
