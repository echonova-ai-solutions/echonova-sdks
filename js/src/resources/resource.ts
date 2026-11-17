/**
 * Base class and shared helpers for the service namespaces.
 *
 * A resource builds requests and parses results; it never calls `fetch`
 * itself. Retries, rate limits, timeouts and error mapping all happen in the
 * transport, so every operation behaves the same way.
 */

import { APIConnectionError, APIStatusError, UsageError } from '../errors.js';
import { APIPromise } from '../core/api-promise.js';
import type { DownloadOptions } from '../core/download.js';
import { MalformedEnvelopeError } from '../core/envelope.js';
import type { PreparedUpload } from '../core/files.js';
import type { APIResponse, HeaderValues, HttpTransport, RequestSpec, ResponseMeta } from '../core/http.js';
import type { Logger } from '../core/logger.js';
import { attemptTimeout, buildPath, type Operation } from '../core/operations.js';
import { Page, PagePromise } from '../core/pagination.js';
import { DEFAULT_WAIT_TIMEOUT_MS, WaitBudget, waitForJob, type PollLimiter } from '../core/polling.js';
import { randomId, type Runtime } from '../core/runtime.js';
import type { DeleteResult, SyncProcessing } from '../types/models.js';
import type { ListParams, RequestOptions, SyncRequestOptions } from '../types/params.js';
import type { StreamOptions } from '../streaming/options.js';

/** What a resource needs from its client. Internal. */
export interface ClientContext {
  transport: HttpTransport;
  limiter: PollLimiter;
  runtime: Runtime;
  logger: Logger;
  download(url: string | null | undefined, options?: DownloadOptions): Promise<Uint8Array | string>;
  /** Stream settings derived from the client (loaded lazily by the streaming methods). */
  streamOptions(): StreamOptions;
}

/** A job ID, or any job object: `JobInitiated`, `TtsJob`, `SttResult`, ... */
export type JobRef = string | { readonly id: string } | { readonly jobId: string };

export function jobIdOf(job: JobRef): string {
  const value =
    typeof job === 'string'
      ? job
      : ((job as { id?: unknown } | null)?.id ?? (job as { jobId?: unknown } | null)?.jobId);
  if (typeof value !== 'string' || !value.trim()) throw new UsageError('expected a job ID or a job object');
  return value.trim();
}

/**
 * Turn response data into a result: check the fields the SDK relies on, and add
 * `requestId`. Everything else is kept exactly as the API sent it.
 */
export function model<T>(what: string, required: readonly string[] = [], withRequestId = true) {
  return (data: unknown, meta: Pick<ResponseMeta, 'requestId'>): T => {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new MalformedEnvelopeError(`expected a JSON object for ${what}`);
    }
    for (const field of required) {
      if ((data as Record<string, unknown>)[field] == null) throw new MalformedEnvelopeError(`${what} is missing '${field}'`);
    }
    return (withRequestId ? { ...data, requestId: meta.requestId } : data) as T;
  };
}

export function itemsOf<T>(data: unknown, meta: ResponseMeta, item: (data: unknown, meta: ResponseMeta) => T) {
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new MalformedEnvelopeError('expected a list result with items and total');
  const total = (data as { total?: unknown }).total;
  return { items: items.map((value) => item(value, meta)), total: typeof total === 'number' ? total : null };
}

/** Only the values the caller set: the API treats a missing field as its default. */
export function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value != null));
}

/** A job, as the polls after a `202 Processing` answer read it. */
type PolledJob = { readonly id: string; readonly status?: string };

/**
 * How a synchronous call reads its job after a `202 Processing` answer (ADR 0014). Its result
 * is then the completed job's JSON plus `jobId`, typed as the result a `200` returns.
 */
export interface SyncJob<J extends PolledJob> {
  /** The job's `get` operation. Polls share the client's limiter with `jobs.wait()`. */
  get: Operation;
  parseJob: (data: unknown, meta: ResponseMeta) => J;
  /** Milliseconds between polls. */
  interval: number;
}

/** A `202 Processing` answer: the job is still running. */
class Processing {
  constructor(readonly jobId: string) {}
}

function parseProcessing(data: unknown): Processing {
  const jobId = (data as Partial<SyncProcessing> | null)?.jobId;
  if (typeof jobId !== 'string' || !jobId.trim()) throw new MalformedEnvelopeError("a 202 Processing answer is missing 'jobId'");
  return new Processing(jobId.trim());
}

/** Printable ASCII, no surrounding spaces: what a header carries unchanged. */
const KEY_PATTERN = /^[!-~](?:[ -~]*[!-~])?$/;

/** The call's key: the caller's (the option, else an `Idempotency-Key` header), or a new one. `null` when the header was removed. */
function idempotencyKeyOf(options: SyncRequestOptions): string | null {
  let key: unknown = options.idempotencyKey;
  if (key === undefined) {
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (name.toLowerCase() === 'idempotency-key' && value !== undefined) key = value;
    }
    if (key === undefined) return randomId();
    if (key === null) return null;
  }
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new UsageError('idempotencyKey must be a non-empty string of printable ASCII characters, without surrounding spaces');
  }
  return key;
}

/** The caller's extra headers without `Idempotency-Key`: what the polls after a 202 send. */
function withoutKey(headers: HeaderValues | undefined): HeaderValues | undefined {
  return headers && Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'idempotency-key'));
}

export interface Call<T> {
  /** Path parameters. `jobId` also accepts a job object. Checked when the call runs, so misuse rejects the promise. */
  path?: Record<string, string | JobRef>;
  query?: Record<string, string | number | boolean | null | undefined>;
  json?: unknown;
  upload?: () => Promise<PreparedUpload>;
  bytes?: boolean;
  parse: (data: unknown, meta: ResponseMeta) => T;
}

export abstract class APIResource {
  protected readonly _client: ClientContext;

  constructor(client: ClientContext) {
    this._client = client;
  }

  protected _request<T>(operation: Operation, call: Call<T>, options?: RequestOptions): APIPromise<T> {
    return new APIPromise(this._send(operation, call, options));
  }

  protected async _send<T>(
    operation: Operation,
    call: Call<T>,
    options: RequestOptions = {},
    sync: Pick<RequestSpec, 'idempotencyKey' | 'waitBudget'> = {},
  ): Promise<APIResponse<T>> {
    const path: Record<string, string> = {};
    for (const [name, value] of Object.entries(call.path ?? {})) {
      if (name === 'jobId') path[name] = jobIdOf(value);
      else if (typeof value !== 'string' || !value.trim()) throw new UsageError(`${name} must be a non-empty string`);
      else path[name] = value.trim();
    }
    const upload = call.upload ? await call.upload() : undefined;
    return this._client.transport.request<T>({
      method: operation.method,
      path: buildPath(operation.path, path),
      route: operation.path,
      bucket: operation.name,
      query: call.query,
      json: call.json,
      upload,
      responseType: call.bytes ? 'bytes' : 'envelope',
      parse: call.parse,
      sensitive: operation.sensitive,
      defaultTimeout: attemptTimeout(operation, upload?.size),
      signal: options.signal,
      timeout: options.timeout,
      maxRetries: options.maxRetries,
      deadline: options.deadline,
      headers: options.headers,
      ...sync,
    });
  }

  /**
   * A synchronous call that makes a job (ADR 0014). It sends an `Idempotency-Key`, the
   * same on every attempt, so the transport retries it like a request that can't run
   * twice, and waits out a first request with the key that is still running. When the
   * API answers `202 Processing`, it polls the job and returns what a `200` would have.
   * Errors from the call carry the key.
   */
  protected _sync<T, J extends PolledJob>(
    operation: Operation,
    call: Call<T>,
    job: SyncJob<J>,
    options: SyncRequestOptions = {},
  ): APIPromise<T> {
    return new APIPromise(this.#sendSync(operation, call, job, options));
  }

  async #sendSync<T, J extends PolledJob>(
    operation: Operation,
    call: Call<T>,
    job: SyncJob<J>,
    options: SyncRequestOptions,
  ): Promise<APIResponse<T>> {
    const { idempotencyKey: _, waitTimeout = DEFAULT_WAIT_TIMEOUT_MS, ...rest } = options;
    if (typeof waitTimeout !== 'number' || !(waitTimeout >= 0)) {
      throw new UsageError('waitTimeout must be a number of milliseconds, 0 or more');
    }
    const key = operation.idempotencyKey ? idempotencyKeyOf(options) : null;
    // One budget for both waits: resending while an in-progress 409 lasts (in the transport),
    // and polling the job after a 202. It starts at the first of them, within the deadline.
    const budget = new WaitBudget(waitTimeout);
    try {
      const parse = (data: unknown, meta: ResponseMeta): T | Processing =>
        meta.status === 202 ? parseProcessing(data) : call.parse(data, meta);
      const sent = { idempotencyKey: key ?? undefined, waitBudget: budget };
      const first = await this._send<T | Processing>(operation, { ...call, parse }, rest, sent);
      if (!(first.data instanceof Processing)) return first as APIResponse<T>;
      const now = this._client.runtime.clock() * 1000;
      const polls = { signal: rest.signal, headers: withoutKey(rest.headers) };
      return await this.#jobResult<T, J>(first.data.jobId, job, Math.max(0, budget.endsAt(now) - now), polls);
    } catch (error) {
      // Status and connection errors carry the key; JobFailedError and JobWaitTimeoutError carry the job.
      if (key !== null && (error instanceof APIStatusError || error instanceof APIConnectionError)) {
        (error as { idempotencyKey?: string }).idempotencyKey ??= key;
      }
      throw error;
    }
  }

  /** Poll the job of a `202 Processing` answer until it ends: the result is its JSON plus `jobId`. */
  async #jobResult<T, J extends PolledJob>(
    jobId: string,
    job: SyncJob<J>,
    timeoutMs: number,
    options: Pick<RequestOptions, 'signal' | 'headers'>,
  ): Promise<APIResponse<T>> {
    const { limiter, runtime, logger } = this._client;
    logger.info(`job ${jobId} is still processing; polling it for up to ${(timeoutMs / 1000).toFixed(0)} s`);
    let last: APIResponse<J> | undefined;
    const done = await waitForJob<J>({
      jobId,
      get: async (signal) => {
        last = await this._send(job.get, { path: { jobId }, parse: job.parseJob }, { ...options, signal });
        return last.data;
      },
      defaultInterval: job.interval,
      options: { timeoutMs, signal: options.signal },
      limiter,
      bucket: job.get.name,
      runtime,
      logger,
    });
    const response = last as APIResponse<J>; // the poll that returned `done`, so its request ID
    return { ...response, data: { ...done, jobId: done.id } as unknown as T };
  }

  /** One page of a job list; the page fetches the following ones with the same options. */
  protected _list<T extends { readonly id: string }>(
    operation: Operation,
    item: (data: unknown, meta: ResponseMeta) => T,
    params: ListParams = {},
    options?: RequestOptions,
  ): PagePromise<T> {
    const parse = (data: unknown, meta: ResponseMeta): Page<T> =>
      new Page({
        ...itemsOf(data, meta, item),
        offset: params.offset ?? 0,
        limit: params.limit ?? null,
        requestId: meta.requestId,
        fetch: (offset) => this._list(operation, item, { ...params, offset }, options),
      });
    return new PagePromise(this._send(operation, { query: { offset: params.offset, limit: params.limit }, parse }, options));
  }
}

export function parseDelete(data: unknown, meta: ResponseMeta): DeleteResult {
  return { ...model<DeleteResult>('DeleteResult')(data, meta), alreadyDeleted: meta.alreadyDeleted };
}
