"""WebSocket pass-through: auth on the upgrade, frames both ways, close codes, refused handshakes."""

from __future__ import annotations

import asyncio
import json

import pytest
from conftest import API_KEY, ORIGIN, UPSTREAM_RID, USER_TOKEN, Harness, StartProxy, all_log_text
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from echonova_proxy.log import quiet_libraries
from echonova_proxy.tokens import mint_stream_token

pytestmark = pytest.mark.anyio

TTS = "/v1/text-to-speech/stream"
STT = "/v1/speech-to-text/stream"
AUTH = {"Authorization": f"Bearer {USER_TOKEN}"}


def open_ws(h: Harness, path: str, headers: dict[str, str] | None = None) -> connect:
    return connect(h.ws_url(path), additional_headers=AUTH if headers is None else headers, open_timeout=5)


async def closed(ws: ClientConnection) -> tuple[int | None, str | None]:
    """Read until the connection ends; return the close code and reason the app saw."""
    try:
        while True:
            await asyncio.wait_for(ws.recv(), timeout=5)
    except ConnectionClosed:
        return ws.close_code, ws.close_reason


async def refused(h: Harness, path: str, headers: dict[str, str] | None = None) -> InvalidStatus:
    with pytest.raises(InvalidStatus) as info:
        async with open_ws(h, path, headers):
            pass
    return info.value


async def test_text_and_binary_frames_are_relayed_in_order_both_ways(harness: Harness) -> None:
    async with open_ws(harness, TTS) as ws:
        for i in range(50):
            await ws.send(json.dumps({"type": "synthesize", "text": f"part {i}"}))
            await ws.send(bytes([i]) * (1000 + i))
        for i in range(50):
            assert json.loads(await ws.recv()) == {"type": "synthesize", "text": f"part {i}"}
            assert await ws.recv() == bytes([i]) * (1000 + i)
        # A large burst from upstream: 2,000 frames of 32 KiB arrive complete and in order.
        await ws.send(json.dumps({"type": "burst", "count": 2000, "size": 8192}))
        for i in range(2000):
            frame = await ws.recv()
            assert isinstance(frame, bytes)
            assert frame == i.to_bytes(4, "big") * 8192
        assert json.loads(await ws.recv()) == {"type": "done"}


async def test_backpressure_when_the_app_reads_slowly(harness: Harness) -> None:
    frames, size = 2000, 16384  # 2,000 frames of 64 KiB: 125 MiB
    async with open_ws(harness, TTS) as ws:
        await ws.send(json.dumps({"type": "burst", "count": frames, "size": size}))
        await asyncio.sleep(1)  # the app reads nothing for a second
        in_flight = harness.fake.burst_sent
        assert in_flight < frames // 2, f"upstream sent {in_flight} frames: the proxy read ahead"
        for i in range(frames):
            assert await ws.recv() == i.to_bytes(4, "big") * size
        assert json.loads(await ws.recv()) == {"type": "done"}


async def test_backpressure_when_upstream_reads_slowly(harness: Harness) -> None:
    frames, frame = 2000, bytes(range(256)) * 256  # 125 MiB in 64 KiB frames
    sent = 0
    async with open_ws(harness, TTS) as ws:
        await ws.send(json.dumps({"type": "pause", "seconds": 1.5}))

        async def pump() -> None:
            nonlocal sent
            for _ in range(frames):
                await ws.send(frame)
                sent += 1

        task = asyncio.ensure_future(pump())
        await asyncio.sleep(1)  # upstream reads nothing for this long
        assert sent < frames // 2, f"the app sent {sent} frames: the proxy buffered them"
        for _ in range(frames):
            assert await asyncio.wait_for(ws.recv(), timeout=10) == frame  # echoed once upstream reads again
        await task


async def test_upstream_gets_the_key_and_only_the_documented_query(harness: Harness) -> None:
    token = mint_stream_token("demo-user", b"test-secret", 60)
    url = harness.ws_url(STT) + f"?sample_rate=16000&language=ar&encoding=pcm_s16le&access_token={token}&debug=1"
    async with connect(
        url,
        additional_headers={"Cookie": f"session={USER_TOKEN}", "X-Request-Id": "app-ws-1"},
        open_timeout=5,
    ) as ws:
        assert ws.response.headers["x-request-id"] == "app-ws-1"
        assert json.loads(await ws.recv()) == {"type": "session.started"}  # sent before we said anything
    seen = harness.fake.ws_handshakes[-1]
    assert seen.path == STT
    assert seen.query == "sample_rate=16000&language=ar&encoding=pcm_s16le"
    assert [v for k, v in seen.raw_headers if k == "authorization"] == [f"Bearer {API_KEY}"]
    assert "cookie" not in seen.headers
    assert seen.headers["x-request-id"] == "app-ws-1"

    async with open_ws(harness, TTS + "?sample_rate=16000"):
        pass
    assert harness.fake.ws_handshakes[-1].query == ""  # the TTS stream takes no query


async def test_a_speech_to_text_sessions_job_is_recorded_before_the_app_sees_its_id(harness: Harness) -> None:
    async with open_ws(harness, STT) as ws:
        assert json.loads(await ws.recv())["type"] == "session.started"
        assert not await harness.jobs.is_owner("speech-to-text", "stt-stream-1", "demo-user")
        # The fake API echoes text frames, so this comes back from upstream like the real message.
        await ws.send(json.dumps({"type": "session.saved", "jobId": "stt-stream-1", "status": "saved"}))
        assert json.loads(await ws.recv())["jobId"] == "stt-stream-1"
        assert await harness.jobs.is_owner("speech-to-text", "stt-stream-1", "demo-user")
        # Frames keep their order around the one held for the record.
        await ws.send(json.dumps({"type": "session.started", "jobId": "stt-stream-2"}))
        await ws.send("after")
        assert json.loads(await ws.recv())["jobId"] == "stt-stream-2"
        assert await ws.recv() == "after"
    # The app's own frames going up are never taken as a job id.
    async with open_ws(harness, TTS) as tts:
        await tts.send(json.dumps({"type": "session.saved", "jobId": "tts-stream-1"}))
        await tts.recv()
    assert not await harness.jobs.is_owner("speech-to-text", "tts-stream-1", "demo-user")


async def test_user_auth_on_the_upgrade(harness: Harness) -> None:
    for headers in ({}, {"Authorization": "Bearer wrong-token"}, {"Authorization": f"Bearer {API_KEY}"}):
        error = await refused(harness, TTS, headers)
        assert error.response.status_code == 401
        assert json.loads(error.response.body)["errorMessage"] == "Unauthorized"
    # Browsers: a cookie, or a short-lived token in the URL.
    async with open_ws(harness, TTS, {"Cookie": f"session={USER_TOKEN}"}):
        pass
    token = mint_stream_token("demo-user", b"test-secret", 60)
    async with connect(harness.ws_url(TTS) + f"?access_token={token}", open_timeout=5):
        pass
    expired = mint_stream_token("demo-user", b"test-secret", -1)
    forged = mint_stream_token("demo-user", b"other-secret", 60)
    for bad in (expired, forged, USER_TOKEN):
        with pytest.raises(InvalidStatus) as info:
            async with connect(harness.ws_url(TTS) + f"?access_token={bad}", open_timeout=5):
                pass
        assert info.value.response.status_code == 401
    assert len(harness.fake.ws_handshakes) == 2


async def test_stream_token_from_the_proxy_opens_a_stream(harness: Harness) -> None:
    token = (await harness.client.post(harness.base + "/stream-token")).json()["token"]
    async with connect(harness.ws_url(TTS) + f"?access_token={token}", open_timeout=5) as ws:
        await ws.send("hello")
        assert await ws.recv() == "hello"


@pytest.mark.parametrize(
    ("code", "reason"),
    [
        (4002, "insufficient_balance"),
        (4029, "spending_limit"),
        (1011, "upstream_error"),
        (1008, "invalid_message"),
        (4008, "max_duration"),
        (1001, "server_restarting"),
        (1000, "stopped"),
    ],
)
async def test_upstream_close_codes_reach_the_app(harness: Harness, code: int, reason: str) -> None:
    async with open_ws(harness, STT + "?sample_rate=16000&language=en") as ws:
        assert json.loads(await ws.recv())["type"] == "session.started"
        await ws.send(json.dumps({"type": "close", "code": code, "reason": reason}))
        assert json.loads(await ws.recv()) == {"type": "error", "code": "bye"}  # the last message comes first
        assert await closed(ws) == (code, reason)


async def test_upstream_drop_without_close_frame_is_a_drop_for_the_app(harness: Harness) -> None:
    async with open_ws(harness, TTS) as ws:
        await ws.send(json.dumps({"type": "drop"}))
        code, _ = await closed(ws)
    assert code == 1006


@pytest.mark.parametrize(("code", "reason"), [(1000, "done"), (4000, "user left"), (1001, "page closed")])
async def test_app_close_codes_reach_upstream(harness: Harness, code: int, reason: str) -> None:
    async with open_ws(harness, TTS) as ws:
        await ws.send("last words")
        assert await ws.recv() == "last words"
        await ws.close(code, reason)
    await asyncio.wait_for(harness.fake.ws_closed.wait(), timeout=5)
    assert harness.fake.ws_closes == [(code, reason)]


@pytest.mark.parametrize(
    ("status", "message", "headers"),
    [
        (429, "Too many concurrent streams", {}),
        (429, "ThrottlerException: Too Many Requests", {"retry-after": "42"}),
        (401, "Unauthorized", {}),
        (402, "Insufficient subscription balance", {}),
        (400, "sample_rate must be an integer", {}),
        (503, "Streaming is not enabled", {}),
    ],
)
async def test_refused_upstream_handshake_is_mirrored(
    harness: Harness, status: int, message: str, headers: dict[str, str]
) -> None:
    body = {
        "data": None,
        "success": False,
        "statusCode": status,
        "errorMessage": message,
        "docs": "https://x.example.com",
    }
    harness.fake.ws_reject = (status, body, headers)
    error = await refused(harness, STT + "?sample_rate=16000&language=ar")
    assert error.response.status_code == status
    assert json.loads(error.response.body) == body
    assert error.response.headers["content-type"].startswith("application/json")
    assert error.response.headers["x-request-id"] == UPSTREAM_RID
    assert error.response.headers.get("retry-after") == headers.get("retry-after")
    assert "x-internal-trace" not in error.response.headers


async def test_upstream_unreachable_refuses_with_503(start_proxy: StartProxy) -> None:
    async with start_proxy(upstream_url="http://127.0.0.1:9") as h:
        error = await refused(h, TTS)
    assert error.response.status_code == 503
    assert "temporarily unavailable" in json.loads(error.response.body)["errorMessage"]


async def test_per_user_stream_limit_and_release(start_proxy: StartProxy) -> None:
    async with start_proxy(max_streams_per_user=1) as h:
        async with open_ws(h, TTS):
            error = await refused(h, STT + "?sample_rate=16000&language=ar")
            assert error.response.status_code == 429
            assert json.loads(error.response.body)["errorMessage"] == "Too many concurrent streams"
            assert "retry-after" not in error.response.headers
        await asyncio.sleep(0.2)  # the proxy releases the slot when the stream ends
        async with open_ws(h, TTS):
            pass


async def test_total_stream_limit(start_proxy: StartProxy) -> None:
    async with start_proxy(max_streams_per_user=5, max_streams_total=1) as h, open_ws(h, TTS):
        assert (await refused(h, TTS)).response.status_code == 429


async def test_stream_paths_only(harness: Harness) -> None:
    assert (await refused(harness, "/v1/text-to-speech/sync")).response.status_code == 404
    assert (await refused(harness, "/v1/widgets/w1/tickets")).response.status_code == 404
    assert harness.fake.ws_handshakes == []


async def test_cross_site_websocket_is_refused(harness: Harness) -> None:
    error = await refused(harness, TTS, {"Cookie": f"session={USER_TOKEN}", "Origin": "https://evil.example.org"})
    assert error.response.status_code == 403
    async with open_ws(harness, TTS, {"Cookie": f"session={USER_TOKEN}", "Origin": ORIGIN}):
        pass
    assert len(harness.fake.ws_handshakes) == 1


async def test_ws_logs_have_no_tokens(harness: Harness, logs: pytest.LogCaptureFixture) -> None:
    quiet_libraries()
    token = mint_stream_token("demo-user", b"test-secret", 60)
    async with connect(harness.ws_url(TTS) + f"?access_token={token}", open_timeout=5) as ws:
        await ws.send("private words")
        await ws.recv()
    await refused(harness, TTS + "?access_token=bad-token-value")
    await asyncio.sleep(0.1)
    text = all_log_text(logs)
    assert '"event": "ws.close"' in text
    for secret in (token, "bad-token-value", API_KEY, "private words"):
        assert secret not in text


async def test_stopping_the_proxy_closes_open_streams_with_1012(start_proxy: StartProxy) -> None:
    async with start_proxy() as h:
        ws = await connect(h.ws_url(TTS), additional_headers=AUTH, open_timeout=5)
        h.proxy.server.should_exit = True  # what SIGTERM does
        code, _ = await closed(ws)
        assert code == 1012
        await asyncio.wait_for(h.fake.ws_closed.wait(), timeout=5)
        assert h.fake.ws_closes[0][0] == 1012
