"""Speech to Text over REST: ``transcribe``, async jobs and transcript export."""

from __future__ import annotations

import builtins
import json
from collections.abc import AsyncIterable, AsyncIterator, Callable, Iterable, Iterator, Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, overload

from typing_extensions import Unpack

from .. import _operations as ops
from .._base_client import RequestSpec, job_id_of
from .._core._envelope import MalformedEnvelopeError
from .._core._files import FileInput, form_value, prepare_file
from .._pagination import AsyncPage, AsyncPageRequest, Page
from .._polling import DEFAULT_WAIT_TIMEOUT, STT_POLL_INTERVAL, candidates_flow, check_interval, wait_flow
from .._response import ApiResponse, async_to_raw_response_wrapper, to_raw_response_wrapper
from ..types.models import DeleteResult, JobInitiated, SttJob, SttResult, TranscriptExport
from ..types.params import RequestOptions, Terminology
from ._base import AsyncResource, JobRef, SyncResource, compact, model_parser, page_data, parse_delete

if TYPE_CHECKING:
    from .._client import AsyncEchoNova, EchoNova
    from .._streaming import AsyncConnecting, AsyncSttSession, ReconnectPolicy, SttSession, TranscribeEvent

__all__ = ["AsyncSpeechToText", "AsyncSttJobs", "SpeechToText", "SttJobs"]

Language = Literal["ar", "en"] | str
ExportFormat = Literal["txt", "srt", "json"]
TerminologyInput = Terminology | Mapping[str, Any] | str


def _form(
    language: str,
    numbers_as_digits: bool | None,
    identify_speakers: bool | None,
    terminology: TerminologyInput | None,
) -> dict[str, str]:
    """Multipart fields. Their names are snake_case, and ``terminology`` travels as a JSON string."""
    form = {"language": language}
    if numbers_as_digits is not None:
        form["numbers_as_digits"] = form_value(numbers_as_digits)
    if identify_speakers is not None:
        form["identify_speakers"] = form_value(identify_speakers)
    if terminology is not None:
        form["terminology"] = (
            terminology if isinstance(terminology, str) else json.dumps(terminology, ensure_ascii=False)
        )
    return form


def _export_parser(format: str) -> Callable[[ApiResponse], Any]:
    def parse(response: ApiResponse) -> str | TranscriptExport:
        if format != "json":
            return response.http.content.decode("utf-8", errors="replace")
        try:
            data = json.loads(response.http.content)
        except ValueError as exc:
            raise MalformedEnvelopeError("the JSON export is not valid JSON") from exc
        return TranscriptExport._from_json(data, request_id=response.request_id)

    return parse


# --- Sync ---------------------------------------------------------------------------------------


class SttJobs(SyncResource):
    def create(
        self,
        file: FileInput,
        *,
        language: Language,
        numbers_as_digits: bool | None = None,
        identify_speakers: bool | None = None,
        terminology: TerminologyInput | None = None,
        **options: Unpack[RequestOptions],
    ) -> JobInitiated:
        """Upload audio for an async transcription job. Get the result with ``wait()`` or a webhook."""
        spec = RequestSpec(
            ops.STT_JOBS_CREATE,
            form=_form(language, numbers_as_digits, identify_speakers, terminology),
            file=prepare_file(file),
            options=options,
        )
        return self._client._request(spec, model_parser(JobInitiated))

    def get(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> SttJob:
        spec = RequestSpec(ops.STT_JOBS_GET, path_params={"jobId": job_id_of(job_id)}, options=options)
        return self._client._request(spec, model_parser(SttJob))

    def list(
        self, *, offset: int | None = None, limit: int | None = None, **options: Unpack[RequestOptions]
    ) -> Page[SttJob]:
        """List jobs, newest first. Iterating the page continues through the next pages."""

        def parse(response: ApiResponse) -> Page[SttJob]:
            items, total, raw = page_data(response, SttJob)
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
        return self._client._request(RequestSpec(ops.STT_JOBS_LIST, query=query, options=options), parse)

    def delete(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> DeleteResult:
        """Delete a finished job and its audio."""
        spec = RequestSpec(ops.STT_JOBS_DELETE, path_params={"jobId": job_id_of(job_id)}, options=options)
        return self._client._request(spec, parse_delete)

    def wait(
        self,
        job_id: JobRef,
        *,
        poll_interval: float | None = None,
        timeout: float = DEFAULT_WAIT_TIMEOUT,
        raise_on_failure: bool = True,
    ) -> SttJob:
        """Poll until the job completes or fails (every 5 s by default).

        Raises ``JobFailedError`` for a failed job unless ``raise_on_failure=False``,
        and ``JobWaitTimeoutError`` after ``timeout`` seconds.
        """
        job_id = job_id_of(job_id)
        flow = wait_flow(
            job_id=job_id,
            get=lambda: self.get(job_id),
            interval=check_interval(poll_interval, STT_POLL_INTERVAL),
            timeout=timeout,
            raise_on_failure=raise_on_failure,
            limiter=self._client._limits.limiter,
            bucket=ops.STT_JOBS_GET.name,
            runtime=self._client._runtime,
        )
        result: SttJob = self._client._run(flow)
        return result

    @overload
    def export(
        self,
        job_id: JobRef,
        *,
        format: Literal["txt", "srt"],
        lang: Literal["en", "ar"] | None = None,
        **options: Unpack[RequestOptions],
    ) -> str: ...
    @overload
    def export(
        self,
        job_id: JobRef,
        *,
        format: Literal["json"],
        lang: Literal["en", "ar"] | None = None,
        **options: Unpack[RequestOptions],
    ) -> TranscriptExport: ...
    def export(
        self,
        job_id: JobRef,
        *,
        format: ExportFormat,
        lang: Literal["en", "ar"] | None = None,
        **options: Unpack[RequestOptions],
    ) -> str | TranscriptExport:
        """Export a completed transcript: ``txt`` or ``srt`` as text, ``json`` as a ``TranscriptExport``.

        ``lang`` sets the language of the speaker labels.
        """
        spec = RequestSpec(
            ops.STT_JOBS_EXPORT,
            path_params={"jobId": job_id_of(job_id)},
            query=compact(format=format, lang=lang),
            options=options,
        )
        result: str | TranscriptExport = self._client._request(spec, _export_parser(format))
        return result

    def find_candidates(self, sent_at: datetime) -> builtins.list[SttJob]:
        """Jobs that may have come from a request whose response was lost.

        Lists jobs created from ``sent_at`` minus 5 s. It never picks one for you:
        concurrent uploads appear too, so check before you act.
        """
        flow = candidates_flow(list_page=lambda offset: self.list(offset=offset, limit=100), sent_at=sent_at)
        found: builtins.list[SttJob] = self._client._run(flow)
        return found


class SpeechToText(SyncResource):
    def __init__(self, client: EchoNova) -> None:
        super().__init__(client)
        self.jobs = SttJobs(client)

    def connect(
        self,
        *,
        sample_rate: int,
        language: str,
        terminology: Terminology | None = None,
        encoding: str = "pcm_s16le",
        wait_for_slot: float | None = None,
    ) -> SttSession:
        """Open a live Speech to Text session for PCM16LE mono audio at ``sample_rate`` Hz.

        Returns once the session has started (and ``terminology`` is confirmed, when
        given). Use it as a context manager; sessions never reconnect on their own.
        """
        from .._streaming import connect_stt_sync

        return connect_stt_sync(
            self._client._stream_options(asynchronous=False),
            sample_rate=sample_rate,
            language=language,
            terminology=terminology,
            encoding=encoding,
            wait_for_slot=wait_for_slot,
        )

    def transcribe_stream(
        self,
        source: Iterable[bytes] | bytes,
        *,
        sample_rate: int,
        language: str,
        terminology: Terminology | None = None,
        segment_seconds: float = 14.0,
        reconnect: ReconnectPolicy | None = None,
        realtime: bool = False,
        encoding: str = "pcm_s16le",
        wait_for_slot: float | None = None,
    ) -> Iterator[TranscribeEvent]:
        """Transcribe a PCM16LE source, rolling over to new sessions past the session limit.

        Yields ``Transcript`` events plus ``StreamErrorEvent``, ``Reconnected`` and
        ``AudioDropped``; filter with ``isinstance(event, Transcript)`` for text only.
        """
        from .._streaming import transcribe_stream_sync

        extra = {"reconnect": reconnect} if reconnect is not None else {}
        return transcribe_stream_sync(
            self._client._stream_options(asynchronous=False),
            source,
            sample_rate=sample_rate,
            language=language,
            terminology=terminology,
            segment_seconds=segment_seconds,
            realtime=realtime,
            encoding=encoding,
            wait_for_slot=wait_for_slot,
            **extra,
        )

    def transcribe(
        self,
        file: FileInput,
        *,
        language: Language,
        numbers_as_digits: bool | None = None,
        identify_speakers: bool | None = None,
        terminology: TerminologyInput | None = None,
        **options: Unpack[RequestOptions],
    ) -> SttResult:
        """Transcribe an audio file and wait for the result.

        ``file`` is a path, bytes, a binary file object or ``(filename, content[, content_type])``.
        """
        spec = RequestSpec(
            ops.STT_TRANSCRIBE,
            form=_form(language, numbers_as_digits, identify_speakers, terminology),
            file=prepare_file(file),
            options=options,
        )
        return self._client._request(spec, model_parser(SttResult))


# --- Async --------------------------------------------------------------------------------------


class AsyncSttJobs(AsyncResource):
    async def create(
        self,
        file: FileInput,
        *,
        language: Language,
        numbers_as_digits: bool | None = None,
        identify_speakers: bool | None = None,
        terminology: TerminologyInput | None = None,
        **options: Unpack[RequestOptions],
    ) -> JobInitiated:
        """Upload audio for an async transcription job. Get the result with ``wait()`` or a webhook."""
        spec = RequestSpec(
            ops.STT_JOBS_CREATE,
            form=_form(language, numbers_as_digits, identify_speakers, terminology),
            file=prepare_file(file),
            options=options,
        )
        return await self._client._request(spec, model_parser(JobInitiated))

    async def get(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> SttJob:
        spec = RequestSpec(ops.STT_JOBS_GET, path_params={"jobId": job_id_of(job_id)}, options=options)
        return await self._client._request(spec, model_parser(SttJob))

    def list(
        self, *, offset: int | None = None, limit: int | None = None, **options: Unpack[RequestOptions]
    ) -> AsyncPageRequest[SttJob]:
        """List jobs, newest first. ``await`` for one page, or ``async for`` over all of them."""

        def parse(response: ApiResponse) -> AsyncPage[SttJob]:
            items, total, raw = page_data(response, SttJob)
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
        spec = RequestSpec(ops.STT_JOBS_LIST, query=query, options=options)
        return AsyncPageRequest(lambda: self._client._request(spec, parse))

    async def delete(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> DeleteResult:
        """Delete a finished job and its audio."""
        spec = RequestSpec(ops.STT_JOBS_DELETE, path_params={"jobId": job_id_of(job_id)}, options=options)
        return await self._client._request(spec, parse_delete)

    async def wait(
        self,
        job_id: JobRef,
        *,
        poll_interval: float | None = None,
        timeout: float = DEFAULT_WAIT_TIMEOUT,
        raise_on_failure: bool = True,
    ) -> SttJob:
        """Poll until the job completes or fails (every 5 s by default).

        Raises ``JobFailedError`` for a failed job unless ``raise_on_failure=False``,
        and ``JobWaitTimeoutError`` after ``timeout`` seconds.
        """
        job_id = job_id_of(job_id)
        flow = wait_flow(
            job_id=job_id,
            get=lambda: self.get(job_id),
            interval=check_interval(poll_interval, STT_POLL_INTERVAL),
            timeout=timeout,
            raise_on_failure=raise_on_failure,
            limiter=self._client._limits.limiter,
            bucket=ops.STT_JOBS_GET.name,
            runtime=self._client._runtime,
        )
        result: SttJob = await self._client._run(flow)
        return result

    @overload
    async def export(
        self,
        job_id: JobRef,
        *,
        format: Literal["txt", "srt"],
        lang: Literal["en", "ar"] | None = None,
        **options: Unpack[RequestOptions],
    ) -> str: ...
    @overload
    async def export(
        self,
        job_id: JobRef,
        *,
        format: Literal["json"],
        lang: Literal["en", "ar"] | None = None,
        **options: Unpack[RequestOptions],
    ) -> TranscriptExport: ...
    async def export(
        self,
        job_id: JobRef,
        *,
        format: ExportFormat,
        lang: Literal["en", "ar"] | None = None,
        **options: Unpack[RequestOptions],
    ) -> str | TranscriptExport:
        """Export a completed transcript: ``txt`` or ``srt`` as text, ``json`` as a ``TranscriptExport``.

        ``lang`` sets the language of the speaker labels.
        """
        spec = RequestSpec(
            ops.STT_JOBS_EXPORT,
            path_params={"jobId": job_id_of(job_id)},
            query=compact(format=format, lang=lang),
            options=options,
        )
        result: str | TranscriptExport = await self._client._request(spec, _export_parser(format))
        return result

    async def find_candidates(self, sent_at: datetime) -> builtins.list[SttJob]:
        """Jobs that may have come from a request whose response was lost.

        Lists jobs created from ``sent_at`` minus 5 s. It never picks one for you:
        concurrent uploads appear too, so check before you act.
        """
        flow = candidates_flow(list_page=lambda offset: self.list(offset=offset, limit=100), sent_at=sent_at)
        found: builtins.list[SttJob] = await self._client._run(flow)
        return found


class AsyncSpeechToText(AsyncResource):
    def __init__(self, client: AsyncEchoNova) -> None:
        super().__init__(client)
        self.jobs = AsyncSttJobs(client)

    def connect(
        self,
        *,
        sample_rate: int,
        language: str,
        terminology: Terminology | None = None,
        encoding: str = "pcm_s16le",
        wait_for_slot: float | None = None,
    ) -> AsyncConnecting[AsyncSttSession]:
        """Open a live Speech to Text session: ``async with client.speech_to_text.connect(...) as stt``.

        Ready once the session has started (and ``terminology`` is confirmed, when
        given). Sessions never reconnect on their own.
        """
        from .._streaming import connect_stt

        return connect_stt(
            self._client._stream_options(asynchronous=True),
            sample_rate=sample_rate,
            language=language,
            terminology=terminology,
            encoding=encoding,
            wait_for_slot=wait_for_slot,
        )

    def transcribe_stream(
        self,
        source: AsyncIterable[bytes] | Iterable[bytes] | bytes,
        *,
        sample_rate: int,
        language: str,
        terminology: Terminology | None = None,
        segment_seconds: float = 14.0,
        reconnect: ReconnectPolicy | None = None,
        realtime: bool = False,
        encoding: str = "pcm_s16le",
        wait_for_slot: float | None = None,
    ) -> AsyncIterator[TranscribeEvent]:
        """Transcribe a PCM16LE source, rolling over to new sessions past the session limit.

        Yields ``Transcript`` events plus ``StreamErrorEvent``, ``Reconnected`` and
        ``AudioDropped``; filter with ``isinstance(event, Transcript)`` for text only.
        A blocking iterable is read on the event loop: use the sync client for those.
        """
        from .._streaming import transcribe_stream

        extra = {"reconnect": reconnect} if reconnect is not None else {}
        return transcribe_stream(
            self._client._stream_options(asynchronous=True),
            source,
            sample_rate=sample_rate,
            language=language,
            terminology=terminology,
            segment_seconds=segment_seconds,
            realtime=realtime,
            encoding=encoding,
            wait_for_slot=wait_for_slot,
            **extra,
        )

    async def transcribe(
        self,
        file: FileInput,
        *,
        language: Language,
        numbers_as_digits: bool | None = None,
        identify_speakers: bool | None = None,
        terminology: TerminologyInput | None = None,
        **options: Unpack[RequestOptions],
    ) -> SttResult:
        """Transcribe an audio file and wait for the result.

        ``file`` is a path, bytes, a binary file object or ``(filename, content[, content_type])``.
        """
        spec = RequestSpec(
            ops.STT_TRANSCRIBE,
            form=_form(language, numbers_as_digits, identify_speakers, terminology),
            file=prepare_file(file),
            options=options,
        )
        return await self._client._request(spec, model_parser(SttResult))


# --- Raw responses ------------------------------------------------------------------------------


class SttJobsWithRawResponse:
    def __init__(self, jobs: SttJobs) -> None:
        self.create = to_raw_response_wrapper(jobs.create)
        self.get = to_raw_response_wrapper(jobs.get)
        self.list = to_raw_response_wrapper(jobs.list)
        self.delete = to_raw_response_wrapper(jobs.delete)
        self.export = to_raw_response_wrapper(jobs.export)


class SpeechToTextWithRawResponse:
    def __init__(self, stt: SpeechToText) -> None:
        self.transcribe = to_raw_response_wrapper(stt.transcribe)
        self.jobs = SttJobsWithRawResponse(stt.jobs)


class AsyncSttJobsWithRawResponse:
    def __init__(self, jobs: AsyncSttJobs) -> None:
        self.create = async_to_raw_response_wrapper(jobs.create)
        self.get = async_to_raw_response_wrapper(jobs.get)
        self.list = async_to_raw_response_wrapper(jobs.list)
        self.delete = async_to_raw_response_wrapper(jobs.delete)
        self.export = async_to_raw_response_wrapper(jobs.export)


class AsyncSpeechToTextWithRawResponse:
    def __init__(self, stt: AsyncSpeechToText) -> None:
        self.transcribe = async_to_raw_response_wrapper(stt.transcribe)
        self.jobs = AsyncSttJobsWithRawResponse(stt.jobs)
