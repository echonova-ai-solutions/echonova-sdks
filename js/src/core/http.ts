/**
 * HTTP transport over `fetch`, wired to the retry table, the rate-limit
 * tracker and the error classifier.
 *
 * Retry safety: a POST that may have run on the server is never sent again,
 * unless it carries an `Idempotency-Key` (ADR 0014). Fetch can't tell
 * "connection refused" apart from "sent but no answer" in every runtime, so any
 * failure the SDK can't positively identify as a connection failure is treated
 * as "sent, no response" (rule R3): GET and DELETE are retried, POST is not and
 * its error carries `mayHaveExecuted: true`.
 */

import {
  APIConnectionError,
  APITimeoutError,
  EchoNovaError,
  ProtocolError,
  RateLimitError,
  UsageError,
} from '../errors.js';
import { classifyResponse, buildStatusError, executedFlag } from './classifier.js';
import { header, headersToRecord, MalformedEnvelopeError, parseErrorBody, unwrapSuccess } from './envelope.js';
import type { Logger } from './logger.js';
import type { WaitBudget } from './polling.js';
import type { RateLimitInfo, RateLimitTracker } from './ratelimit.js';
import { RetryPolicy, type RetryDecision } from './retry.js';
import { POST_IDEMPOTENT, type Phase } from './rules.js';
import { defaultSleep } from './runtime.js';
import { isWorkerd } from '../runtime/detect.js';

export { defaultSleep } from './runtime.js';

/** The subset of `fetch` the SDK uses. Any WHATWG-compatible implementation works. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HeaderValues = Readonly<Record<string, string | null | undefined>>;

export type RequestBody = string | Uint8Array | ArrayBuffer | Blob | FormData | URLSearchParams | ReadableStream<Uint8Array>;

/** An upload body that can be opened once per attempt (a file reopened, bytes reused, a stream once). */
export interface UploadBody {
  /** A fresh body for one attempt, with its content type when `fetch` can't set it (a streamed multipart body). */
  open(): Promise<{ body: RequestBody; contentType?: string | undefined }>;
  /** Whether a failed attempt may be sent again: false once a one-shot stream has been read. */
  replayable(): boolean;
}

/** What the SDK passes to a parser and keeps for `withResponse()`. */
export interface ResponseMeta {
  status: number;
  headers: Headers;
  requestId: string | null;
  /** A DELETE whose first attempt got no response and whose retry got 404: the job was already deleted. */
  alreadyDeleted: boolean;
}

// `any` keeps a plain `RequestSpec` assignable to every `RequestSpec<T>`.
export interface RequestSpec<T = any> {
  method: 'GET' | 'POST' | 'DELETE' | (string & {});
  /** Path including the version prefix, e.g. `/v1/text-to-speech/voices`. */
  path: string;
  /** Rate-limit bucket: the API operation (the server counts per key per endpoint). */
  bucket: string;
  /** Route template for logs, e.g. `/v1/text-to-speech/jobs/{jobId}`. Defaults to `path`. */
  route?: string | undefined;
  query?: Readonly<Record<string, string | number | boolean | null | undefined>> | undefined;
  /** JSON body (serialized on every attempt). */
  json?: unknown;
  /** Any other body. A `ReadableStream` can't be replayed, so it is never retried once sent. */
  body?: RequestBody | undefined;
  /** Override replayability, e.g. `false` for a body that is consumed when read. */
  bodyReplayable?: boolean | undefined;
  /**
   * An audio upload. Sent with `redirect: 'error'`, so `fetch` never buffers it for a redirect;
   * Cloudflare Workers reject that mode, so there it is `'manual'` and a 3xx fails on its status.
   */
  upload?: UploadBody | undefined;
  headers?: HeaderValues | undefined;
  /**
   * The call's `Idempotency-Key`, for an operation that accepts one. It is sent on
   * every attempt, and an attempt that carried it is retried by the `POST_IDEMPOTENT`
   * column: the server runs the request at most once per key.
   */
  idempotencyKey?: string | undefined;
  /**
   * With `idempotencyKey`: the call's wait budget. While the API answers that the first
   * request with the key is still running (an in-progress 409), the request is sent again
   * every 5 s (or after `Retry-After` when longer) within it, outside `maxRetries`.
   */
  waitBudget?: WaitBudget | undefined;
  /** Per-call timeout in milliseconds (one attempt). */
  timeout?: number | undefined;
  /** The operation's default timeout in milliseconds, used when neither the call nor the client sets one. */
  defaultTimeout?: number | undefined;
  /** Total milliseconds for the call, retries and waits included. */
  deadline?: number | null | undefined;
  maxRetries?: number | undefined;
  signal?: AbortSignal | undefined;
  /** `envelope` (default): unwrap `data`. `bytes`: raw body (file downloads such as transcript export). */
  responseType?: 'envelope' | 'bytes' | undefined;
  /**
   * Turns the response data into the result. Runs inside the retry loop: a
   * `MalformedEnvelopeError` is handled like a malformed body (rule R4).
   */
  parse?: ((data: unknown, meta: ResponseMeta) => T) | undefined;
  /** The response holds a secret: never copy its body into an error. */
  sensitive?: boolean | undefined;
}

export interface APIResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  requestId: string | null;
  rateLimit: RateLimitInfo | null;
  /** Attempts made, including the successful one. */
  attempts: number;
  /** A DELETE whose first attempt got no response and whose retry got 404: the job was already deleted. */
  alreadyDeleted: boolean;
  /** The HTTP response. Its body has already been read. */
  response: Response;
}

export interface AuthContext {
  method: string;
  url: string;
}

/** One attempt of an API call, as passed to the `onRequest` and `onResponse` hooks. */
export interface RequestDetails {
  /** The SDK operation, e.g. `textToSpeech.jobs.get`. */
  operation: string;
  method: string;
  url: string;
  /** The headers about to be sent. A hook may add or change them. They include your credentials. */
  headers: Headers;
  /** 1 for the first attempt. */
  attempt: number;
  /** This attempt's deadline in milliseconds. */
  timeout: number;
}

export type OnRequestHook = (request: RequestDetails) => void | Promise<void>;
/** Called with each HTTP response from the API (not downloads), after the SDK has read its body. */
export type OnResponseHook = (response: Response, request: RequestDetails) => void | Promise<void>;

export interface TransportOptions {
  baseURL: string;
  fetch: FetchLike;
  /** Client-wide timeout in milliseconds, or null to use each operation's default. */
  timeout: number | null;
  maxRetries: number;
  defaultHeaders: HeaderValues;
  /** Headers that authenticate a request (API key and/or the `auth` hook). Called on every attempt. */
  authHeaders: (context: AuthContext) => Promise<HeaderValues> | HeaderValues;
  userAgent: string | null;
  logger: Logger;
  rateLimitPreflight: boolean;
  tracker: RateLimitTracker;
  policy: RetryPolicy;
  /** Client-wide total deadline per call, in milliseconds. */
  deadline?: number | null | undefined;
  onRequest?: OnRequestHook | undefined;
  onResponse?: OnResponseHook | undefined;
  /** Aborts in-flight requests and refuses new ones once the client is closed. */
  closeSignal?: AbortSignal | undefined;
  /** Waits `ms` milliseconds; rejects with the signal's reason if aborted. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Monotonic milliseconds, for elapsed time and deadlines. */
  now?: (() => number) | undefined;
  /** Wall-clock time, for `sentAt`. */
  date?: (() => Date) | undefined;
}

export const FALLBACK_TIMEOUT_MS = 60_000;
/** How often a request whose first attempt is still running is sent again (ADR 0014). */
export const IN_PROGRESS_RESEND_MS = 5000;

const PHASE_MESSAGES: Readonly<Record<Phase, string>> = {
  connect: 'Could not connect to {target}',
  send_incomplete: 'The connection failed while sending the request to {target}; it did not run',
  no_response: 'No response from {target} after the request was sent',
  malformed_success: 'Unexpected response body from {target}',
};

export function phaseMessage(phase: Phase, target: string): string {
  return PHASE_MESSAGES[phase].replace('{target}', target);
}

const method = (what: string): string => what.slice(0, what.indexOf(' '));

/** Error codes that mean the connection was never established, so no request byte was sent. */
const CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'ConnectionRefused', // Bun
  'FailedToOpenSocket', // Bun
]);
const TLS_ERROR_CODE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;
/** Deno's fetch errors have no `code`; DNS, TCP and TLS failures say "client error (Connect)". */
const DENO_CONNECT_ERROR = /\bclient error \(Connect\)/;

/** Classify a `fetch` rejection: `connect` only when it is certain nothing was sent. */
export function failurePhase(error: unknown): Phase {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && (CONNECT_ERROR_CODES.has(code) || TLS_ERROR_CODE.test(code))) return 'connect';
    if (typeof message === 'string' && DENO_CONNECT_ERROR.test(message)) return 'connect';
    current = (current as { cause?: unknown }).cause;
  }
  return 'no_response';
}

/** True when `fetch` refused to follow a redirect (`redirect: 'error'`). */
function isRedirectRefusal(error: unknown): boolean {
  const cause = (error as { cause?: { message?: unknown } } | null)?.cause;
  return typeof cause?.message === 'string' && /redirect/i.test(cause.message);
}

/** An SDK error raised while `fetch` read the request body (such as an upload stream that yielded text). */
function bodyError(error: unknown): EchoNovaError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if (current instanceof EchoNovaError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Settle with `promise`, or reject with the signal's reason as soon as it aborts,
 * even when a custom `fetch` or response body ignores the signal.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** One attempt's signal: aborts on the caller's signal, on client close, or when the attempt's deadline passes. */
export function attemptSignal(signals: ReadonlyArray<AbortSignal | undefined>, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** (Re)start the deadline: `ms` from now. */
  const arm = (ms: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(`request timed out after ${ms} ms`, 'TimeoutError'));
    }, ms);
  };
  arm(timeoutMs);
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      continue;
    }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    /** Restart the deadline, e.g. while a download is still receiving data. */
    reset: arm,
    done: () => {
      clearTimeout(timer);
      for (const remove of listeners) remove();
    },
  };
}

function isStream(body: unknown): body is ReadableStream {
  return typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** How much of an error response is read: enough for any real error message. */
const ERROR_BODY_LIMIT = 64 * 1024;

/**
 * Read at most `limit` bytes of a response body and cancel the rest, so a huge
 * or endless error body can't exhaust memory.
 */
async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer()).slice(0, limit);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, limit - size);
      chunks.push(part);
      size += part.length;
    }
  } finally {
    if (size >= limit) void reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export class HttpTransport {
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly timeout: number | null;
  /** The client-wide total deadline per call, in milliseconds. */
  readonly deadline: number | null;
  readonly tracker: RateLimitTracker;
  readonly policy: RetryPolicy;
  readonly #options: TransportOptions;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;
  readonly #date: () => Date;

  constructor(options: TransportOptions) {
    this.#options = options;
    this.baseURL = options.baseURL;
    this.maxRetries = options.maxRetries;
    this.timeout = options.timeout;
    this.deadline = options.deadline ?? null;
    this.tracker = options.tracker;
    this.policy = options.policy;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? (() => performance.now());
    this.#date = options.date ?? (() => new Date());
  }

  buildURL(path: string, query?: RequestSpec['query']): string {
    const url = `${this.baseURL}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.append(key, String(value));
    }
    const text = params.toString();
    return text ? `${url}?${text}` : url;
  }

  async #headers(spec: RequestSpec<unknown>, url: string): Promise<Headers> {
    const headers = new Headers();
    const apply = (values: HeaderValues | undefined): void => {
      if (!values) return;
      for (const [name, value] of Object.entries(values)) {
        if (value === null) headers.delete(name);
        else if (value !== undefined) headers.set(name, value);
      }
    };
    headers.set('Accept', spec.responseType === 'bytes' ? '*/*' : 'application/json');
    if (this.#options.userAgent) headers.set('User-Agent', this.#options.userAgent);
    apply(this.#options.defaultHeaders);
    apply(await this.#options.authHeaders({ method: spec.method.toUpperCase(), url }));
    if (spec.json !== undefined) headers.set('Content-Type', 'application/json');
    apply(spec.headers);
    if (spec.idempotencyKey !== undefined) headers.set('Idempotency-Key', spec.idempotencyKey);
    return headers;
  }

  /**
   * Wait while the bucket is blocked by a throttle 429 or its window is used up,
   * instead of sending a request that would only extend the block. A wait longer
   * than the policy's `maxRetryAfter` (or past the deadline) throws `RateLimitError` without sending.
   */
  async #waitForBucket(
    bucket: string,
    policy: RetryPolicy,
    firstSentAt: Date | null,
    signal: AbortSignal | undefined,
    deadlineAt: number | null,
  ): Promise<void> {
    for (;;) {
      const seconds = this.tracker.waitTime(bucket, { preflight: this.#options.rateLimitPreflight });
      if (seconds <= 0) return;
      if (seconds > policy.maxRetryAfter || (deadlineAt !== null && this.#now() + seconds * 1000 > deadlineAt)) {
        const sent = firstSentAt === null ? 'nothing was sent' : 'the request was not sent again';
        throw new RateLimitError({
          message: `the rate limit for ${bucket} clears in ${seconds.toFixed(0)} s, beyond what this call may wait; ${sent}`,
          retryAfter: seconds,
          sentAt: firstSentAt,
        });
      }
      this.#options.logger.debug(`waiting ${seconds.toFixed(1)} s for the ${bucket} rate-limit window`);
      await this.#sleep(seconds * 1000, signal);
    }
  }

  #checkOpen(what: string): void {
    if (this.#options.closeSignal?.aborted) throw new UsageError(`the client is closed; ${what} was not sent`);
  }

  async request<T = unknown>(spec: RequestSpec<T>): Promise<APIResponse<T>> {
    const method = spec.method.toUpperCase();
    const what = `${method} ${spec.route ?? spec.path}`;
    const url = this.buildURL(spec.path, spec.query);
    const maxRetries = spec.maxRetries ?? this.maxRetries;
    const base = this.#options.policy;
    const policy =
      maxRetries === base.maxRetries ? base : new RetryPolicy({ maxRetries, maxRetryAfter: base.maxRetryAfter, rules: base.rules });
    const upload = spec.upload;
    const replayable = (): boolean =>
      upload ? upload.replayable() : (spec.bodyReplayable ?? !isStream(spec.body));
    const timeoutMs = spec.timeout ?? this.timeout ?? spec.defaultTimeout ?? FALLBACK_TIMEOUT_MS;
    const deadlineMs = spec.deadline ?? this.deadline;
    const deadlineAt = deadlineMs === null ? null : this.#now() + deadlineMs;
    if (spec.waitBudget) spec.waitBudget.deadlineAt = deadlineAt;
    const closeSignal = this.#options.closeSignal;
    const log = this.#options.logger;
    this.#checkOpen(what);

    let retriesDone = 0;
    // The first attempt's send time: where to start looking for a job a lost POST may have created.
    let firstSentAt: Date | null = null;
    // Set once an attempt was sent but got no answer: it may have been processed.
    let anAttemptWentUnanswered = false;
    const retryAfterDelay = async (decision: RetryDecision, reason: string): Promise<boolean> => {
      if (!decision.retry) return false;
      if (deadlineAt !== null && this.#now() + decision.delay * 1000 >= deadlineAt) return false;
      log.info(`retrying ${what} in ${decision.delay.toFixed(2)} s (attempt ${retriesDone + 1} failed: ${reason})`);
      await this.#sleep(decision.delay * 1000, spec.signal);
      retriesDone += 1;
      return true;
    };

    for (;;) {
      spec.signal?.throwIfAborted();
      this.#checkOpen(what);
      await this.#waitForBucket(spec.bucket, policy, firstSentAt, spec.signal, deadlineAt);
      let attemptTimeout = timeoutMs;
      if (deadlineAt !== null) {
        const remaining = Math.floor(deadlineAt - this.#now());
        if (remaining <= 0) {
          throw new APITimeoutError(`the deadline of ${deadlineMs} ms expired before ${what} was sent`, {
            kind: 'total',
            sentAt: firstSentAt,
          });
        }
        attemptTimeout = Math.min(timeoutMs, remaining);
      }
      const attempt = retriesDone + 1;
      const headers = await this.#headers(spec, url);
      const init: RequestInit & { duplex?: 'half' } = { method, headers, redirect: upload && !isWorkerd() ? 'error' : 'manual' };
      let body: RequestBody | undefined = spec.body;
      if (spec.json !== undefined) body = JSON.stringify(spec.json);
      else if (upload) {
        const opened = await upload.open();
        body = opened.body;
        if (opened.contentType) headers.set('Content-Type', opened.contentType);
      }
      if (body !== undefined) {
        init.body = body as BodyInit;
        if (isStream(body)) init.duplex = 'half';
      }
      const details: RequestDetails = { operation: spec.bucket, method, url, headers, attempt, timeout: attemptTimeout };
      await this.#options.onRequest?.(details);
      // The retry column: a POST that carried the call's key can't run twice (ADR 0014).
      const key = spec.idempotencyKey;
      const retryMethod =
        method === 'POST' && key !== undefined && headers.get('idempotency-key') === key ? POST_IDEMPOTENT : method;

      const deadline = attemptSignal([spec.signal, closeSignal], attemptTimeout);
      init.signal = deadline.signal;
      firstSentAt ??= this.#date();
      const started = this.#now();
      let response: Response;
      let bytes: Uint8Array;
      try {
        response = await abortable(this.#options.fetch(url, init), deadline.signal);
        bytes = isSuccess(response.status)
          ? new Uint8Array(await abortable(response.arrayBuffer(), deadline.signal))
          : await abortable(readCapped(response, ERROR_BODY_LIMIT), deadline.signal);
      } catch (error) {
        deadline.done();
        if (spec.signal?.aborted) throw spec.signal.reason ?? error;
        if (closeSignal?.aborted) {
          throw new APIConnectionError(`${what} was cancelled because the client was closed`, {
            mayHaveExecuted: executedFlag('unknown', method),
            sentAt: firstSentAt,
            cause: error,
          });
        }
        const timedOut = deadline.timedOut();
        // The body broke before it was fully sent, so the request can't have run.
        const fromBody = upload && !timedOut ? bodyError(error) : null;
        if (fromBody) throw fromBody;
        if (upload && !timedOut && isRedirectRefusal(error)) {
          throw new ProtocolError({
            errorMessage: `the server answered ${what} with a redirect, which the SDK does not follow for uploads`,
            mayHaveExecuted: executedFlag('unknown', method),
            sentAt: firstSentAt,
            cause: error,
          });
        }
        const phase: Phase = timedOut ? 'no_response' : failurePhase(error);
        anAttemptWentUnanswered ||= phase === 'no_response';
        log.debug(`${what} failed: ${timedOut ? 'timeout' : phase} (attempt ${attempt})`);
        const decision = policy.decideTransport(retryMethod, phase, { retriesDone, bodyReplayable: replayable() });
        if (await retryAfterDelay(decision, decision.row)) continue;
        throw this.#connectionError(what, phase, decision, {
          timedOut,
          timeoutMs: attemptTimeout,
          sentAt: firstSentAt,
          withKey: retryMethod !== method,
          cause: error,
        });
      }
      deadline.done();

      const status = response.status;
      const requestId = header(response.headers, 'x-request-id');
      const rateLimit = this.tracker.observe(spec.bucket, response.headers);
      const elapsed = Math.round(this.#now() - started);
      log.debug(`${what} -> ${status} request_id=${requestId ?? '-'} attempt=${attempt} elapsed=${elapsed}ms`);
      await this.#options.onResponse?.(response, details);
      const meta = { status, headers: response.headers, requestId, rateLimit, attempts: attempt, response };
      const finish = (data: unknown, alreadyDeleted: boolean): APIResponse<T> => {
        const parsed = spec.parse ? spec.parse(data, { status, headers: response.headers, requestId, alreadyDeleted }) : (data as T);
        return { ...meta, data: parsed, alreadyDeleted };
      };

      if (isSuccess(status)) {
        try {
          return finish(spec.responseType === 'bytes' ? bytes : unwrapSuccess(bytes), false);
        } catch (error) {
          if (!(error instanceof MalformedEnvelopeError)) throw error;
          const decision = policy.decideTransport(retryMethod, 'malformed_success', { retriesDone, bodyReplayable: replayable() });
          if (await retryAfterDelay(decision, decision.row)) continue;
          throw new ProtocolError({
            statusCode: status,
            errorMessage: `unexpected response body: ${error.message}`,
            requestId,
            headers: headersToRecord(response.headers),
            rawBody: spec.sensitive ? null : parseErrorBody(bytes).rawBody,
            mayHaveExecuted: executedFlag(decision.mayHaveExecuted, method),
            rule: 'malformed_success',
            sentAt: firstSentAt,
            cause: error,
          });
        }
      }

      if (status < 400 || status > 599) {
        // Redirects and other statuses the API never sends.
        throw new ProtocolError({
          statusCode: status,
          errorMessage: `unexpected HTTP ${status} ${response.statusText}`.trim(),
          requestId,
          headers: headersToRecord(response.headers),
          rawBody: parseErrorBody(bytes).rawBody,
          mayHaveExecuted: executedFlag('unknown', method),
          sentAt: firstSentAt,
        });
      }

      const { rule, retryAfter } = classifyResponse(status, response.headers, bytes, { rules: policy.rules });
      if (method === 'DELETE' && anAttemptWentUnanswered && rule.error === 'JobNotFoundError') {
        // An earlier attempt was probably processed, so the job is gone (rule R3).
        return finish({ deleted: true }, true);
      }
      if (rule.blocksBucket && retryAfter !== null) this.tracker.block(spec.bucket, retryAfter);
      const statusError = (notReplayable: boolean) =>
        buildStatusError(status, response.headers, bytes, {
          method,
          sentAt: firstSentAt,
          reasonPhrase: response.statusText || null,
          retryDisabledReason: notReplayable ? 'body_not_replayable' : null,
          rules: policy.rules,
        });
      if (spec.waitBudget && retryMethod === POST_IDEMPOTENT && rule.error === 'RequestInProgressError') {
        // The first request with this key is still running, and will answer a resend once it ends:
        // send it again every 5 s (or after Retry-After) within the wait budget, outside maxRetries.
        // The first other answer decides the call (ADR 0014).
        const endsAt = spec.waitBudget.endsAt(this.#now());
        const wait = Math.max(IN_PROGRESS_RESEND_MS, (retryAfter ?? 0) * 1000);
        if (!replayable()) throw statusError(true);
        if (this.#now() + wait >= endsAt) throw statusError(false);
        log.info(`${what}: the request with this Idempotency-Key is still running; sending it again in ${wait / 1000} s`);
        await this.#sleep(wait, spec.signal);
        continue;
      }
      const decision = policy.decideStatus(retryMethod, rule, { retriesDone, retryAfter, bodyReplayable: replayable() });
      if (await retryAfterDelay(decision, decision.row)) continue;
      throw statusError(decision.reason === 'body_not_replayable');
    }
  }

  #connectionError(
    what: string,
    phase: Phase,
    decision: RetryDecision,
    ctx: { timedOut: boolean; timeoutMs: number; sentAt: Date | null; withKey: boolean; cause: unknown },
  ): APIConnectionError {
    const mayHaveExecuted = executedFlag(decision.mayHaveExecuted, method(what));
    const cause = ctx.cause;
    const detail = ctx.timedOut
      ? `timed out after ${ctx.timeoutMs} ms`
      : cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : String(cause);
    let message = `${phaseMessage(phase, what)}: ${detail}`;
    if (mayHaveExecuted) {
      message += ctx.withKey
        ? '. It may have run: send it again with the same idempotencyKey to get its result without a second charge.'
        : '. It may have run and been charged: check recent jobs before sending it again.';
    }
    const init = {
      mayHaveExecuted,
      sentAt: ctx.sentAt,
      retryDisabledReason: decision.reason === 'body_not_replayable' ? 'body_not_replayable' : null,
      cause,
    };
    return ctx.timedOut ? new APITimeoutError(message, { ...init, kind: 'total' }) : new APIConnectionError(message, init);
  }
}
