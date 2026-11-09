"""Text to Speech sessions against the mock server. Each test runs on the async and the sync session."""

from __future__ import annotations

import asyncio
import dataclasses
import time
from collections.abc import AsyncIterator

import pytest
from mock_server import MockServer, Rejection
from stream_adapters import Bridge, open_tts
from stream_helpers import TEST_KEY, options_for, run

from echonova import (
    APIConnectionError,
    AuthenticationError,
    ConcurrencyLimitError,
    FeatureNotEnabledError,
    InsufficientBalanceError,
    InvalidRequestError,
    ProtocolError,
    RateLimitError,
    SessionEndedError,
    SessionExpiredError,
    SpendingLimitError,
    StreamConnectionLostError,
    UpstreamError,
    UsageError,
    VoiceNotFoundError,
)
from echonova._streaming import StreamOptions, connect_tts, speak, speak_sync
from echonova._streaming._errors import charge_state_of


def wait_for(predicate: object, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():  # type: ignore[operator]
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        time.sleep(0.01)


def synth_frames(server: MockServer, conn: int = 0) -> list[dict[str, object]]:
    return [f for f in server.tts_conns[conn].received if isinstance(f, dict) and f.get("type") == "synthesize"]


def frame_types(server: MockServer, conn: int = 0) -> list[object]:
    return [f.get("type") for f in server.tts_conns[conn].received if isinstance(f, dict)]


def test_synthesize_streams_audio_at_the_server_sample_rate(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1", speed=1.1)
    try:
        synth = tts.synthesize("Hello there", num_steps=32)
        chunks = synth.chunks()
        result = synth.result()
    finally:
        tts.close()
    assert len(chunks) == 3
    assert synth.sample_rate == 22_050  # from start, not a constant
    assert (result.outcome, result.charged, result.characters) == ("completed", True, 11)
    assert synth.metrics.ttfb is not None
    frame = synth_frames(server)[0]
    assert frame == {
        "type": "synthesize",
        "requestId": synth.request_id,
        "text": "Hello there",
        "voiceId": "v1",
        "speed": 1.1,
        "numSteps": 32,
    }
    headers = server.attempts[0].headers
    assert headers["Authorization"] == f"Bearer {TEST_KEY}"
    assert headers["User-Agent"] == "echonova-python/test"


def test_new_synthesis_supersedes_the_running_one(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        first = tts.synthesize("[slow] first")
        first.first_chunk()
        second = tts.synthesize("second")
        second_audio = second.chunks()
        first_result = first.result()
    finally:
        tts.close()
    assert first_result.outcome == "superseded"
    assert first_result.charged is True
    assert len(second_audio) == 3
    assert "cancel" not in frame_types(server)  # the server replaced it; no cancel frame needed


def test_cancel_and_context_manager_exit(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        synth = tts.synthesize("[slow] long text")
        synth.first_chunk()
        synth.cancel()
        result = synth.result()
        assert (result.outcome, result.charged) == ("cancelled", True)
        assert frame_types(server).count("cancel") == 1
        tts.cancel()  # nothing running: must not send another cancel
        time.sleep(0.05)
        assert frame_types(server).count("cancel") == 1
    finally:
        tts.close()


def test_async_context_manager_exit_cancels(server: MockServer, opts: StreamOptions) -> None:
    async def body() -> str:
        async with connect_tts(opts, voice_id="v1") as tts:
            async with tts.synthesize("[slow] text") as synth:
                async for _ in synth:
                    break
            return (await synth.result()).outcome

    assert run(body()) == "cancelled"


def test_sync_context_manager_exit_cancels(server: MockServer, opts: StreamOptions) -> None:
    from echonova._streaming import connect_tts_sync

    with connect_tts_sync(opts, voice_id="v1") as tts:
        with tts.synthesize("[slow] text") as synth:
            next(iter(synth))
        assert synth.result().outcome == "cancelled"


def test_enqueue_plays_in_order_one_at_a_time(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        handles = [tts.enqueue(text) for text in ("one", "two", "three")]
        results = [h.result().outcome for h in handles]
    finally:
        tts.close()
    assert results == ["completed"] * 3
    received = [f for f in server.tts_conns[0].received if isinstance(f, dict)]
    assert [f["text"] for f in received] == ["one", "two", "three"]


def test_speak_stream_splits_sentences(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        audio = tts.speak_stream("First one. Second one! مرحبا؟ ")
    finally:
        tts.close()
    assert [f["text"] for f in synth_frames(server)] == ["First one.", "Second one!", "مرحبا؟"]
    assert len(audio) == 9


def test_speak_stream_from_async_llm_deltas(server: MockServer, opts: StreamOptions) -> None:
    async def deltas() -> AsyncIterator[str]:
        for piece in ["Hel", "lo world. How ", "are you", "? Bye"]:
            await asyncio.sleep(0.01)
            yield piece

    async def body() -> list[bytes]:
        async with connect_tts(opts, voice_id="v1") as tts:
            return [chunk async for chunk in tts.speak_stream(deltas())]

    audio = run(body())
    assert [f["text"] for f in synth_frames(server)] == ["Hello world.", "How are you?", "Bye"]
    assert len(audio) == 9


def test_interrupt_ends_speak_stream_and_drops_the_queue(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        audio = tts.speak_stream("[slow] one. [slow] two. [slow] three.", stop_after=2)
        time.sleep(0.1)
    finally:
        tts.close()
    assert len(audio) == 2
    assert [f["text"] for f in synth_frames(server)] == ["[slow] one."]
    assert "cancel" in frame_types(server)


def test_pre_audio_upstream_error_is_resent_once(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        synth = tts.synthesize("[upstream_pre] hello")
        assert len(synth.chunks()) == 3
        assert synth.result().outcome == "completed"
        failing = tts.synthesize("[upstream_pre_always] hello")
        with pytest.raises(UpstreamError):
            failing.result()
        assert failing.charge_state == "no"
    finally:
        tts.close()
    frames = synth_frames(server)
    assert [f["requestId"] for f in frames[:2]] == [synth.request_id] * 2  # same request, sent twice
    assert len(frames) == 4  # and the always-failing one also twice: never more


def test_mid_stream_upstream_error_keeps_audio_then_raises(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        synth = tts.synthesize("[upstream_mid] text")
        with pytest.raises(UpstreamError) as info:
            synth.chunks()
        assert synth.charge_state == "yes"
        assert charge_state_of(info.value) == "yes"
        assert len(synth_frames(server)) == 1  # charged: never resent
    finally:
        tts.close()


def test_dropped_connection_loses_the_request_and_reconnects_lazily(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        synth = tts.synthesize("[drop] text")
        with pytest.raises(StreamConnectionLostError):
            synth.chunks()
        assert synth.state == "lost"
        assert synth.charge_state == "yes"
        wait_for(lambda: not tts.connected)
        assert len(server.tts_conns) == 1
        assert tts.synthesize("again").result().outcome == "completed"
    finally:
        tts.close()
    assert len(server.tts_conns) == 2


def test_server_idle_close_is_silent_and_the_next_request_reconnects(
    server: MockServer, mode: str, bridge: Bridge | None
) -> None:
    server.tts.idle_timeout = 0.15
    opts = options_for(server, keepalive=None)
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        wait_for(lambda: not tts.connected and server.tts_conns[0].close_code is not None)
        assert server.tts_conns[0].close_code == 4008
        assert tts.synthesize("hello").result().outcome == "completed"
    finally:
        tts.close()
    assert len(server.tts_conns) == 2


def test_keepalive_pings_keep_an_idle_socket_open(server: MockServer, mode: str, bridge: Bridge | None) -> None:
    server.tts.idle_timeout = 0.3
    opts = options_for(server, keepalive=0.05)
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        time.sleep(0.8)
        assert tts.connected
        assert frame_types(server).count("ping") >= 5
        assert tts.synthesize("hello").result().outcome == "completed"
    finally:
        tts.close()
    assert len(server.tts_conns) == 1


def test_no_pong_means_the_connection_is_lost(server: MockServer, mode: str, bridge: Bridge | None) -> None:
    server.tts.answer_pings = False
    opts = options_for(server, keepalive=0.05, pong_timeout=0.2)
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        synth = tts.synthesize("[nostart] text")
        with pytest.raises(StreamConnectionLostError, match="no pong"):
            synth.result()
        assert synth.charge_state == "unknown"  # sent, never started: probably charged, never resent
    finally:
        tts.close()
    assert len(synth_frames(server)) == 1


def test_billing_close_fails_the_session(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        synth = tts.synthesize("[close:4002] text")
        with pytest.raises(InsufficientBalanceError):
            synth.result()
        with pytest.raises(SessionEndedError):
            tts.synthesize("more")
    finally:
        tts.close()


def test_protocol_close_is_a_protocol_error(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        synth = tts.synthesize("[close:1002] text")
        with pytest.raises(ProtocolError):
            synth.result()
    finally:
        tts.close()


def test_rejected_synthesis_leaves_the_server_running_so_the_sdk_cancels(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        first = tts.synthesize("[slow] first")
        first.first_chunk()
        rejected = tts.synthesize("   ")
        with pytest.raises(InvalidRequestError):
            rejected.result()
        assert first.result().outcome == "superseded"  # stopped, as the caller asked
    finally:
        tts.close()
    assert frame_types(server).count("cancel") == 1


def test_server_session_limit_mid_synthesis(server: MockServer, mode: str, bridge: Bridge | None) -> None:
    server.tts.max_duration = 0.3
    tts = open_tts(mode, options_for(server), bridge, voice_id="v1")
    try:
        synth = tts.synthesize("[slow] long")
        with pytest.raises(SessionExpiredError):
            synth.chunks()
        assert synth.state == "lost"
        assert synth.charge_state == "yes"
        assert tts.synthesize("next").result().outcome == "completed"
    finally:
        tts.close()
    assert server.tts_conns[0].close_code == 4008


def test_awaiting_a_synthesis_waits_until_it_is_sent(server: MockServer, opts: StreamOptions) -> None:
    async def body() -> tuple[str, str]:
        async with connect_tts(opts, voice_id="v1") as tts:
            synth = await tts.synthesize("hello")
            state = synth.state
            await synth.result()
            return state, synth.state

    before, after = run(body())
    assert before in ("sent", "streaming", "completed")
    assert after == "completed"


def test_rejections_are_per_request(server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        with pytest.raises(VoiceNotFoundError):
            tts.synthesize("hi", voice_id="missing").result()
        with pytest.raises(InvalidRequestError):
            tts.synthesize("   ").result()
        assert tts.synthesize("still fine").result().outcome == "completed"
    finally:
        tts.close()


def test_oversized_frame_raises_before_sending(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        with pytest.raises(UsageError):
            tts.synthesize("hi", extra_body={"padding": "x" * 70_000})
    finally:
        tts.close()
    assert synth_frames(server) == []


def test_idle_socket_is_rotated(server: MockServer, mode: str, bridge: Bridge | None) -> None:
    opts = options_for(server, rotate_after=0.2)
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        wait_for(lambda: not tts.connected and server.tts_conns[0].close_code is not None)
        assert server.tts_conns[0].close_code == 1000  # closed by the SDK, before the server's limit
        assert tts.synthesize("hello").result().outcome == "completed"
    finally:
        tts.close()
    assert len(server.tts_conns) == 2


def test_rotation_waits_for_the_running_synthesis(server: MockServer, mode: str, bridge: Bridge | None) -> None:
    server.tts.frames = 10
    server.tts.frame_interval = 0.03
    tts = open_tts(mode, options_for(server, rotate_after=0.1), bridge, voice_id="v1")
    try:
        synth = tts.synthesize("takes 0.3 s")
        assert len(synth.chunks()) == 10  # not cut off by the rotation
        assert synth.result().outcome == "completed"
        wait_for(lambda: not tts.connected and server.tts_conns[0].close_code is not None)
        assert server.tts_conns[0].close_code == 1000
    finally:
        tts.close()
    assert len(server.tts_conns) == 1


def test_connection_attempt_limit(server: MockServer, mode: str, bridge: Bridge | None) -> None:
    opts = options_for(server, max_connect_attempts=1)
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    try:
        with pytest.raises(StreamConnectionLostError):
            tts.synthesize("[drop] x").result()
        synth = tts.synthesize("needs a new socket")
        with pytest.raises(APIConnectionError) as info:
            synth.result()
        assert info.value.retry_disabled_reason == "attempt_limit"
        assert synth.charge_state == "no"
    finally:
        tts.close()


# --- Handshake ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rejection", "error"),
    [
        (Rejection(401, "Unauthorized"), AuthenticationError),
        (Rejection(402, "Insufficient subscription balance"), InsufficientBalanceError),
        (Rejection(429, "Monthly spending limit exhausted"), SpendingLimitError),
        (Rejection(429, "Too many concurrent streams"), ConcurrencyLimitError),
        (Rejection(503, "Streaming is not enabled"), FeatureNotEnabledError),
        (Rejection(429, "ThrottlerException: Too Many Requests", retry_after="120"), RateLimitError),
    ],
)
def test_handshake_rejections_are_not_retried(
    server: MockServer,
    opts: StreamOptions,
    mode: str,
    bridge: Bridge | None,
    rejection: Rejection,
    error: type[Exception],
) -> None:
    server.rejections.append(rejection)
    with pytest.raises(error) as info:
        open_tts(mode, opts, bridge, voice_id="v1")
    assert info.value.status_code == rejection.status  # type: ignore[attr-defined]
    assert info.value.transport == "websocket"  # type: ignore[attr-defined]
    assert info.value.request_id  # type: ignore[attr-defined]
    assert len(server.attempts) == 1


@pytest.mark.parametrize(
    "rejection",
    [
        Rejection(429, "ThrottlerException: Too Many Requests", retry_after="0"),
        Rejection(503, "<html>upstream busy</html>", json_body=False),
    ],
)
def test_handshake_retryable_rejections(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None, rejection: Rejection
) -> None:
    server.rejections.append(rejection)
    tts = open_tts(mode, opts, bridge, voice_id="v1")
    tts.close()
    assert [a.rejected for a in server.attempts] == [rejection.status, None]


def test_wait_for_slot_retries_concurrency_rejections(
    server: MockServer, opts: StreamOptions, mode: str, bridge: Bridge | None
) -> None:
    server.rejections.extend([Rejection(429, "Too many concurrent streams")] * 3)
    tts = open_tts(mode, opts, bridge, voice_id="v1", wait_for_slot=5.0)
    tts.close()
    assert [a.rejected for a in server.attempts] == [429, 429, 429, None]


def test_speak_one_shot(server: MockServer, opts: StreamOptions) -> None:
    audio = speak_sync(opts, "hello", voice_id="v1")
    assert audio.sample_rate == 22_050
    assert len(audio.pcm) == 3 * 960
    audio_async = run(speak(opts, "hello", voice_id="v1", speed=1.5))
    assert audio_async == audio
    assert synth_frames(server, 1)[0]["speed"] == 1.5
    wait_for(lambda: all(conn.close_code is not None for conn in server.tts_conns))
    assert all(conn.close_code == 1000 for conn in server.tts_conns)


def test_headers_provider_may_be_async(server: MockServer) -> None:
    async def headers() -> dict[str, str]:
        return {"Authorization": "Bearer ek_async"}

    opts = dataclasses.replace(options_for(server), headers=headers)
    run(speak(opts, "hello", voice_id="v1"))
    assert server.attempts[0].headers["Authorization"] == "Bearer ek_async"
    with pytest.raises(UsageError, match="async"):
        speak_sync(opts, "hello", voice_id="v1")
