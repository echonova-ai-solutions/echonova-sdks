"""The REST clients open streams with their own URL, credentials, default headers and User-Agent."""

from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from typing import Any

import pytest
from mock_server import MockServer
from stream_helpers import TEST_KEY, pcm, run

from echonova import AsyncEchoNova, EchoNova, UsageError
from echonova._streaming import Transcript
from echonova.audio import Audio


def _http_base(server: MockServer) -> str:
    return server.url.replace("ws://", "http://", 1)


def test_sync_tts_connect_uses_the_client_settings(server: MockServer) -> None:
    client = EchoNova(api_key=TEST_KEY, base_url=_http_base(server), default_headers={"X-Trace": "t-1"})
    with client, client.text_to_speech.connect(voice_id="v1", speed=1.2) as tts:
        result = tts.synthesize("Hello").result()
    assert result.outcome == "completed"
    headers = server.attempts[0].headers
    assert headers["Authorization"] == f"Bearer {TEST_KEY}"
    assert headers["X-Trace"] == "t-1"
    assert headers["User-Agent"].startswith("echonova-python/")
    assert server.attempts[0].path.startswith("/v1/text-to-speech/stream")


def test_sync_speak_returns_audio(server: MockServer) -> None:
    with EchoNova(api_key=TEST_KEY, base_url=_http_base(server)) as client:
        audio = client.text_to_speech.speak("Hello", voice_id="v1")
    assert isinstance(audio, Audio)
    assert audio.sample_rate == server.tts.sample_rate
    assert len(audio.pcm) == server.tts.frames * server.tts.frame_bytes


def test_async_proxy_mode_auth_hook_reaches_the_handshake(server: MockServer) -> None:
    async def auth() -> dict[str, str]:
        return {"Authorization": "Bearer app-session-token"}

    async def body() -> None:
        client = AsyncEchoNova(base_url=_http_base(server), auth=auth)
        async with client, client.text_to_speech.connect(voice_id="v1") as tts:
            await tts.synthesize("Hi").result()

    run(body())
    assert server.attempts[0].headers["Authorization"] == "Bearer app-session-token"


def test_sync_stt_connect(server: MockServer) -> None:
    client = EchoNova(api_key=TEST_KEY, base_url=_http_base(server))
    with client, client.speech_to_text.connect(sample_rate=16_000, language="ar") as stt:
        stt.send_audio(pcm(0.5))
        stt.end_segment()
        summary = stt.stop()
        events = list(stt)
    assert server.stt_conns[0].query == {"sample_rate": "16000", "language": "ar", "encoding": "pcm_s16le"}
    assert summary.reason
    assert any(isinstance(event, Transcript) for event in events)


def test_async_stt_connect_and_transcribe_stream(server: MockServer) -> None:
    async def body() -> list[object]:
        async with AsyncEchoNova(api_key=TEST_KEY, base_url=_http_base(server)) as client:
            async with client.speech_to_text.connect(sample_rate=16_000, language="en") as stt:
                assert stt.session_id
                await stt.stop()
            return [
                event
                async for event in client.speech_to_text.transcribe_stream(pcm(1.0), sample_rate=16_000, language="en")
            ]

    events = run(body())
    assert any(isinstance(event, Transcript) for event in events)


def test_sync_transcribe_stream(server: MockServer) -> None:
    with EchoNova(api_key=TEST_KEY, base_url=_http_base(server)) as client:
        events = list(client.speech_to_text.transcribe_stream(pcm(1.0), sample_rate=16_000, language="ar"))
    assert any(isinstance(event, Transcript) for event in events)


def test_rest_only_use_does_not_load_websockets() -> None:
    code = (
        "import sys, echonova; echonova.EchoNova(api_key='ek_x').close(); "
        "assert 'websockets' not in sys.modules, 'websockets imported eagerly'"
    )
    assert subprocess.run([sys.executable, "-c", code], check=False).returncode == 0  # noqa: S603 - fixed argv


def _pings(server: MockServer) -> int:
    return sum(1 for f in server.tts_conns[0].received if isinstance(f, dict) and f.get("type") == "ping")


def test_stream_keepalive_option_reaches_the_stream_options() -> None:
    for client_type in (EchoNova, AsyncEchoNova):
        assert client_type(api_key=TEST_KEY)._stream_options(asynchronous=False).keepalive == 30.0  # the default
        quick = client_type(api_key=TEST_KEY, stream_keepalive=5)
        assert quick._stream_options(asynchronous=True).keepalive == 5.0
        assert quick.with_options(max_retries=0)._stream_options(asynchronous=True).keepalive == 5.0  # kept
        off = quick.with_options(stream_keepalive=None)
        assert off._stream_options(asynchronous=False).keepalive is None  # keepalive and liveness checks off
        assert off.with_options(stream_keepalive=12.5)._stream_options(asynchronous=False).keepalive == 12.5


@pytest.mark.parametrize("value", [0, -1, float("inf"), float("nan"), True, "30"])
def test_stream_keepalive_must_be_positive_seconds_or_none(value: Any) -> None:
    with pytest.raises(UsageError, match="stream_keepalive"):
        EchoNova(api_key=TEST_KEY, stream_keepalive=value)
    with pytest.raises(UsageError, match="stream_keepalive"):
        AsyncEchoNova(api_key=TEST_KEY, stream_keepalive=value)


def test_sync_client_stream_keepalive_pings_an_idle_stream(server: MockServer) -> None:
    server.tts.idle_timeout = 0.3
    client = EchoNova(api_key=TEST_KEY, base_url=_http_base(server), stream_keepalive=0.05)
    with client, client.text_to_speech.connect(voice_id="v1") as tts:
        time.sleep(0.6)
        assert tts.connected  # the pings kept it inside the server's idle timeout
    assert _pings(server) >= 4


def test_async_client_stream_keepalive_pings_an_idle_stream(server: MockServer) -> None:
    server.tts.idle_timeout = 0.3

    async def body() -> bool:
        client = AsyncEchoNova(api_key=TEST_KEY, base_url=_http_base(server), stream_keepalive=0.05)
        async with client, client.text_to_speech.connect(voice_id="v1") as tts:
            await asyncio.sleep(0.6)
            return tts.connected

    assert run(body())
    assert _pings(server) >= 4


def test_an_auth_hook_error_fails_the_stream_connection_unchanged(server: MockServer) -> None:
    class SignedOut(Exception):
        pass

    def auth() -> dict[str, str]:
        raise SignedOut

    with EchoNova(base_url=_http_base(server), auth=auth) as client, pytest.raises(SignedOut):
        client.text_to_speech.connect(voice_id="v1")
    assert server.attempts == []
