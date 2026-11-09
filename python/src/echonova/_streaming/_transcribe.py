"""``transcribe_stream``: transcribe an audio source of any length over Speech to Text sessions.

- It cuts its own segments every ``segment_seconds`` of audio, so it always
  knows where each cut fell.
- Shortly before a session's time limit it rolls over: it cuts, stops the
  session, waits for its last transcripts and opens a new one. Audio that
  arrives meanwhile is buffered (bounded) and sent to the new session.
- After a dropped connection (1001, 1006 or 1011) it reconnects and replays the
  audio sent since the last cut. A segment is charged when its transcript is
  sent, so audio that was never cut into a segment can be replayed without
  paying twice. Segments that were cut but got no result are not replayed; they
  are reported as ``AudioDropped``.
- It never reconnects after a billing or protocol close (4002, 4029, 1008, 1009).
- Each session is kept as a job of its own: ``SessionSaved`` is passed on for
  every session that reports one, including those ended by a rollover.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import logging
import queue
import threading
from collections import deque
from collections.abc import AsyncIterable, AsyncIterator, Iterable, Iterator
from typing import Any, cast

from ..audio import iter_frames
from ..errors import (
    EchoNovaError,
    ServerRestartingError,
    SessionEndedError,
    SessionExpiredError,
    StreamConnectionLostError,
    UpstreamError,
    UsageError,
)
from ._aio import cancel_and_wait, wait_event
from ._link import AttemptLimiter
from ._options import ReconnectPolicy, StreamOptions
from ._stt_protocol import Piece, SegmentPlan
from ._stt_session import AsyncSttSession, SttSession, Terminology, stt_query
from ._types import (
    AudioDropped,
    Reconnected,
    SessionSaved,
    StreamErrorEvent,
    SttEvent,
    TranscribeEvent,
    Transcript,
    UnknownEvent,
)

logger = logging.getLogger("echonova.streaming")

DEFAULT_RECONNECT = ReconnectPolicy(max_attempts=3)
MAX_BUFFER_SECONDS = 60.0  # audio held while a session is being replaced, before the source is paused
_WAIT_SLICE = 0.5

_EOF = object()
_ROLLOVER = object()
_SESSION_DOWN = object()
_END = object()


@dataclasses.dataclass(frozen=True, slots=True)
class _Failure:
    error: BaseException


def _tail_dropped() -> SessionEndedError:
    """The session hit its time limit while stopping and the last segment got no result: resend it."""
    return SessionEndedError("the Speech to Text session ended (max_duration) before its last segment")


def reconnect_reason(error: BaseException, summary_reason: str | None) -> tuple[str, bool, bool] | None:
    """``(reason, counts_as_failure, after_abnormal_loss)`` when a new session should be opened."""
    if isinstance(error, ServerRestartingError):
        return "server_restarting", True, True
    if isinstance(error, StreamConnectionLostError):
        return "connection_lost", True, True
    if isinstance(error, UpstreamError) and error.close_code == 1011:
        return "upstream_error", True, False
    if isinstance(error, SessionExpiredError):
        return "session_expired", True, False
    if isinstance(error, SessionEndedError) and summary_reason in ("max_duration", "idle_timeout"):
        return summary_reason, False, False
    return None


class _Bookkeeping:
    """State shared by the async and sync drivers."""

    def __init__(
        self,
        options: StreamOptions,
        *,
        sample_rate: int,
        language: str,
        terminology: Terminology | None,
        segment_seconds: float,
        reconnect: ReconnectPolicy,
        realtime: bool,
        encoding: str,
        wait_for_slot: float | None,
    ) -> None:
        stt_query(sample_rate, language, encoding)  # validate before anything starts
        if segment_seconds <= 0:
            raise UsageError("segment_seconds must be positive")
        self.options = options
        self.clock = options.clock
        self.sample_rate = sample_rate
        self.language = language
        self.terminology = terminology
        self.encoding = encoding
        self.wait_for_slot = wait_for_slot
        self.reconnect = reconnect
        self.realtime = realtime
        self.plan = SegmentPlan(sample_rate, segment_seconds)
        self.limiter = AttemptLimiter(options.max_connect_attempts, options.connect_window)
        self.failures = 0
        self.index = 0
        self.buffer_limit = int(sample_rate * 2 * MAX_BUFFER_SECONDS)
        self.audio_seconds = 0.0
        self.started: float | None = None

    def forward(self, event: SttEvent) -> TranscribeEvent | None:
        if isinstance(event, Transcript):
            self.plan.result()
            self.failures = 0
            event = dataclasses.replace(event, index=self.index)
            self.index += 1
            return event
        if isinstance(event, StreamErrorEvent):
            if event.code == "upstream_error":  # this segment failed; the session goes on
                self.plan.result()
            return event
        if isinstance(event, (SessionSaved, UnknownEvent)):
            return event
        return None

    def rollover_at(self, started_at: float | None, max_seconds: float | None) -> float | None:
        if started_at is None or max_seconds is None:
            return None
        return started_at + max(0.0, max_seconds - self.options.rollover_margin)

    def pace(self, piece: bytes) -> float:
        """Seconds to wait so audio goes out no faster than real time (``realtime=True``)."""
        if not self.realtime:
            return 0.0
        now = self.clock()
        if self.started is None:
            self.started = now
        self.audio_seconds += len(piece) / (self.sample_rate * 2)
        return max(0.0, self.audio_seconds - (now - self.started))


# --- Async ----------------------------------------------------------------------------------------


class _AsyncTranscriber(_Bookkeeping):
    def __init__(self, source: AsyncIterable[bytes] | Iterable[bytes] | bytes, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.source = source
        self.session: AsyncSttSession | None = None
        self._out: asyncio.Queue[object] = asyncio.Queue()
        self._chunks: deque[bytes] = deque()
        self._buffered = 0
        self._source_done = False
        self._source_error: BaseException | None = None
        self._changed = asyncio.Event()
        self._reader: asyncio.Task[None] | None = None
        self._forwarder: asyncio.Task[None] | None = None
        self._stopping = False

    async def run(self) -> AsyncIterator[TranscribeEvent]:
        driver = asyncio.create_task(self._drive())
        try:
            while True:
                item = await self._out.get()
                if item is _END:
                    return
                if isinstance(item, _Failure):
                    raise item.error
                yield cast(TranscribeEvent, item)
        finally:
            self._stopping = True
            self._notify()
            await cancel_and_wait(driver)
            await self._shutdown()

    def _notify(self) -> None:
        event, self._changed = self._changed, asyncio.Event()
        event.set()

    def _emit(self, event: object) -> None:
        self._out.put_nowait(event)

    async def _drive(self) -> None:
        try:
            await self._main()
            self._emit(_END)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._emit(_Failure(exc))

    async def _main(self) -> None:
        self._reader = asyncio.create_task(self._read_source())
        self.session = await self._open(after_abnormal=False)
        while True:
            item = await self._next_item()
            if item is _EOF:
                break
            if item is _ROLLOVER:
                await self._rollover()
                continue
            if item is _SESSION_DOWN:
                await self._recover(self._session_error())
                continue
            assert isinstance(item, bytes)
            for piece in self.plan.split(item):
                await self._deliver(piece)
                delay = self.pace(piece.data)
                if delay > 0.01:
                    await asyncio.sleep(delay)
        if self.plan.finish():
            logger.warning("dropped 1 trailing byte: audio must be whole 16-bit samples")
        await self._finish()

    async def _read_source(self) -> None:
        source = self.source
        try:
            if isinstance(source, (bytes, bytearray, memoryview)):
                for frame in iter_frames(source, self.sample_rate):
                    await self._push(frame)
            elif isinstance(source, AsyncIterable):
                async for chunk in source:
                    await self._push(bytes(chunk))
            else:
                for chunk in source:
                    await self._push(bytes(chunk))
        except Exception as exc:
            self._source_error = exc
        finally:
            self._source_done = True
            self._notify()

    async def _push(self, chunk: bytes) -> None:
        while self._buffered >= self.buffer_limit:
            await self._changed.wait()
        self._chunks.append(chunk)
        self._buffered += len(chunk)
        self._notify()

    async def _next_item(self) -> object:
        while True:
            if self._stopping:
                raise asyncio.CancelledError
            session = self.session
            assert session is not None
            if self._chunks:
                chunk = self._chunks.popleft()
                self._buffered -= len(chunk)
                self._notify()
                return chunk
            if self._source_error is not None:
                raise self._source_error
            if self._source_done:
                return _EOF
            if session.closed:
                return _SESSION_DOWN
            deadline = self.rollover_at(session.started_at, session.max_session_seconds)
            if deadline is not None and self.clock() >= deadline:
                return _ROLLOVER
            timeout = None if deadline is None else max(0.0, deadline - self.clock()) + 0.001
            await wait_event(self._changed, timeout)

    def _session_error(self) -> BaseException:
        session = self.session
        assert session is not None
        if session.failure is not None:
            return session.failure
        reason = session.summary.reason if session.summary else "closed"
        return SessionEndedError(f"the Speech to Text session ended ({reason})")

    async def _deliver(self, piece: Piece) -> None:
        self.plan.delivered(piece.data)
        data = piece.data
        while True:
            session = self.session
            assert session is not None
            try:
                if data:
                    await session.send_audio(data)
                if piece.cut:
                    self.plan.cut(await session.end_segment())
                return
            except EchoNovaError as exc:
                await self._recover(exc)
                data = b""  # the replay after the reconnect included it

    async def _open(self, *, after_abnormal: bool) -> AsyncSttSession:
        session = AsyncSttSession(
            self.options,
            sample_rate=self.sample_rate,
            language=self.language,
            terminology=self.terminology,
            encoding=self.encoding,
            wait_for_slot=self.wait_for_slot,
            limiter=self.limiter,
        )
        await session._start(after_abnormal=after_abnormal)
        self.plan.new_session()
        self._forwarder = asyncio.create_task(self._forward(session))
        return session

    async def _forward(self, session: AsyncSttSession) -> None:
        try:
            async for event in session:
                forwarded = self.forward(event)
                if forwarded is not None:
                    self._emit(forwarded)
        except EchoNovaError:
            pass  # the driver sees the failure when it next sends, and decides
        finally:
            self._notify()

    async def _join_forwarder(self) -> None:
        if self._forwarder is not None:
            await self._forwarder
            self._forwarder = None

    async def _end_session(self) -> None:
        """Close the current session and wait until all of its events have been passed on."""
        session = self.session
        if session is not None and not session.closed:
            await session.close()
        await self._join_forwarder()
        dropped = self.plan.take_dropped()
        if dropped:
            self._emit(AudioDropped(dropped))

    async def _recover(self, error: BaseException) -> None:
        while True:
            session = self.session
            summary = session.summary if session is not None else None
            decision = reconnect_reason(error, summary.reason if summary else None)
            if decision is None:
                raise error
            reason, counted, abnormal = decision
            await self._end_session()
            if counted:
                self.failures += 1
                if self.failures > self.reconnect.max_attempts:
                    raise error
                await asyncio.sleep(self.reconnect.delay(self.failures))
            logger.info("Speech to Text stream reconnecting (%s)", reason)
            self.session = await self._open(after_abnormal=abnormal)
            self._emit(Reconnected(reason, self.session.session_id, self.failures))
            replay = self.plan.replay()
            try:
                if replay:
                    await self.session.send_audio(replay)
                return
            except EchoNovaError as exc:
                error = exc

    async def _rollover(self) -> None:
        session = self.session
        assert session is not None
        try:
            if self.plan.uncut:
                self.plan.cut(await session.end_segment())
            await session.stop()
        except EchoNovaError as exc:
            await self._recover(exc)
            return
        await self._end_session()
        self.session = await self._open(after_abnormal=False)
        self._emit(Reconnected("rollover", self.session.session_id, 0))

    async def _finish(self) -> None:
        while True:
            session = self.session
            assert session is not None
            try:
                summary = await session.stop()
                if summary.reason == "max_duration" and self.plan.uncut:
                    await self._join_forwarder()  # every result of this session has been counted
                    if not self.plan.tail_answered:
                        raise _tail_dropped()
                break
            except EchoNovaError as exc:
                await self._recover(exc)
        await self._end_session()

    async def _shutdown(self) -> None:
        await cancel_and_wait(self._reader)
        session = self.session
        if session is not None and not session.closed:
            with contextlib.suppress(Exception):
                await session.close()
        await cancel_and_wait(self._forwarder)


def transcribe_stream(
    options: StreamOptions,
    source: AsyncIterable[bytes] | Iterable[bytes] | bytes,
    *,
    sample_rate: int,
    language: str,
    terminology: Terminology | None = None,
    segment_seconds: float = 14.0,
    reconnect: ReconnectPolicy = DEFAULT_RECONNECT,
    realtime: bool = False,
    encoding: str = "pcm_s16le",
    wait_for_slot: float | None = None,
) -> AsyncIterator[TranscribeEvent]:
    """Transcribe ``source`` (PCM16LE mono chunks) and yield events as they arrive.

    Yields ``Transcript`` events, plus ``StreamErrorEvent`` (one segment failed),
    ``SessionSaved`` (a session was kept as a job: one per session),
    ``Reconnected`` and ``AudioDropped``. ``realtime=True`` paces sending at 1x,
    to simulate a live source with a file.
    """
    transcriber = _AsyncTranscriber(
        source,
        options=options,
        sample_rate=sample_rate,
        language=language,
        terminology=terminology,
        segment_seconds=segment_seconds,
        reconnect=reconnect,
        realtime=realtime,
        encoding=encoding,
        wait_for_slot=wait_for_slot,
    )
    return transcriber.run()


# --- Sync -----------------------------------------------------------------------------------------


class _Stopped(Exception):
    """Internal: the consumer stopped iterating."""


class _SyncTranscriber(_Bookkeeping):
    def __init__(self, source: Iterable[bytes] | bytes, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.source = source
        self.session: SttSession | None = None
        self._out: queue.Queue[object] = queue.Queue()
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._chunks: deque[bytes] = deque()
        self._buffered = 0
        self._source_done = False
        self._source_error: BaseException | None = None
        self._stopping = False
        self._forwarder: threading.Thread | None = None

    def run(self) -> Iterator[TranscribeEvent]:
        driver = threading.Thread(target=self._drive, name="echonova-stt-transcriber", daemon=True)
        reader = threading.Thread(target=self._read_source, name="echonova-stt-source", daemon=True)
        reader.start()
        driver.start()
        try:
            while True:
                item = self._out.get()
                if item is _END:
                    return
                if isinstance(item, _Failure):
                    raise item.error
                yield cast(TranscribeEvent, item)
        finally:
            with self._cond:
                self._stopping = True
                self._cond.notify_all()
            session = self.session
            if session is not None and not session.closed:
                with contextlib.suppress(Exception):
                    session.close()
            driver.join(self.options.close_timeout + 1)

    def _emit(self, event: object) -> None:
        self._out.put(event)

    def _drive(self) -> None:
        try:
            self._main()
            self._emit(_END)
        except _Stopped:
            self._emit(_END)
        except Exception as exc:
            self._emit(_Failure(exc))

    def _check_stopping(self) -> None:
        if self._stopping:
            raise _Stopped

    def _main(self) -> None:
        self.session = self._open(after_abnormal=False)
        while True:
            item = self._next_item()
            if item is _EOF:
                break
            if item is _ROLLOVER:
                self._rollover()
                continue
            if item is _SESSION_DOWN:
                self._recover(self._session_error())
                continue
            assert isinstance(item, bytes)
            for piece in self.plan.split(item):
                self._deliver(piece)
                delay = self.pace(piece.data)
                if delay > 0.01:
                    with self._cond:
                        self._cond.wait_for(lambda: self._stopping, delay)
        if self.plan.finish():
            logger.warning("dropped 1 trailing byte: audio must be whole 16-bit samples")
        self._finish()

    def _read_source(self) -> None:
        source = self.source
        try:
            chunks = (
                iter_frames(source, self.sample_rate) if isinstance(source, (bytes, bytearray, memoryview)) else source
            )
            for chunk in chunks:
                with self._cond:
                    while self._buffered >= self.buffer_limit and not self._stopping:
                        self._cond.wait(_WAIT_SLICE)
                    if self._stopping:
                        return
                    data = bytes(chunk)
                    self._chunks.append(data)
                    self._buffered += len(data)
                    self._cond.notify_all()
        except Exception as exc:
            self._source_error = exc
        finally:
            with self._cond:
                self._source_done = True
                self._cond.notify_all()

    def _next_item(self) -> object:
        with self._cond:
            while True:
                self._check_stopping()
                session = self.session
                assert session is not None
                if self._chunks:
                    chunk = self._chunks.popleft()
                    self._buffered -= len(chunk)
                    self._cond.notify_all()
                    return chunk
                if self._source_error is not None:
                    raise self._source_error
                if self._source_done:
                    return _EOF
                if session.closed:
                    return _SESSION_DOWN
                deadline = self.rollover_at(session.started_at, session.max_session_seconds)
                if deadline is not None and self.clock() >= deadline:
                    return _ROLLOVER
                timeout = _WAIT_SLICE if deadline is None else min(_WAIT_SLICE, max(0.0, deadline - self.clock()))
                self._cond.wait(timeout + 0.001)

    def _session_error(self) -> BaseException:
        session = self.session
        assert session is not None
        if session.failure is not None:
            return session.failure
        reason = session.summary.reason if session.summary else "closed"
        return SessionEndedError(f"the Speech to Text session ended ({reason})")

    def _deliver(self, piece: Piece) -> None:
        self.plan.delivered(piece.data)
        data = piece.data
        while True:
            self._check_stopping()
            session = self.session
            assert session is not None
            try:
                if data:
                    session.send_audio(data)
                if piece.cut:
                    self.plan.cut(session.end_segment())
                return
            except EchoNovaError as exc:
                self._recover(exc)
                data = b""

    def _open(self, *, after_abnormal: bool) -> SttSession:
        self._check_stopping()
        session = SttSession(
            self.options,
            sample_rate=self.sample_rate,
            language=self.language,
            terminology=self.terminology,
            encoding=self.encoding,
            wait_for_slot=self.wait_for_slot,
            limiter=self.limiter,
        )
        session._start(after_abnormal=after_abnormal)
        self.plan.new_session()
        forwarder = threading.Thread(target=self._forward, args=(session,), name="echonova-stt-events", daemon=True)
        forwarder.start()
        self._forwarder = forwarder
        return session

    def _forward(self, session: SttSession) -> None:
        try:
            for event in session:
                forwarded = self.forward(event)
                if forwarded is not None:
                    self._emit(forwarded)
        except EchoNovaError:
            pass
        finally:
            with self._cond:
                self._cond.notify_all()

    def _join_forwarder(self) -> None:
        if self._forwarder is not None:
            self._forwarder.join()
            self._forwarder = None

    def _end_session(self) -> None:
        session = self.session
        if session is not None and not session.closed:
            session.close()
        self._join_forwarder()
        dropped = self.plan.take_dropped()
        if dropped:
            self._emit(AudioDropped(dropped))

    def _recover(self, error: BaseException) -> None:
        while True:
            self._check_stopping()
            session = self.session
            summary = session.summary if session is not None else None
            decision = reconnect_reason(error, summary.reason if summary else None)
            if decision is None:
                raise error
            reason, counted, abnormal = decision
            self._end_session()
            if counted:
                self.failures += 1
                if self.failures > self.reconnect.max_attempts:
                    raise error
                with self._cond:
                    self._cond.wait_for(lambda: self._stopping, self.reconnect.delay(self.failures))
            logger.info("Speech to Text stream reconnecting (%s)", reason)
            self.session = self._open(after_abnormal=abnormal)
            self._emit(Reconnected(reason, self.session.session_id, self.failures))
            replay = self.plan.replay()
            try:
                if replay:
                    self.session.send_audio(replay)
                return
            except EchoNovaError as exc:
                error = exc

    def _rollover(self) -> None:
        session = self.session
        assert session is not None
        try:
            if self.plan.uncut:
                self.plan.cut(session.end_segment())
            session.stop()
        except EchoNovaError as exc:
            self._recover(exc)
            return
        self._end_session()
        self.session = self._open(after_abnormal=False)
        self._emit(Reconnected("rollover", self.session.session_id, 0))

    def _finish(self) -> None:
        while True:
            self._check_stopping()
            session = self.session
            assert session is not None
            try:
                summary = session.stop()
                if summary.reason == "max_duration" and self.plan.uncut:
                    self._join_forwarder()  # every result of this session has been counted
                    if not self.plan.tail_answered:
                        raise _tail_dropped()
                break
            except EchoNovaError as exc:
                self._recover(exc)
        self._end_session()


def transcribe_stream_sync(
    options: StreamOptions,
    source: Iterable[bytes] | bytes,
    *,
    sample_rate: int,
    language: str,
    terminology: Terminology | None = None,
    segment_seconds: float = 14.0,
    reconnect: ReconnectPolicy = DEFAULT_RECONNECT,
    realtime: bool = False,
    encoding: str = "pcm_s16le",
    wait_for_slot: float | None = None,
) -> Iterator[TranscribeEvent]:
    """Blocking ``transcribe_stream``: a background thread sends; this generator yields events."""
    transcriber = _SyncTranscriber(
        source,
        options=options,
        sample_rate=sample_rate,
        language=language,
        terminology=terminology,
        segment_seconds=segment_seconds,
        reconnect=reconnect,
        realtime=realtime,
        encoding=encoding,
        wait_for_slot=wait_for_slot,
    )
    return transcriber.run()
