/** Speech to Text over REST: `transcribe`, async jobs and transcript export. */

import type { APIPromise } from '../core/api-promise.js';
import { MalformedEnvelopeError } from '../core/envelope.js';
import { prepareUpload } from '../core/files.js';
import { OPS } from '../core/operations.js';
import type { PagePromise } from '../core/pagination.js';
import { findCandidates, STT_POLL_INTERVAL_MS, waitForJob, type WaitOptions } from '../core/polling.js';
import type { DeleteResult, JobInitiated, SttJob, SttResult, TranscriptExport } from '../types/models.js';
import type {
  ExportFormat,
  ExportParams,
  ListParams,
  RequestOptions,
  SyncRequestOptions,
  TranscribeParams,
} from '../types/params.js';
import type {
  AudioSource,
  ConnectSttOptions,
  SttSession,
  TranscribeEvent,
  TranscribeStreamOptions,
} from '../streaming/index.js';
import { APIResource, jobIdOf, model, parseDelete, type ClientContext, type JobRef, type SyncJob } from './resource.js';

/** Multipart fields. Their names are snake_case, and `terminology` travels as a JSON string. A field left out is not sent. */
function fields(p: TranscribeParams): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (p.language != null) out.push(['language', p.language]);
  if (p.numbersAsDigits != null) out.push(['numbers_as_digits', String(p.numbersAsDigits)]);
  if (p.identifySpeakers != null) out.push(['identify_speakers', String(p.identifySpeakers)]);
  if (p.terminology != null) {
    out.push(['terminology', typeof p.terminology === 'string' ? p.terminology : JSON.stringify(p.terminology)]);
  }
  return out;
}

const parseJob = model<SttJob>('SttJob', ['id', 'status']);
const parseExport = model<TranscriptExport>('TranscriptExport');

/** After a `202 Processing`, `transcribe()` polls the job every 5 s and returns it as an `SttResult`. */
const TRANSCRIBE_JOB: SyncJob<SttJob> = { get: OPS.sttJobsGet, parseJob, interval: STT_POLL_INTERVAL_MS };
const decoder = new TextDecoder();

export class SttJobs extends APIResource {
  /** Upload audio for an async transcription job. Get the result with `wait()` or a webhook. */
  create(params: TranscribeParams, options?: RequestOptions): APIPromise<JobInitiated> {
    return this._request(
      OPS.sttJobsCreate,
      { upload: () => prepareUpload(params.file, fields(params)), parse: model<JobInitiated>('JobInitiated', ['jobId', 'status']) },
      options,
    );
  }

  get(job: JobRef, options?: RequestOptions): APIPromise<SttJob> {
    return this._request(OPS.sttJobsGet, { path: { jobId: job }, parse: parseJob }, options);
  }

  /** List jobs, newest first. `await` it for one page, or `for await` over it to walk every page. */
  list(params?: ListParams, options?: RequestOptions): PagePromise<SttJob> {
    return this._list(OPS.sttJobsList, parseJob, params, options);
  }

  /** Delete a finished job and its audio. */
  delete(job: JobRef, options?: RequestOptions): APIPromise<DeleteResult> {
    return this._request(OPS.sttJobsDelete, { path: { jobId: job }, parse: parseDelete }, options);
  }

  /**
   * Poll until the job completes or fails (every 5 s by default, for up to 20 minutes).
   * Throws `JobFailedError` for a failed job unless `raiseOnFailure` is false, and
   * `JobWaitTimeoutError` when it gives up; calling it again is safe.
   */
  async wait(job: JobRef, options: WaitOptions = {}): Promise<SttJob> {
    const jobId = jobIdOf(job);
    return waitForJob({
      jobId,
      get: (signal) => this.get(jobId, { signal }),
      defaultInterval: STT_POLL_INTERVAL_MS,
      options,
      limiter: this._client.limiter,
      bucket: OPS.sttJobsGet.name,
      runtime: this._client.runtime,
      logger: this._client.logger,
    });
  }

  /**
   * Export a completed transcript: `txt` or `srt` as text, `json` as a `TranscriptExport`.
   * `lang` sets the language of the speaker labels.
   */
  export(job: JobRef, params: ExportParams<'txt' | 'srt'>, options?: RequestOptions): APIPromise<string>;
  export(job: JobRef, params: ExportParams<'json'>, options?: RequestOptions): APIPromise<TranscriptExport>;
  export(job: JobRef, params: ExportParams<ExportFormat>, options?: RequestOptions): APIPromise<string | TranscriptExport>;
  export(job: JobRef, params: ExportParams, options?: RequestOptions): APIPromise<string | TranscriptExport> {
    return this._request(
      OPS.sttJobsExport,
      {
        path: { jobId: job },
        query: { format: params.format, lang: params.lang },
        bytes: true,
        parse: (data, meta) => {
          const text = decoder.decode(data as Uint8Array);
          if (params.format !== 'json') return text;
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new MalformedEnvelopeError('the JSON export is not valid JSON');
          }
          return parseExport(parsed, meta);
        },
      },
      options,
    );
  }

  /**
   * Jobs that may have come from an upload whose response was lost: jobs created
   * from `sentAt` minus 5 s. It never picks one for you: concurrent uploads appear too.
   */
  async findCandidates(sentAt: Date | string | number): Promise<SttJob[]> {
    return findCandidates({ listPage: (offset) => this.list({ offset, limit: 100 }), sentAt });
  }
}

export class SpeechToText extends APIResource {
  readonly jobs: SttJobs;

  constructor(client: ClientContext) {
    super(client);
    this.jobs = new SttJobs(client);
  }

  /**
   * Open a live Speech to Text session for PCM16LE mono audio. Resolves once the
   * session has started (and `terminology` is confirmed). Sessions never
   * reconnect on their own. Streaming code is loaded on first use.
   */
  async connect(init: ConnectSttOptions): Promise<SttSession> {
    const streaming = await import('../streaming/index.js');
    return streaming.connectStt(this._client.streamOptions(), init);
  }

  /**
   * Transcribe a PCM16LE source, rolling over to new sessions past the session
   * limit. Yields `Transcript` events plus `StreamErrorEvent`, `Reconnected`,
   * `AudioDropped` and `SessionSaved`. Argument errors surface on the first `next()`.
   */
  async *transcribeStream(source: AudioSource, init: TranscribeStreamOptions): AsyncGenerator<TranscribeEvent> {
    const streaming = await import('../streaming/index.js');
    yield* streaming.transcribeStream(this._client.streamOptions(), source, init);
  }

  /**
   * Transcribe an audio file and wait for the result. Without `language`, the API
   * detects Arabic or English (`auto`).
   *
   * Every attempt sends the same `Idempotency-Key` (pass `idempotencyKey` to choose it),
   * so retries never transcribe twice. If the job is still running after 220 s, the
   * SDK polls it every 5 s, for up to `waitTimeout`, instead of uploading again.
   */
  transcribe(params: TranscribeParams, options?: SyncRequestOptions): APIPromise<SttResult> {
    return this._sync<SttResult, SttJob>(
      OPS.sttTranscribe,
      { upload: () => prepareUpload(params.file, fields(params)), parse: model<SttResult>('SttResult', ['jobId', 'status']) },
      TRANSCRIBE_JOB,
      options,
    );
  }
}
