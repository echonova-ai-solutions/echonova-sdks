"""Speech to Text stream sessions: ``AsyncSttSession`` and ``SttSession``.

A session never reconnects on its own: a new connection is a new session with
a new ``session_id``. ``transcribe_stream`` builds reconnects on top.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import AsyncIterable, AsyncIterator, Callable, Iterable, Iterator, Mapping
from concurrent.futures import Future
from types import TracebackType
from typing import Any

from ..audio import iter_frames
from ..errors import APITimeoutError, EchoNovaError, SessionEndedError, StreamClosedError, TimeoutKind
from ._aio import wait_event
from ._errors import CloseInfo
from ._link import AttemptLimiter, decode_event
from ._options import STT_PATH, StreamOptions
from ._stt_protocol import SttProtocol, SttState
from ._types import SegmentMark, SessionSummary, SttEvent, TerminologySet, Transcript
from ._ws_async import AsyncLink, open_websocket
from ._ws_async import LinkClosed as AsyncLinkClosed
from ._ws_sync import LinkClosed as SyncLinkClosed
from ._ws_sync import SyncLink, open_websocket_sync

logger = logging.getLogger("echonova.streaming")

END_SEGMENT_FRAME = '{"type":"end_segment"}'
STOP_FRAME = '{"type":"stop"}'
DEFAULT_STOP_TIMEOUT = 20.0
_SYNC_WAIT_SLICE = 0.5

Terminology = Mapping[str, Any]
AudioSource = AsyncIterable[bytes] | Iterable[bytes] | bytes | bytearray | memoryview


def stt_query(sample_rate: int, language: str, encoding: str) -> dict[str, str | int]:
    if not isinstance(sample_rate, int) or isinstance(sample_rate, bool) or sample_rate <= 0:
        raise TypeError("sample_rate must be a positive int (the Hz of the audio you send)")
    return {"sample_rate": sample_rate, "language": language, "encoding": encoding}


class _SttBase:
    _protocol: SttProtocol
    handshake_request_id: str | None

    @property
    def session_id(self) -> str | None:
        return self._protocol.session_id

    @property
    def job_id(self) -> str | None:
        """The ID this session's job gets once it is saved (from ``session.started``).

        Whether it was saved arrives at the end, in ``SessionSaved`` and in
        ``stop().saved_status``.
        """
        return self._protocol.job_id

    @property
    def language(self) -> str | None:
        return self._protocol.language

    @property
    def sample_rate(self) -> int:
        return self._protocol.sample_rate

    @property
    def max_session_seconds(self) -> float | None:
        """Seconds from ``session.started`` until the server ends the session."""
        return self._protocol.max_session_seconds

    @property
    def started_at(self) -> float | None:
        return self._protocol.started_at

    @property
    def state(self) -> SttState:
        return self._protocol.state

    @property
    def closed(self) -> bool:
        return self._protocol.closed

    @property
    def failure(self) -> EchoNovaError | None:
        """The error that ended the session, if it ended abnormally."""
        return self._protocol.fatal

    @property
    def summary(self) -> SessionSummary | None:
        """Totals from ``session.ended``, once it has arrived (with ``session.saved``, once that has too)."""
        return self._protocol.summary()

    @property
    def audio_seconds_sent(self) -> float:
        return self._protocol.framer.seconds_emitted

    def _warn_tail(self, dropped: int) -> None:
        if dropped:
            logger.warning("dropped %d trailing byte at stop(): audio must be whole 16-bit samples", dropped)

    def _start_error(self) -> EchoNovaError:
        return self._protocol.fatal or StreamClosedError("the Speech to Text session closed before it started")

    def __repr__(self) -> str:
        return f"{type(self).__name__}(session_id={self.session_id!r}, state={self.state!r})"


# --- Async ----------------------------------------------------------------------------------------


class AsyncSttSession(_SttBase):
    """A Speech to Text stream. Create it with ``connect_stt()``.

    Send audio with ``send_audio()`` (or ``feed_from()``), and iterate the session
    for events. If the session ends abnormally, iteration yields every event
    already received and then raises.
    """

    def __init__(
        self,
        options: StreamOptions,
        *,
        sample_rate: int,
        language: str,
        terminology: Terminology | None = None,
        encoding: str = "pcm_s16le",
        wait_for_slot: float | None = None,
        limiter: AttemptLimiter | None = None,
    ) -> None:
        self._options = options
        self._clock = options.clock
        self._url = options.url(STT_PATH, stt_query(sample_rate, language, encoding))
        self._terminology = terminology
        self._wait_for_slot = wait_for_slot
        self._limiter = limiter or AttemptLimiter(options.max_connect_attempts, options.connect_window)
        self._protocol = SttProtocol(sample_rate)
        self._link: AsyncLink | None = None
        self._changed = asyncio.Event()
        self._out_lock = asyncio.Lock()
        self._terminology_lock = asyncio.Lock()
        self.handshake_request_id = None

    async def _start(self, *, after_abnormal: bool = False) -> AsyncSttSession:
        ws = await open_websocket(
            self._options,
            self._url,
            limiter=self._limiter,
            wait_for_slot=self._wait_for_slot,
            after_abnormal=after_abnormal,
        )
        self._link = AsyncLink(
            ws, self._options, on_text=self._on_text, on_binary=self._on_binary, on_closed=self._on_closed
        )
        self.handshake_request_id = self._link.handshake_request_id
        protocol = self._protocol
        try:
            await self._wait_until(
                lambda: protocol.started or protocol.closed, self._options.session_start_timeout, "session_start"
            )
            if not protocol.started:
                raise self._start_error()
            if self._terminology is not None:
                await self.set_terminology(self._terminology)
        except BaseException:
            await self._link.close()
            raise
        return self

    # --- Sending -------------------------------------------------------------------------------------

    async def send_audio(self, audio: bytes | bytearray | memoryview) -> None:
        """Send PCM16LE mono audio. Waits while the socket's send buffer is full."""
        async with self._out_lock:
            await self._settle()
            for frame in self._protocol.push_audio(audio):
                await self._send(frame)

    async def end_segment(self) -> SegmentMark:
        """Transcribe the audio sent since the last segment now (send it when the speaker pauses)."""
        async with self._out_lock:
            await self._settle()
            frames, mark = self._protocol.cut()
            for frame in frames:
                await self._send(frame)
            await self._send(END_SEGMENT_FRAME)
            return mark

    async def set_terminology(self, terminology: Terminology | None) -> TerminologySet:
        """Set (or with None, clear) the terms for later segments. Waits for the server to confirm."""
        async with self._terminology_lock:
            async with self._out_lock:
                await self._settle()
                await self._send(self._protocol.begin_terminology(terminology))
            protocol = self._protocol
            await self._wait_until(
                lambda: not protocol.terminology_waiting, self._options.session_start_timeout, "read"
            )
            reply = protocol.terminology_reply
            if isinstance(reply, EchoNovaError):
                raise reply
            if reply is None:  # pragma: no cover - the wait ends only with a reply
                raise SessionEndedError("no reply to the terminology frame")
            return reply

    async def stop(self, timeout: float | None = DEFAULT_STOP_TIMEOUT) -> SessionSummary:
        """Finish: transcribe the remaining audio, wait for the last transcripts and ``session.ended``.

        ``session.saved`` and the close usually follow at once; ``stop()`` waits briefly
        for them. The summary's ``job_id`` and ``saved_status`` are None if
        ``session.saved`` did not come.
        """
        protocol = self._protocol
        if not (protocol.closed or protocol.stop_requested or protocol.ended or protocol.fatal):
            async with self._out_lock:
                frames, dropped = protocol.begin_stop()
                self._warn_tail(dropped)
                for frame in frames:
                    await self._send(frame)
                await self._send(STOP_FRAME)
        try:
            await self._wait_until(lambda: protocol.closed or protocol.ended is not None, timeout, "stop_drain")
        except APITimeoutError:
            if self._link is not None:
                self._link.abort(None)
            raise
        await self._settle()
        if not protocol.closed and self._link is not None:
            logger.debug("no close after session.ended; closing the Speech to Text session")
            await self._link.close()
        if protocol.fatal is not None:
            raise protocol.fatal
        summary = protocol.summary()
        if summary is None:
            raise SessionEndedError("the session closed without session.ended")
        return summary

    async def close(self) -> None:
        """Close now, without ``stop()``. Audio not yet transcribed is discarded."""
        protocol = self._protocol
        if not protocol.closed and protocol.ended is None:
            logger.warning("closing a Speech to Text session without stop(); untranscribed audio is discarded")
        if self._link is not None:
            await self._link.close()

    aclose = close

    def feed_from(self, source: AudioSource) -> asyncio.Task[SessionSummary]:
        """Send audio from ``source`` in a task, then ``stop()``. Await the task for the summary."""

        async def run() -> SessionSummary:
            if isinstance(source, (bytes, bytearray, memoryview)):
                for frame in iter_frames(source, self.sample_rate):
                    await self.send_audio(frame)
            elif isinstance(source, AsyncIterable):
                async for chunk in source:
                    await self.send_audio(chunk)
            else:
                for chunk in source:
                    await self.send_audio(chunk)
            return await self.stop()

        return asyncio.create_task(run())

    # --- Events --------------------------------------------------------------------------------------

    def __aiter__(self) -> AsyncIterator[SttEvent]:
        return self._events()

    async def _events(self) -> AsyncIterator[SttEvent]:
        protocol = self._protocol
        while True:
            if protocol.events:
                yield protocol.events.popleft()
                continue
            if protocol.closed:
                if protocol.fatal is not None:
                    raise protocol.fatal
                return
            await self._changed.wait()

    async def transcripts(self) -> AsyncIterator[Transcript]:
        """Only the transcripts."""
        async for event in self:
            if isinstance(event, Transcript):
                yield event

    async def __aenter__(self) -> AsyncSttSession:
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        await self.close()

    # --- Internals -----------------------------------------------------------------------------------

    def _notify(self) -> None:
        event, self._changed = self._changed, asyncio.Event()
        event.set()

    async def _settle(self) -> None:
        """After ``session.ended``, wait briefly for ``session.saved`` and the close (which decides any error)."""
        link = self._link
        if self._protocol.ended is not None and not self._protocol.closed and link is not None:
            await wait_event(link.done, self._options.close_timeout)

    async def _wait_until(self, predicate: Callable[[], bool], timeout: float | None, kind: TimeoutKind) -> None:
        deadline = None if timeout is None else self._clock() + timeout
        while not predicate():
            event = self._changed
            if deadline is None:
                await event.wait()
                continue
            remaining = deadline - self._clock()
            if remaining <= 0:
                raise APITimeoutError(f"timed out after {timeout:g} s ({kind})", kind=kind, may_have_executed=None)
            await wait_event(event, remaining)

    async def _send(self, frame: bytes | str) -> None:
        link = self._link
        if link is None:
            raise SessionEndedError("the session is not connected")
        try:
            if isinstance(frame, str):
                await link.send_text(frame)
            else:
                await link.send_bytes(frame)
        except AsyncLinkClosed:
            await link.done.wait()
            self._protocol.check_sendable()
            raise SessionEndedError("the session is closed") from None

    def _on_text(self, text: str) -> None:
        event = decode_event(text)
        if event.get("type") == "pong":
            if self._link is not None:
                self._link.pong()
            return
        self._protocol.receive_event(event, self._clock())
        self._notify()

    def _on_binary(self, data: bytes) -> None:
        self._protocol.receive_binary(data)

    def _on_closed(self, info: CloseInfo) -> None:
        self._protocol.connection_closed(info)
        self._notify()


# --- Sync -----------------------------------------------------------------------------------------


class SttSession(_SttBase):
    """A Speech to Text stream (blocking). Create it with ``connect_stt_sync()``.

    A background thread reads the socket; iterate the session for events.
    """

    def __init__(
        self,
        options: StreamOptions,
        *,
        sample_rate: int,
        language: str,
        terminology: Terminology | None = None,
        encoding: str = "pcm_s16le",
        wait_for_slot: float | None = None,
        limiter: AttemptLimiter | None = None,
    ) -> None:
        self._options = options
        self._clock = options.clock
        self._url = options.url(STT_PATH, stt_query(sample_rate, language, encoding))
        self._terminology = terminology
        self._wait_for_slot = wait_for_slot
        self._limiter = limiter or AttemptLimiter(options.max_connect_attempts, options.connect_window)
        self._protocol = SttProtocol(sample_rate)
        self._link: SyncLink | None = None
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._out_lock = threading.Lock()
        self._terminology_lock = threading.Lock()
        self.handshake_request_id = None

    def _start(self, *, after_abnormal: bool = False) -> SttSession:
        ws = open_websocket_sync(
            self._options,
            self._url,
            limiter=self._limiter,
            wait_for_slot=self._wait_for_slot,
            after_abnormal=after_abnormal,
        )
        self._link = SyncLink(
            ws,
            self._options,
            on_text=self._on_text,
            on_binary=self._on_binary,
            on_closed=self._on_closed,
            name="stt",
        )
        self.handshake_request_id = self._link.handshake_request_id
        protocol = self._protocol
        try:
            self._wait_until(
                lambda: protocol.started or protocol.closed, self._options.session_start_timeout, "session_start"
            )
            if not protocol.started:
                raise self._start_error()
            if self._terminology is not None:
                self.set_terminology(self._terminology)
        except BaseException:
            self._link.close()
            raise
        return self

    # --- Sending -------------------------------------------------------------------------------------

    def send_audio(self, audio: bytes | bytearray | memoryview) -> None:
        """Send PCM16LE mono audio. Blocks while the socket's send buffer is full."""
        with self._out_lock:
            self._settle()
            with self._lock:
                frames = self._protocol.push_audio(audio)
            for frame in frames:
                self._send(frame)

    def end_segment(self) -> SegmentMark:
        """Transcribe the audio sent since the last segment now (send it when the speaker pauses)."""
        with self._out_lock:
            self._settle()
            with self._lock:
                frames, mark = self._protocol.cut()
            for frame in frames:
                self._send(frame)
            self._send(END_SEGMENT_FRAME)
            return mark

    def set_terminology(self, terminology: Terminology | None) -> TerminologySet:
        """Set (or with None, clear) the terms for later segments. Waits for the server to confirm."""
        with self._terminology_lock:
            with self._out_lock:
                self._settle()
                with self._lock:
                    text = self._protocol.begin_terminology(terminology)
                self._send(text)
            protocol = self._protocol
            self._wait_until(lambda: not protocol.terminology_waiting, self._options.session_start_timeout, "read")
            reply = protocol.terminology_reply
            if isinstance(reply, EchoNovaError):
                raise reply
            if reply is None:  # pragma: no cover
                raise SessionEndedError("no reply to the terminology frame")
            return reply

    def stop(self, timeout: float | None = DEFAULT_STOP_TIMEOUT) -> SessionSummary:
        """Finish: transcribe the remaining audio, wait for the last transcripts and ``session.ended``.

        ``session.saved`` and the close usually follow at once; ``stop()`` waits briefly
        for them. The summary's ``job_id`` and ``saved_status`` are None if
        ``session.saved`` did not come.
        """
        protocol = self._protocol
        with self._out_lock:
            with self._lock:
                send = not (protocol.closed or protocol.stop_requested or protocol.ended or protocol.fatal)
                frames, dropped = protocol.begin_stop() if send else ([], 0)
            if send:
                self._warn_tail(dropped)
                for frame in frames:
                    self._send(frame)
                self._send(STOP_FRAME)
        try:
            self._wait_until(lambda: protocol.closed or protocol.ended is not None, timeout, "stop_drain")
        except APITimeoutError:
            if self._link is not None:
                self._link.abort(None)
            raise
        self._settle()
        if not protocol.closed and self._link is not None:
            logger.debug("no close after session.ended; closing the Speech to Text session")
            self._link.close()
        if protocol.fatal is not None:
            raise protocol.fatal
        summary = protocol.summary()
        if summary is None:
            raise SessionEndedError("the session closed without session.ended")
        return summary

    def close(self) -> None:
        """Close now, without ``stop()``. Audio not yet transcribed is discarded."""
        protocol = self._protocol
        if not protocol.closed and protocol.ended is None:
            logger.warning("closing a Speech to Text session without stop(); untranscribed audio is discarded")
        if self._link is not None:
            self._link.close()

    def feed_from(self, source: Iterable[bytes] | bytes | bytearray | memoryview) -> Future[SessionSummary]:
        """Send audio from ``source`` on a thread, then ``stop()``. The future holds the summary."""
        future: Future[SessionSummary] = Future()

        def run() -> None:
            if not future.set_running_or_notify_cancel():
                return
            try:
                chunks = (
                    iter_frames(source, self.sample_rate)
                    if isinstance(source, (bytes, bytearray, memoryview))
                    else source
                )
                for chunk in chunks:
                    self.send_audio(chunk)
                future.set_result(self.stop())
            except BaseException as exc:
                future.set_exception(exc)

        threading.Thread(target=run, name="echonova-stt-feeder", daemon=True).start()
        return future

    # --- Events --------------------------------------------------------------------------------------

    def __iter__(self) -> Iterator[SttEvent]:
        protocol = self._protocol
        while True:
            with self._lock:
                while not protocol.events and not protocol.closed:
                    self._cond.wait(_SYNC_WAIT_SLICE)
                if protocol.events:
                    event = protocol.events.popleft()
                elif protocol.fatal is not None:
                    raise protocol.fatal
                else:
                    return
            yield event

    def transcripts(self) -> Iterator[Transcript]:
        """Only the transcripts."""
        for event in self:
            if isinstance(event, Transcript):
                yield event

    def __enter__(self) -> SttSession:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.close()

    # --- Internals -----------------------------------------------------------------------------------

    def _settle(self) -> None:
        """After ``session.ended``, wait briefly for ``session.saved`` and the close (which decides any error)."""
        link = self._link
        if self._protocol.ended is not None and not self._protocol.closed and link is not None:
            link.done.wait(self._options.close_timeout)

    def _wait_until(self, predicate: Callable[[], bool], timeout: float | None, kind: TimeoutKind) -> None:
        deadline = None if timeout is None else self._clock() + timeout
        with self._lock:
            while not predicate():
                remaining = _SYNC_WAIT_SLICE
                if deadline is not None:
                    left = deadline - self._clock()
                    if left <= 0:
                        raise APITimeoutError(
                            f"timed out after {timeout:g} s ({kind})", kind=kind, may_have_executed=None
                        )
                    remaining = min(remaining, left)
                self._cond.wait(remaining)

    def _send(self, frame: bytes | str) -> None:
        link = self._link
        if link is None:
            raise SessionEndedError("the session is not connected")
        try:
            if isinstance(frame, str):
                link.send_text(frame)
            else:
                link.send_bytes(frame)
        except SyncLinkClosed:
            link.done.wait(self._options.close_timeout + 1)
            with self._lock:
                self._protocol.check_sendable()
            raise SessionEndedError("the session is closed") from None

    def _on_text(self, text: str) -> None:
        event = decode_event(text)
        with self._lock:
            if event.get("type") == "pong":
                if self._link is not None:
                    self._link.pong()
                return
            self._protocol.receive_event(event, self._clock())
            self._cond.notify_all()

    def _on_binary(self, data: bytes) -> None:
        self._protocol.receive_binary(data)

    def _on_closed(self, info: CloseInfo) -> None:
        with self._lock:
            self._protocol.connection_closed(info)
            self._cond.notify_all()
