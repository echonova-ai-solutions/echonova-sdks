from __future__ import annotations

import pytest
from hypothesis import given
from hypothesis import strategies as st

from echonova._streaming._pcm_framer import MAX_FRAME_BYTES, PcmFramer


@pytest.mark.parametrize(
    ("sample_rate", "frame_ms", "expected"),
    [
        (16_000, 100, 3_200),
        (8_000, 100, 1_600),
        (48_000, 100, 9_600),
        (48_000, 1_000, MAX_FRAME_BYTES),
        (8_001, 100, 1_600),
    ],
)
def test_frame_size(sample_rate: int, frame_ms: int, expected: int) -> None:
    assert PcmFramer(sample_rate, frame_ms=frame_ms).frame_bytes == expected


@given(
    sample_rate=st.sampled_from([8_000, 16_000, 22_050, 44_100, 48_000]),
    chunks=st.lists(st.binary(max_size=20_000), max_size=30),
    segment_after=st.integers(min_value=0, max_value=30),
)
def test_frames_are_lossless_even_and_bounded(sample_rate: int, chunks: list[bytes], segment_after: int) -> None:
    framer = PcmFramer(sample_rate)
    sent: list[bytes] = []
    for index, chunk in enumerate(chunks):
        sent += framer.push(chunk)
        if index == segment_after:
            sent += framer.flush()  # end_segment
    tail, dropped = framer.finish()
    sent += tail
    data = b"".join(chunks)
    assert all(len(frame) % 2 == 0 and 0 < len(frame) <= MAX_FRAME_BYTES for frame in sent)
    assert b"".join(sent) == data[: len(data) - dropped]
    assert dropped == len(data) % 2
    assert framer.bytes_emitted == len(data) - dropped


def test_odd_byte_carries_across_end_segment() -> None:
    framer = PcmFramer(16_000)
    framer.push(b"\x01\x02\x03")
    assert framer.flush() == [b"\x01\x02"]
    assert framer.pending_bytes == 1
    assert framer.push(b"\x04") == []
    assert framer.flush() == [b"\x03\x04"]


def test_input_is_copied() -> None:
    framer = PcmFramer(8_000, frame_ms=1)  # 16-byte frames
    buffer = bytearray(b"a" * 10)
    framer.push(buffer)
    buffer[:] = b"b" * 10
    assert framer.push(b"c" * 6) == [b"a" * 10 + b"c" * 6]


def test_invalid_arguments() -> None:
    with pytest.raises(ValueError, match="sample_rate"):
        PcmFramer(0)
    with pytest.raises(ValueError, match="frame_ms"):
        PcmFramer(16_000, frame_ms=0)
