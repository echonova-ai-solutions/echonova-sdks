"""Run the same test body against the async and the sync sessions.

The async adapters run every call on a private event loop thread, so a test can
drive both flavours with plain blocking calls and assert identical behaviour.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterable, Awaitable, Callable, Iterable
from typing import Any, TypeVar

from echonova._streaming import (
    AsyncSttSession,
    AsyncSynthesis,
    AsyncTtsSession,
    SessionSummary,
    StreamOptions,
    SttSession,
    Synthesis,
    TtsSession,
    connect_stt,
    connect_stt_sync,
    connect_tts,
    connect_tts_sync,
    transcribe_stream,
    transcribe_stream_sync,
)

T = TypeVar("T")
TIMEOUT = 15.0


class Bridge:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="test-async-bridge", daemon=True)
        self.thread.start()

    def run(self, function: Callable[[], Awaitable[T] | T]) -> T:
        async def call() -> T:
            result = function()
            if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
                return await result  # type: ignore[no-any-return]
            return result  # type: ignore[return-value]

        return asyncio.run_coroutine_threadsafe(call(), self.loop).result(TIMEOUT)

    def close(self) -> None:
        async def cancel_all() -> None:
            tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        asyncio.run_coroutine_threadsafe(cancel_all(), self.loop).result(5)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()


# --- Text to Speech --------------------------------------------------------------------------------


class SynthesisAdapter:
    def __init__(self, handle: Synthesis | AsyncSynthesis, bridge: Bridge | None) -> None:
        self.handle = handle
        self.bridge = bridge

    def chunks(self) -> list[bytes]:
        handle = self.handle
        if isinstance(handle, AsyncSynthesis):
            assert self.bridge is not None

            async def collect() -> list[bytes]:
                return [chunk async for chunk in handle]

            return self.bridge.run(collect)
        return list(handle)

    def first_chunk(self) -> bytes:
        handle = self.handle
        if isinstance(handle, AsyncSynthesis):
            assert self.bridge is not None

            async def first() -> bytes:
                async for chunk in handle:
                    return chunk
                raise AssertionError("no audio")

            return self.bridge.run(first)
        return next(iter(handle))

    def result(self) -> Any:
        handle = self.handle
        if isinstance(handle, AsyncSynthesis):
            assert self.bridge is not None
            return self.bridge.run(handle.result)
        return handle.result(timeout=TIMEOUT)

    def cancel(self) -> None:
        handle = self.handle
        if isinstance(handle, AsyncSynthesis):
            assert self.bridge is not None
            self.bridge.run(handle.cancel)
        else:
            handle.cancel()

    def __getattr__(self, name: str) -> Any:
        return getattr(self.handle, name)


class TtsAdapter:
    def __init__(self, session: TtsSession | AsyncTtsSession, bridge: Bridge | None) -> None:
        self.session = session
        self.bridge = bridge

    def _call(self, function: Callable[[], Any]) -> Any:
        return self.bridge.run(function) if self.bridge is not None else function()

    def synthesize(self, text: str, **kwargs: Any) -> SynthesisAdapter:
        return SynthesisAdapter(self._call(lambda: self.session.synthesize(text, **kwargs)), self.bridge)

    def enqueue(self, text: str, **kwargs: Any) -> SynthesisAdapter:
        return SynthesisAdapter(self._call(lambda: self.session.enqueue(text, **kwargs)), self.bridge)

    def cancel(self) -> None:
        self._call(self.session.cancel)

    def interrupt(self) -> None:
        self._call(self.session.interrupt)

    def close(self) -> None:
        self._call(self.session.close)

    def speak_stream(
        self,
        texts: Any,
        stop_after: int | None = None,
        on_chunk: Callable[[bytes], None] | None = None,
        **kwargs: Any,
    ) -> list[bytes]:
        session = self.session
        if isinstance(session, AsyncTtsSession):
            assert self.bridge is not None

            async def collect() -> list[bytes]:
                out = []
                async for chunk in session.speak_stream(texts, **kwargs):
                    out.append(chunk)
                    if on_chunk is not None:
                        on_chunk(chunk)
                    if stop_after is not None and len(out) >= stop_after:
                        await session.interrupt()
                return out

            return self.bridge.run(collect)
        out = []
        for chunk in session.speak_stream(texts, **kwargs):
            out.append(chunk)
            if on_chunk is not None:
                on_chunk(chunk)
            if stop_after is not None and len(out) >= stop_after:
                session.interrupt()
        return out

    def __getattr__(self, name: str) -> Any:
        return getattr(self.session, name)


def open_tts(mode: str, options: StreamOptions, bridge: Bridge | None, **kwargs: Any) -> TtsAdapter:
    if mode == "async":
        assert bridge is not None

        async def connect() -> AsyncTtsSession:
            return await connect_tts(options, **kwargs)

        return TtsAdapter(bridge.run(connect), bridge)
    return TtsAdapter(connect_tts_sync(options, **kwargs), None)


# --- Speech to Text --------------------------------------------------------------------------------


class SttAdapter:
    def __init__(self, session: SttSession | AsyncSttSession, bridge: Bridge | None) -> None:
        self.session = session
        self.bridge = bridge

    def _call(self, function: Callable[[], Any]) -> Any:
        return self.bridge.run(function) if self.bridge is not None else function()

    def send_audio(self, data: bytes) -> None:
        self._call(lambda: self.session.send_audio(data))

    def end_segment(self) -> Any:
        return self._call(self.session.end_segment)

    def set_terminology(self, terminology: Any) -> Any:
        return self._call(lambda: self.session.set_terminology(terminology))

    def stop(self, timeout: float | None = 20.0) -> SessionSummary:
        return self._call(lambda: self.session.stop(timeout))  # type: ignore[no-any-return]

    def close(self) -> None:
        self._call(self.session.close)

    def feed_from(self, source: Any) -> SessionSummary:
        session = self.session
        if isinstance(session, AsyncSttSession):
            assert self.bridge is not None

            async def feed() -> SessionSummary:
                return await session.feed_from(source)

            return self.bridge.run(feed)
        return session.feed_from(source).result(TIMEOUT)

    def events(self) -> tuple[list[Any], BaseException | None]:
        """Every event until the session ends, and the error it raised after them (if any)."""
        session = self.session
        out: list[Any] = []
        if isinstance(session, AsyncSttSession):
            assert self.bridge is not None

            async def drain() -> BaseException | None:
                try:
                    async for event in session:
                        out.append(event)
                except Exception as exc:
                    return exc
                return None

            return out, self.bridge.run(drain)
        try:
            for event in session:
                out.append(event)
        except Exception as exc:
            return out, exc
        return out, None

    def __getattr__(self, name: str) -> Any:
        return getattr(self.session, name)


def open_stt(mode: str, options: StreamOptions, bridge: Bridge | None, **kwargs: Any) -> SttAdapter:
    if mode == "async":
        assert bridge is not None

        async def connect() -> AsyncSttSession:
            return await connect_stt(options, **kwargs)

        return SttAdapter(bridge.run(connect), bridge)
    return SttAdapter(connect_stt_sync(options, **kwargs), None)


def run_transcribe(
    mode: str, options: StreamOptions, source: Iterable[bytes] | AsyncIterable[bytes] | bytes, **kwargs: Any
) -> tuple[list[Any], BaseException | None]:
    out: list[Any] = []
    if mode == "async":

        async def drain() -> BaseException | None:
            try:
                async for event in transcribe_stream(options, source, **kwargs):  # type: ignore[arg-type]
                    out.append(event)
            except Exception as exc:
                return exc
            return None

        async def guarded() -> BaseException | None:
            return await asyncio.wait_for(drain(), TIMEOUT)

        return out, asyncio.run(guarded())
    try:
        for event in transcribe_stream_sync(options, source, **kwargs):  # type: ignore[arg-type]
            out.append(event)
    except Exception as exc:
        return out, exc
    return out, None
