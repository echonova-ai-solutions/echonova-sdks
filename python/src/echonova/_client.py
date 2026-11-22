"""``EchoNova`` (blocking) and ``AsyncEchoNova`` (asyncio): the same API, the same behaviour."""

from __future__ import annotations

import asyncio
import inspect
import os
from collections.abc import Awaitable, Callable, Mapping
from functools import cached_property
from pathlib import Path
from types import TracebackType
from typing import Any, Self, TypeVar, cast, overload

import httpx

from ._base_client import (
    NOT_GIVEN,
    BaseClient,
    RequestSpec,
    _Limits,
    _Pool,
    _Sink,
    aread_error_body,
    check_options,
    public_signature,
    read_error_body,
)
from ._config import DEFAULT_MAX_RETRIES, DEFAULT_STREAM_KEEPALIVE, Runtime, Timeout
from ._response import ApiResponse, raw_mode
from ._transport import Action, Authenticate, Call, Failure, Flow, Send, Sleep
from .errors import EchoNovaError, UsageError
from .resources.agents import Agents, AgentsWithRawResponse, AsyncAgents, AsyncAgentsWithRawResponse
from .resources.sound_cleaning import (
    AsyncSoundCleaning,
    AsyncSoundCleaningWithRawResponse,
    SoundCleaning,
    SoundCleaningWithRawResponse,
)
from .resources.speech_to_text import (
    AsyncSpeechToText,
    AsyncSpeechToTextWithRawResponse,
    SpeechToText,
    SpeechToTextWithRawResponse,
)
from .resources.text_to_speech import (
    AsyncTextToSpeech,
    AsyncTextToSpeechWithRawResponse,
    TextToSpeech,
    TextToSpeechWithRawResponse,
)
from .resources.widgets import AsyncWidgets, AsyncWidgetsWithRawResponse, Widgets, WidgetsWithRawResponse

__all__ = ["AsyncEchoNova", "EchoNova"]

T = TypeVar("T")
SyncAuth = Callable[[], Mapping[str, str]]
AsyncAuth = Callable[[], Mapping[str, str] | Awaitable[Mapping[str, str]]]
PathLike = str | os.PathLike[str]


def _new_http_client() -> httpx.Client:
    return httpx.Client(follow_redirects=False, limits=httpx.Limits(max_connections=100, max_keepalive_connections=20))


def _new_download_client() -> httpx.Client:
    return httpx.Client(follow_redirects=True)


def _new_async_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        follow_redirects=False, limits=httpx.Limits(max_connections=100, max_keepalive_connections=20)
    )


def _new_async_download_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(follow_redirects=True)


class EchoNova(BaseClient[httpx.Client]):
    """The EchoNova API client.

    ``api_key`` defaults to the ``ECHONOVA_API_KEY`` environment variable. Reuse one
    client per process: it keeps a connection pool and the rate-limit state.

    Proxy mode: with ``base_url`` pointing at your own backend and ``auth``
    returning your app's headers, no EchoNova key is needed on the device.

    ``stream_keepalive`` applies to the streams this client opens: after that many
    seconds without sending anything, a stream sends a ping (default 30). It treats
    the connection as lost when a ping gets no answer within 15 s or nothing arrives
    for 60 s. None turns keepalive and these checks off.
    """

    text_to_speech: TextToSpeech
    speech_to_text: SpeechToText
    sound_cleaning: SoundCleaning
    widgets: Widgets
    agents: Agents

    @public_signature
    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        auth: SyncAuth | None = None,
        timeout: float | Timeout | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        deadline: float | None = None,
        rate_limit_preflight: bool = True,
        default_headers: Mapping[str, str] | None = None,
        http_client: httpx.Client | None = None,
        download_http_client: httpx.Client | None = None,
        on_request: Callable[[httpx.Request], Any] | None = None,
        on_response: Callable[[httpx.Response], Any] | None = None,
        stream_keepalive: float | None = DEFAULT_STREAM_KEEPALIVE,
        _runtime: Runtime | None = None,
        _limits: _Limits | None = None,
        _api_key_from_env: bool = False,
        _pool: _Pool[httpx.Client] | None = None,
    ) -> None:
        if auth is not None and inspect.iscoroutinefunction(auth):
            raise UsageError("auth is an async function; use AsyncEchoNova, or pass a regular function")
        super().__init__(
            api_key=api_key,
            base_url=base_url,
            auth=auth,
            timeout=timeout,
            max_retries=max_retries,
            deadline=deadline,
            rate_limit_preflight=rate_limit_preflight,
            default_headers=default_headers,
            on_request=on_request,
            on_response=on_response,
            runtime=_runtime,
            limits=_limits,
            stream_keepalive=stream_keepalive,
            api_key_from_env=_api_key_from_env,
        )
        if http_client is not None and not isinstance(http_client, httpx.Client):
            raise UsageError("http_client must be an httpx.Client (use httpx.AsyncClient with AsyncEchoNova)")
        if _pool is not None and http_client is None:
            self._pool = _pool
        else:
            self._pool = _Pool(
                http_client or _new_http_client(),
                owns_http=http_client is None,
                download=download_http_client,
                factory=_new_download_client,
            )
        self._owns_pool = _pool is None or http_client is not None
        self.text_to_speech = TextToSpeech(self)
        self.speech_to_text = SpeechToText(self)
        self.sound_cleaning = SoundCleaning(self)
        self.widgets = Widgets(self)
        self.agents = Agents(self)

    @cached_property
    def with_raw_response(self) -> EchoNovaWithRawResponse:
        """The same methods, returning ``RawResponse`` (headers, status, rate limit) with ``.parse()``."""
        return EchoNovaWithRawResponse(self)

    def with_options(
        self,
        *,
        api_key: str | None = NOT_GIVEN,
        base_url: str | None = NOT_GIVEN,
        auth: SyncAuth | None = NOT_GIVEN,
        timeout: float | Timeout | None = NOT_GIVEN,
        max_retries: int = NOT_GIVEN,
        deadline: float | None = NOT_GIVEN,
        rate_limit_preflight: bool = NOT_GIVEN,
        default_headers: Mapping[str, str] | None = NOT_GIVEN,
        http_client: httpx.Client | None = NOT_GIVEN,
        on_request: Callable[[httpx.Request], Any] | None = NOT_GIVEN,
        on_response: Callable[[httpx.Response], Any] | None = NOT_GIVEN,
        stream_keepalive: float | None = NOT_GIVEN,
    ) -> Self:
        """A copy with some options changed. It shares this client's connection pool: close this one, not the copy."""
        changes = {k: v for k, v in locals().items() if k != "self" and not k.startswith("__")}
        kwargs = self._option_kwargs(changes)
        if http_client:
            kwargs["http_client"] = http_client
        else:
            kwargs["_pool"] = self._pool
        return type(self)(**kwargs)

    # --- I/O driver -------------------------------------------------------------------------------

    def _run(self, flow: Flow[T]) -> T:
        try:
            action: Action = next(flow)
            while True:
                action = flow.send(self._perform(action))
        except StopIteration as done:
            return cast(T, done.value)
        finally:
            flow.close()

    def _perform(self, action: Action) -> Any:
        if isinstance(action, Sleep):
            self._runtime.sleep(action.seconds)
            return None
        if isinstance(action, Authenticate):
            return self._auth_headers()
        if isinstance(action, Send):
            return self._send(action)
        if isinstance(action, Call):
            try:
                return action.fn()
            except EchoNovaError as exc:
                return Failure(exc)
        raise TypeError(f"unknown action {action!r}")

    def _send(self, action: Send) -> httpx.Response | Exception:
        if action.download:
            client = self._pool.download_client()
        else:
            client = self._pool.http
            if self._on_request is not None:
                self._on_request(action.request)
        try:
            response = client.send(action.request, stream=True, follow_redirects=action.download)
            try:
                if not response.is_success:
                    read_error_body(response)  # capped: an error body is only read for its message
                elif action.sink is None:
                    response.read()
                else:
                    for chunk in response.iter_bytes():
                        action.sink.write(chunk)
            finally:
                response.close()
        except httpx.HTTPError as exc:
            return exc
        if not action.download and self._on_response is not None:
            self._on_response(response)
        return response

    def _request(self, spec: RequestSpec, parser: Callable[[ApiResponse], T]) -> T:
        check_options(spec.options)
        result: T = self._run(self._api_flow(spec, parser, raw=raw_mode()))
        return result

    # --- Downloads --------------------------------------------------------------------------------

    @overload
    def download(self, url: str | None, to: None = None) -> bytes: ...
    @overload
    def download(self, url: str | None, to: PathLike) -> Path: ...
    def download(self, url: str | None, to: PathLike | None = None) -> bytes | Path:
        """Download a signed link (``audio_url``, ``output_url``) without sending your API key.

        Returns the bytes, or streams to ``to`` (a file path, or a directory to keep
        the link's file name) and returns the path. An expired link raises
        ``DownloadExpiredError``: get the job again for a fresh one.
        """
        url = self._download_url(url)
        sink = _Sink(to, url)
        try:
            self._run(self._download_flow(url, sink))
            return sink.finish()
        except BaseException:
            sink.discard()
            raise

    # --- Lifecycle --------------------------------------------------------------------------------

    def close(self) -> None:
        """Close the connection pools this client created. Copies from ``with_options()`` leave them open."""
        if not self._owns_pool:
            return
        for client in self._pool.owned():
            client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.close()


class AsyncEchoNova(BaseClient[httpx.AsyncClient]):
    """The EchoNova API client for asyncio. Same options and methods as ``EchoNova``.

    ``auth`` may be an async function.
    """

    text_to_speech: AsyncTextToSpeech
    speech_to_text: AsyncSpeechToText
    sound_cleaning: AsyncSoundCleaning
    widgets: AsyncWidgets
    agents: AsyncAgents

    @public_signature
    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        auth: AsyncAuth | None = None,
        timeout: float | Timeout | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        deadline: float | None = None,
        rate_limit_preflight: bool = True,
        default_headers: Mapping[str, str] | None = None,
        http_client: httpx.AsyncClient | None = None,
        download_http_client: httpx.AsyncClient | None = None,
        on_request: Callable[[httpx.Request], Any] | None = None,
        on_response: Callable[[httpx.Response], Any] | None = None,
        stream_keepalive: float | None = DEFAULT_STREAM_KEEPALIVE,
        _runtime: Runtime | None = None,
        _limits: _Limits | None = None,
        _api_key_from_env: bool = False,
        _pool: _Pool[httpx.AsyncClient] | None = None,
    ) -> None:
        super().__init__(
            api_key=api_key,
            base_url=base_url,
            auth=auth,
            timeout=timeout,
            max_retries=max_retries,
            deadline=deadline,
            rate_limit_preflight=rate_limit_preflight,
            default_headers=default_headers,
            on_request=on_request,
            on_response=on_response,
            runtime=_runtime,
            limits=_limits,
            stream_keepalive=stream_keepalive,
            api_key_from_env=_api_key_from_env,
        )
        if http_client is not None and not isinstance(http_client, httpx.AsyncClient):
            raise UsageError("http_client must be an httpx.AsyncClient (use httpx.Client with EchoNova)")
        if _pool is not None and http_client is None:
            self._pool = _pool
        else:
            self._pool = _Pool(
                http_client or _new_async_http_client(),
                owns_http=http_client is None,
                download=download_http_client,
                factory=_new_async_download_client,
            )
        self._owns_pool = _pool is None or http_client is not None
        self.text_to_speech = AsyncTextToSpeech(self)
        self.speech_to_text = AsyncSpeechToText(self)
        self.sound_cleaning = AsyncSoundCleaning(self)
        self.widgets = AsyncWidgets(self)
        self.agents = AsyncAgents(self)

    @cached_property
    def with_raw_response(self) -> AsyncEchoNovaWithRawResponse:
        """The same methods, returning ``RawResponse`` (headers, status, rate limit) with ``.parse()``."""
        return AsyncEchoNovaWithRawResponse(self)

    def with_options(
        self,
        *,
        api_key: str | None = NOT_GIVEN,
        base_url: str | None = NOT_GIVEN,
        auth: AsyncAuth | None = NOT_GIVEN,
        timeout: float | Timeout | None = NOT_GIVEN,
        max_retries: int = NOT_GIVEN,
        deadline: float | None = NOT_GIVEN,
        rate_limit_preflight: bool = NOT_GIVEN,
        default_headers: Mapping[str, str] | None = NOT_GIVEN,
        http_client: httpx.AsyncClient | None = NOT_GIVEN,
        on_request: Callable[[httpx.Request], Any] | None = NOT_GIVEN,
        on_response: Callable[[httpx.Response], Any] | None = NOT_GIVEN,
        stream_keepalive: float | None = NOT_GIVEN,
    ) -> Self:
        """A copy with some options changed. It shares this client's connection pool: close this one, not the copy."""
        changes = {k: v for k, v in locals().items() if k != "self" and not k.startswith("__")}
        kwargs = self._option_kwargs(changes)
        if http_client:
            kwargs["http_client"] = http_client
        else:
            kwargs["_pool"] = self._pool
        return type(self)(**kwargs)

    # --- I/O driver -------------------------------------------------------------------------------

    async def _run(self, flow: Flow[T]) -> T:
        try:
            action: Action = next(flow)
            while True:
                action = flow.send(await self._perform(action))
        except StopIteration as done:
            return cast(T, done.value)
        finally:
            flow.close()

    async def _perform(self, action: Action) -> Any:
        if isinstance(action, Sleep):
            await (self._runtime.async_sleep or asyncio.sleep)(action.seconds)
            return None
        if isinstance(action, Authenticate):
            return await self._async_auth_headers()
        if isinstance(action, Send):
            return await self._send(action)
        if isinstance(action, Call):
            try:
                result = action.fn()
                return (await result) if inspect.isawaitable(result) else result
            except EchoNovaError as exc:
                return Failure(exc)
        raise TypeError(f"unknown action {action!r}")

    async def _send(self, action: Send) -> httpx.Response | Exception:
        if action.download:
            client = self._pool.download_client()
        else:
            client = self._pool.http
            await _call_hook(self._on_request, action.request)
        try:
            response = await client.send(action.request, stream=True, follow_redirects=action.download)
            try:
                if not response.is_success:
                    await aread_error_body(response)  # capped: an error body is only read for its message
                elif action.sink is None:
                    await response.aread()
                else:
                    async for chunk in response.aiter_bytes():
                        action.sink.write(chunk)
            finally:
                await response.aclose()
        except httpx.HTTPError as exc:
            return exc
        if not action.download:
            await _call_hook(self._on_response, response)
        return response

    async def _request(self, spec: RequestSpec, parser: Callable[[ApiResponse], T]) -> T:
        check_options(spec.options)
        result: T = await self._run(self._api_flow(spec, parser, raw=raw_mode()))
        return result

    # --- Downloads --------------------------------------------------------------------------------

    @overload
    async def download(self, url: str | None, to: None = None) -> bytes: ...
    @overload
    async def download(self, url: str | None, to: PathLike) -> Path: ...
    async def download(self, url: str | None, to: PathLike | None = None) -> bytes | Path:
        """Download a signed link (``audio_url``, ``output_url``) without sending your API key.

        Returns the bytes, or streams to ``to`` (a file path, or a directory to keep
        the link's file name) and returns the path. An expired link raises
        ``DownloadExpiredError``: get the job again for a fresh one.
        """
        url = self._download_url(url)
        sink = _Sink(to, url)
        try:
            await self._run(self._download_flow(url, sink))
            return sink.finish()
        except BaseException:
            sink.discard()
            raise

    # --- Lifecycle --------------------------------------------------------------------------------

    async def close(self) -> None:
        """Close the connection pools this client created. Copies from ``with_options()`` leave them open."""
        if not self._owns_pool:
            return
        for client in self._pool.owned():
            await client.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        await self.close()


async def _call_hook(hook: Callable[[Any], Any] | None, value: Any) -> None:
    if hook is None:
        return
    result = hook(value)
    if inspect.isawaitable(result):
        await result


class EchoNovaWithRawResponse:
    def __init__(self, client: EchoNova) -> None:
        self.text_to_speech = TextToSpeechWithRawResponse(client.text_to_speech)
        self.speech_to_text = SpeechToTextWithRawResponse(client.speech_to_text)
        self.sound_cleaning = SoundCleaningWithRawResponse(client.sound_cleaning)
        self.widgets = WidgetsWithRawResponse(client.widgets)
        self.agents = AgentsWithRawResponse(client.agents)


class AsyncEchoNovaWithRawResponse:
    def __init__(self, client: AsyncEchoNova) -> None:
        self.text_to_speech = AsyncTextToSpeechWithRawResponse(client.text_to_speech)
        self.speech_to_text = AsyncSpeechToTextWithRawResponse(client.speech_to_text)
        self.sound_cleaning = AsyncSoundCleaningWithRawResponse(client.sound_cleaning)
        self.widgets = AsyncWidgetsWithRawResponse(client.widgets)
        self.agents = AsyncAgentsWithRawResponse(client.agents)
