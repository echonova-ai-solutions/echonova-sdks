/**
 * Base class and shared helpers for the service namespaces.
 *
 * A resource builds requests and parses results; it never calls `fetch`
 * itself. Retries, rate limits, timeouts and error mapping all happen in the
 * transport, so every operation behaves the same way.
 */

import { UsageError } from '../errors.js';
import { APIPromise } from '../core/api-promise.js';
import type { DownloadOptions } from '../core/download.js';
import { MalformedEnvelopeError } from '../core/envelope.js';
import type { PreparedUpload } from '../core/files.js';
import type { APIResponse, HttpTransport, ResponseMeta } from '../core/http.js';
import type { Logger } from '../core/logger.js';
import { attemptTimeout, buildPath, type Operation } from '../core/operations.js';
import { Page, PagePromise } from '../core/pagination.js';
import type { PollLimiter } from '../core/polling.js';
import type { Runtime } from '../core/runtime.js';
import type { DeleteResult } from '../types/models.js';
import type { ListParams, RequestOptions } from '../types/params.js';

/** What a resource needs from its client. Internal. */
export interface ClientContext {
  transport: HttpTransport;
  limiter: PollLimiter;
  runtime: Runtime;
  logger: Logger;
  download(url: string | null | undefined, options?: DownloadOptions): Promise<Uint8Array | string>;
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

  protected async _send<T>(operation: Operation, call: Call<T>, options: RequestOptions = {}): Promise<APIResponse<T>> {
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
    });
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
