"""Split raw PCM16LE audio into frames the Speech to Text stream accepts.

Frames are about ``frame_ms`` of audio, never larger than 65,536 bytes (larger
frames close the socket with 1008), and always an even number of bytes, so a
16-bit sample is never split. An odd trailing byte is held until more audio
arrives. Input is copied, so callers can reuse their buffers.
"""

from __future__ import annotations

MAX_FRAME_BYTES = 65_536
BYTES_PER_SAMPLE = 2


class PcmFramer:
    def __init__(self, sample_rate: int, *, frame_ms: int = 100) -> None:
        if sample_rate <= 0:
            raise ValueError("sample_rate must be a positive number of Hz")
        if frame_ms <= 0:
            raise ValueError("frame_ms must be positive")
        size = sample_rate * BYTES_PER_SAMPLE * frame_ms // 1000
        size -= size % 2
        self.frame_bytes = max(BYTES_PER_SAMPLE, min(MAX_FRAME_BYTES, size))
        self.sample_rate = sample_rate
        self._buffer = bytearray()
        self.bytes_emitted = 0

    @property
    def pending_bytes(self) -> int:
        return len(self._buffer)

    @property
    def seconds_emitted(self) -> float:
        return self.bytes_emitted / (self.sample_rate * BYTES_PER_SAMPLE)

    def push(self, data: bytes | bytearray | memoryview) -> list[bytes]:
        """Add audio; return the complete frames now ready to send."""
        self._buffer += data
        frames = []
        while len(self._buffer) >= self.frame_bytes:
            frames.append(bytes(self._buffer[: self.frame_bytes]))
            del self._buffer[: self.frame_bytes]
        self.bytes_emitted += sum(len(f) for f in frames)
        return frames

    def flush(self) -> list[bytes]:
        """Return all buffered whole samples (before ``end_segment``). An odd byte stays buffered."""
        whole = len(self._buffer) - len(self._buffer) % 2
        if whole == 0:
            return []
        frame = bytes(self._buffer[:whole])
        del self._buffer[:whole]
        self.bytes_emitted += whole
        return [frame]

    def finish(self) -> tuple[list[bytes], int]:
        """Flush at ``stop``. Returns the last frames and how many odd bytes were dropped (0 or 1)."""
        frames = self.flush()
        dropped = len(self._buffer)
        self._buffer.clear()
        return frames, dropped
