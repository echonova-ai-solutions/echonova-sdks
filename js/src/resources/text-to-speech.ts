/** Text to Speech over REST: `generate`, voices and async jobs. */

import { JobFailedError, UsageError } from '../errors.js';
import type { APIPromise } from '../core/api-promise.js';
import type { DownloadOptions } from '../core/download.js';
import { OPS } from '../core/operations.js';
import type { PagePromise } from '../core/pagination.js';
import { findCandidates, TTS_POLL_INTERVAL_MS, waitForJob, type WaitOptions } from '../core/polling.js';
import type { DeleteResult, JobInitiated, TtsJob, TtsResult, Voice, VoiceList } from '../types/models.js';
import type { ListParams, RequestOptions, SpeechParams, SyncRequestOptions } from '../types/params.js';
import type { Audio, ConnectTtsOptions, SpeakOptions, TtsSession } from '../streaming/index.js';
import {
  APIResource,
  compact,
  itemsOf,
  jobIdOf,
  model,
  parseDelete,
  type ClientContext,
  type JobRef,
  type SyncJob,
} from './resource.js';

const speechBody = (p: SpeechParams) => ({
  text: p.text,
  voiceId: p.voiceId,
  ...compact({ speed: p.speed, cfg: p.cfg, numSteps: p.numSteps, tashkeel: p.tashkeel, normalize: p.normalize }),
});

const parseJob = model<TtsJob>('TtsJob', ['id', 'status']);
const parseVoice = model<Voice>('Voice', ['id'], false);

/** After a `202 Processing`, `generate()` polls the job every 3 s and returns it as a `TtsResult`. */
const GENERATE_JOB: SyncJob<TtsJob> = { get: OPS.ttsJobsGet, parseJob, interval: TTS_POLL_INTERVAL_MS };

export class Voices extends APIResource {
  /** Every voice you can use. The list changes rarely: cache it. */
  list(options?: RequestOptions): APIPromise<VoiceList> {
    return this._request(
      OPS.ttsVoicesList,
      {
        parse: (data, meta) => {
          const { items } = itemsOf(data, meta, parseVoice);
          const list = { ...(data as object), items, requestId: meta.requestId } as VoiceList;
          Object.defineProperty(list, Symbol.iterator, { value: () => items[Symbol.iterator]() });
          return list;
        },
      },
      options,
    );
  }
}

export class TtsJobs extends APIResource {
  /** Start an async synthesis job. Get the result with `wait()` or a `job.completed` webhook. */
  create(params: SpeechParams, options?: RequestOptions): APIPromise<JobInitiated> {
    return this._request(
      OPS.ttsJobsCreate,
      { json: speechBody(params), parse: model<JobInitiated>('JobInitiated', ['jobId', 'status']) },
      options,
    );
  }

  /** Get a job, with a freshly signed `audioUrl` once it has completed. */
  get(job: JobRef, options?: RequestOptions): APIPromise<TtsJob> {
    return this._request(OPS.ttsJobsGet, { path: { jobId: job }, parse: parseJob }, options);
  }

  /** List jobs, newest first. `await` it for one page, or `for await` over it to walk every page. */
  list(params?: ListParams, options?: RequestOptions): PagePromise<TtsJob> {
    return this._list(OPS.ttsJobsList, parseJob, params, options);
  }

  /** Delete a finished job and its audio. */
  delete(job: JobRef, options?: RequestOptions): APIPromise<DeleteResult> {
    return this._request(OPS.ttsJobsDelete, { path: { jobId: job }, parse: parseDelete }, options);
  }

  /**
   * Poll until the job completes or fails (every 3 s by default, for up to 20 minutes).
   * Throws `JobFailedError` for a failed job unless `raiseOnFailure` is false, and
   * `JobWaitTimeoutError` when it gives up; calling it again is safe.
   */
  async wait(job: JobRef, options: WaitOptions = {}): Promise<TtsJob> {
    const jobId = jobIdOf(job);
    return waitForJob({
      jobId,
      get: (signal) => this.get(jobId, { signal }),
      defaultInterval: TTS_POLL_INTERVAL_MS,
      options,
      limiter: this._client.limiter,
      bucket: OPS.ttsJobsGet.name,
      runtime: this._client.runtime,
      logger: this._client.logger,
    });
  }

  /** Get the job for a fresh link, then download its WAV audio: to a file with `to`, else as bytes. */
  download(job: JobRef, options: DownloadOptions & { to: string }): Promise<string>;
  download(job: JobRef, options?: DownloadOptions): Promise<Uint8Array>;
  async download(job: JobRef, options: DownloadOptions = {}): Promise<Uint8Array | string> {
    const fresh = await this.get(job, { signal: options.signal });
    if (fresh.status === 'failed') throw new JobFailedError(`job ${fresh.id} failed: ${fresh.error || 'no error message'}`, { job: fresh });
    if (!fresh.audioUrl) throw new UsageError(`job ${fresh.id} has no audio yet (status ${fresh.status}); call wait() first`);
    return this._client.download(fresh.audioUrl, options);
  }

  /**
   * Jobs that may have come from a request whose response was lost: jobs created
   * from `sentAt` minus 5 s, optionally with the same `text`. It never picks one
   * for you, because other requests can match too.
   */
  async findCandidates(sentAt: Date | string | number, options: { text?: string | undefined } = {}): Promise<TtsJob[]> {
    return findCandidates({ listPage: (offset) => this.list({ offset, limit: 100 }), sentAt, text: options.text });
  }
}

export class TextToSpeech extends APIResource {
  readonly voices: Voices;
  readonly jobs: TtsJobs;

  constructor(client: ClientContext) {
    super(client);
    this.voices = new Voices(client);
    this.jobs = new TtsJobs(client);
  }

  /**
   * Open a streaming Text to Speech session: `await using tts = await client.textToSpeech.connect({ voiceId })`.
   * The options apply to every synthesis on it. Streaming code is loaded on first use.
   */
  async connect(init: ConnectTtsOptions): Promise<TtsSession> {
    const streaming = await import('../streaming/index.js');
    return streaming.connectTts(this._client.streamOptions(), init);
  }

  /** Synthesize `text` over a stream of its own and return the PCM audio (lower latency than `generate`). */
  async speak(text: string, init: SpeakOptions): Promise<Audio> {
    const streaming = await import('../streaming/index.js');
    return streaming.speak(this._client.streamOptions(), text, init);
  }

  /**
   * Synthesize speech and wait for it. `audioUrl` is a signed WAV link that expires.
   *
   * Every attempt sends the same `Idempotency-Key` (pass `idempotencyKey` to choose it),
   * so retries never synthesize twice. If the job is still running after 220 s, the
   * SDK polls it every 3 s, for up to `waitTimeout`.
   */
  generate(params: SpeechParams, options?: SyncRequestOptions): APIPromise<TtsResult> {
    return this._sync<TtsResult, TtsJob>(
      OPS.ttsGenerate,
      { json: speechBody(params), parse: model<TtsResult>('TtsResult', ['jobId', 'status']) },
      GENERATE_JOB,
      options,
    );
  }
}
