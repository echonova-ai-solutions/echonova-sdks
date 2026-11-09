/**
 * HTTP transport over `fetch`, wired to the retry table, the rate-limit
 * tracker and the error classifier.
 *
 * Retry safety: a POST that may have run on the server is never sent again.
 * Fetch can't tell "connection refused" apart from "sent but no answer" in
 * every runtime, so any failure the SDK can't positively identify as a
 * connection failure is treated as "sent, no response" (rule R3): GET and
 * DELETE are retried, POST is not and its error carries `mayHaveExecuted: true`.
 */

import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  ProtocolError,
  RateLimitError,
} from '../errors.js';
import { classifyResponse, buildStatusError, executedFlag } from './classifier.js';
import { header, headersToRecord, MalformedEnvelopeError, parseErrorBody, unwrapSuccess } from './envelope.js';
import type { Logger } from './logger.js';
import type { RateLimitInfo, RateLimitTracker } from './ratelimit.js';
import { RetryPolicy, type RetryDecision } from './retry.js';
import type { Phase } from './rules.js';

/** The subset of `fetch` the SDK uses. Any WHATWG-compatible implementation works. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HeaderValues = Readonly<Record<string, string | null | undefined>>;

export type RequestBody = string | Uint8Array | ArrayBuffer | Blob | FormData | URLSearchParams | ReadableStream<Uint8Array>;

export interface RequestSpec {
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
  headers?: HeaderValues | undefined;
  /** Per-call timeout in milliseconds (one attempt). */
  timeout?: number | undefined;
  /** The operation's default timeout in milliseconds, used when neither the call nor the client sets one. */
  defaultTimeout?: number | undefined;
  maxRetries?: number | undefined;
  signal?: AbortSignal | undefined;
  /** `envelope` (default): unwrap `data`. `bytes`: raw body (file downloads such as transcript export). */
  responseType?: 'envelope' | 'bytes' | undefined;
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
}

export interface AuthContext {
  method: string;
  url: string;
}

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
  /** Waits `ms` milliseconds; rejects with the signal's reason if aborted. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  /** Monotonic milliseconds, for elapsed-time logs. */
  now?: (() => number) | undefined;
}

export const FALLBACK_TIMEOUT_MS = 60_000;

const PHASE_MESSAGES: Readonly<Record<Phase, string>> = {
  connect: 'Could not connect to {target}',
  send_incomplete: 'The connection failed while sending the request to {target}; it did not run',
  no_response: 'No response from {target} after the request was sent',
  malformed_success: 'Unexpected response body from {target}',
};

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

/** Classify a `fetch` rejection: `connect` only when it is certain nothing was sent. */
export function failurePhase(error: unknown): Phase {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && (CONNECT_ERROR_CODES.has(code) || TLS_ERROR_CODE.test(code))) return 'connect';
    current = (current as { cause?: unknown }).cause;
  }
  return 'no_response';
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** One attempt's signal: aborts on the caller's signal or when the attempt's deadline passes. */
function attemptSignal(user: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`request timed out after ${timeoutMs} ms`, 'TimeoutError'));
  }, timeoutMs);
  const onAbort = (): void => controller.abort(user?.reason);
  if (user?.aborted) controller.abort(user.reason);
  else user?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      user?.removeEventListener('abort', onAbort);
    },
  };
}

function isReplayable(body: RequestBody | undefined): boolean {
  return !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream);
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

export class HttpTransport {
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly timeout: number | null;
  readonly tracker: RateLimitTracker;
  readonly #options: TransportOptions;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;

  constructor(options: TransportOptions) {
    this.#options = options;
    this.baseURL = options.baseURL;
    this.maxRetries = options.maxRetries;
    this.timeout = options.timeout;
    this.tracker = options.tracker;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? (() => performance.now());
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

  async #headers(spec: RequestSpec, url: string): Promise<Headers> {
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
    return headers;
  }

  /**
   * Wait while the bucket is blocked by a throttle 429 or its window is used up,
   * instead of sending a request that would only extend the block. A wait longer
   * than the policy's `maxRetryAfter` throws `RateLimitError` without sending.
   */
  async #waitForBucket(
    bucket: string,
    policy: RetryPolicy,
    firstSentAt: Date | null,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (;;) {
      const seconds = this.tracker.waitTime(bucket, { preflight: this.#options.rateLimitPreflight });
      if (seconds <= 0) return;
      if (seconds > policy.maxRetryAfter) {
        throw new RateLimitError({
          message: `the rate limit for ${bucket} clears in ${seconds.toFixed(0)} s, beyond what this call may wait; nothing was sent`,
          retryAfter: seconds,
          sentAt: firstSentAt,
        });
      }
      this.#options.logger.debug(`waiting ${seconds.toFixed(1)} s for the ${bucket} rate-limit window`);
      await this.#sleep(seconds * 1000, signal);
    }
  }

  async request<T = unknown>(spec: RequestSpec): Promise<APIResponse<T>> {
    const method = spec.method.toUpperCase();
    const what = `${method} ${spec.route ?? spec.path}`;
    const url = this.buildURL(spec.path, spec.query);
    const maxRetries = spec.maxRetries ?? this.maxRetries;
    const base = this.#options.policy;
    const policy =
      maxRetries === base.maxRetries ? base : new RetryPolicy({ maxRetries, maxRetryAfter: base.maxRetryAfter, rules: base.rules });
    const replayable = spec.bodyReplayable ?? isReplayable(spec.body);
    const timeoutMs = spec.timeout ?? this.timeout ?? spec.defaultTimeout ?? FALLBACK_TIMEOUT_MS;
    const log = this.#options.logger;

    let retriesDone = 0;
    // The first attempt's send time: where to start looking for a job a lost POST may have created.
    let firstSentAt: Date | null = null;
    // Set once an attempt was sent but got no answer: it may have been processed.
    let anAttemptWentUnanswered = false;
    const retryAfterDelay = async (decision: RetryDecision, reason: string): Promise<boolean> => {
      if (!decision.retry) return false;
      log.info(`retrying ${what} in ${decision.delay.toFixed(2)} s (attempt ${retriesDone + 1} failed: ${reason})`);
      await this.#sleep(decision.delay * 1000, spec.signal);
      retriesDone += 1;
      return true;
    };

    for (;;) {
      spec.signal?.throwIfAborted();
      await this.#waitForBucket(spec.bucket, policy, firstSentAt, spec.signal);
      const attempt = retriesDone + 1;
      const headers = await this.#headers(spec, url);
      const init: RequestInit & { duplex?: 'half' } = { method, headers, redirect: 'manual' };
      if (spec.json !== undefined) init.body = JSON.stringify(spec.json);
      else if (spec.body !== undefined) {
        init.body = spec.body as BodyInit;
        if (!isReplayable(spec.body)) init.duplex = 'half';
      }

      const deadline = attemptSignal(spec.signal, timeoutMs);
      init.signal = deadline.signal;
      firstSentAt ??= new Date();
      const started = this.#now();
      let response: Response;
      let bytes: Uint8Array;
      try {
        response = await this.#options.fetch(url, init);
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        deadline.done();
        if (spec.signal?.aborted) throw spec.signal.reason ?? error;
        const timedOut = deadline.timedOut();
        const phase: Phase = timedOut ? 'no_response' : failurePhase(error);
        anAttemptWentUnanswered ||= phase === 'no_response';
        log.debug(`${what} failed: ${timedOut ? 'timeout' : phase} (attempt ${attempt})`);
        const decision = policy.decideTransport(method, phase, { retriesDone, bodyReplayable: replayable });
        if (await retryAfterDelay(decision, decision.row)) continue;
        throw this.#connectionError(what, phase, decision, { timedOut, timeoutMs, sentAt: firstSentAt, cause: error });
      }
      deadline.done();

      const status = response.status;
      const requestId = header(response.headers, 'x-request-id');
      const rateLimit = this.tracker.observe(spec.bucket, response.headers);
      const elapsed = Math.round(this.#now() - started);
      log.debug(`${what} -> ${status} request_id=${requestId ?? '-'} attempt=${attempt} elapsed=${elapsed}ms`);
      const meta = { status, headers: response.headers, requestId, rateLimit, attempts: attempt };

      if (isSuccess(status)) {
        if (spec.responseType === 'bytes') return { ...meta, data: bytes as T, alreadyDeleted: false };
        try {
          return { ...meta, data: unwrapSuccess(bytes) as T, alreadyDeleted: false };
        } catch (error) {
          if (!(error instanceof MalformedEnvelopeError)) throw error;
          const decision = policy.decideTransport(method, 'malformed_success', { retriesDone, bodyReplayable: replayable });
          if (await retryAfterDelay(decision, decision.row)) continue;
          throw new ProtocolError({
            statusCode: status,
            errorMessage: `unexpected response body: ${error.message}`,
            requestId,
            headers: headersToRecord(response.headers),
            rawBody: parseErrorBody(bytes).rawBody,
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
        return { ...meta, data: { deleted: true } as T, alreadyDeleted: true };
      }
      if (rule.blocksBucket && retryAfter !== null) this.tracker.block(spec.bucket, retryAfter);
      const decision = policy.decideStatus(method, rule, { retriesDone, retryAfter, bodyReplayable: replayable });
      if (await retryAfterDelay(decision, decision.row)) continue;
      throw buildStatusError(status, response.headers, bytes, {
        method,
        sentAt: firstSentAt,
        reasonPhrase: response.statusText || null,
        retryDisabledReason: decision.reason === 'body_not_replayable' ? 'body_not_replayable' : null,
        rules: policy.rules,
      });
    }
  }

  #connectionError(
    what: string,
    phase: Phase,
    decision: RetryDecision,
    ctx: { timedOut: boolean; timeoutMs: number; sentAt: Date | null; cause: unknown },
  ): APIConnectionError {
    const mayHaveExecuted = executedFlag(decision.mayHaveExecuted, method(what));
    const cause = ctx.cause;
    const detail = ctx.timedOut
      ? `timed out after ${ctx.timeoutMs} ms`
      : cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : String(cause);
    let message = `${PHASE_MESSAGES[phase].replace('{target}', what)}: ${detail}`;
    if (mayHaveExecuted) message += '. It may have run and been charged: check recent jobs before sending it again.';
    const init = {
      mayHaveExecuted,
      sentAt: ctx.sentAt,
      retryDisabledReason: decision.reason === 'body_not_replayable' ? 'body_not_replayable' : null,
      cause,
    };
    return ctx.timedOut ? new APITimeoutError(message, { ...init, kind: 'total' }) : new APIConnectionError(message, init);
  }
}
