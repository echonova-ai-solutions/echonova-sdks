/**
 * The EchoNova client: configuration, authentication and the HTTP transport.
 *
 * ```ts
 * import EchoNova from 'echonova';
 * const client = new EchoNova(); // reads ECHONOVA_API_KEY
 * ```
 */

import * as Errors from './errors.js';
import { HttpTransport, type AuthContext, type FetchLike, type HeaderValues } from './core/http.js';
import { isLogLevel, makeLogger, type Logger, type LogLevel } from './core/logger.js';
import { RateLimitTracker, type RateLimitInfo } from './core/ratelimit.js';
import { RetryPolicy } from './core/retry.js';
import { loadRules } from './core/rules.js';
import { isBrowserLike, readEnv, runtimeInfo } from './runtime/detect.js';
import { VERSION } from './version.js';

export type { AuthContext, FetchLike } from './core/http.js';

export const DEFAULT_BASE_URL = 'https://api.echonova.ai';

/**
 * Returns headers that authenticate a request, for proxy mode: for example your
 * own session token when `baseURL` points at your backend. Called before every attempt.
 */
export type AuthHook = (context: AuthContext) => HeaderValues | Promise<HeaderValues>;

export interface ClientOptions {
  /**
   * Your EchoNova API key (`ek_…`). Defaults to the `ECHONOVA_API_KEY`
   * environment variable, unless `auth` is set. Keep it on your server: never
   * ship it to browsers or apps.
   */
  apiKey?: string | null | undefined;
  /**
   * The API host, without `/v1`. Defaults to `ECHONOVA_BASE_URL` or
   * `https://api.echonova.ai`. Point it at your own backend for proxy mode.
   */
  baseURL?: string | null | undefined;
  /**
   * Authentication headers for every request, for proxy mode (with `baseURL`
   * pointing at your backend). When set, `ECHONOVA_API_KEY` is not read, so the
   * key can't reach a proxy by accident.
   */
  auth?: AuthHook | undefined;
  /** Timeout for one attempt, in milliseconds. Defaults to a per-operation value. */
  timeout?: number | undefined;
  /** Retries for failures that are safe to retry. Default 2. A POST that may have run is never retried. */
  maxRetries?: number | undefined;
  /**
   * Wait for the rate-limit window to reset when the last response said no
   * requests remain, instead of sending a request that would be throttled. Default true.
   */
  rateLimitPreflight?: boolean | undefined;
  /** Headers sent with every request. A `null` value removes a default header. */
  defaultHeaders?: HeaderValues | undefined;
  /** A custom `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike | undefined;
  /**
   * Allow an API key in a browser-like environment. Anyone using your app could
   * read the key, so prefer proxy mode. Default false.
   */
  dangerouslyAllowBrowser?: boolean | undefined;
  /** Log level. Defaults to `ECHONOVA_LOG`, or `"off"`. */
  logLevel?: LogLevel | undefined;
  /** Where log lines go. Defaults to `console`. */
  logger?: Logger | undefined;
}

/** Show a key as `ek_…c21d`: enough to tell keys apart, useless to an attacker. Short keys are hidden entirely. */
export function redactKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length < 12) return '…';
  return `${key.startsWith('ek_') ? 'ek_' : ''}…${key.slice(-4)}`;
}

function userAgent(): string | null {
  if (isBrowserLike()) return null; // browsers don't allow setting it
  const runtime = runtimeInfo();
  const details = [runtime.version ? `${runtime.name}/${runtime.version}` : runtime.name, runtime.platform].filter(Boolean);
  return `echonova-js/${VERSION} (${details.join('; ')})`;
}

function normalizeBaseURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Errors.UsageError(`baseURL is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Errors.UsageError('baseURL must be an http(s) URL');
  }
  if (url.search || url.hash) throw new Errors.UsageError('baseURL must not have a query string or fragment');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const transports = new WeakMap<EchoNova, HttpTransport>();

/** @internal The transport behind a client (for resources and tests). Not part of the public API. */
export function transportOf(client: EchoNova): HttpTransport {
  const transport = transports.get(client);
  if (!transport) throw new TypeError('not an EchoNova client');
  return transport;
}

export class EchoNova {
  // Errors, also reachable as `EchoNova.RateLimitError` etc.
  static readonly EchoNovaError = Errors.EchoNovaError;
  static readonly UsageError = Errors.UsageError;
  static readonly SessionEndedError = Errors.SessionEndedError;
  static readonly UnsupportedEnvironmentError = Errors.UnsupportedEnvironmentError;
  static readonly APIConnectionError = Errors.APIConnectionError;
  static readonly APITimeoutError = Errors.APITimeoutError;
  static readonly StreamConnectionLostError = Errors.StreamConnectionLostError;
  static readonly APIStatusError = Errors.APIStatusError;
  static readonly InvalidRequestError = Errors.InvalidRequestError;
  static readonly AuthenticationError = Errors.AuthenticationError;
  static readonly PermissionDeniedError = Errors.PermissionDeniedError;
  static readonly FeatureNotEnabledError = Errors.FeatureNotEnabledError;
  static readonly NotFoundError = Errors.NotFoundError;
  static readonly VoiceNotFoundError = Errors.VoiceNotFoundError;
  static readonly JobNotFoundError = Errors.JobNotFoundError;
  static readonly RequestTimeoutError = Errors.RequestTimeoutError;
  static readonly BillingError = Errors.BillingError;
  static readonly InsufficientBalanceError = Errors.InsufficientBalanceError;
  static readonly SpendingLimitError = Errors.SpendingLimitError;
  static readonly RateLimitError = Errors.RateLimitError;
  static readonly ConcurrencyLimitError = Errors.ConcurrencyLimitError;
  static readonly ServerError = Errors.ServerError;
  static readonly ServiceUnavailableError = Errors.ServiceUnavailableError;
  static readonly GatewayError = Errors.GatewayError;
  static readonly UpstreamError = Errors.UpstreamError;
  static readonly ProtocolError = Errors.ProtocolError;
  static readonly StreamClosedError = Errors.StreamClosedError;
  static readonly ServerRestartingError = Errors.ServerRestartingError;
  static readonly SessionExpiredError = Errors.SessionExpiredError;
  static readonly JobFailedError = Errors.JobFailedError;
  static readonly JobWaitTimeoutError = Errors.JobWaitTimeoutError;
  static readonly DownloadExpiredError = Errors.DownloadExpiredError;
  static readonly WebhookVerificationError = Errors.WebhookVerificationError;

  static readonly DEFAULT_BASE_URL = DEFAULT_BASE_URL;
  static readonly VERSION = VERSION;

  /** The API host requests go to (paths carry `/v1`). */
  readonly baseURL: string;
  /** Client-wide timeout per attempt, in milliseconds, or null for per-operation defaults. */
  readonly timeout: number | null;
  readonly maxRetries: number;

  readonly #apiKey: string | null;
  readonly #hasAuthHook: boolean;

  // --- Resources --------------------------------------------------------------------------
  // The service namespaces (textToSpeech, speechToText, soundCleaning) are added here once
  // their API is final. Each one is built in the constructor from `transportOf(this)`; see
  // src/resources/resource.ts.

  constructor(options: ClientOptions = {}) {
    const auth = options.auth;
    // With an auth hook the environment key is not used: it must never reach a custom proxy by accident.
    const keyOption = options.apiKey === undefined && auth === undefined ? readEnv('ECHONOVA_API_KEY') : options.apiKey;
    if (keyOption != null && typeof keyOption !== 'string') throw new Errors.UsageError('apiKey must be a string');
    const apiKey = keyOption?.trim() || null;
    const baseURL = normalizeBaseURL(options.baseURL?.trim() || readEnv('ECHONOVA_BASE_URL')?.trim() || DEFAULT_BASE_URL);

    const envLevel = readEnv('ECHONOVA_LOG')?.trim().toLowerCase();
    const level: LogLevel = options.logLevel ?? (envLevel === 'warning' ? 'warn' : isLogLevel(envLevel) ? envLevel : 'off');
    const logger = makeLogger(level, options.logger);

    if (apiKey === null && auth === undefined) {
      throw new Errors.UsageError(
        'No API key. Pass `apiKey`, set ECHONOVA_API_KEY, or pass `auth` with `baseURL` (proxy mode).',
      );
    }
    if (apiKey !== null && isBrowserLike() && !options.dangerouslyAllowBrowser) {
      throw new Errors.UnsupportedEnvironmentError(
        'An EchoNova API key was given in a browser-like environment, where anyone using the app can read it. ' +
          'Keep the key on your server and point `baseURL` at your backend (proxy mode), ' +
          'or pass `dangerouslyAllowBrowser: true` if you understand the risk.',
      );
    }
    if (apiKey !== null && !apiKey.startsWith('ek_')) {
      logger.warn("the API key does not start with 'ek_'; check it is an EchoNova API key");
    }
    if (new URL(baseURL).pathname.replace(/\/+$/, '').endsWith('/v1')) {
      logger.warn('baseURL ends with /v1, but request paths already start with /v1');
    }

    const timeout = options.timeout ?? null;
    if (timeout !== null && !(Number.isFinite(timeout) && timeout > 0)) {
      throw new Errors.UsageError('timeout must be a positive number of milliseconds');
    }
    const maxRetries = options.maxRetries ?? loadRules().defaults.maxRetries;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new Errors.UsageError('maxRetries must be a whole number, 0 or more');
    }
    const fetchImpl =
      options.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchImpl) {
      throw new Errors.UnsupportedEnvironmentError('fetch is not available in this runtime; pass `fetch` in the options');
    }

    this.#apiKey = apiKey;
    this.#hasAuthHook = auth !== undefined;
    this.baseURL = baseURL;
    this.timeout = timeout;
    this.maxRetries = maxRetries;

    transports.set(
      this,
      new HttpTransport({
        baseURL,
        fetch: fetchImpl,
        timeout,
        maxRetries,
        defaultHeaders: { ...options.defaultHeaders },
        authHeaders: async (context) => {
          const headers: Record<string, string | null | undefined> = {};
          if (apiKey !== null) headers['Authorization'] = `Bearer ${apiKey}`;
          if (auth) Object.assign(headers, await auth(context));
          return headers;
        },
        userAgent: userAgent(),
        logger,
        rateLimitPreflight: options.rateLimitPreflight ?? true,
        tracker: new RateLimitTracker(),
        policy: new RetryPolicy({ maxRetries }),
      }),
    );
  }

  /** The last rate-limit headers seen for each operation. */
  get rateLimits(): Readonly<Record<string, RateLimitInfo>> {
    return transportOf(this).tracker.snapshot();
  }

  /** `EchoNova(baseURL='https://api.echonova.ai', apiKey='ek_…c21d')`. Never shows the key itself. */
  toString(): string {
    const key = redactKey(this.#apiKey);
    const auth = this.#hasAuthHook ? ', auth=<hook>' : '';
    return `EchoNova(baseURL='${this.baseURL}', apiKey=${key === null ? 'null' : `'${key}'`}${auth})`;
  }

  toJSON(): Record<string, unknown> {
    return { baseURL: this.baseURL, apiKey: redactKey(this.#apiKey), timeout: this.timeout, maxRetries: this.maxRetries };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}
