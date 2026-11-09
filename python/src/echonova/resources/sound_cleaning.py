"""Sound Cleaning: ``clean`` (synchronous) and the jobs it leaves behind."""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, overload

from typing_extensions import Unpack

from .. import _operations as ops
from .._base_client import RequestSpec, job_id_of
from .._core._files import FileInput, form_value, prepare_file
from .._pagination import AsyncPage, AsyncPageRequest, Page
from .._response import ApiResponse, async_to_raw_response_wrapper, to_raw_response_wrapper
from ..errors import JobFailedError, UsageError
from ..types.models import CleanJob, DeleteResult
from ..types.params import RequestOptions
from ._base import AsyncResource, JobRef, SyncResource, compact, model_parser, page_data, parse_delete

if TYPE_CHECKING:
    from .._client import AsyncEchoNova, EchoNova

__all__ = ["AsyncCleanJobs", "AsyncSoundCleaning", "CleanJobs", "SoundCleaning"]


def _form(**options: Any) -> dict[str, str]:
    """Multipart fields, camelCase as the API names them. Only the options the caller set are sent."""
    names = {
        "cutoff_freq": "cutoffFreq",
        "q_factor": "qFactor",
        "target_lufs": "targetLufs",
        "true_peak_dbfs": "truePeakDbfs",
        "comp_thresh_db": "compThreshDb",
        "comp_ratio": "compRatio",
        "comp_attack_ms": "compAttackMs",
        "comp_release_ms": "compReleaseMs",
        "sample_rate": "sampleRate",
        "bit_depth": "bitDepth",
    }
    return {names[key]: form_value(value) for key, value in options.items() if value is not None}


def _output_url(job: CleanJob) -> str:
    if job.status == "failed":
        raise JobFailedError(f"job {job.id} failed: {job.error or 'no error message'}", job=job)
    if not job.output_url:
        raise UsageError(f"job {job.id} has no cleaned audio (status {job.status})")
    return job.output_url


# --- Sync ---------------------------------------------------------------------------------------


class CleanJobs(SyncResource):
    def get(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> CleanJob:
        """Get a job, with a freshly signed ``output_url``."""
        spec = RequestSpec(ops.CLEAN_JOBS_GET, path_params={"jobId": job_id_of(job_id)}, options=options)
        return self._client._request(spec, model_parser(CleanJob))

    def list(
        self, *, offset: int | None = None, limit: int | None = None, **options: Unpack[RequestOptions]
    ) -> Page[CleanJob]:
        """List jobs, newest first. Iterating the page continues through the next pages."""

        def parse(response: ApiResponse) -> Page[CleanJob]:
            items, total, raw = page_data(response, CleanJob)
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
        return self._client._request(RequestSpec(ops.CLEAN_JOBS_LIST, query=query, options=options), parse)

    def delete(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> DeleteResult:
        """Delete a job with its original and cleaned audio."""
        spec = RequestSpec(ops.CLEAN_JOBS_DELETE, path_params={"jobId": job_id_of(job_id)}, options=options)
        return self._client._request(spec, parse_delete)

    @overload
    def download(self, job_id: JobRef, to: None = None) -> bytes: ...
    @overload
    def download(self, job_id: JobRef, to: str | os.PathLike[str]) -> Path: ...
    def download(self, job_id: JobRef, to: str | os.PathLike[str] | None = None) -> bytes | Path:
        """Get the job for a fresh link, then download the cleaned WAV (to a file, or as bytes)."""
        url = _output_url(self.get(job_id))
        return self._client.download(url, to=to)


class SoundCleaning(SyncResource):
    def __init__(self, client: EchoNova) -> None:
        super().__init__(client)
        self.jobs = CleanJobs(client)

    def clean(
        self,
        file: FileInput,
        *,
        cutoff_freq: float | None = None,
        q_factor: float | None = None,
        target_lufs: float | None = None,
        true_peak_dbfs: float | None = None,
        comp_thresh_db: float | None = None,
        comp_ratio: float | None = None,
        comp_attack_ms: float | None = None,
        comp_release_ms: float | None = None,
        sample_rate: int | None = None,
        bit_depth: int | None = None,
        **options: Unpack[RequestOptions],
    ) -> CleanJob:
        """Clean an audio file and wait for the result. ``output_url`` links to the cleaned WAV."""
        form = _form(
            cutoff_freq=cutoff_freq,
            q_factor=q_factor,
            target_lufs=target_lufs,
            true_peak_dbfs=true_peak_dbfs,
            comp_thresh_db=comp_thresh_db,
            comp_ratio=comp_ratio,
            comp_attack_ms=comp_attack_ms,
            comp_release_ms=comp_release_ms,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
        )
        spec = RequestSpec(ops.CLEAN, form=form, file=prepare_file(file), options=options)
        return self._client._request(spec, model_parser(CleanJob))


# --- Async --------------------------------------------------------------------------------------


class AsyncCleanJobs(AsyncResource):
    async def get(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> CleanJob:
        """Get a job, with a freshly signed ``output_url``."""
        spec = RequestSpec(ops.CLEAN_JOBS_GET, path_params={"jobId": job_id_of(job_id)}, options=options)
        return await self._client._request(spec, model_parser(CleanJob))

    def list(
        self, *, offset: int | None = None, limit: int | None = None, **options: Unpack[RequestOptions]
    ) -> AsyncPageRequest[CleanJob]:
        """List jobs, newest first. ``await`` for one page, or ``async for`` over all of them."""

        def parse(response: ApiResponse) -> AsyncPage[CleanJob]:
            items, total, raw = page_data(response, CleanJob)
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
        spec = RequestSpec(ops.CLEAN_JOBS_LIST, query=query, options=options)
        return AsyncPageRequest(lambda: self._client._request(spec, parse))

    async def delete(self, job_id: JobRef, **options: Unpack[RequestOptions]) -> DeleteResult:
        """Delete a job with its original and cleaned audio."""
        spec = RequestSpec(ops.CLEAN_JOBS_DELETE, path_params={"jobId": job_id_of(job_id)}, options=options)
        return await self._client._request(spec, parse_delete)

    @overload
    async def download(self, job_id: JobRef, to: None = None) -> bytes: ...
    @overload
    async def download(self, job_id: JobRef, to: str | os.PathLike[str]) -> Path: ...
    async def download(self, job_id: JobRef, to: str | os.PathLike[str] | None = None) -> bytes | Path:
        """Get the job for a fresh link, then download the cleaned WAV (to a file, or as bytes)."""
        url = _output_url(await self.get(job_id))
        return await self._client.download(url, to=to)


class AsyncSoundCleaning(AsyncResource):
    def __init__(self, client: AsyncEchoNova) -> None:
        super().__init__(client)
        self.jobs = AsyncCleanJobs(client)

    async def clean(
        self,
        file: FileInput,
        *,
        cutoff_freq: float | None = None,
        q_factor: float | None = None,
        target_lufs: float | None = None,
        true_peak_dbfs: float | None = None,
        comp_thresh_db: float | None = None,
        comp_ratio: float | None = None,
        comp_attack_ms: float | None = None,
        comp_release_ms: float | None = None,
        sample_rate: int | None = None,
        bit_depth: int | None = None,
        **options: Unpack[RequestOptions],
    ) -> CleanJob:
        """Clean an audio file and wait for the result. ``output_url`` links to the cleaned WAV."""
        form = _form(
            cutoff_freq=cutoff_freq,
            q_factor=q_factor,
            target_lufs=target_lufs,
            true_peak_dbfs=true_peak_dbfs,
            comp_thresh_db=comp_thresh_db,
            comp_ratio=comp_ratio,
            comp_attack_ms=comp_attack_ms,
            comp_release_ms=comp_release_ms,
            sample_rate=sample_rate,
            bit_depth=bit_depth,
        )
        spec = RequestSpec(ops.CLEAN, form=form, file=prepare_file(file), options=options)
        return await self._client._request(spec, model_parser(CleanJob))


# --- Raw responses ------------------------------------------------------------------------------


class CleanJobsWithRawResponse:
    def __init__(self, jobs: CleanJobs) -> None:
        self.get = to_raw_response_wrapper(jobs.get)
        self.list = to_raw_response_wrapper(jobs.list)
        self.delete = to_raw_response_wrapper(jobs.delete)


class SoundCleaningWithRawResponse:
    def __init__(self, cleaning: SoundCleaning) -> None:
        self.clean = to_raw_response_wrapper(cleaning.clean)
        self.jobs = CleanJobsWithRawResponse(cleaning.jobs)


class AsyncCleanJobsWithRawResponse:
    def __init__(self, jobs: AsyncCleanJobs) -> None:
        self.get = async_to_raw_response_wrapper(jobs.get)
        self.list = async_to_raw_response_wrapper(jobs.list)
        self.delete = async_to_raw_response_wrapper(jobs.delete)


class AsyncSoundCleaningWithRawResponse:
    def __init__(self, cleaning: AsyncSoundCleaning) -> None:
        self.clean = async_to_raw_response_wrapper(cleaning.clean)
        self.jobs = AsyncCleanJobsWithRawResponse(cleaning.jobs)
