"""Text to Speech over REST: ``generate``, voices and async jobs."""

from __future__ import annotations

import builtins
import os
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, overload

from typing_extensions import Unpack

from .. import _operations as ops
from .._base_client import RequestSpec, job_id_of
from .._pagination import AsyncPage, AsyncPageRequest, Page
from .._polling import DEFAULT_WAIT_TIMEOUT, TTS_POLL_INTERVAL, candidates_flow, check_interval, wait_flow
from .._response import ApiResponse, async_to_raw_response_wrapper, to_raw_response_wrapper
from ..errors import JobFailedError, UsageError
from ..types.models import DeleteResult, JobInitiated, TtsJob, TtsResult, VoiceList
from ..types.params import RequestOptions
from ._base import AsyncResource, JobRef, SyncResource, compact, model_parser, page_data, parse_delete

if TYPE_CHECKING:
    from .._client import AsyncEchoNova, EchoNova
    from .._streaming import AsyncConnecting, AsyncTtsSession, TtsSession
    from ..audio import Audio

__all__ = ["AsyncTextToSpeech", "AsyncTtsJobs", "AsyncVoices", "TextToSpeech", "TtsJobs", "Voices"]


def _speech_body(
    text: str,
    voice_id: str,
    speed: float | None,
    cfg: float | None,
    num_steps: int | None,
    tashkeel: bool | None,
    normalize: bool | None,
) -> dict[str, Any]:
    return {
        "text": text,
        "voiceId": voice_id,
        **compact(speed=speed, cfg=cfg, numSteps=num_steps, tashkeel=tashkeel, normalize=normalize),
    }


def _audio_url(job: TtsJob) -> str:
    if job.status == "failed":
        raise JobFailedError(f"job {job.id} failed: {job.error or 'no error message'}", job=job)
    if not job.audio_url:
        raise UsageError(f"job {job.id} has no audio yet (status {job.status}); call wait() first")
    return job.audio_url


# --- Sync ---------------------------------------------------------------------------------------


class Voices(SyncResource):
    def list(self, **options: Unpack[RequestOptions]) -> VoiceList:
        """Every voice you can use. The list changes rarely: cache it."""
        return self._client._request(RequestSpec(ops.TTS_VOICES_LIST, options=options), model_parser(VoiceList))


class TtsJobs(SyncResource):
    def create(
        self,
        text: str,
        *,
        voice_id: str,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        **options: Unpack[RequestOptions],
    ) -> JobInitiated:
        """Start an async synthesis job. Get the result with ``wait()`` or a ``job.completed`` webhook."""
        body = _speech_body(text, voice_id, speed, cfg, num_steps, tashkeel, normalize)
        return self._client._request(
            RequestSpec(ops.TTS_JOBS_CREATE, json=body, options=options), model_parser(JobInitiated)
        )

    def get(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> TtsJob:
        """Get a job, with a freshly signed ``audio_url`` when it has completed."""
        spec = RequestSpec(ops.TTS_JOBS_GET, path_params={"jobId": job_id_of(job_id)}, options=options)
        return self._client._request(spec, model_parser(TtsJob))

    def list(
        self, *, offset: int | None = None, limit: int | None = None, **options: Unpack[RequestOptions]
    ) -> Page[TtsJob]:
        """List jobs, newest first. Iterating the page continues through the next pages."""

        def parse(response: ApiResponse) -> Page[TtsJob]:
            items, total, raw = page_data(response, TtsJob)
            return Page(
                items=items,
                total=total,
                offset=offset or 0,
                limit=limit,
                request_id=response.request_id,
                raw=raw,
                fetch=lambda next_offset: self.list(offset=next_offset, limit=limit, **options),
            )

        query = compact(offset=offset, limit=limit)
        return self._client._request(RequestSpec(ops.TTS_JOBS_LIST, query=query, options=options), parse)

    def delete(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> DeleteResult:
        """Delete a finished job and its audio."""
        spec = RequestSpec(ops.TTS_JOBS_DELETE, path_params={"jobId": job_id_of(job_id)}, options=options)
        return self._client._request(spec, parse_delete)

    def wait(
        self,
        job_id: JobRef,
        *,
        poll_interval: float | None = None,
        timeout: float = DEFAULT_WAIT_TIMEOUT,
        raise_on_failure: bool = True,
    ) -> TtsJob:
        """Poll until the job completes or fails (every 3 s by default).

        Raises ``JobFailedError`` for a failed job unless ``raise_on_failure=False``,
        and ``JobWaitTimeoutError`` after ``timeout`` seconds.
        """
        job_id = job_id_of(job_id)
        flow = wait_flow(
            job_id=job_id,
            get=lambda: self.get(job_id),
            interval=check_interval(poll_interval, TTS_POLL_INTERVAL),
            timeout=timeout,
            raise_on_failure=raise_on_failure,
            limiter=self._client._limits.limiter,
            bucket=ops.TTS_JOBS_GET.name,
            runtime=self._client._runtime,
        )
        result: TtsJob = self._client._run(flow)
        return result

    @overload
    def download(self, job_id: JobRef, to: None = None) -> bytes: ...
    @overload
    def download(self, job_id: JobRef, to: str | os.PathLike[str]) -> Path: ...
    def download(self, job_id: JobRef, to: str | os.PathLike[str] | None = None) -> bytes | Path:
        """Get the job for a fresh link, then download its WAV audio (to a file, or as bytes)."""
        url = _audio_url(self.get(job_id))
        return self._client.download(url, to=to)

    def find_candidates(self, sent_at: datetime, *, text: str | None = None) -> builtins.list[TtsJob]:
        """Jobs that may have come from a request whose response was lost.

        Lists jobs created from ``sent_at`` minus 5 s, optionally with the same
        ``text``. It never picks one for you: other requests can match too, so check before you act.
        """
        flow = candidates_flow(list_page=lambda offset: self.list(offset=offset, limit=100), sent_at=sent_at, text=text)
        found: builtins.list[TtsJob] = self._client._run(flow)
        return found


class TextToSpeech(SyncResource):
    def __init__(self, client: EchoNova) -> None:
        super().__init__(client)
        self.voices = Voices(client)
        self.jobs = TtsJobs(client)

    def generate(
        self,
        text: str,
        *,
        voice_id: str,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        **options: Unpack[RequestOptions],
    ) -> TtsResult:
        """Synthesize speech and wait for it. ``audio_url`` is a signed WAV link that expires."""
        body = _speech_body(text, voice_id, speed, cfg, num_steps, tashkeel, normalize)
        return self._client._request(RequestSpec(ops.TTS_GENERATE, json=body, options=options), model_parser(TtsResult))

    def connect(
        self,
        *,
        voice_id: str,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        wait_for_slot: float | None = None,
    ) -> TtsSession:
        """Open a streaming Text to Speech session. The options apply to every synthesis on it.

        Use it as a context manager. ``wait_for_slot`` keeps retrying for that many
        seconds when the workspace has no free stream slot.
        """
        from .._streaming import connect_tts_sync

        return connect_tts_sync(
            self._client._stream_options(asynchronous=False),
            voice_id=voice_id,
            speed=speed,
            cfg=cfg,
            num_steps=num_steps,
            tashkeel=tashkeel,
            normalize=normalize,
            wait_for_slot=wait_for_slot,
        )

    def speak(
        self,
        text: str,
        *,
        voice_id: str,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        wait_for_slot: float | None = None,
    ) -> Audio:
        """Synthesize ``text`` over a stream and return the PCM audio (lower latency than ``generate``)."""
        from .._streaming import speak_sync

        return speak_sync(
            self._client._stream_options(asynchronous=False),
            text,
            voice_id=voice_id,
            speed=speed,
            cfg=cfg,
            num_steps=num_steps,
            tashkeel=tashkeel,
            normalize=normalize,
            wait_for_slot=wait_for_slot,
        )


# --- Async --------------------------------------------------------------------------------------


class AsyncVoices(AsyncResource):
    async def list(self, **options: Unpack[RequestOptions]) -> VoiceList:
        """Every voice you can use. The list changes rarely: cache it."""
        return await self._client._request(RequestSpec(ops.TTS_VOICES_LIST, options=options), model_parser(VoiceList))


class AsyncTtsJobs(AsyncResource):
    async def create(
        self,
        text: str,
        *,
        voice_id: str,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        **options: Unpack[RequestOptions],
    ) -> JobInitiated:
        """Start an async synthesis job. Get the result with ``wait()`` or a ``job.completed`` webhook."""
        body = _speech_body(text, voice_id, speed, cfg, num_steps, tashkeel, normalize)
        return await self._client._request(
            RequestSpec(ops.TTS_JOBS_CREATE, json=body, options=options), model_parser(JobInitiated)
        )

    async def get(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> TtsJob:
        """Get a job, with a freshly signed ``audio_url`` when it has completed."""
        spec = RequestSpec(ops.TTS_JOBS_GET, path_params={"jobId": job_id_of(job_id)}, options=options)
        return await self._client._request(spec, model_parser(TtsJob))

    def list(
        self, *, offset: int | None = None, limit: int | None = None, **options: Unpack[RequestOptions]
    ) -> AsyncPageRequest[TtsJob]:
        """List jobs, newest first. ``await`` for one page, or ``async for`` over all of them."""

        def parse(response: ApiResponse) -> AsyncPage[TtsJob]:
            items, total, raw = page_data(response, TtsJob)
            return AsyncPage(
                items=items,
                total=total,
                offset=offset or 0,
                limit=limit,
                request_id=response.request_id,
                raw=raw,
                fetch=lambda next_offset: self.list(offset=next_offset, limit=limit, **options),
            )

        query = compact(offset=offset, limit=limit)
        spec = RequestSpec(ops.TTS_JOBS_LIST, query=query, options=options)
        return AsyncPageRequest(lambda: self._client._request(spec, parse))

    async def delete(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> DeleteResult:
        """Delete a finished job and its audio."""
        spec = RequestSpec(ops.TTS_JOBS_DELETE, path_params={"jobId": job_id_of(job_id)}, options=options)
        return await self._client._request(spec, parse_delete)

    async def wait(
        self,
        job_id: JobRef,
        *,
        poll_interval: float | None = None,
        timeout: float = DEFAULT_WAIT_TIMEOUT,
        raise_on_failure: bool = True,
    ) -> TtsJob:
        """Poll until the job completes or fails (every 3 s by default).

        Raises ``JobFailedError`` for a failed job unless ``raise_on_failure=False``,
        and ``JobWaitTimeoutError`` after ``timeout`` seconds.
        """
        job_id = job_id_of(job_id)
        flow = wait_flow(
            job_id=job_id,
            get=lambda: self.get(job_id),
            interval=check_interval(poll_interval, TTS_POLL_INTERVAL),
            timeout=timeout,
            raise_on_failure=raise_on_failure,
            limiter=self._client._limits.limiter,
            bucket=ops.TTS_JOBS_GET.name,
            runtime=self._client._runtime,
        )
        result: TtsJob = await self._client._run(flow)
        return result

    @overload
    async def download(self, job_id: JobRef, to: None = None) -> bytes: ...
    @overload
    async def download(self, job_id: JobRef, to: str | os.PathLike[str]) -> Path: ...
    async def download(self, job_id: JobRef, to: str | os.PathLike[str] | None = None) -> bytes | Path:
        """Get the job for a fresh link, then download its WAV audio (to a file, or as bytes)."""
        url = _audio_url(await self.get(job_id))
        return await self._client.download(url, to=to)

    async def find_candidates(self, sent_at: datetime, *, text: str | None = None) -> builtins.list[TtsJob]:
        """Jobs that may have come from a request whose response was lost.

        Lists jobs created from ``sent_at`` minus 5 s, optionally with the same
        ``text``. It never picks one for you: other requests can match too, so check before you act.
        """
        flow = candidates_flow(list_page=lambda offset: self.list(offset=offset, limit=100), sent_at=sent_at, text=text)
        found: builtins.list[TtsJob] = await self._client._run(flow)
        return found


class AsyncTextToSpeech(AsyncResource):
    def __init__(self, client: AsyncEchoNova) -> None:
        super().__init__(client)
        self.voices = AsyncVoices(client)
        self.jobs = AsyncTtsJobs(client)

    async def generate(
        self,
        text: str,
        *,
        voice_id: str,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        **options: Unpack[RequestOptions],
    ) -> TtsResult:
        """Synthesize speech and wait for it. ``audio_url`` is a signed WAV link that expires."""
        body = _speech_body(text, voice_id, speed, cfg, num_steps, tashkeel, normalize)
        return await self._client._request(
            RequestSpec(ops.TTS_GENERATE, json=body, options=options), model_parser(TtsResult)
        )

    def connect(
        self,
        *,
        voice_id: str,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        wait_for_slot: float | None = None,
    ) -> AsyncConnecting[AsyncTtsSession]:
        """Open a streaming Text to Speech session: ``async with client.text_to_speech.connect(...) as tts``.

        The options apply to every synthesis on it. ``wait_for_slot`` keeps retrying
        for that many seconds when the workspace has no free stream slot.
        """
        from .._streaming import connect_tts

        return connect_tts(
            self._client._stream_options(asynchronous=True),
            voice_id=voice_id,
            speed=speed,
            cfg=cfg,
            num_steps=num_steps,
            tashkeel=tashkeel,
            normalize=normalize,
            wait_for_slot=wait_for_slot,
        )

    async def speak(
        self,
        text: str,
        *,
        voice_id: str,
        speed: float | None = None,
        cfg: float | None = None,
        num_steps: int | None = None,
        tashkeel: bool | None = None,
        normalize: bool | None = None,
        wait_for_slot: float | None = None,
    ) -> Audio:
        """Synthesize ``text`` over a stream and return the PCM audio (lower latency than ``generate``)."""
        from .._streaming import speak

        return await speak(
            self._client._stream_options(asynchronous=True),
            text,
            voice_id=voice_id,
            speed=speed,
            cfg=cfg,
            num_steps=num_steps,
            tashkeel=tashkeel,
            normalize=normalize,
            wait_for_slot=wait_for_slot,
        )


# --- Raw responses ------------------------------------------------------------------------------


class VoicesWithRawResponse:
    def __init__(self, voices: Voices) -> None:
        self.list = to_raw_response_wrapper(voices.list)


class TtsJobsWithRawResponse:
    def __init__(self, jobs: TtsJobs) -> None:
        self.create = to_raw_response_wrapper(jobs.create)
        self.get = to_raw_response_wrapper(jobs.get)
        self.list = to_raw_response_wrapper(jobs.list)
        self.delete = to_raw_response_wrapper(jobs.delete)


class TextToSpeechWithRawResponse:
    def __init__(self, tts: TextToSpeech) -> None:
        self.generate = to_raw_response_wrapper(tts.generate)
        self.voices = VoicesWithRawResponse(tts.voices)
        self.jobs = TtsJobsWithRawResponse(tts.jobs)


class AsyncVoicesWithRawResponse:
    def __init__(self, voices: AsyncVoices) -> None:
        self.list = async_to_raw_response_wrapper(voices.list)


class AsyncTtsJobsWithRawResponse:
    def __init__(self, jobs: AsyncTtsJobs) -> None:
        self.create = async_to_raw_response_wrapper(jobs.create)
        self.get = async_to_raw_response_wrapper(jobs.get)
        self.list = async_to_raw_response_wrapper(jobs.list)
        self.delete = async_to_raw_response_wrapper(jobs.delete)


class AsyncTextToSpeechWithRawResponse:
    def __init__(self, tts: AsyncTextToSpeech) -> None:
        self.generate = async_to_raw_response_wrapper(tts.generate)
        self.voices = AsyncVoicesWithRawResponse(tts.voices)
        self.jobs = AsyncTtsJobsWithRawResponse(tts.jobs)
