/** Sound Cleaning: `clean` (synchronous) and the jobs it leaves behind. */

import { JobFailedError, UsageError } from '../errors.js';
import type { APIPromise } from '../core/api-promise.js';
import type { DownloadOptions } from '../core/download.js';
import { prepareUpload } from '../core/files.js';
import { OPS } from '../core/operations.js';
import type { PagePromise } from '../core/pagination.js';
import type { CleanJob, DeleteResult } from '../types/models.js';
import type { CleanParams, ListParams, RequestOptions } from '../types/params.js';
import { APIResource, model, parseDelete, type ClientContext, type JobRef } from './resource.js';

/** The form fields, camelCase as the API names them. */
const OPTION_NAMES = [
  'cutoffFreq',
  'qFactor',
  'targetLufs',
  'truePeakDbfs',
  'compThreshDb',
  'compRatio',
  'compAttackMs',
  'compReleaseMs',
  'sampleRate',
  'bitDepth',
] as const;

const parseJob = model<CleanJob>('CleanJob', ['id', 'status']);

export class CleanJobs extends APIResource {
  /** Get a job, with a freshly signed `outputUrl`. */
  get(job: JobRef, options?: RequestOptions): APIPromise<CleanJob> {
    return this._request(OPS.cleanJobsGet, { path: { jobId: job }, parse: parseJob }, options);
  }

  /** List jobs, newest first. `await` it for one page, or `for await` over it to walk every page. */
  list(params?: ListParams, options?: RequestOptions): PagePromise<CleanJob> {
    return this._list(OPS.cleanJobsList, parseJob, params, options);
  }

  /** Delete a job with its original and cleaned audio. */
  delete(job: JobRef, options?: RequestOptions): APIPromise<DeleteResult> {
    return this._request(OPS.cleanJobsDelete, { path: { jobId: job }, parse: parseDelete }, options);
  }

  /** Get the job for a fresh link, then download the cleaned WAV: to a file with `to`, else as bytes. */
  download(job: JobRef, options: DownloadOptions & { to: string }): Promise<string>;
  download(job: JobRef, options?: DownloadOptions): Promise<Uint8Array>;
  async download(job: JobRef, options: DownloadOptions = {}): Promise<Uint8Array | string> {
    const fresh = await this.get(job, { signal: options.signal });
    if (fresh.status === 'failed') throw new JobFailedError(`job ${fresh.id} failed: ${fresh.error || 'no error message'}`, { job: fresh });
    if (!fresh.outputUrl) throw new UsageError(`job ${fresh.id} has no cleaned audio (status ${fresh.status})`);
    return this._client.download(fresh.outputUrl, options);
  }
}

export class SoundCleaning extends APIResource {
  readonly jobs: CleanJobs;

  constructor(client: ClientContext) {
    super(client);
    this.jobs = new CleanJobs(client);
  }

  /** Clean an audio file and wait for the result. `outputUrl` links to the cleaned WAV. */
  clean(params: CleanParams, options?: RequestOptions): APIPromise<CleanJob> {
    const fields: Array<[string, string]> = [];
    for (const name of OPTION_NAMES) {
      const value = params[name];
      if (value != null) fields.push([name, String(value)]);
    }
    return this._request(OPS.clean, { upload: () => prepareUpload(params.file, fields), parse: parseJob }, options);
  }
}
