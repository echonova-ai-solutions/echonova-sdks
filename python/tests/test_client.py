"""Client configuration: keys, base URL, proxy mode, headers, timeouts, options and lifecycle."""

from __future__ import annotations

import asyncio
import contextlib
import platform
from typing import Any

import httpx
import pytest

import echonova
from _support import JOB_ID, TEST_KEY, FakeTime, Recorder, make_async_client, make_client, ok
from echonova import AsyncEchoNova, EchoNova, Timeout, UsageError

TTS_JOB = {"id": JOB_ID, "status": "processing", "text": "hi", "voiceId": "v1", "createdAt": "2026-11-09T12:00:00Z"}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ECHONOVA_API_KEY", raising=False)
    monkeypatch.delenv("ECHONOVA_BASE_URL", raising=False)


def job_handler(request: httpx.Request) -> httpx.Response:
    return ok(TTS_JOB)


def test_api_key_from_env_is_stripped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ECHONOVA_API_KEY", f"  {TEST_KEY}\n")
    recorder = Recorder(job_handler)
    client = EchoNova(http_client=httpx.Client(transport=httpx.MockTransport(recorder)))
    client.text_to_speech.jobs.get(JOB_ID)
    assert recorder.last.headers["authorization"] == f"Bearer {TEST_KEY}"


def test_explicit_key_wins_over_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ECHONOVA_API_KEY", "ek_REDACTEDfromtheenvironment")
    client = EchoNova(api_key=TEST_KEY)
    assert client._auth_headers() == {"Authorization": f"Bearer {TEST_KEY}"}


@pytest.mark.parametrize("key", [None, "", "   "])
def test_missing_key_is_a_usage_error(key: str | None) -> None:
    with pytest.raises(UsageError, match="No API key"):
        EchoNova(api_key=key)


def test_base_url_default_env_and_normalisation(monkeypatch: pytest.MonkeyPatch) -> None:
    assert EchoNova(api_key=TEST_KEY).base_url == "https://api.echonova.ai"
    monkeypatch.setenv("ECHONOVA_BASE_URL", "https://staging.example.com/")
    assert EchoNova(api_key=TEST_KEY).base_url == "https://staging.example.com"
    assert EchoNova(api_key=TEST_KEY, base_url="http://localhost:8080/api/").base_url == "http://localhost:8080/api"


@pytest.mark.parametrize("url", ["api.echonova.ai", "ftp://api.echonova.ai", "https://x.example.com/?a=1"])
def test_bad_base_url(url: str) -> None:
    with pytest.raises(UsageError):
        EchoNova(api_key=TEST_KEY, base_url=url)


def test_requests_go_to_base_url_plus_v1_path() -> None:
    recorder = Recorder(job_handler)
    client = make_client(recorder, base_url="https://proxy.example.com/echonova")
    client.text_to_speech.jobs.get(JOB_ID)
    assert str(recorder.last.url) == f"https://proxy.example.com/echonova/v1/text-to-speech/jobs/{JOB_ID}"


def test_ws_base_url() -> None:
    assert EchoNova(api_key=TEST_KEY)._ws_base_url == "wss://api.echonova.ai"
    client = EchoNova(api_key=TEST_KEY, base_url="http://localhost:3000/proxy")
    assert client._ws_base_url == "ws://localhost:3000/proxy"


def test_user_agent() -> None:
    client = EchoNova(api_key=TEST_KEY)
    expected = (
        f"echonova-python/{echonova.__version__} (python/{platform.python_version()}; {platform.system().lower()})"
    )
    assert client._user_agent == expected
    recorder = Recorder(job_handler)
    make_client(recorder).text_to_speech.jobs.get(JOB_ID)
    assert recorder.last.headers["user-agent"] == expected
    assert "x-request-id" not in recorder.last.headers  # the API ignores it, so the SDK doesn't send one


def test_repr_redacts_the_key() -> None:
    text = repr(EchoNova(api_key=TEST_KEY))
    assert TEST_KEY not in text
    assert "ek_…c21d" in text


def test_non_ek_key_logs_a_warning_without_the_key(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("WARNING", logger="echonova")
    EchoNova(api_key="sk-REDACTED-not-an-echonova-key-1234")
    assert "does not start with 'ek_'" in caplog.text
    assert "1234" not in caplog.text


# --- Proxy mode -----------------------------------------------------------------------------------


def test_proxy_mode_needs_no_key_and_ignores_the_env_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ECHONOVA_API_KEY", TEST_KEY)
    tokens = iter(["t1", "t2"])
    recorder = Recorder(job_handler)
    client = make_client(
        recorder,
        api_key=None,
        base_url="https://api.myapp.example.com/echonova",
        auth=lambda: {"Authorization": f"Session {next(tokens)}"},
    )
    client.text_to_speech.jobs.get(JOB_ID)
    client.text_to_speech.jobs.get(JOB_ID)
    assert [r.headers["authorization"] for r in recorder.requests] == ["Session t1", "Session t2"]
    assert recorder.last.url.host == "api.myapp.example.com"
    assert "ek_" not in str(recorder.last.headers)


def test_proxy_mode_auth_headers_for_streaming() -> None:
    client = EchoNova(base_url="https://proxy.example.com", auth=lambda: {"X-App-Token": "abc"})
    assert client._auth_headers() == {"X-App-Token": "abc"}
    keyed = EchoNova(api_key=TEST_KEY, auth=lambda: {"X-Extra": "1"})
    assert keyed._auth_headers() == {"Authorization": f"Bearer {TEST_KEY}", "X-Extra": "1"}


class _SignedOut(Exception):
    pass


def _signed_out() -> dict[str, str]:
    raise _SignedOut("the user signed out")


def test_an_auth_hook_error_reaches_the_caller_unchanged_and_nothing_is_sent() -> None:
    recorder = Recorder(job_handler)
    client = make_client(recorder, api_key=None, base_url="https://proxy.example.com", auth=_signed_out)
    with pytest.raises(_SignedOut):
        client.text_to_speech.jobs.get(JOB_ID)
    async_client = make_async_client(recorder, api_key=None, base_url="https://proxy.example.com", auth=_signed_out)
    with pytest.raises(_SignedOut):
        asyncio.run(async_client.text_to_speech.jobs.get(JOB_ID))
    assert recorder.requests == []


def test_sync_client_rejects_an_async_auth_hook() -> None:
    async def auth() -> dict[str, str]:
        return {}

    with pytest.raises(UsageError, match="AsyncEchoNova"):
        EchoNova(base_url="https://proxy.example.com", auth=auth)  # type: ignore[arg-type]


def test_async_client_awaits_an_async_auth_hook() -> None:
    async def auth() -> dict[str, str]:
        return {"Authorization": "Session s1"}

    recorder = Recorder(job_handler)
    client = make_async_client(recorder, api_key=None, base_url="https://proxy.example.com", auth=auth)

    async def run() -> dict[str, str]:
        await client.text_to_speech.jobs.get(JOB_ID)
        return await client._async_auth_headers()

    assert asyncio.run(run()) == {"Authorization": "Session s1"}
    assert recorder.last.headers["authorization"] == "Session s1"
    with pytest.raises(UsageError):
        client._auth_headers()


# --- Headers, hooks, options --------------------------------------------------------------------


def test_default_and_extra_headers() -> None:
    recorder = Recorder(job_handler)
    client = make_client(recorder, default_headers={"X-Team": "voice", "X-Trace": "a"})
    client.text_to_speech.jobs.get(JOB_ID, extra_headers={"X-Trace": "b"})
    assert recorder.last.headers["x-team"] == "voice"
    assert recorder.last.headers["x-trace"] == "b"
    assert recorder.last.headers["accept"] == "application/json"


def test_unknown_keyword_is_a_type_error() -> None:
    client = make_client(job_handler)
    with pytest.raises(TypeError, match="sped"):
        client.text_to_speech.generate("hi", voice_id="v", sped=1.2)  # type: ignore[call-arg]


def test_hooks_see_each_attempt() -> None:
    seen: list[Any] = []
    client = make_client(job_handler, on_request=seen.append, on_response=seen.append)
    client.text_to_speech.jobs.get(JOB_ID)
    assert isinstance(seen[0], httpx.Request)
    assert isinstance(seen[1], httpx.Response)


def test_async_hooks_may_be_coroutines() -> None:
    seen: list[str] = []

    async def on_request(request: httpx.Request) -> None:
        seen.append(request.method)

    client = make_async_client(job_handler, on_request=on_request)
    asyncio.run(client.text_to_speech.jobs.get(JOB_ID))
    assert seen == ["GET"]


def captured_timeouts(handler_calls: list[httpx.Request]) -> dict[str, float]:
    timeout: dict[str, float] = handler_calls[-1].extensions["timeout"]
    return timeout


@pytest.mark.parametrize(
    ("call", "write", "read"),
    [
        (lambda c: c.text_to_speech.jobs.get(JOB_ID), 10, 30),
        (lambda c: c.text_to_speech.generate("hi", voice_id="v"), 10, 240),
        (lambda c: c.text_to_speech.jobs.create("hi", voice_id="v"), 10, 30),
        (lambda c: c.speech_to_text.jobs.export(JOB_ID, format="txt"), 10, 60),
        (lambda c: c.speech_to_text.jobs.create(b"RIFF\0\0\0\0WAVE", language="en"), 60, 120),
        (lambda c: c.speech_to_text.transcribe(b"RIFF\0\0\0\0WAVE", language="en"), 60, 600),
        (lambda c: c.sound_cleaning.clean(b"RIFF\0\0\0\0WAVE"), 60, 600),
    ],
)
def test_default_timeouts_per_operation(call: Any, write: float, read: float) -> None:
    recorder = Recorder(lambda r: ok({"jobId": JOB_ID, "id": JOB_ID, "status": "completed"}))
    client = make_client(recorder)
    with contextlib.suppress(Exception):  # only the request matters here
        call(client)
    timeout = captured_timeouts(recorder.requests)
    assert timeout == {"connect": 10, "read": read, "write": write, "pool": 10}


def test_timeout_overrides() -> None:
    recorder = Recorder(job_handler)
    client = make_client(recorder, timeout=Timeout(read=90))
    client.text_to_speech.jobs.get(JOB_ID)
    assert captured_timeouts(recorder.requests) == {"connect": 10, "read": 90, "write": 10, "pool": 10}
    client.text_to_speech.jobs.get(JOB_ID, timeout=5)
    assert captured_timeouts(recorder.requests) == {"connect": 5, "read": 5, "write": 5, "pool": 5}
    with pytest.raises(UsageError):
        make_client(recorder, timeout="30")


def test_deadline_caps_the_attempt_timeouts() -> None:
    recorder = Recorder(job_handler)
    make_client(recorder, deadline=4).text_to_speech.jobs.get(JOB_ID)
    assert captured_timeouts(recorder.requests) == {"connect": 4, "read": 4, "write": 4, "pool": 4}


def test_with_options_shares_pool_and_rate_limit_state() -> None:
    recorder = Recorder(lambda r: ok(TTS_JOB, headers={"X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "9"}))
    client = make_client(recorder)
    scoped = client.with_options(max_retries=5, timeout=7)
    assert scoped._pool is client._pool
    assert scoped._limits is client._limits
    assert scoped._max_retries == 5
    scoped.text_to_speech.jobs.get(JOB_ID)
    assert client.rate_limits["text_to_speech.jobs.get"].remaining == 9
    other_key = client.with_options(api_key="ek_REDACTEDanotherkey0000000000")
    assert other_key._limits is not client._limits
    assert other_key._pool is client._pool
    scoped.close()  # a copy never closes the shared pool
    assert not client._pool.http.is_closed


def test_with_options_never_carries_the_env_key_into_proxy_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ECHONOVA_API_KEY", TEST_KEY)
    client = EchoNova()
    proxied = client.with_options(base_url="https://proxy.example.com", auth=lambda: {"X-App-Token": "abc"})
    assert proxied._api_key is None
    assert proxied._auth_headers() == {"X-App-Token": "abc"}
    # Also through a copy made before the auth hook was added, and after the variable is gone.
    copy = client.with_options(max_retries=1)
    monkeypatch.delenv("ECHONOVA_API_KEY")
    assert copy._api_key == TEST_KEY
    assert copy.with_options(auth=lambda: {"X-App-Token": "abc"})._api_key is None


def test_with_options_keeps_an_explicit_key_with_an_auth_hook(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ECHONOVA_API_KEY", TEST_KEY)
    explicit = EchoNova(api_key=TEST_KEY).with_options(auth=lambda: {"X-Extra": "1"})
    assert explicit._api_key == TEST_KEY
    replaced = EchoNova().with_options(api_key=TEST_KEY, auth=lambda: {"X-Extra": "1"})
    assert replaced._api_key == TEST_KEY


def test_async_with_options_never_carries_the_env_key_into_proxy_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ECHONOVA_API_KEY", TEST_KEY)
    client = AsyncEchoNova()
    proxied = client.with_options(base_url="https://proxy.example.com", auth=lambda: {"X-App-Token": "abc"})
    assert proxied._api_key is None
    asyncio.run(client.close())


def test_with_options_rejects_unknown_arguments() -> None:
    with pytest.raises(TypeError):
        make_client(job_handler).with_options(retries=3)  # type: ignore[call-arg]


def test_close_and_context_managers() -> None:
    with EchoNova(api_key=TEST_KEY) as client:
        http = client._pool.http
        download = client._pool.download_client()
    assert http.is_closed
    assert download.is_closed

    injected = httpx.Client()
    EchoNova(api_key=TEST_KEY, http_client=injected).close()
    assert not injected.is_closed  # the caller owns it
    injected.close()

    async def run() -> httpx.AsyncClient:
        async with AsyncEchoNova(api_key=TEST_KEY) as aclient:
            return aclient._pool.http

    assert asyncio.run(run()).is_closed


def test_http_client_type_is_checked() -> None:
    with pytest.raises(UsageError):
        EchoNova(api_key=TEST_KEY, http_client=httpx.AsyncClient())  # type: ignore[arg-type]
    with pytest.raises(UsageError):
        AsyncEchoNova(api_key=TEST_KEY, http_client=httpx.Client())  # type: ignore[arg-type]


def test_echonova_log_env(monkeypatch: pytest.MonkeyPatch) -> None:
    import logging

    from echonova import _logging

    monkeypatch.setenv("ECHONOVA_LOG", "debug")
    monkeypatch.setattr(_logging, "_configured", False)
    logger = logging.getLogger("echonova")
    saved = (list(logger.handlers), logger.level)
    try:
        logger.handlers.clear()
        EchoNova(api_key=TEST_KEY)
        assert logger.level == logging.DEBUG
        assert logger.handlers
    finally:
        logger.handlers[:] = saved[0]
        logger.setLevel(saved[1])


def test_clock_injection_keeps_tests_fast() -> None:
    time = FakeTime()
    client = make_client(job_handler, time=time)
    assert client._runtime.clock() == 1000.0


def test_plain_http_with_a_key_logs_a_warning(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("WARNING", logger="echonova")
    EchoNova(api_key=TEST_KEY, base_url="http://localhost:8080")
    assert "unencrypted" not in caplog.text
    EchoNova(api_key=TEST_KEY, base_url="http://proxy.example.com")
    assert "unencrypted" in caplog.text


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "127.8.9.10", "[::1]"])
def test_plain_http_to_loopback_is_silent(caplog: pytest.LogCaptureFixture, host: str) -> None:
    caplog.set_level("WARNING", logger="echonova")
    EchoNova(api_key=TEST_KEY, base_url=f"http://{host}:8080")
    EchoNova(base_url=f"http://{host}:8080", auth=lambda: {"X-Session": "s"})
    AsyncEchoNova(base_url=f"http://{host}:8080", auth=lambda: {"X-Session": "s"})
    assert "unencrypted" not in caplog.text


@pytest.mark.parametrize("host", ["proxy.example.com", "10.0.0.5", "[fd00::1]", "localhost.example.com"])
def test_plain_http_with_an_auth_hook_logs_a_warning(caplog: pytest.LogCaptureFixture, host: str) -> None:
    caplog.set_level("WARNING", logger="echonova")
    EchoNova(base_url=f"http://{host}", auth=lambda: {"X-Session": "s"})
    assert "auth hook's headers would be sent unencrypted" in caplog.text
    assert "API key" not in caplog.text
    caplog.clear()
    AsyncEchoNova(base_url=f"https://{host}", auth=lambda: {"X-Session": "s"})
    assert "unencrypted" not in caplog.text


class _EndlessBody:
    """A 1 MiB error body, counting the chunks the client pulls from it."""

    def __init__(self, prefix: bytes = b"") -> None:
        self.prefix = prefix
        self.pulled = 0

    def chunks(self) -> Any:
        yield self.prefix
        for _ in range(1024):
            self.pulled += 1
            yield b"x" * 1024

    async def achunks(self) -> Any:
        for chunk in self.chunks():
            yield chunk


def test_error_bodies_are_read_up_to_64_kib() -> None:
    from echonova import NotFoundError
    from echonova._base_client import ERROR_BODY_LIMIT

    endless = _EndlessBody(b"<html>")
    client = make_client(lambda r: httpx.Response(404, content=endless.chunks()))
    with pytest.raises(NotFoundError) as caught:
        client.text_to_speech.jobs.get(JOB_ID)
    assert endless.pulled <= ERROR_BODY_LIMIT // 1024
    assert caught.value.raw_body is not None
    assert caught.value.raw_body.startswith("<html>")

    endless = _EndlessBody()
    downloads = make_client(job_handler, download=lambda r: httpx.Response(404, content=endless.chunks()))
    with pytest.raises(NotFoundError):
        downloads.download("https://storage.example.com/out.wav?sig=x")
    assert endless.pulled <= ERROR_BODY_LIMIT // 1024


def test_async_error_bodies_are_read_up_to_64_kib() -> None:
    from echonova import NotFoundError
    from echonova._base_client import ERROR_BODY_LIMIT

    endless = _EndlessBody(b"<html>")
    client = make_async_client(lambda r: httpx.Response(404, content=endless.achunks()))
    with pytest.raises(NotFoundError):
        asyncio.run(client.text_to_speech.jobs.get(JOB_ID))
    assert endless.pulled <= ERROR_BODY_LIMIT // 1024

    endless = _EndlessBody()
    downloads = make_async_client(job_handler, download=lambda r: httpx.Response(404, content=endless.achunks()))
    with pytest.raises(NotFoundError):
        asyncio.run(downloads.download("https://storage.example.com/out.wav?sig=x"))
    assert endless.pulled <= ERROR_BODY_LIMIT // 1024


def test_an_error_envelope_under_the_cap_keeps_its_message() -> None:
    from echonova import NotFoundError

    padded = {"data": None, "success": False, "statusCode": 404, "errorMessage": "Job not found", "pad": "p" * 60_000}
    client = make_client(lambda r: httpx.Response(404, json=padded))
    with pytest.raises(NotFoundError) as caught:
        client.text_to_speech.jobs.get(JOB_ID)
    assert caught.value.error_message == "Job not found"
