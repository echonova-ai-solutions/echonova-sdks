"""Audio upload inputs: name, content type and replay across retries.

The content type comes from an explicit value, then the SDK's own extension map
(not the OS ``mimetypes`` table), then the file's leading bytes. The SDK always
sends a specific ``audio/*`` type and never ``application/octet-stream``.

Each attempt gets a fresh body: paths are reopened, bytes are reused and
seekable files are rewound to where they started. A non-seekable stream can only
be sent again while nothing has been read from it.
"""

from __future__ import annotations

import io
import os
from pathlib import Path
from typing import IO, Any

from ..errors import UsageError

FileContent = bytes | IO[bytes]
FileInput = str | os.PathLike[str] | bytes | IO[bytes] | tuple[str, FileContent] | tuple[str, FileContent, str]
"""A path, bytes, a binary file object, or ``(filename, content[, content_type])``."""

EXTENSION_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".webm": "audio/webm",
    ".amr": "audio/amr",
}
_TYPE_EXTENSIONS = {content_type: ext for ext, content_type in EXTENSION_TYPES.items()}
_GENERIC_TYPES = {"application/octet-stream", "binary/octet-stream", ""}
SNIFF_BYTES = 16


def sniff_content_type(head: bytes) -> str | None:
    """Recognise common audio containers from their first bytes."""
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head[:4] == b"fLaC":
        return "audio/flac"
    if head[:4] == b"OggS":
        return "audio/ogg"
    if head[:3] == b"ID3":
        return "audio/mpeg"
    if head[:6] == b"#!AMR\n":
        return "audio/amr"
    if head[4:8] == b"ftyp":
        return "audio/mp4"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "audio/webm"
    if len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0:
        layer = (head[1] >> 1) & 0x03
        return "audio/aac" if layer == 0 else "audio/mpeg"  # ADTS AAC has layer 0; MPEG audio doesn't
    return None


class _Window:
    """A seekable file viewed from ``start``, so a rewind goes back to where the caller left it."""

    def __init__(self, file: IO[bytes], start: int) -> None:
        self._file = file
        self._start = start

    def read(self, size: int = -1) -> bytes:
        return self._file.read(size)

    def tell(self) -> int:
        return self._file.tell() - self._start

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        if whence == os.SEEK_SET:
            offset += self._start
        return self._file.seek(offset, whence) - self._start


class _OneShot:
    """A non-seekable stream, with any bytes already read for sniffing put back in front."""

    def __init__(self, file: IO[bytes], head: bytes) -> None:
        self._file = file
        self._head = head
        self.consumed = False

    def read(self, size: int = -1) -> bytes:
        self.consumed = True
        if self._head:
            if size is None or size < 0:
                data, self._head = self._head + self._file.read(), b""
                return data
            data, self._head = self._head[:size], self._head[size:]
            if len(data) < size:
                data += self._file.read(size - len(data))
            return data
        return self._file.read(size)


class PreparedFile:
    """One upload, ready to be opened for each attempt."""

    def __init__(self, filename: str, content_type: str, source: Any, *, kind: str, start: int = 0) -> None:
        self.filename = filename
        self.content_type = content_type
        self._source = source
        self._kind = kind  # "path" | "bytes" | "seekable" | "stream"
        self._start = start
        self._open_handle: IO[bytes] | None = None

    @property
    def replayable(self) -> bool:
        return not (self._kind == "stream" and self._source.consumed)

    def open(self) -> bytes | IO[bytes] | Any:
        """The body for one attempt. Call ``close_attempt()`` when the attempt ends."""
        if self._kind == "path":
            self._open_handle = open(self._source, "rb")  # noqa: SIM115 - closed by close_attempt()
            return self._open_handle
        if self._kind == "seekable":
            self._source.seek(self._start)
            return self._source if self._start == 0 else _Window(self._source, self._start)
        return self._source

    def close_attempt(self) -> None:
        if self._open_handle is not None:
            self._open_handle.close()
            self._open_handle = None


def _resolve_type(explicit: str | None, filename: str | None, head: bytes | None) -> str | None:
    if explicit is not None:
        if explicit.strip().lower() in _GENERIC_TYPES:
            raise UsageError(
                f"content type {explicit!r} is too generic: the API needs the audio type, such as 'audio/mpeg'"
            )
        return explicit
    if filename:
        known = EXTENSION_TYPES.get(Path(filename).suffix.lower())
        if known:
            return known
    return sniff_content_type(head) if head else None


def _default_name(content_type: str) -> str:
    return "audio" + _TYPE_EXTENSIONS.get(content_type.split(";")[0].strip().lower(), "")


def _file_name(file: Any) -> str | None:
    name = getattr(file, "name", None)
    return os.path.basename(name) if isinstance(name, str) and name else None


def _seekable(file: Any) -> bool:
    try:
        return bool(file.seekable()) if hasattr(file, "seekable") else False
    except (OSError, ValueError):
        return False


def prepare_file(value: FileInput) -> PreparedFile:
    """Normalise an upload: a path, bytes, a binary file object, or ``(filename, content[, content_type])``."""
    explicit_type: str | None = None
    filename: str | None = None
    content: Any = value
    if isinstance(value, tuple):
        if len(value) not in (2, 3) or not isinstance(value[0], str):
            raise UsageError("a file tuple is (filename, content) or (filename, content, content_type)")
        filename, content = value[0], value[1]
        if len(value) == 3:
            explicit_type = value[2]
    elif isinstance(value, (str, os.PathLike)):
        path = Path(os.fspath(value))
        if not path.is_file():
            raise UsageError(f"no such file: {path}")
        head = None
        if path.suffix.lower() not in EXTENSION_TYPES:
            with open(path, "rb") as handle:
                head = handle.read(SNIFF_BYTES)
        content_type = _require_type(_resolve_type(None, path.name, head), path.name)
        return PreparedFile(path.name, content_type, path, kind="path")

    if isinstance(content, (bytes, bytearray, memoryview)):
        data = bytes(content)
        content_type = _require_type(_resolve_type(explicit_type, filename, data[:SNIFF_BYTES]), filename)
        return PreparedFile(filename or _default_name(content_type), content_type, data, kind="bytes")

    if isinstance(content, io.TextIOBase) or not hasattr(content, "read"):
        raise UsageError("file must be a path, bytes, or a file object opened in binary mode ('rb')")
    filename = filename or _file_name(content)
    if _seekable(content):
        start = content.tell()
        head = None
        if explicit_type is None and not (filename and Path(filename).suffix.lower() in EXTENSION_TYPES):
            head = content.read(SNIFF_BYTES)
            content.seek(start)
        content_type = _require_type(_resolve_type(explicit_type, filename, head), filename)
        return PreparedFile(
            filename or _default_name(content_type), content_type, content, kind="seekable", start=start
        )

    head = b""
    if explicit_type is None and not (filename and Path(filename).suffix.lower() in EXTENSION_TYPES):
        head = content.read(SNIFF_BYTES) or b""
    content_type = _require_type(_resolve_type(explicit_type, filename, head), filename)
    return PreparedFile(filename or _default_name(content_type), content_type, _OneShot(content, head), kind="stream")


def _require_type(content_type: str | None, filename: str | None) -> str:
    if content_type is None:
        what = repr(filename) if filename else "the file"
        raise UsageError(
            f"can't tell the audio format of {what}. Use a known extension "
            f"({', '.join(EXTENSION_TYPES)}) or pass (filename, content, content_type)."
        )
    return content_type


def form_value(value: Any) -> str:
    """Encode a multipart field value the way the API reads it."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)
