"""Entry points for the streaming layer. The client wires these into its resources.

Async factories return an object that can be awaited (giving the connected
session) or used directly with ``async with``. Sync factories return a
connected session, which is also a context manager.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Generator, Mapping
from types import TracebackType
from typing import Any, Generic, Protocol, TypeVar

from ..audio import Audio
from ._options import StreamOptions
from ._stt_session import AsyncSttSession, SttSession, Terminology
from ._tts_session import AsyncTtsSession, TtsSession, synthesis_options


class _AsyncClosable(Protocol):
    async def close(self) -> None: ...


S = TypeVar("S", bound=_AsyncClosable)


class AsyncConnecting(Generic[S]):
    """``await`` it for the connected session, or use it with ``async with`` to close it automatically."""

    def __init__(self, opener: Callable[[], Awaitable[S]]) -> None:
        self._opener = opener
        self._session: S | None = None

    def __await__(self) -> Generator[Any, None, S]:
        return self._open().__await__()

    async def _open(self) -> S:
        return await self._opener()

    async def __aenter__(self) -> S:
        self._session = await self._opener()
        return self._session

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        if self._session is not None:
            await self._session.close()


def _tts_defaults(
    speed: float | None,
    cfg: float | None,
    num_steps: int | None,
    tashkeel: bool | None,
    normalize: bool | None,
) -> dict[str, Any]:
    defaults = synthesis_options(
        voice_id=None,
        speed=speed,
        cfg=cfg,
        num_steps=num_steps,
        tashkeel=tashkeel,
        normalize=normalize,
        extra_body=None,
    )
    return {k: v for k, v in defaults.items() if v is not None}


# --- Text to Speech -------------------------------------------------------------------------------


def connect_tts(
    options: StreamOptions,
    *,
    voice_id: str,
    speed: float | None = None,
    cfg: float | None = None,
    num_steps: int | None = None,
    tashkeel: bool | None = None,
    normalize: bool | None = None,
    wait_for_slot: float | None = None,
) -> AsyncConnecting[AsyncTtsSession]:
    """Open a Text to Speech stream. The options given here apply to every synthesis on it."""
    session = AsyncTtsSession(
        options,
        voice_id=voice_id,
        defaults=_tts_defaults(speed, cfg, num_steps, tashkeel, normalize),
        wait_for_slot=wait_for_slot,
    )
    return AsyncConnecting(session._start)


def connect_tts_sync(
    options: StreamOptions,
    *,
    voice_id: str,
    speed: float | None = None,
    cfg: float | None = None,
    num_steps: int | None = None,
    tashkeel: bool | None = None,
    normalize: bool | None = None,
    wait_for_slot: float | None = None,
) -> TtsSession:
    """Open a Text to Speech stream (blocking)."""
    session = TtsSession(
        options,
        voice_id=voice_id,
        defaults=_tts_defaults(speed, cfg, num_steps, tashkeel, normalize),
        wait_for_slot=wait_for_slot,
    )
    return session._start()


async def speak(
    options: StreamOptions,
    text: str,
    *,
    voice_id: str,
    speed: float | None = None,
    cfg: float | None = None,
    num_steps: int | None = None,
    tashkeel: bool | None = None,
    normalize: bool | None = None,
    extra_body: Mapping[str, Any] | None = None,
    wait_for_slot: float | None = None,
) -> Audio:
    """Synthesize ``text`` over a stream of its own and return all the audio."""
    async with connect_tts(options, voice_id=voice_id, wait_for_slot=wait_for_slot) as tts:
        synthesis = tts.synthesize(
            text,
            speed=speed,
            cfg=cfg,
            num_steps=num_steps,
            tashkeel=tashkeel,
            normalize=normalize,
            extra_body=extra_body,
        )
        audio = await synthesis.collect()
        await synthesis.result()
        return audio


def speak_sync(
    options: StreamOptions,
    text: str,
    *,
    voice_id: str,
    speed: float | None = None,
    cfg: float | None = None,
    num_steps: int | None = None,
    tashkeel: bool | None = None,
    normalize: bool | None = None,
    extra_body: Mapping[str, Any] | None = None,
    wait_for_slot: float | None = None,
) -> Audio:
    """Synthesize ``text`` over a stream of its own and return all the audio (blocking)."""
    with connect_tts_sync(options, voice_id=voice_id, wait_for_slot=wait_for_slot) as tts:
        synthesis = tts.synthesize(
            text,
            speed=speed,
            cfg=cfg,
            num_steps=num_steps,
            tashkeel=tashkeel,
            normalize=normalize,
            extra_body=extra_body,
        )
        audio = synthesis.collect()
        synthesis.result()
        return audio


# --- Speech to Text -------------------------------------------------------------------------------


def connect_stt(
    options: StreamOptions,
    *,
    sample_rate: int,
    language: str | None = None,
    terminology: Terminology | None = None,
    encoding: str = "pcm_s16le",
    wait_for_slot: float | None = None,
) -> AsyncConnecting[AsyncSttSession]:
    """Open a Speech to Text stream. Ready once the server has started the session
    (and confirmed ``terminology``, when given)."""
    session = AsyncSttSession(
        options,
        sample_rate=sample_rate,
        language=language,
        terminology=terminology,
        encoding=encoding,
        wait_for_slot=wait_for_slot,
    )
    return AsyncConnecting(session._start)


def connect_stt_sync(
    options: StreamOptions,
    *,
    sample_rate: int,
    language: str | None = None,
    terminology: Terminology | None = None,
    encoding: str = "pcm_s16le",
    wait_for_slot: float | None = None,
) -> SttSession:
    """Open a Speech to Text stream (blocking)."""
    session = SttSession(
        options,
        sample_rate=sample_rate,
        language=language,
        terminology=terminology,
        encoding=encoding,
        wait_for_slot=wait_for_slot,
    )
    return session._start()
