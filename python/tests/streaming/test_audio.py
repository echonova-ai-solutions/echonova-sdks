from __future__ import annotations

import io
import struct
import wave
from pathlib import Path

import pytest

from echonova.audio import Audio, WavWriter, iter_frames, iter_wav_pcm, read_wav, wav_header


def test_audio_duration_and_wav_round_trip(tmp_path: Path) -> None:
    audio = Audio(b"\x01\x00" * 16_000, 16_000)
    assert audio.duration == 1.0
    assert audio.channels == 1
    path = audio.to_wav(tmp_path / "a.wav")
    with wave.open(str(path), "rb") as reader:  # the stdlib agrees with our header
        assert (reader.getnchannels(), reader.getsampwidth(), reader.getframerate()) == (1, 2, 16_000)
        assert reader.readframes(reader.getnframes()) == audio.pcm
    assert read_wav(path) == audio
    assert "bytes=32000" in repr(audio)  # no PCM dump in reprs


def test_empty_audio_has_zero_duration() -> None:
    assert Audio(b"", 0).duration == 0.0


def test_wav_header_streaming_sizes() -> None:
    header = wav_header(24_000)
    assert len(header) == 44
    riff_size, data_size = struct.unpack("<I", header[4:8])[0], struct.unpack("<I", header[40:44])[0]
    assert riff_size == data_size == 0xFFFFFFFF
    fixed = wav_header(24_000, data_len=100)
    assert struct.unpack("<I", fixed[4:8])[0] == 136
    assert struct.unpack("<I", fixed[40:44])[0] == 100
    with pytest.raises(ValueError, match="sample_rate"):
        wav_header(0)


def test_read_wav_of_a_streaming_header_reads_to_the_end() -> None:
    data = wav_header(8_000) + b"\x02\x00" * 10
    assert read_wav(io.BytesIO(data)) == Audio(b"\x02\x00" * 10, 8_000)


def test_wav_writer_patches_sizes(tmp_path: Path) -> None:
    path = tmp_path / "w.wav"
    with WavWriter(path, 22_050) as writer:
        writer.write(b"\x00\x01" * 50)
        writer.write(b"\x02\x03" * 50)
    assert writer.bytes_written == 200
    raw = path.read_bytes()
    assert struct.unpack("<I", raw[40:44])[0] == 200
    assert read_wav(path) == Audio(b"\x00\x01" * 50 + b"\x02\x03" * 50, 22_050)
    with pytest.raises(ValueError, match="closed"):
        writer.write(b"\x00\x00")


def test_wav_writer_on_unseekable_stream_keeps_streaming_sizes() -> None:
    class Pipe(io.RawIOBase):
        def __init__(self) -> None:
            self.data = bytearray()

        def writable(self) -> bool:
            return True

        def write(self, b: bytes) -> int:  # type: ignore[override]
            self.data += b
            return len(b)

    pipe = Pipe()
    writer = WavWriter(pipe, 16_000)  # type: ignore[arg-type]
    writer.write(b"\x00\x00")
    writer.close()
    assert struct.unpack("<I", bytes(pipe.data[40:44]))[0] == 0xFFFFFFFF


def _wav(channels: int = 1, bits: int = 16, tag: int = 1, extensible: bool = False) -> bytes:
    block = channels * bits // 8
    if extensible:
        fmt = struct.pack("<HHIIHHHHI", 0xFFFE, channels, 16_000, 16_000 * block, block, bits, 22, bits, 0)
        fmt += struct.pack("<H", tag) + b"\x00" * 14
    else:
        fmt = struct.pack("<HHIIHH", tag, channels, 16_000, 16_000 * block, block, bits)
    extra = b"LIST" + struct.pack("<I", 3) + b"abc\x00"  # odd-sized chunk with padding
    body = (
        b"WAVE"
        + b"fmt "
        + struct.pack("<I", len(fmt))
        + fmt
        + extra
        + b"data"
        + struct.pack("<I", 4)
        + b"\x01\x02\x03\x04"
    )
    return b"RIFF" + struct.pack("<I", len(body)) + body


def test_read_wav_validates_mono_16_bit_pcm() -> None:
    assert read_wav(io.BytesIO(_wav())).pcm == b"\x01\x02\x03\x04"
    assert read_wav(io.BytesIO(_wav(extensible=True))).pcm == b"\x01\x02\x03\x04"
    with pytest.raises(ValueError, match="channels"):
        read_wav(io.BytesIO(_wav(channels=2)))
    with pytest.raises(ValueError, match="8-bit"):
        read_wav(io.BytesIO(_wav(bits=8)))
    with pytest.raises(ValueError, match="format 3"):
        read_wav(io.BytesIO(_wav(tag=3)))
    with pytest.raises(ValueError, match="not a WAV"):
        read_wav(io.BytesIO(b"ID3" + b"\x00" * 40))


def test_iter_wav_pcm_chunks(tmp_path: Path) -> None:
    path = Audio(bytes(range(256)) * 10, 16_000).to_wav(tmp_path / "c.wav")
    chunks = list(iter_wav_pcm(path, chunk_bytes=1001))
    assert all(len(c) == 1000 for c in chunks[:-1])
    assert b"".join(chunks) == bytes(range(256)) * 10


def test_iter_frames() -> None:
    frames = list(iter_frames(b"\x00" * 7_000, 16_000, frame_ms=100))
    assert [len(f) for f in frames] == [3_200, 3_200, 600]
    assert list(iter_frames(b"", 16_000)) == []
    with pytest.raises(ValueError, match="positive"):
        list(iter_frames(b"\x00\x00", 0))
