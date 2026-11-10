"""Text to Speech stream sessions: ``AsyncTtsSession`` and ``TtsSession``.

One socket carries many syntheses, one at a time. The socket is reopened
lazily when something needs sending, and rotated while idle before the
server's session limit.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections import deque
from collections.abc import AsyncIterable, AsyncIterator, Callable, Generator, Iterable, Iterator, Mapping
from functools import partial
from types import TracebackType
from typing import Any

from ..audio import Audio
from ..errors import EchoNovaError
from ._aio import cancel_and_wait, wait_event
from ._errors import CloseInfo
from ._link import AttemptLimiter, decode_event
from ._options import TTS_PATH, StreamOptions
from ._tts_protocol import Outbound, SentenceSplitter, SynthesisCore, TtsProtocol
from ._types import ChargeState, SynthesisMetrics, SynthesisResult, SynthesisState, UnknownEvent
from ._ws_async import AsyncLink, open_websocket
from ._ws_async import LinkClosed as AsyncLinkClosed
from ._ws_sync import LinkClosed as SyncLinkClosed
from ._ws_sync import SyncLink, open_websocket_sync

logger = logging.getLogger("echonova.streaming")

_SYNC_WAIT_SLICE = 0.5  # seconds; waiters re-check state at least this often


def synthesis_options(
    *,
    voice_id: str | None,
    speed: float | None,
    cfg: float | None,
    num_steps: int | None,
    tashkeel: bool | None,
    normalize: bool | None,
    extra_body: Mapping[str, Any] | None,
) -> dict[str, Any]:
    return {
        "voice_id": voice_id,
        "speed": speed,
        "cfg": cfg,
        "num_steps": num_steps,
        "tashkeel": tashkeel,
        "normalize": normalize,
        "extra_body": dict(extra_body) if extra_body else None,
    }


class _SynthesisBase:
    _core: SynthesisCore

    @property
    def request_id(self) -> str:
        return self._core.request_id

    @property
    def state(self) -> SynthesisState:
        return self._core.state

    @property
    def sample_rate(self) -> int | None:
        """Sample rate of the audio, from the server's ``start`` (None before it arrives)."""
        return self._core.sample_rate

    @property
    def metrics(self) -> SynthesisMetrics:
        return self._core.metrics()

    @property
    def charge_state(self) -> ChargeState:
        return self._core.charge_state

    @property
    def credits_consumed(self) -> float | None:
        """The final cost the server reported (in ``done``, ``cancelled``, or an ``error`` after audio started).

        None until the server reports it, and when it never does (for example a
        synthesis cancelled before it was charged, or one lost with the connection).
        """
        return self._core.credits_consumed

    @property
    def error(self) -> EchoNovaError | None:
        return self._core.error

    @property
    def done(self) -> bool:
        return self._core.terminal

    def __repr__(self) -> str:
        return f"{type(self).__name__}(request_id={self.request_id!r}, state={self.state!r})"


# --- Async ----------------------------------------------------------------------------------------


class AsyncSynthesis(_SynthesisBase):
    """One synthesis. Iterate it with ``async for`` to get PCM16LE mono audio at ``sample_rate``.

    ``await synthesis`` waits until the request has been sent. Leaving
    ``async with synthesis:`` cancels it if it is still running. Each audio chunk
    is delivered once: iterate from one place only.
    """

    def __init__(self, session: AsyncTtsSession, core: SynthesisCore) -> None:
        self._session = session
        self._core = core

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self._audio()

    async def _audio(self) -> AsyncIterator[bytes]:
        core = self._core
        while True:
            if core.chunks:
                yield core.chunks.popleft()
                continue
            if core.terminal:
                if core.error is not None:
                    raise core.error
                return
            await self._session._changed_wait()

    async def result(self) -> SynthesisResult:
        """Wait for the synthesis to finish. Raises its error if it failed or was lost."""
        core = self._core
        await self._session._wait_until(lambda: core.terminal)
        if core.error is not None:
            raise core.error
        return core.result()

    async def collect(self) -> Audio:
        """All remaining audio, once the synthesis has finished."""
        chunks = [chunk async for chunk in self]
        return Audio(b"".join(chunks), self._core.sample_rate or 0)

    async def cancel(self) -> None:
        """Stop this synthesis.

        Once its audio has started, it costs only the share of audio sent (at least 1
        credit); cancelled before it was charged, it costs nothing.
        ``result().credits_consumed`` is the final cost, when the server reports it.
        """
        self._session._cancel_core(self._core)

    def __await__(self) -> Generator[Any, None, AsyncSynthesis]:
        return self._wait_sent().__await__()

    async def _wait_sent(self) -> AsyncSynthesis:
        core = self._core
        await self._session._wait_until(lambda: core.terminal or (core.state != "queued" and not core.sending))
        if core.state == "failed" and not core.ever_sent and core.error is not None:
            raise core.error
        return self

    async def __aenter__(self) -> AsyncSynthesis:
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        if not self._core.terminal:
            await self.cancel()


class AsyncTtsSession:
    """A Text to Speech stream. Create it with ``connect_tts()``."""

    def __init__(
        self,
        options: StreamOptions,
        *,
        voice_id: str,
        defaults: Mapping[str, Any] | None = None,
        wait_for_slot: float | None = None,
    ) -> None:
        self._options = options
        self._clock = options.clock
        self._url = options.url(TTS_PATH)
        self._wait_for_slot = wait_for_slot
        self._protocol = TtsProtocol(
            voice_id=voice_id,
            defaults=defaults,
            start_timeout=options.synthesis_start_timeout,
            cancel_ack_timeout=options.cancel_ack_timeout,
        )
        self._limiter = AttemptLimiter(options.max_connect_attempts, options.connect_window)
        self._link: AsyncLink | None = None
        self._changed = asyncio.Event()
        self._pump_kick = asyncio.Event()
        self._timer_kick = asyncio.Event()
        self._connect_lock = asyncio.Lock()
        self._tasks: list[asyncio.Task[None]] = []
        self._closed = False
        self.handshake_request_id: str | None = None

    # --- Lifecycle -----------------------------------------------------------------------------------

    async def _start(self) -> AsyncTtsSession:
        await self._reconnect()
        self._tasks = [asyncio.create_task(self._pump()), asyncio.create_task(self._timer())]
        return self

    async def close(self) -> None:
        """Close the socket. Requests not yet sent are dropped; one still running ends as cancelled."""
        if self._closed:
            return
        self._closed = True
        self._protocol.close(self._clock())
        self._kick()
        await cancel_and_wait(*self._tasks)
        link = self._link
        if link is not None:
            await link.close()
        self._notify()

    aclose = close

    async def __aenter__(self) -> AsyncTtsSession:
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        await self.close()

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def connected(self) -> bool:
        return self._link is not None and not self._link.closed

    @property
    def sample_rate(self) -> int | None:
        """Sample rate of the most recent synthesis that started, from its ``start`` event (None before the first).

        ``speak_stream()`` yields only audio; read the rate here. It is set before
        the first chunk of each synthesis is delivered.
        """
        return self._protocol.sample_rate

    @property
    def dropped_frames(self) -> int:
        """Audio frames that matched no running synthesis and were discarded."""
        return self._protocol.orphan_frames

    @property
    def unknown_events(self) -> list[UnknownEvent]:
        """The latest events of types this SDK version doesn't know (kept, never raised)."""
        return list(self._protocol.unknown_events)

    # --- Public API ----------------------------------------------------------------------------------

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str | None = None,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        extra_body: Mapping[str, Any] | None = None,
    ) -> AsyncSynthesis:
        """Speak ``text`` now, replacing whatever is running and dropping anything queued."""
        options = synthesis_options(
            voice_id=voice_id,
            speed=speed,
            cfg=cfg,
            num_steps=num_steps,
            tashkeel=tashkeel,
            normalize=normalize,
            extra_body=extra_body,
        )
        core = self._protocol.synthesize(text, options, self._clock())
        self._kick()
        return AsyncSynthesis(self, core)

    def enqueue(
        self,
        text: str,
        *,
        voice_id: str | None = None,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        extra_body: Mapping[str, Any] | None = None,
    ) -> AsyncSynthesis:
        """Queue ``text``. It is sent once everything before it has finished."""
        options = synthesis_options(
            voice_id=voice_id,
            speed=speed,
            cfg=cfg,
            num_steps=num_steps,
            tashkeel=tashkeel,
            normalize=normalize,
            extra_body=extra_body,
        )
        core = self._protocol.enqueue(text, options, self._clock())
        self._kick()
        return AsyncSynthesis(self, core)

    async def cancel(self) -> None:
        """Cancel the running synthesis, if any. Queued ones still play afterwards."""
        self._protocol.cancel_active(self._clock())
        self._kick()

    async def interrupt(self) -> None:
        """Barge-in: cancel the running synthesis and drop everything queued."""
        self._protocol.interrupt(self._clock())
        self._kick()

    async def speak_stream(
        self,
        texts: str | Iterable[str] | AsyncIterable[str],
        *,
        voice_id: str | None = None,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        deltas: bool | None = None,
    ) -> AsyncIterator[bytes]:
        """Speak text as one continuous PCM stream, sentence by sentence.

        ``texts`` is a string, an iterable of texts, or an async iterable of text
        deltas (for example from an LLM). Text is split into sentences of at most
        500 characters, queued in order, and the audio is yielded in order, at
        ``sample_rate``. ``deltas`` says whether items are fragments of one text;
        it defaults to True for async iterables. ``interrupt()`` ends the stream.
        """
        options: dict[str, Any] = {
            "voice_id": voice_id,
            "speed": speed,
            "cfg": cfg,
            "num_steps": num_steps,
            "tashkeel": tashkeel,
            "normalize": normalize,
        }
        handles: deque[AsyncSynthesis] = deque()
        feed_done = False
        feed_error: BaseException | None = None
        generation = self._protocol.interrupts

        def add(sentences: list[str]) -> None:
            for sentence in sentences:
                handles.append(self.enqueue(sentence, **options))

        async def feed() -> None:
            nonlocal feed_done, feed_error
            splitter = SentenceSplitter()
            try:
                if isinstance(texts, str):
                    add(splitter.push(texts) + splitter.flush())
                elif isinstance(texts, AsyncIterable):
                    async for item in texts:
                        if self._protocol.interrupts != generation:
                            break
                        add(splitter.push(item) if deltas is not False else splitter.push(item) + splitter.flush())
                    add(splitter.flush())
                else:
                    for item in texts:
                        add(splitter.push(item) + splitter.flush() if not deltas else splitter.push(item))
                    add(splitter.flush())
            except Exception as exc:
                feed_error = exc
            finally:
                feed_done = True
                self._notify()

        feeder: asyncio.Task[None] = asyncio.create_task(feed())
        try:
            while self._protocol.interrupts == generation:
                if handles:
                    async for chunk in handles[0]:
                        yield chunk
                    handles.popleft()
                    continue
                if feed_error is not None:
                    raise feed_error
                if feed_done:
                    break
                await self._changed_wait()
        finally:
            await cancel_and_wait(feeder)
            for synthesis in handles:
                self._cancel_core(synthesis._core)

    # --- Internals -----------------------------------------------------------------------------------

    def _notify(self) -> None:
        event, self._changed = self._changed, asyncio.Event()
        event.set()

    def _kick(self) -> None:
        self._notify()
        self._pump_kick.set()
        self._timer_kick.set()

    async def _changed_wait(self) -> None:
        await self._changed.wait()

    async def _wait_until(self, predicate: Callable[[], bool]) -> None:
        while not predicate():
            await self._changed.wait()

    def _cancel_core(self, core: SynthesisCore) -> None:
        self._protocol.cancel(core, self._clock())
        self._kick()

    async def _reconnect(self) -> AsyncLink:
        async with self._connect_lock:
            link = self._link
            if link is not None and not link.closed:
                return link
            ws = await open_websocket(
                self._options,
                self._url,
                limiter=self._limiter,
                wait_for_slot=self._wait_for_slot,
                after_abnormal=self._protocol.after_abnormal,
            )
            gen = self._protocol.conn_gen
            link = AsyncLink(
                ws,
                self._options,
                on_text=partial(self._on_text, gen),
                on_binary=partial(self._on_binary, gen),
                on_closed=partial(self._on_closed, gen),
            )
            self._link = link
            self.handshake_request_id = link.handshake_request_id
            self._protocol.connection_opened(self._clock())
            self._kick()
            return link

    def _on_text(self, gen: int, text: str) -> None:
        if gen != self._protocol.conn_gen:
            return
        event = decode_event(text)
        if event.get("type") == "pong":
            if self._link is not None:
                self._link.pong()
            return
        self._protocol.receive_event(event, self._clock())
        self._kick()

    def _on_binary(self, gen: int, data: bytes) -> None:
        if gen != self._protocol.conn_gen:
            return
        self._protocol.receive_binary(data, self._clock())
        self._notify()

    def _on_closed(self, gen: int, info: CloseInfo) -> None:
        if gen != self._protocol.conn_gen:
            return
        self._protocol.connection_closed(info, self._clock())
        self._link = None
        if not info.local:
            logger.info("Text to Speech socket closed (code %s); it reopens when needed", info.code)
        self._kick()

    def _rotation_due(self, link: AsyncLink) -> bool:
        return link.age(self._clock()) >= self._options.rotate_after

    async def _pump(self) -> None:
        while not self._closed:
            await self._pump_kick.wait()
            self._pump_kick.clear()
            if self._closed:
                return
            try:
                await self._drain()
            except Exception:  # never let a bug stop all sending silently
                logger.exception("Text to Speech sender failed")

    async def _drain(self) -> None:
        while True:
            item = self._protocol.next_outbound(self._clock())
            if item is None:
                return
            link = self._link
            if item.kind == "synthesize":
                if link is not None and not link.closed and self._rotation_due(link) and not self._protocol.in_flight():
                    await link.close()
                    link = None
                if link is None or link.closed:
                    try:
                        link = await self._reconnect()
                    except EchoNovaError as error:
                        self._protocol.send_failed(item, error, self._clock())
                        self._notify()
                        continue
                    except BaseException:
                        self._protocol.requeue(item, self._clock())
                        raise
            if link is None:
                self._protocol.requeue(item, self._clock())
                continue
            if not await self._send(link, item):
                await link.done.wait()
                continue
            self._kick()

    async def _send(self, link: AsyncLink, item: Outbound) -> bool:
        try:
            await link.send_text(item.text)
        except AsyncLinkClosed:
            self._protocol.requeue(item, self._clock())
            return False
        except BaseException:
            self._protocol.requeue(item, self._clock())
            raise
        self._protocol.sent(item, self._clock())
        return True

    async def _timer(self) -> None:
        while not self._closed:
            self._timer_kick.clear()
            now = self._clock()
            self._protocol.tick(now)
            self._notify()
            if self._protocol.has_outbound():
                self._pump_kick.set()
            link = self._link
            if link is not None and not link.closed and self._protocol.idle and self._rotation_due(link):
                logger.debug("rotating an idle Text to Speech socket")
                await link.close()
                continue
            deadlines = [self._protocol.next_deadline()]
            if link is not None and not link.closed:
                # Once due, rotation waits for the socket to go idle; activity wakes this loop.
                rotation = link.opened_at + self._options.rotate_after
                if rotation > now:
                    deadlines.append(rotation)
            due = [d for d in deadlines if d is not None]
            timeout = max(0.0, min(due) - self._clock()) + 0.001 if due else None
            await wait_event(self._timer_kick, timeout)


# --- Sync -----------------------------------------------------------------------------------------


class Synthesis(_SynthesisBase):
    """One synthesis. Iterate it to get PCM16LE mono audio at ``sample_rate``.

    Leaving ``with synthesis:`` cancels it if it is still running. Each audio
    chunk is delivered once: iterate from one place only.
    """

    def __init__(self, session: TtsSession, core: SynthesisCore) -> None:
        self._session = session
        self._core = core

    def __iter__(self) -> Iterator[bytes]:
        core = self._core
        session = self._session
        while True:
            chunk = session._next_chunk(core)
            if chunk is None:
                if core.error is not None:
                    raise core.error
                return
            yield chunk

    def result(self, timeout: float | None = None) -> SynthesisResult:
        """Wait for the synthesis to finish. Raises its error if it failed or was lost."""
        core = self._core
        self._session._wait_until(lambda: core.terminal, timeout)
        if core.error is not None:
            raise core.error
        if not core.terminal:
            raise TimeoutError("the synthesis has not finished")
        return core.result()

    def collect(self) -> Audio:
        """All remaining audio, once the synthesis has finished."""
        return Audio(b"".join(self), self._core.sample_rate or 0)

    def cancel(self) -> None:
        """Stop this synthesis.

        Once its audio has started, it costs only the share of audio sent (at least 1
        credit); cancelled before it was charged, it costs nothing.
        ``result().credits_consumed`` is the final cost, when the server reports it.
        """
        self._session._cancel_core(self._core)

    def __enter__(self) -> Synthesis:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        if not self._core.terminal:
            self.cancel()


class TtsSession:
    """A Text to Speech stream (blocking). Create it with ``connect_tts_sync()``."""

    def __init__(
        self,
        options: StreamOptions,
        *,
        voice_id: str,
        defaults: Mapping[str, Any] | None = None,
        wait_for_slot: float | None = None,
    ) -> None:
        self._options = options
        self._clock = options.clock
        self._url = options.url(TTS_PATH)
        self._wait_for_slot = wait_for_slot
        self._protocol = TtsProtocol(
            voice_id=voice_id,
            defaults=defaults,
            start_timeout=options.synthesis_start_timeout,
            cancel_ack_timeout=options.cancel_ack_timeout,
        )
        self._limiter = AttemptLimiter(options.max_connect_attempts, options.connect_window)
        self._link: SyncLink | None = None
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._drive_lock = threading.Lock()
        self._drive_again = False
        self._connect_lock = threading.Lock()
        self._closed = False
        self.handshake_request_id: str | None = None

    # --- Lifecycle -----------------------------------------------------------------------------------

    def _start(self) -> TtsSession:
        self._reconnect()
        return self

    def close(self) -> None:
        """Close the socket. Requests not yet sent are dropped; one still running ends as cancelled."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._protocol.close(self._clock())
            link = self._link
            self._cond.notify_all()
        if link is not None:
            link.close()
        with self._lock:
            self._cond.notify_all()

    def __enter__(self) -> TtsSession:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.close()

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def connected(self) -> bool:
        return self._link is not None and not self._link.closed

    @property
    def sample_rate(self) -> int | None:
        """Sample rate of the most recent synthesis that started, from its ``start`` event (None before the first).

        ``speak_stream()`` yields only audio; read the rate here. It is set before
        the first chunk of each synthesis is delivered.
        """
        return self._protocol.sample_rate

    @property
    def dropped_frames(self) -> int:
        """Audio frames that matched no running synthesis and were discarded."""
        return self._protocol.orphan_frames

    @property
    def unknown_events(self) -> list[UnknownEvent]:
        """The latest events of types this SDK version doesn't know (kept, never raised)."""
        return list(self._protocol.unknown_events)

    # --- Public API ----------------------------------------------------------------------------------

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str | None = None,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        extra_body: Mapping[str, Any] | None = None,
    ) -> Synthesis:
        """Speak ``text`` now, replacing whatever is running and dropping anything queued."""
        options = synthesis_options(
            voice_id=voice_id,
            speed=speed,
            cfg=cfg,
            num_steps=num_steps,
            tashkeel=tashkeel,
            normalize=normalize,
            extra_body=extra_body,
        )
        with self._lock:
            core = self._protocol.synthesize(text, options, self._clock())
            self._cond.notify_all()
        self._drive(may_connect=True)
        return Synthesis(self, core)

    def enqueue(
        self,
        text: str,
        *,
        voice_id: str | None = None,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        extra_body: Mapping[str, Any] | None = None,
    ) -> Synthesis:
        """Queue ``text``. It is sent once everything before it has finished."""
        options = synthesis_options(
            voice_id=voice_id,
            speed=speed,
            cfg=cfg,
            num_steps=num_steps,
            tashkeel=tashkeel,
            normalize=normalize,
            extra_body=extra_body,
        )
        with self._lock:
            core = self._protocol.enqueue(text, options, self._clock())
        self._drive(may_connect=True)
        return Synthesis(self, core)

    def cancel(self) -> None:
        """Cancel the running synthesis, if any. Queued ones still play afterwards."""
        with self._lock:
            self._protocol.cancel_active(self._clock())
            self._cond.notify_all()
        self._drive(may_connect=False)

    def interrupt(self) -> None:
        """Barge-in: cancel the running synthesis and drop everything queued."""
        with self._lock:
            self._protocol.interrupt(self._clock())
            self._cond.notify_all()
        self._drive(may_connect=False)

    def speak_stream(
        self,
        texts: str | Iterable[str],
        *,
        voice_id: str | None = None,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        deltas: bool = False,
    ) -> Iterator[bytes]:
        """Speak text as one continuous PCM stream, sentence by sentence.

        ``texts`` is a string or an iterable of texts; pass ``deltas=True`` when
        the items are fragments of one text (for example LLM deltas). Text is
        split into sentences of at most 500 characters, queued in order, and the
        audio is yielded in order, at ``sample_rate``. ``interrupt()`` ends the stream.
        """
        options: dict[str, Any] = {
            "voice_id": voice_id,
            "speed": speed,
            "cfg": cfg,
            "num_steps": num_steps,
            "tashkeel": tashkeel,
            "normalize": normalize,
        }
        handles: deque[Synthesis] = deque()
        state: dict[str, Any] = {"done": False, "error": None, "stop": False}
        generation = self._protocol.interrupts

        def add(sentences: list[str]) -> None:
            for sentence in sentences:
                if state["stop"]:
                    return
                synthesis = self.enqueue(sentence, **options)
                with self._lock:
                    handles.append(synthesis)
                    self._cond.notify_all()

        def feed() -> None:
            splitter = SentenceSplitter()
            try:
                if isinstance(texts, str):
                    add(splitter.push(texts) + splitter.flush())
                else:
                    for item in texts:
                        if state["stop"] or self._protocol.interrupts != generation:
                            break
                        add(splitter.push(item) if deltas else splitter.push(item) + splitter.flush())
                    add(splitter.flush())
            except Exception as exc:
                state["error"] = exc
            finally:
                with self._lock:
                    state["done"] = True
                    self._cond.notify_all()

        feeder = threading.Thread(target=feed, name="echonova-tts-feeder", daemon=True)
        feeder.start()
        try:
            while self._protocol.interrupts == generation:
                with self._lock:
                    while not handles and not state["done"] and self._protocol.interrupts == generation:
                        self._cond.wait(_SYNC_WAIT_SLICE)
                    current = handles[0] if handles else None
                if current is not None:
                    yield from current
                    with self._lock:
                        handles.popleft()
                    continue
                if state["error"] is not None:
                    raise state["error"]
                if state["done"]:
                    break
        finally:
            state["stop"] = True
            with self._lock:
                remaining = list(handles)
            for synthesis in remaining:
                synthesis.cancel()

    # --- Internals -----------------------------------------------------------------------------------

    def _cancel_core(self, core: SynthesisCore) -> None:
        with self._lock:
            self._protocol.cancel(core, self._clock())
            self._cond.notify_all()
        self._drive(may_connect=False)

    def _wait_until(self, predicate: Callable[[], bool], timeout: float | None) -> None:
        deadline = None if timeout is None else self._clock() + timeout
        while True:
            with self._lock:
                if predicate():
                    return
                connect = self._needs_connect()
                if not connect:
                    remaining = _SYNC_WAIT_SLICE
                    if deadline is not None:
                        remaining = min(remaining, deadline - self._clock())
                    if remaining <= 0:
                        return
                    self._cond.wait(remaining)
            if connect:
                self._drive(may_connect=True)

    def _next_chunk(self, core: SynthesisCore) -> bytes | None:
        while True:
            with self._lock:
                if core.chunks:
                    return core.chunks.popleft()
                if core.terminal:
                    return None
                if not self._needs_connect():
                    self._cond.wait(_SYNC_WAIT_SLICE)
                    continue
            self._drive(may_connect=True)

    def _needs_connect(self) -> bool:
        """Something is waiting to be sent and no socket is open (call with the lock held)."""
        if self._closed or self._protocol.fatal is not None:
            return False
        link = self._link
        return (link is None or link.closed) and self._protocol.has_outbound()

    def _drive(self, *, may_connect: bool) -> None:
        """Send whatever the protocol has queued. Only one thread sends at a time."""
        self._drive_again = True
        while self._drive_again:
            if not self._drive_lock.acquire(blocking=may_connect):
                return  # the thread holding it sees _drive_again and loops
            try:
                self._drive_again = False
                self._drain(may_connect)
            finally:
                self._drive_lock.release()

    def _drain(self, may_connect: bool) -> None:
        while True:
            with self._lock:
                item = self._protocol.next_outbound(self._clock())
                link = self._link
                rotate = (
                    item is not None
                    and item.kind == "synthesize"
                    and link is not None
                    and not link.closed
                    and link.age(self._clock()) >= self._options.rotate_after
                    and not self._protocol.in_flight()
                )
            if item is None:
                return
            if rotate and link is not None:
                if not may_connect:
                    with self._lock:
                        self._protocol.requeue(item, self._clock())
                    return
                link.close()
                link = None
            if item.kind == "synthesize" and (link is None or link.closed):
                if not may_connect:
                    with self._lock:
                        self._protocol.requeue(item, self._clock())
                    return
                try:
                    link = self._reconnect()
                except EchoNovaError as error:
                    with self._lock:
                        self._protocol.send_failed(item, error, self._clock())
                        self._cond.notify_all()
                    continue
                except BaseException:
                    with self._lock:
                        self._protocol.requeue(item, self._clock())
                    raise
            if link is None:
                with self._lock:
                    self._protocol.requeue(item, self._clock())
                return
            try:
                link.send_text(item.text)
            except SyncLinkClosed:
                if not link.on_reader_thread():
                    link.done.wait(self._options.close_timeout + 1)
                with self._lock:
                    self._protocol.requeue(item, self._clock())
                    self._cond.notify_all()
                if not may_connect:
                    return
                continue
            except BaseException:
                with self._lock:
                    self._protocol.requeue(item, self._clock())
                raise
            with self._lock:
                self._protocol.sent(item, self._clock())
                self._cond.notify_all()

    def _reconnect(self) -> SyncLink:
        with self._connect_lock:
            link = self._link
            if link is not None and not link.closed:
                return link
            ws = open_websocket_sync(
                self._options,
                self._url,
                limiter=self._limiter,
                wait_for_slot=self._wait_for_slot,
                after_abnormal=self._protocol.after_abnormal,
            )
            with self._lock:
                gen = self._protocol.conn_gen
                link = SyncLink(
                    ws,
                    self._options,
                    on_text=partial(self._on_text, gen),
                    on_binary=partial(self._on_binary, gen),
                    on_closed=partial(self._on_closed, gen),
                    tick=self._tick,
                    name="tts",
                )
                self._link = link
                self.handshake_request_id = link.handshake_request_id
                self._protocol.connection_opened(self._clock())
                self._cond.notify_all()
            return link

    def _on_text(self, gen: int, text: str) -> None:
        event = decode_event(text)
        with self._lock:
            if gen != self._protocol.conn_gen:
                return
            if event.get("type") == "pong":
                if self._link is not None:
                    self._link.pong()
                return
            self._protocol.receive_event(event, self._clock())
            self._cond.notify_all()
        self._drive(may_connect=False)

    def _on_binary(self, gen: int, data: bytes) -> None:
        with self._lock:
            if gen != self._protocol.conn_gen:
                return
            self._protocol.receive_binary(data, self._clock())
            self._cond.notify_all()

    def _on_closed(self, gen: int, info: CloseInfo) -> None:
        with self._lock:
            if gen != self._protocol.conn_gen:
                return
            self._protocol.connection_closed(info, self._clock())
            self._link = None
            self._cond.notify_all()
        if not info.local:
            logger.info("Text to Speech socket closed (code %s); it reopens when needed", info.code)

    def _tick(self, now: float) -> float | None:
        with self._lock:
            self._protocol.tick(now)
            self._cond.notify_all()
            deadline = self._protocol.next_deadline()
            link = self._link
            rotate = link is not None and self._protocol.idle and link.age(now) >= self._options.rotate_after
        if rotate and link is not None:
            logger.debug("rotating an idle Text to Speech socket")
            link.close()
            return None
        self._drive(may_connect=False)
        if link is not None:
            rotation = link.opened_at + self._options.rotate_after
            if rotation > now:  # once due, rotation waits for the socket to go idle
                deadline = rotation if deadline is None else min(deadline, rotation)
        return deadline
