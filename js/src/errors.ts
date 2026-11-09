/**
 * Errors thrown by the EchoNova SDK.
 *
 * Errors are grouped by what went wrong, not by transport. For example,
 * `InsufficientBalanceError` covers a REST 402, a WebSocket handshake 402 and a
 * stream closed with code 4002. The class tree matches `spec/error-rules.json`
 * and is the same in every EchoNova SDK.
 *
 * `instanceof` works even when an error was created by the other build of this
 * package (ESM vs CommonJS) or by another copy of it: each class checks a brand
 * registered with `Symbol.for`, not only the prototype chain.
 */

export type Transport = 'http' | 'websocket';
export type TimeoutKind = 'connect' | 'write' | 'read' | 'pool' | 'total' | 'session_start' | 'stop_drain';
export type WebhookFailure = 'headers' | 'timestamp' | 'signature' | 'payload';

const BRAND = Symbol.for('echonova.error.class');
const brandKey = (name: string): symbol => Symbol.for(`echonova.error:${name}`);

type AnyConstructor = abstract new (...args: never[]) => object;

function register(cls: AnyConstructor, name: string): void {
  Object.defineProperty(cls, BRAND, { value: name });
  Object.defineProperty(cls.prototype, 'name', { value: name, writable: true, configurable: true });
  Object.defineProperty(cls.prototype, brandKey(name), { value: true });
}

/** Base class for every error thrown by this SDK. */
export class EchoNovaError extends Error {
  static {
    register(this, 'EchoNovaError');
  }

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }

  static override [Symbol.hasInstance]<T>(this: abstract new (...args: never[]) => T, value: unknown): value is T {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    // Fall back to the brand only for the SDK's own classes, not for user subclasses.
    if (!Object.hasOwn(this, BRAND)) return false;
    const name = (this as unknown as Record<symbol, string>)[BRAND];
    return (
      typeof value === 'object' &&
      value !== null &&
      name !== undefined &&
      (value as Record<symbol, unknown>)[brandKey(name)] === true
    );
  }
}

// --- Local misuse: nothing was sent ---------------------------------------------------------

/** The SDK was called incorrectly. Nothing was sent to EchoNova. */
export class UsageError extends EchoNovaError {
  static {
    register(this, 'UsageError');
  }
}

/** A stream session was used after it ended. */
export class SessionEndedError extends UsageError {
  static {
    register(this, 'SessionEndedError');
  }
}

/** The runtime can't do this safely, such as sending an API key from a browser. */
export class UnsupportedEnvironmentError extends EchoNovaError {
  static {
    register(this, 'UnsupportedEnvironmentError');
  }
}

// --- No HTTP response -----------------------------------------------------------------------

export interface APIConnectionErrorInit {
  /**
   * For POST requests: `true` means the request was fully sent, so it may have run
   * and been charged; `false` means it definitely did not run; `null` means unknown.
   * Always `false` for other methods.
   */
  mayHaveExecuted?: boolean | null | undefined;
  /** When the failed attempt was sent. */
  sentAt?: Date | null | undefined;
  /** Why the SDK did not retry, when retrying was otherwise allowed (e.g. `"body_not_replayable"`). */
  retryDisabledReason?: string | null | undefined;
  cause?: unknown;
}

/**
 * No response was received from EchoNova.
 *
 * `mayHaveExecuted` matters for POST requests. `true` means the request was fully
 * sent, so it may have run and been charged: list recent jobs before sending it
 * again. `false` means it definitely did not run. `null` means unknown.
 */
export class APIConnectionError extends EchoNovaError {
  static {
    register(this, 'APIConnectionError');
  }

  readonly mayHaveExecuted: boolean | null;
  readonly sentAt: Date | null;
  readonly retryDisabledReason: string | null;

  constructor(message: string, init: APIConnectionErrorInit = {}) {
    super(message, { cause: init.cause });
    this.mayHaveExecuted = init.mayHaveExecuted === undefined ? false : init.mayHaveExecuted;
    this.sentAt = init.sentAt ?? null;
    this.retryDisabledReason = init.retryDisabledReason ?? null;
  }
}

export interface APITimeoutErrorInit extends APIConnectionErrorInit {
  kind: TimeoutKind;
}

/** A timeout expired. `kind` says which one. */
export class APITimeoutError extends APIConnectionError {
  static {
    register(this, 'APITimeoutError');
  }

  readonly kind: TimeoutKind;

  constructor(message: string, init: APITimeoutErrorInit) {
    super(message, init);
    this.kind = init.kind;
  }
}

/** A stream's connection dropped without a close frame (1006, pong timeout or reset). */
export class StreamConnectionLostError extends APIConnectionError {
  static {
    register(this, 'StreamConnectionLostError');
  }
}

// --- The server answered --------------------------------------------------------------------

export interface APIStatusErrorInit {
  /** Overrides the default message built from the fields below. */
  message?: string | null | undefined;
  statusCode?: number | null | undefined;
  errorMessage?: string | null | undefined;
  errorCode?: string | null | undefined;
  requestId?: string | null | undefined;
  docsUrl?: string | null | undefined;
  headers?: Readonly<Record<string, string>> | null | undefined;
  rawBody?: string | null | undefined;
  transport?: Transport | undefined;
  retryAfter?: number | null | undefined;
  mayHaveExecuted?: boolean | null | undefined;
  rule?: string | null | undefined;
  closeCode?: number | null | undefined;
  sessionId?: string | null | undefined;
  sentAt?: Date | null | undefined;
  fromProxy?: boolean | undefined;
  retryDisabledReason?: string | null | undefined;
  cause?: unknown;
}

/**
 * EchoNova answered with an error: a REST status, a WebSocket handshake
 * rejection, or an error event or close on a stream.
 *
 * `errorMessage` is the server's text, unmodified. It is never split on commas,
 * because single messages can contain them.
 */
export class APIStatusError extends EchoNovaError {
  static {
    register(this, 'APIStatusError');
  }

  /** HTTP status (REST or WebSocket handshake). */
  readonly statusCode: number | null;
  /** The server's error text, exactly as sent. */
  readonly errorMessage: string | null;
  /** The REST `errorCode` or the stream error `code`, when the server sent one. */
  readonly errorCode: string | null;
  /** The server's `X-Request-Id`. Quote it when contacting support. */
  readonly requestId: string | null;
  /** Link to the documentation for this error (the envelope's `docs`). */
  readonly docsUrl: string | null;
  /** Response headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** The start of the response body (at most 4 KiB). */
  readonly rawBody: string | null;
  readonly transport: Transport;
  /** Seconds to wait before trying again, from `Retry-After`. */
  readonly retryAfter: number | null;
  /**
   * For POST requests: `true` if the request may have run and been charged,
   * `false` if it did not, `null` if unknown. Always `false` for other methods.
   */
  readonly mayHaveExecuted: boolean | null;
  /** Id of the classification rule that matched (from `spec/error-rules.json`). */
  readonly rule: string | null;
  /** WebSocket close code, for errors raised by a stream closing. */
  readonly closeCode: number | null;
  /** Stream session id, when known. */
  readonly sessionId: string | null;
  /** When the failed request was sent. */
  readonly sentAt: Date | null;
  /** `true` when the response came from the hosting proxy rather than the API itself. */
  readonly fromProxy: boolean;
  /** Why the SDK did not retry, when retrying was otherwise allowed (e.g. `"body_not_replayable"`). */
  readonly retryDisabledReason: string | null;

  constructor(init: APIStatusErrorInit = {}) {
    const statusCode = init.statusCode ?? null;
    const errorMessage = init.errorMessage ?? null;
    const errorCode = init.errorCode ?? null;
    const requestId = init.requestId ?? null;
    const closeCode = init.closeCode ?? null;
    super(init.message ?? describe(statusCode, errorCode, closeCode, errorMessage, requestId), {
      cause: init.cause,
    });
    this.statusCode = statusCode;
    this.errorMessage = errorMessage;
    this.errorCode = errorCode;
    this.requestId = requestId;
    this.docsUrl = init.docsUrl ?? null;
    this.headers = { ...(init.headers ?? {}) };
    this.rawBody = init.rawBody ?? null;
    this.transport = init.transport ?? 'http';
    this.retryAfter = init.retryAfter ?? null;
    this.mayHaveExecuted = init.mayHaveExecuted === undefined ? false : init.mayHaveExecuted;
    this.rule = init.rule ?? null;
    this.closeCode = closeCode;
    this.sessionId = init.sessionId ?? null;
    this.sentAt = init.sentAt ?? null;
    this.fromProxy = init.fromProxy ?? false;
    this.retryDisabledReason = init.retryDisabledReason ?? null;
  }
}

function describe(
  statusCode: number | null,
  errorCode: string | null,
  closeCode: number | null,
  errorMessage: string | null,
  requestId: string | null,
): string {
  const parts: string[] = [];
  if (statusCode !== null) parts.push(String(statusCode));
  if (closeCode !== null) parts.push(`close ${closeCode}`);
  if (errorCode) parts.push(`[${errorCode}]`);
  parts.push(errorMessage || 'no error message');
  const text = parts.join(' ');
  return requestId ? `${text} (request_id: ${requestId})` : text;
}

/** The request was rejected as invalid (400, 405, 409, 413, 415, 422, or a stream `validation_failed`). */
export class InvalidRequestError extends APIStatusError {
  static {
    register(this, 'InvalidRequestError');
  }
}

/** 401: the API key is missing, wrong, disabled or deleted. */
export class AuthenticationError extends APIStatusError {
  static {
    register(this, 'AuthenticationError');
  }
}

/** 403: no active subscription, or the key lacks access to this service. */
export class PermissionDeniedError extends APIStatusError {
  static {
    register(this, 'PermissionDeniedError');
  }
}

/** The feature is not enabled for this account (for example `Streaming is not enabled`). */
export class FeatureNotEnabledError extends PermissionDeniedError {
  static {
    register(this, 'FeatureNotEnabledError');
  }
}

/** 404: the resource doesn't exist or belongs to another workspace. */
export class NotFoundError extends APIStatusError {
  static {
    register(this, 'NotFoundError');
  }
}

/** The voice id is unknown, inactive or not available to this workspace. */
export class VoiceNotFoundError extends NotFoundError {
  static {
    register(this, 'VoiceNotFoundError');
  }
}

/** The job id is unknown or belongs to another workspace. */
export class JobNotFoundError extends NotFoundError {
  static {
    register(this, 'JobNotFoundError');
  }
}

/** 408: the server stopped waiting for the request body. The request did not run. */
export class RequestTimeoutError extends APIStatusError {
  static {
    register(this, 'RequestTimeoutError');
  }
}

/** The account can't pay for this request. Retrying won't help. */
export class BillingError extends APIStatusError {
  static {
    register(this, 'BillingError');
  }
}

/** 402 or stream close 4002: not enough credits. */
export class InsufficientBalanceError extends BillingError {
  static {
    register(this, 'InsufficientBalanceError');
  }
}

/** 429 `Monthly spending limit exhausted` or stream close 4029: the key reached its Credit Limit. */
export class SpendingLimitError extends BillingError {
  static {
    register(this, 'SpendingLimitError');
  }
}

/**
 * 429: too many requests. `retryAfter` holds the seconds to wait, when the server sent it.
 *
 * This is deliberately not the parent of `SpendingLimitError`: a rate limit
 * clears by waiting, a spending limit doesn't.
 */
export class RateLimitError extends APIStatusError {
  static {
    register(this, 'RateLimitError');
  }
}

/** 429 `Too many concurrent streams`: the workspace has no free stream slot. */
export class ConcurrencyLimitError extends APIStatusError {
  static {
    register(this, 'ConcurrencyLimitError');
  }
}

/** 5xx: EchoNova failed to handle the request. */
export class ServerError extends APIStatusError {
  static {
    register(this, 'ServerError');
  }
}

/** 503: a service is temporarily unavailable. */
export class ServiceUnavailableError extends ServerError {
  static {
    register(this, 'ServiceUnavailableError');
  }
}

/** 502 or 504. `fromProxy` is true when the response came from the hosting proxy, not the API. */
export class GatewayError extends ServerError {
  static {
    register(this, 'GatewayError');
  }
}

/** A speech service failed during a stream (`upstream_error` or close 1011). */
export class UpstreamError extends ServerError {
  static {
    register(this, 'UpstreamError');
  }
}

/** The server sent something that breaks the documented contract, or closed with 1008 or 1009. */
export class ProtocolError extends APIStatusError {
  static {
    register(this, 'ProtocolError');
  }
}

// --- Streams --------------------------------------------------------------------------------

export interface StreamClosedErrorInit {
  closeCode?: number | null | undefined;
  reason?: string | null | undefined;
  sessionId?: string | null | undefined;
  cause?: unknown;
}

/** A stream closed in a way that is not covered by a more specific error. */
export class StreamClosedError extends EchoNovaError {
  static {
    register(this, 'StreamClosedError');
  }

  readonly closeCode: number | null;
  readonly reason: string | null;
  readonly sessionId: string | null;

  constructor(message: string, init: StreamClosedErrorInit = {}) {
    super(message, { cause: init.cause });
    this.closeCode = init.closeCode ?? null;
    this.reason = init.reason ?? null;
    this.sessionId = init.sessionId ?? null;
  }
}

/** Close 1001: the server is restarting. Reconnect. */
export class ServerRestartingError extends StreamClosedError {
  static {
    register(this, 'ServerRestartingError');
  }
}

/** Close 4008: the session hit its idle timeout or maximum length. */
export class SessionExpiredError extends StreamClosedError {
  static {
    register(this, 'SessionExpiredError');
  }
}

// --- Jobs, downloads, webhooks --------------------------------------------------------------

/** A job finished with status `failed`. `job` holds the failed job. */
export class JobFailedError extends EchoNovaError {
  static {
    register(this, 'JobFailedError');
  }

  readonly job: unknown;

  constructor(message: string, init: { job: unknown; cause?: unknown }) {
    super(message, { cause: init.cause });
    this.job = init.job;
  }
}

/** `wait()` gave up before the job finished. Calling `wait()` again is safe. */
export class JobWaitTimeoutError extends EchoNovaError {
  static {
    register(this, 'JobWaitTimeoutError');
  }

  readonly jobId: string;
  readonly lastJob: unknown;

  constructor(message: string, init: { jobId: string; lastJob?: unknown; cause?: unknown }) {
    super(message, { cause: init.cause });
    this.jobId = init.jobId;
    this.lastJob = init.lastJob ?? null;
  }
}

/** A signed download link expired. Get the job again for a fresh link. */
export class DownloadExpiredError extends EchoNovaError {
  static {
    register(this, 'DownloadExpiredError');
  }

  /** The link without its query string, which carries the signature. */
  readonly url: string | null;

  constructor(message: string, init: { url?: string | null | undefined; cause?: unknown } = {}) {
    super(message, { cause: init.cause });
    this.url = init.url ?? null;
  }
}

/** A webhook request failed verification. `reason` says which check failed. */
export class WebhookVerificationError extends EchoNovaError {
  static {
    register(this, 'WebhookVerificationError');
  }

  readonly reason: WebhookFailure;

  constructor(message: string, init: { reason: WebhookFailure; cause?: unknown }) {
    super(message, { cause: init.cause });
    this.reason = init.reason;
  }
}

/** Every error class, by name. The keys match the taxonomy in `spec/error-rules.json`. */
export const ERROR_CLASSES = {
  EchoNovaError,
  UsageError,
  SessionEndedError,
  UnsupportedEnvironmentError,
  APIConnectionError,
  APITimeoutError,
  StreamConnectionLostError,
  APIStatusError,
  InvalidRequestError,
  AuthenticationError,
  PermissionDeniedError,
  FeatureNotEnabledError,
  NotFoundError,
  VoiceNotFoundError,
  JobNotFoundError,
  RequestTimeoutError,
  BillingError,
  InsufficientBalanceError,
  SpendingLimitError,
  RateLimitError,
  ConcurrencyLimitError,
  ServerError,
  ServiceUnavailableError,
  GatewayError,
  UpstreamError,
  ProtocolError,
  StreamClosedError,
  ServerRestartingError,
  SessionExpiredError,
  JobFailedError,
  JobWaitTimeoutError,
  DownloadExpiredError,
  WebhookVerificationError,
} as const;

export type ErrorClassName = keyof typeof ERROR_CLASSES;
