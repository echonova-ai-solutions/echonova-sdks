"""Signed-link downloads: no credentials, streamed to disk or returned, expired links explained."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from _support import JOB_ID, SIGNED_URL, TEST_KEY, FakeTime, Recorder, make_async_client, make_client, ok
from echonova import DownloadExpiredError, JobFailedError, NotFoundError, ServerError, UsageError

AUDIO = b"RIFF" + b"\x01" * 200_000


def storage(*responses: httpx.Response) -> Recorder:
    pending = list(responses)
    return Recorder(lambda r: pending.pop(0) if pending else httpx.Response(200, content=AUDIO))


def api(request: httpx.Request) -> httpx.Response:
    return ok({"id": JOB_ID, "status": "completed", "audioUrl": SIGNED_URL, "outputUrl": SIGNED_URL})


def test_download_sends_no_authorization_header() -> None:
    files = storage()
    data = make_client(api, download=files).download(SIGNED_URL)
    assert data == AUDIO
    request = files.last
    assert "authorization" not in request.headers
    assert str(request.url) == SIGNED_URL
    assert request.headers["user-agent"].startswith("echonova-python/")


def test_download_ignores_default_headers_and_auth_hooks() -> None:
    files = storage()
    client = make_client(api, download=files, default_headers={"X-Team": "a"}, auth=lambda: {"X-App": "secret"})
    client.download(SIGNED_URL)
    assert "x-team" not in files.last.headers
    assert "x-app" not in files.last.headers


def test_download_to_a_file(tmp_path: Path) -> None:
    target = tmp_path / "speech.wav"
    result = make_client(api, download=storage()).download(SIGNED_URL, to=target)
    assert result == target
    assert target.read_bytes() == AUDIO
    assert list(tmp_path.iterdir()) == [target]  # the temporary file was renamed into place


def test_download_to_a_directory_keeps_the_link_name(tmp_path: Path) -> None:
    result = make_client(api, download=storage()).download(SIGNED_URL, to=tmp_path)
    assert result == tmp_path / "out.wav"


def test_expired_link_is_explained_and_leaves_no_file(tmp_path: Path) -> None:
    files = storage(httpx.Response(403, text="<Error><Code>AuthenticationFailed</Code></Error>"))
    with pytest.raises(DownloadExpiredError) as info:
        make_client(api, download=files).download(SIGNED_URL, to=tmp_path / "x.wav")
    assert info.value.url == "https://storage.example.com/tts/out.wav"
    assert "sig=" not in str(info.value)
    assert list(tmp_path.iterdir()) == []
    assert len(files.requests) == 1


def test_transient_storage_errors_are_retried() -> None:
    time = FakeTime()
    files = storage(httpx.Response(503, text="busy"), httpx.Response(500))
    assert make_client(api, download=files, time=time).download(SIGNED_URL) == AUDIO
    assert len(files.requests) == 3


def test_missing_file_is_not_retried_and_hides_the_body() -> None:
    files = storage(httpx.Response(404, text="<Error>BlobNotFound https://storage.example.com/path?sig=x</Error>"))
    with pytest.raises(NotFoundError) as info:
        make_client(api, download=files).download(SIGNED_URL)
    assert "sig" not in str(info.value)
    assert info.value.raw_body is None
    assert len(files.requests) == 1


class _BrokenStream(httpx.SyncByteStream):
    """Sends some bytes, then the connection resets."""

    def __init__(self, request: httpx.Request) -> None:
        self._request = request

    def __iter__(self) -> Iterator[bytes]:
        yield b"partial"
        raise httpx.ReadError("reset", request=self._request)


def test_a_reset_mid_download_restarts_the_file(tmp_path: Path) -> None:
    attempts: list[int] = []

    class Flaky(httpx.BaseTransport):
        def handle_request(self, request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            if len(attempts) == 1:
                return httpx.Response(200, stream=_BrokenStream(request))
            return httpx.Response(200, content=AUDIO)

    target = tmp_path / "a.wav"
    client = make_client(api, download_http_client=httpx.Client(transport=Flaky()))
    client.download(SIGNED_URL, to=target)
    assert target.read_bytes() == AUDIO
    assert len(attempts) == 2


def test_download_log_lines_have_no_query_string(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="echonova")
    make_client(api, download=storage(httpx.Response(500))).download(SIGNED_URL)
    assert "storage.example.com/tts/out.wav" in caplog.text
    assert "sig=" not in caplog.text
    assert "REDACTED-secret" not in caplog.text


def test_jobs_download_gets_a_fresh_link_first(tmp_path: Path) -> None:
    recorder = Recorder(api)
    files = storage()
    client = make_client(recorder, download=files)
    client.text_to_speech.jobs.download(JOB_ID, to=tmp_path / "a.wav")
    assert recorder.last.url.path == f"/v1/text-to-speech/jobs/{JOB_ID}"
    assert recorder.last.headers["authorization"] == f"Bearer {TEST_KEY}"
    assert "authorization" not in files.last.headers
    assert client.sound_cleaning.jobs.download(JOB_ID) == AUDIO
    assert recorder.last.url.path == f"/v1/sound-cleaning/jobs/{JOB_ID}"


def test_jobs_download_of_an_unfinished_or_failed_job() -> None:
    client = make_client(lambda r: ok({"id": JOB_ID, "status": "processing"}), download=storage())
    with pytest.raises(UsageError, match="no audio yet"):
        client.text_to_speech.jobs.download(JOB_ID)
    client = make_client(lambda r: ok({"id": JOB_ID, "status": "failed", "error": "boom"}), download=storage())
    with pytest.raises(JobFailedError):
        client.sound_cleaning.jobs.download(JOB_ID)
    with pytest.raises(UsageError):
        client.download(None)


def test_async_download(tmp_path: Path) -> None:
    files = storage(httpx.Response(502))
    client = make_async_client(api, download=files)

    async def run() -> None:
        assert await client.download(SIGNED_URL) == AUDIO
        path = await client.text_to_speech.jobs.download(JOB_ID, to=tmp_path / "b.wav")
        assert path.read_bytes() == AUDIO

    asyncio.run(run())
    assert all("authorization" not in r.headers for r in files.requests)


def test_async_expired_link() -> None:
    client = make_async_client(api, download=storage(httpx.Response(403)))
    with pytest.raises(DownloadExpiredError):
        asyncio.run(client.download(SIGNED_URL))


def test_storage_errors_after_retries_are_server_errors() -> None:
    files = storage(httpx.Response(500), httpx.Response(500), httpx.Response(500))
    with pytest.raises(ServerError):
        make_client(api, download=files).download(SIGNED_URL)
    assert len(files.requests) == 3
