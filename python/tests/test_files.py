"""Upload inputs: names, content types, and replaying the body on a retry."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import httpx
import pytest

from _support import JOB_ID, MP3, WAV, FakeTime, Recorder, fail, make_client, multipart_fields, ok
from echonova import APIConnectionError, UsageError
from echonova._core._files import EXTENSION_TYPES, prepare_file, sniff_content_type

RESULT = {"jobId": JOB_ID, "status": "completed"}


@pytest.mark.parametrize(("ext", "content_type"), sorted(EXTENSION_TYPES.items()))
def test_extension_map(tmp_path: Path, ext: str, content_type: str) -> None:
    path = tmp_path / f"clip{ext.upper()}"
    path.write_bytes(b"\x00" * 8)
    prepared = prepare_file(path)
    assert (prepared.filename, prepared.content_type) == (path.name, content_type)
    assert content_type.startswith("audio/")


def test_wav_is_audio_wav_not_the_os_guess() -> None:
    assert prepare_file(("a.wav", b"")).content_type == "audio/wav"  # mimetypes says audio/x-wav


@pytest.mark.parametrize(
    ("head", "content_type"),
    [
        (WAV, "audio/wav"),
        (MP3, "audio/mpeg"),
        (b"\xff\xfb\x90\x00", "audio/mpeg"),
        (b"\xff\xf1\x50\x80", "audio/aac"),
        (b"fLaC\x00\x00\x00\x22", "audio/flac"),
        (b"OggS\x00\x02", "audio/ogg"),
        (b"#!AMR\n\x3c", "audio/amr"),
        (b"\x00\x00\x00\x20ftypM4A ", "audio/mp4"),
        (b"\x1a\x45\xdf\xa3\x01", "audio/webm"),
        (b"plain text", None),
        (b"", None),
    ],
)
def test_sniffing(head: bytes, content_type: str | None) -> None:
    assert sniff_content_type(head) == content_type


def test_bytes_get_a_name_matching_the_sniffed_type() -> None:
    prepared = prepare_file(MP3)
    assert (prepared.filename, prepared.content_type) == ("audio.mp3", "audio/mpeg")


def test_unknown_extension_falls_back_to_sniffing(tmp_path: Path) -> None:
    path = tmp_path / "recording.dat"
    path.write_bytes(WAV)
    assert prepare_file(path).content_type == "audio/wav"
    assert prepare_file(str(path)).filename == "recording.dat"


def test_explicit_content_type_wins() -> None:
    assert prepare_file(("x.wav", b"", "audio/x-custom")).content_type == "audio/x-custom"


@pytest.mark.parametrize("generic", ["application/octet-stream", "binary/octet-stream", ""])
def test_generic_content_type_is_refused(generic: str) -> None:
    with pytest.raises(UsageError, match="too generic"):
        prepare_file(("x.mp3", MP3, generic))


def test_unrecognisable_file_is_a_usage_error(tmp_path: Path) -> None:
    with pytest.raises(UsageError, match="can't tell the audio format"):
        prepare_file(b"not audio at all")
    path = tmp_path / "notes.txt"
    path.write_text("hello")
    with pytest.raises(UsageError, match=r"notes\.txt"):
        prepare_file(path)


def test_missing_path_and_text_mode_files(tmp_path: Path) -> None:
    with pytest.raises(UsageError, match="no such file"):
        prepare_file(tmp_path / "missing.wav")
    with pytest.raises(UsageError, match="binary mode"):
        prepare_file(io.StringIO("text"))  # type: ignore[arg-type]
    with pytest.raises(UsageError):
        prepare_file(("a.wav",))  # type: ignore[arg-type]


def test_file_object_uses_its_name(tmp_path: Path) -> None:
    path = tmp_path / "talk.flac"
    path.write_bytes(b"fLaC")
    with open(path, "rb") as handle:
        prepared = prepare_file(handle)
        assert (prepared.filename, prepared.content_type) == ("talk.flac", "audio/flac")


# --- Replay across retries ----------------------------------------------------------------------


def flaky(*failures: Any) -> tuple[Recorder, list[bytes]]:
    """Fail with each item in turn (an exception or a response), then succeed. Records the file part of each attempt."""
    pending = list(failures)
    bodies: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(multipart_fields(request)["file"][2])
        if pending:
            failure = pending.pop(0)
            if isinstance(failure, httpx.Response):
                return failure
            raise failure(f"simulated {failure.__name__}", request=request)
        return ok(RESULT)

    return Recorder(handler), bodies


UNAVAILABLE = fail(503, "Speech service temporarily unavailable. Try again.")


def test_path_is_reopened_for_every_attempt(tmp_path: Path) -> None:
    path = tmp_path / "call.wav"
    path.write_bytes(WAV)
    recorder, bodies = flaky(UNAVAILABLE, httpx.ConnectError)
    make_client(recorder).speech_to_text.transcribe(path, language="ar")
    assert bodies == [WAV, WAV, WAV]


def test_bytes_are_reused() -> None:
    recorder, bodies = flaky(UNAVAILABLE)
    make_client(recorder).speech_to_text.transcribe(WAV, language="ar")
    assert bodies == [WAV, WAV]


def test_seekable_file_is_rewound_to_where_it_started() -> None:
    stream = io.BytesIO(b"HEADER" + WAV)
    stream.seek(6)
    recorder, bodies = flaky(UNAVAILABLE)
    make_client(recorder).speech_to_text.transcribe(("call.wav", stream), language="ar")
    assert bodies == [WAV, WAV]


class NonSeekable(io.RawIOBase):
    def __init__(self, data: bytes) -> None:
        self._data = io.BytesIO(data)

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def readinto(self, buffer: Any) -> int:
        chunk = self._data.read(len(buffer))
        buffer[: len(chunk)] = chunk
        return len(chunk)


def test_non_seekable_stream_is_not_replayed() -> None:
    recorder, bodies = flaky(httpx.WriteError)
    with pytest.raises(APIConnectionError) as info:
        make_client(recorder).speech_to_text.transcribe(NonSeekable(WAV), language="ar")  # type: ignore[arg-type]
    assert bodies == [WAV]  # sniffed bytes were put back in front
    assert info.value.retry_disabled_reason == "body_not_replayable"
    assert info.value.may_have_executed is False


def test_non_seekable_stream_retries_while_nothing_was_read() -> None:
    attempts: list[int] = []

    class RefuseFirst(httpx.BaseTransport):
        def handle_request(self, request: httpx.Request) -> httpx.Response:
            attempts.append(1)
            if len(attempts) == 1:
                raise httpx.ConnectError("refused", request=request)  # before any byte of the body
            request.read()
            return ok(RESULT)

    time = FakeTime()
    client = make_client(lambda r: ok(RESULT), time=time)
    client._pool.http = httpx.Client(transport=RefuseFirst())
    client.speech_to_text.transcribe(("x.wav", NonSeekable(WAV)), language="ar")  # type: ignore[arg-type]
    assert len(attempts) == 2


def test_status_error_on_a_consumed_stream_is_not_retried() -> None:
    recorder, bodies = flaky(UNAVAILABLE)
    from echonova import ServiceUnavailableError

    with pytest.raises(ServiceUnavailableError) as info:
        make_client(recorder).sound_cleaning.clean(("x.wav", NonSeekable(WAV)))  # type: ignore[arg-type]
    assert len(bodies) == 1
    assert info.value.retry_disabled_reason == "body_not_replayable"
