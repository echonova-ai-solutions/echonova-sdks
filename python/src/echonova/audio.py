"""Helpers for the raw audio the streams use: 16-bit little-endian mono PCM.

Standard library only. Nothing here resamples or converts formats: audio must
already be mono PCM16 at the sample rate you connect with.
"""

from __future__ import annotations

import os
import struct
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import BinaryIO, TypeAlias, Union

__all__ = ["Audio", "WavWriter", "iter_frames", "iter_wav_pcm", "read_wav", "wav_header"]

BYTES_PER_SAMPLE = 2
UNKNOWN_SIZE = 0xFFFFFFFF  # RIFF/data size for a WAV stream whose length isn't known yet
_PCM = 1
_EXTENSIBLE = 0xFFFE
_HEADER_SIZE = 44

PathLike: TypeAlias = Union[str, "os.PathLike[str]"]


@dataclass(frozen=True, slots=True)
class Audio:
    """PCM16LE mono audio and its sample rate."""

    pcm: bytes = field(repr=False)
    sample_rate: int

    @property
    def channels(self) -> int:
        return 1

    @property
    def duration(self) -> float:
        """Length in seconds."""
        if self.sample_rate <= 0:
            return 0.0
        return len(self.pcm) / (self.sample_rate * BYTES_PER_SAMPLE)

    def wav_bytes(self) -> bytes:
        """The audio as a complete WAV file."""
        return wav_header(self.sample_rate, data_len=len(self.pcm)) + self.pcm

    def to_wav(self, path: PathLike) -> Path:
        """Write the audio to a WAV file and return its path."""
        target = Path(path)
        target.write_bytes(self.wav_bytes())
        return target

    def __repr__(self) -> str:
        return f"Audio(sample_rate={self.sample_rate}, duration={self.duration:.3f}s, bytes={len(self.pcm)})"


def wav_header(
    sample_rate: int,
    *,
    channels: int = 1,
    bits_per_sample: int = 16,
    data_len: int | None = None,
) -> bytes:
    """A 44-byte WAV header. ``data_len=None`` writes 0xFFFFFFFF sizes, for audio still being streamed."""
    if sample_rate <= 0:
        raise ValueError("sample_rate must be a positive number of Hz")
    block_align = channels * bits_per_sample // 8
    if data_len is None:
        riff_size = data_size = UNKNOWN_SIZE
    else:
        if data_len < 0 or data_len + _HEADER_SIZE - 8 > UNKNOWN_SIZE - 1:
            raise ValueError("data_len doesn't fit in a WAV header")
        data_size = data_len
        riff_size = data_len + _HEADER_SIZE - 8
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        riff_size,
        b"WAVE",
        b"fmt ",
        16,
        _PCM,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )


class WavWriter:
    """Write PCM16 mono audio to a WAV file as it arrives.

    The header is written first with unknown sizes; ``close()`` fills in the
    real sizes when the file is seekable.
    """

    def __init__(self, target: PathLike | BinaryIO, sample_rate: int) -> None:
        if isinstance(target, (str, os.PathLike)):
            self._file: BinaryIO = open(target, "wb")  # noqa: SIM115 - closed in close()
            self._owns_file = True
        else:
            self._file = target
            self._owns_file = False
        self.sample_rate = sample_rate
        self.bytes_written = 0
        self.closed = False
        self._start = self._file.tell() if self._file.seekable() else 0
        self._file.write(wav_header(sample_rate))

    def write(self, pcm: bytes | bytearray | memoryview) -> None:
        if self.closed:
            raise ValueError("write to a closed WavWriter")
        self._file.write(pcm)
        self.bytes_written += len(pcm)

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            if self._file.seekable() and self.bytes_written + _HEADER_SIZE - 8 < UNKNOWN_SIZE:
                end = self._file.tell()
                self._file.seek(self._start + 4)
                self._file.write(struct.pack("<I", self.bytes_written + _HEADER_SIZE - 8))
                self._file.seek(self._start + 40)
                self._file.write(struct.pack("<I", self.bytes_written))
                self._file.seek(end)
            self._file.flush()
        finally:
            if self._owns_file:
                self._file.close()

    def __enter__(self) -> WavWriter:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.close()


@dataclass(frozen=True, slots=True)
class _WavInfo:
    sample_rate: int
    data_offset: int
    data_size: int | None  # None: read to the end of the file


def _read_exact(file: BinaryIO, size: int, what: str) -> bytes:
    data = file.read(size)
    if len(data) != size:
        raise ValueError(f"not a valid WAV file: truncated {what}")
    return data


def _parse_header(file: BinaryIO) -> _WavInfo:
    riff, _, wave = struct.unpack("<4sI4s", _read_exact(file, 12, "header"))
    if riff != b"RIFF" or wave != b"WAVE":
        raise ValueError("not a WAV file (missing RIFF/WAVE header)")
    fmt: tuple[int, int, int, int] | None = None
    offset = 12
    while True:
        head = file.read(8)
        if len(head) < 8:
            raise ValueError("not a valid WAV file: no data chunk")
        chunk_id, size = struct.unpack("<4sI", head)
        offset += 8
        if chunk_id == b"fmt ":
            body = _read_exact(file, size, "fmt chunk")
            if size < 16:
                raise ValueError("not a valid WAV file: short fmt chunk")
            tag, channels, sample_rate, _, _, bits = struct.unpack("<HHIIHH", body[:16])
            if tag == _EXTENSIBLE and size >= 26:
                tag = struct.unpack("<H", body[24:26])[0]
            fmt = (tag, channels, sample_rate, bits)
            if size % 2:
                file.read(1)
            offset += size + size % 2
            continue
        if chunk_id == b"data":
            if fmt is None:
                raise ValueError("not a valid WAV file: data before fmt")
            tag, channels, sample_rate, bits = fmt
            if tag != _PCM:
                raise ValueError(f"unsupported WAV encoding (format {tag}); only uncompressed PCM is supported")
            if channels != 1:
                raise ValueError(f"the WAV file has {channels} channels; streams need mono audio")
            if bits != 16:
                raise ValueError(f"the WAV file is {bits}-bit; streams need 16-bit PCM")
            return _WavInfo(sample_rate, offset, None if size == UNKNOWN_SIZE else size)
        file.seek(size + size % 2, os.SEEK_CUR)
        offset += size + size % 2


def read_wav(source: PathLike | BinaryIO) -> Audio:
    """Read a mono 16-bit PCM WAV file. Raises ``ValueError`` for anything else."""
    if isinstance(source, (str, os.PathLike)):
        with open(source, "rb") as file:
            return _read_audio(file)
    source.seek(0)
    return _read_audio(source)


def _read_audio(file: BinaryIO) -> Audio:
    info = _parse_header(file)
    data = file.read() if info.data_size is None else file.read(info.data_size)
    return Audio(data[: len(data) - len(data) % 2], info.sample_rate)


def iter_wav_pcm(source: PathLike | BinaryIO, *, chunk_bytes: int = 3200) -> Iterator[bytes]:
    """Yield the PCM data of a mono 16-bit WAV file in chunks of ``chunk_bytes`` (rounded down to even)."""
    chunk_bytes = max(2, chunk_bytes - chunk_bytes % 2)
    if isinstance(source, (str, os.PathLike)):
        with open(source, "rb") as file:
            yield from _iter_data(file, chunk_bytes)
    else:
        source.seek(0)
        yield from _iter_data(source, chunk_bytes)


def _iter_data(file: BinaryIO, chunk_bytes: int) -> Iterator[bytes]:
    info = _parse_header(file)
    remaining = info.data_size
    while remaining is None or remaining > 0:
        size = chunk_bytes if remaining is None else min(chunk_bytes, remaining)
        data = file.read(size)
        if not data:
            return
        if remaining is not None:
            remaining -= len(data)
        yield data


def iter_frames(pcm: bytes | bytearray | memoryview, sample_rate: int, frame_ms: int = 100) -> Iterator[bytes]:
    """Split PCM16 mono audio into frames of ``frame_ms`` (the last one may be shorter)."""
    if sample_rate <= 0 or frame_ms <= 0:
        raise ValueError("sample_rate and frame_ms must be positive")
    size = max(BYTES_PER_SAMPLE, sample_rate * BYTES_PER_SAMPLE * frame_ms // 1000)
    size -= size % 2
    view = memoryview(pcm).cast("B")
    for start in range(0, len(view), size):
        yield bytes(view[start : start + size])
