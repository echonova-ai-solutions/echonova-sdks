"""Transport rules: frame limits, keepalive/liveness timing, attempt limits, handshake retries, closes."""

from __future__ import annotations

import json

import pytest
from stream_helpers import FastRetry

from echonova import (
    APIConnectionError,
    APITimeoutError,
    AuthenticationError,
    ConcurrencyLimitError,
    FeatureNotEnabledError,
    InsufficientBalanceError,
    ProtocolError,
    RateLimitError,
    ServerRestartingError,
    ServiceUnavailableError,
    SessionExpiredError,
    SpendingLimitError,
    StreamClosedError,
    StreamConnectionLostError,
    UpstreamError,
    UsageError,
)
from echonova._streaming import StreamOptions
from echonova._streaming._errors import CloseInfo, close_error, error_from_frame
from echonova._streaming._link import (
    MAX_JSON_FRAME_BYTES,
    AttemptLimiter,
    HandshakeRetry,
    Liveness,
    decode_event,
    encode_json,
)


def envelope(status: int, message: str) -> bytes:
    return json.dumps({"data": None, "success": False, "statusCode": status, "errorMessage": message}).encode()


# --- Frames ---------------------------------------------------------------------------------------


def test_json_frames_over_64_kib_raise_usage_error() -> None:
    overhead = len(encode_json({"type": "terminology", "terminology": ""}))
    fits = {"type": "terminology", "terminology": "x" * (MAX_JSON_FRAME_BYTES - overhead)}
    assert len(encode_json(fits).encode()) == MAX_JSON_FRAME_BYTES
    with pytest.raises(UsageError, match="65,537 bytes"):
        encode_json({"type": "terminology", "terminology": "x" * (MAX_JSON_FRAME_BYTES - overhead + 1)})


def test_json_size_counts_utf8_bytes() -> None:
    with pytest.raises(UsageError):
        encode_json({"type": "x", "text": "ع" * 40_000})  # 80 KB in UTF-8


def test_decode_event_never_raises() -> None:
    assert decode_event('{"type":"pong"}') == {"type": "pong"}
    assert decode_event("not json") == {"raw_text": "not json"}
    assert decode_event("[1]") == {"raw_value": [1]}


# --- Keepalive and liveness ------------------------------------------------------------------------


def make_liveness(now: float = 0.0, keepalive: float | None = 30.0) -> Liveness:
    return Liveness(now, keepalive=keepalive, pong_timeout=15.0, silence_timeout=60.0)


def test_keepalive_pings_after_30_s_without_sending() -> None:
    live = make_liveness()
    assert live.poll(29.9) is None
    assert live.next_deadline() == 30.0
    assert live.poll(30.0) == "ping"


def test_data_frames_postpone_the_ping() -> None:
    live = make_liveness()
    live.sent(20.0)
    live.received(20.0)
    assert live.poll(30.0) is None
    assert live.poll(50.0) == "ping"


def test_no_pong_within_15_s_is_a_lost_connection() -> None:
    live = make_liveness()
    live.ping_sent(30.0)
    live.received(40.0)  # other traffic doesn't count as the pong
    assert live.poll(44.9) is None
    assert live.next_deadline() == 45.0
    assert live.poll(45.0) == "lost_pong"
    assert "no pong within 15 s" in live.describe("lost_pong")


def test_pong_clears_the_ping() -> None:
    live = make_liveness()
    live.ping_sent(30.0)
    live.pong(31.0)
    assert live.poll(45.0) is None
    assert live.poll(60.0) == "ping"


def test_silence_for_60_s_is_a_lost_connection() -> None:
    live = make_liveness()
    live.sent(55.0)  # still sending, but hearing nothing
    assert live.poll(59.9) is None
    assert live.poll(60.0) == "lost_silence"


def test_keepalive_none_turns_everything_off() -> None:
    live = make_liveness(keepalive=None)
    assert live.poll(1_000.0) is None
    assert live.next_deadline() is None


# --- Connection attempts ---------------------------------------------------------------------------


def test_at_most_6_attempts_per_60_s() -> None:
    limiter = AttemptLimiter(6, 60.0)
    for i in range(6):
        assert limiter.wait_time(float(i)) == 0
        limiter.record(float(i))
    assert limiter.wait_time(10.0) == pytest.approx(50.0)
    assert limiter.wait_time(60.0) == 0  # the first attempt left the window
    error = limiter.error()
    assert isinstance(error, APIConnectionError)
    assert error.retry_disabled_reason == "attempt_limit"


def retry(**kwargs: object) -> HandshakeRetry:
    defaults: dict[str, object] = {
        "now": 0.0,
        "wait_for_slot": None,
        "after_abnormal": False,
        "slot_wait_after_loss": 90.0,
    }
    defaults.update(kwargs)
    return HandshakeRetry(FastRetry(rng=lambda: 0.0), **defaults)  # type: ignore[arg-type]


@pytest.mark.parametrize("status", [200, 204, 302, 304, 399])
def test_handshake_with_an_unexpected_status_is_a_protocol_error(status: int) -> None:
    policy = retry()
    with pytest.raises(ProtocolError) as info:
        policy.on_status(status, {"Location": "wss://elsewhere.example.com/", "X-Request-Id": "r3"}, b"", 0.0)
    assert info.value.status_code == status
    assert info.value.request_id == "r3"
    assert info.value.transport == "websocket"
    assert policy.retries == 0


def test_handshake_401_is_not_retried() -> None:
    with pytest.raises(AuthenticationError) as info:
        retry().on_status(401, {"X-Request-Id": "r1"}, envelope(401, "Unauthorized"), 0.0)
    assert info.value.transport == "websocket"
    assert info.value.request_id == "r1"


@pytest.mark.parametrize(
    ("status", "message", "error"),
    [
        (402, "Insufficient subscription balance", InsufficientBalanceError),
        (429, "Monthly spending limit exhausted", SpendingLimitError),
        (503, "Streaming is not enabled", FeatureNotEnabledError),
    ],
)
def test_handshake_billing_and_disabled_are_not_retried(status: int, message: str, error: type[Exception]) -> None:
    with pytest.raises(error):
        retry().on_status(status, {}, envelope(status, message), 0.0)


def test_handshake_throttle_waits_retry_after_then_gives_up() -> None:
    policy = retry()
    body = envelope(429, "ThrottlerException: Too Many Requests")
    assert policy.on_status(429, {"Retry-After": "3"}, body, 0.0) == pytest.approx(3.0)
    assert policy.on_status(429, {"Retry-After": "3"}, body, 3.0) == pytest.approx(3.0)
    with pytest.raises(RateLimitError):
        policy.on_status(429, {"Retry-After": "3"}, body, 6.0)


def test_handshake_throttle_with_a_long_retry_after_is_not_retried() -> None:
    with pytest.raises(RateLimitError):
        retry().on_status(429, {"Retry-After": "45"}, envelope(429, "ThrottlerException: Too Many Requests"), 0.0)


def test_concurrency_429_needs_wait_for_slot() -> None:
    body = envelope(429, "Too many concurrent streams")
    with pytest.raises(ConcurrencyLimitError):
        retry().on_status(429, {}, body, 0.0)
    waiting = retry(wait_for_slot=5.0)
    now = 0.0
    for _ in range(10):
        now += waiting.on_status(429, {}, body, now)
    with pytest.raises(ConcurrencyLimitError):  # past the 5 s budget
        retry(wait_for_slot=5.0).on_status(429, {}, body, 10.0)


def test_concurrency_429_is_retried_for_90_s_after_an_abnormal_loss() -> None:
    body = envelope(429, "Too many concurrent streams")
    policy = retry(after_abnormal=True)
    assert policy.on_status(429, {}, body, 1.0) > 0
    assert policy.may_wait(1.0, 30.0)
    assert not policy.may_wait(1.0, 95.0)
    with pytest.raises(ConcurrencyLimitError):
        policy.on_status(429, {}, body, 89.999)


def test_handshake_503_unavailable_is_retried() -> None:
    policy = retry()
    assert policy.on_status(503, {}, b"<html>busy</html>", 0.0) >= 0
    assert policy.on_status(503, {}, b"<html>busy</html>", 0.0) >= 0
    with pytest.raises(ServiceUnavailableError, match="busy"):
        policy.on_status(503, {}, b"<html>busy</html>", 0.0)


def test_network_errors_retry_twice_then_raise() -> None:
    policy = retry()
    assert policy.on_network(OSError("refused"), "ws://x/stream?k=v") >= 0
    assert policy.on_network(OSError("refused"), "ws://x/stream?k=v") >= 0
    with pytest.raises(APIConnectionError, match="ws://x/stream: refused"):
        policy.on_network(OSError("refused"), "ws://x/stream?k=v")


def test_network_errors_hide_url_credentials() -> None:
    policy = retry()
    policy.retries = 2
    with pytest.raises(APIConnectionError) as info:
        policy.on_network(OSError("refused"), "wss://user:pa55@proxy.example.com/v1/stream")
    assert "pa55" not in str(info.value)
    assert "wss://proxy.example.com/v1/stream" in str(info.value)


def test_handshake_timeouts_raise_api_timeout_error() -> None:
    policy = retry()
    policy.retries = 2
    with pytest.raises(APITimeoutError) as info:
        policy.on_network(TimeoutError(), "ws://x")
    assert info.value.kind == "connect"


# --- Error frames and closes -----------------------------------------------------------------------


def test_error_frames_map_to_classes() -> None:
    error = error_from_frame({"type": "error", "code": "upstream_error", "message": "boom", "requestId": "r"})
    assert isinstance(error, UpstreamError)
    assert (error.error_code, error.error_message, error.request_id) == ("upstream_error", "boom", "r")
    assert error.transport == "websocket"
    assert type(error_from_frame({"type": "error", "code": "brand_new"})).__name__ == "APIStatusError"


@pytest.mark.parametrize(
    ("info", "ended", "expected"),
    [
        (CloseInfo(1000), True, None),
        (CloseInfo(1000), False, StreamClosedError),
        (CloseInfo(1006), False, StreamConnectionLostError),
        (CloseInfo(1000, lost_reason="no pong within 15 s"), False, StreamConnectionLostError),
        (CloseInfo(1001), False, ServerRestartingError),
        (CloseInfo(1002), False, ProtocolError),
        (CloseInfo(1007), False, ProtocolError),
        (CloseInfo(1008, "invalid_message"), False, ProtocolError),
        (CloseInfo(1009), False, ProtocolError),
        (CloseInfo(1011), False, UpstreamError),
        (CloseInfo(4002), True, InsufficientBalanceError),
        (CloseInfo(4029), True, SpendingLimitError),
        (CloseInfo(4008, "max_duration"), True, None),
        (CloseInfo(4008, "idle_timeout"), False, SessionExpiredError),
        (CloseInfo(4999), False, StreamClosedError),
        (CloseInfo(1000, local=True), False, None),
    ],
)
def test_close_code_map(info: CloseInfo, ended: bool, expected: type[Exception] | None) -> None:
    error = close_error(info, ended_normally=ended)
    if expected is None:
        assert error is None
    else:
        assert type(error) is expected
        if hasattr(error, "close_code") and info.lost_reason is None:
            assert error.close_code == info.code  # type: ignore[union-attr]


def test_close_carries_the_preceding_error_frame() -> None:
    error = close_error(
        CloseInfo(1008, "frame_too_large"),
        last_error={"type": "error", "code": "frame_too_large", "message": "frames must be at most 64 KiB"},
    )
    assert isinstance(error, ProtocolError)
    assert error.error_code == "frame_too_large"
    assert error.error_message == "frames must be at most 64 KiB"
    assert error.close_code == 1008


def test_close_abnormal_flag() -> None:
    assert CloseInfo(1006).abnormal
    assert CloseInfo(1001).abnormal
    assert CloseInfo(1000, lost_reason="silence").abnormal
    assert not CloseInfo(1011).abnormal
    assert not CloseInfo(4008).abnormal


# --- URLs -------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("base", "expected"),
    [
        ("wss://api.echonova.ai", "wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&language=ar"),
        ("https://api.echonova.ai/", "wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&language=ar"),
        ("https://api.echonova.ai/v1", "wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&language=ar"),
        ("http://127.0.0.1:9000", "ws://127.0.0.1:9000/v1/speech-to-text/stream?sample_rate=16000&language=ar"),
        (
            "https://proxy.example/echonova",
            "wss://proxy.example/echonova/v1/speech-to-text/stream?sample_rate=16000&language=ar",
        ),
    ],
)
def test_stream_urls(base: str, expected: str) -> None:
    options = StreamOptions(ws_base_url=base)
    assert options.url("/v1/speech-to-text/stream", {"sample_rate": 16000, "language": "ar"}) == expected


def test_bad_base_url_is_a_usage_error() -> None:
    with pytest.raises(UsageError):
        StreamOptions(ws_base_url="ftp://x").url("/v1/text-to-speech/stream")
