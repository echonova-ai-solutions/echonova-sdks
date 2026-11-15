/**
 * The EchoNova client: configuration, authentication, the HTTP transport and
 * the service namespaces.
 *
 * ```ts
 * import EchoNova from '@echonova/ai';
 * const client = new EchoNova(); // reads ECHONOVA_API_KEY
 * ```
 */

import * as Errors from './errors.js';
import { download as downloadLink, type DownloadOptions } from './core/download.js';
import {
  HttpTransport,
  type AuthContext,
  type FetchLike,
  type HeaderValues,
  type OnRequestHook,
  type OnResponseHook,
} from './core/http.js';
import { isLogLevel, makeLogger, type Logger, type LogLevel } from './core/logger.js';
import { PollLimiter } from './core/polling.js';
import { RateLimitTracker, type RateLimitInfo } from './core/ratelimit.js';
import { RetryPolicy } from './core/retry.js';
import { loadRules } from './core/rules.js';
import { defaultRuntime, type Runtime } from './core/runtime.js';
import { Agents } from './resources/agents.js';
import type { ClientContext } from './resources/resource.js';
import type { QueryProvider, StreamOptions } from './streaming/options.js';
import { SoundCleaning } from './resources/sound-cleaning.js';
import { SpeechToText } from './resources/speech-to-text.js';
import { TextToSpeech } from './resources/text-to-speech.js';
import { Widgets } from './resources/widgets.js';
import { isBrowserLike, readEnv, runtimeInfo } from './runtime/detect.js';
import { VERSION } from './version.js';

export type { AuthContext, FetchLike, OnRequestHook, OnResponseHook, RequestDetails } from './core/http.js';

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
  /** Total milliseconds for one call, retries and rate-limit waits included. Default: none. */
  deadline?: number | undefined;
  /**
   * Wait for the rate-limit window to reset when the last response said no
   * requests remain, instead of sending a request that would be throttled. Default true.
   */
  rateLimitPreflight?: boolean | undefined;
  /** Headers sent with every API request. A `null` value removes a default header. */
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
  /** Called before each attempt of an API call (not downloads). It may change the headers. */
  onRequest?: OnRequestHook | undefined;
  /** Called with each API response (not downloads), after the SDK has read its body. */
  onResponse?: OnResponseHook | undefined;
  /** Settings for streaming sessions (`textToSpeech.connect()`, `speechToText.connect()`, ...). */
  stream?: StreamClientOptions | undefined;
}

/** Streaming settings on the client. Durations are in milliseconds. */
export interface StreamClientOptions {
  /**
   * Query parameters added to the stream URL, called before every connection
   * attempt. For proxy mode in browsers, which can't set headers on a WebSocket:
   * for example `async () => ({ access_token: await getStreamToken() })`.
   */
  query?: QueryProvider | undefined;
  /** Send a keepalive ping after this long without sending anything. Default 30 s; `null` turns it off. */
  keepalive?: number | null | undefined;
  /** Keep retrying "Too many concurrent streams" for up to this long. Default off. */
  waitForSlot?: number | null | undefined;
  /** Opening handshake timeout. Default 10 s. */
  openTimeout?: number | undefined;
}

/** Client-side rate-limit state for one API key, shared with `withOptions()` copies. */
interface Limits {
  tracker: RateLimitTracker;
  limiter: PollLimiter;
}

/** @internal Options the SDK and its tests pass between clients. Not part of the public API. */
export interface InternalClientOptions extends ClientOptions {
  _runtime?: Partial<Runtime> | undefined;
  _shared?: { lifecycle: AbortController; limits: Limits | undefined } | undefined;
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

/** Merge header sets: later ones win, names compared case-insensitively, `null` removes. */
function mergeHeaders(...sources: Array<HeaderValues | undefined>): Record<string, string> {
  const merged = new Map<string, [string, string]>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value === null) merged.delete(name.toLowerCase());
      else if (value !== undefined) merged.set(name.toLowerCase(), [name, value]);
    }
  }
  return Object.fromEntries(merged.values());
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

  // --- Resources --------------------------------------------------------------------------
  /** Text to Speech: `generate`, `voices` and async `jobs`. */
  readonly textToSpeech: TextToSpeech;
  /** Speech to Text: `transcribe` and async `jobs` with transcript export. */
  readonly speechToText: SpeechToText;
  /** Sound Cleaning: `clean` and its `jobs`. */
  readonly soundCleaning: SoundCleaning;
  /** Agents widget tickets. */
  readonly widgets: Widgets;
  /** Live agent sessions. */
  readonly agents: Agents;

  readonly #apiKey: string | null;
  readonly #auth: AuthHook | undefined;
  readonly #options: InternalClientOptions;
  readonly #lifecycle: AbortController;
  readonly #ownsLifecycle: boolean;
  readonly #limits: Limits;
  readonly #runtime: Runtime;
  readonly #logger: Logger;
  readonly #policy: RetryPolicy;
  readonly #fetch: FetchLike;
  readonly #userAgent: string | null;
  readonly #rateLimitPreflight: boolean;

  constructor(options: ClientOptions = {}) {
    const internal = options as InternalClientOptions;
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
    if (!internal._shared) {
      if (apiKey !== null && !apiKey.startsWith('ek_')) {
        logger.warn("the API key does not start with 'ek_'; check it is an EchoNova API key");
      }
      if (new URL(baseURL).pathname.replace(/\/+$/, '').endsWith('/v1')) {
        logger.warn('baseURL ends with /v1, but request paths already start with /v1');
      }
    }

    const timeout = options.timeout ?? null;
    if (timeout !== null && !(Number.isFinite(timeout) && timeout > 0)) {
      throw new Errors.UsageError('timeout must be a positive number of milliseconds');
    }
    const deadline = options.deadline ?? null;
    if (deadline !== null && !(Number.isFinite(deadline) && deadline > 0)) {
      throw new Errors.UsageError('deadline must be a positive number of milliseconds');
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

    const runtime: Runtime = { ...defaultRuntime, ...internal._runtime };
    const shared = internal._shared;
    this.#apiKey = apiKey;
    this.#auth = auth;
    this.#options = { ...options, apiKey, baseURL };
    this.#lifecycle = shared?.lifecycle ?? new AbortController();
    this.#ownsLifecycle = shared === undefined;
    this.#limits = shared?.limits ?? {
      tracker: new RateLimitTracker({ clock: runtime.clock }),
      limiter: new PollLimiter({ clock: runtime.clock }),
    };
    this.#runtime = runtime;
    this.#logger = logger;
    this.#policy = new RetryPolicy({ maxRetries, random: runtime.random });
    this.#fetch = fetchImpl;
    this.#userAgent = userAgent();
    this.#rateLimitPreflight = options.rateLimitPreflight ?? true;
    this.baseURL = baseURL;
    this.timeout = timeout;
    this.maxRetries = maxRetries;

    const transport = new HttpTransport({
      baseURL,
      fetch: fetchImpl,
      timeout,
      maxRetries,
      deadline,
      defaultHeaders: { ...options.defaultHeaders },
      authHeaders: (context) => this.#credentials(context),
      userAgent: this.#userAgent,
      logger,
      rateLimitPreflight: this.#rateLimitPreflight,
      tracker: this.#limits.tracker,
      policy: this.#policy,
      onRequest: options.onRequest,
      onResponse: options.onResponse,
      closeSignal: this.#lifecycle.signal,
      sleep: runtime.sleep,
      now: () => runtime.clock() * 1000,
      date: runtime.now,
    });
    transports.set(this, transport);

    const context: ClientContext = {
      transport,
      limiter: this.#limits.limiter,
      runtime,
      logger,
      download: (url, opts) => this.download(url, opts),
      streamOptions: () => this._streamOptions(),
    };
    this.textToSpeech = new TextToSpeech(context);
    this.speechToText = new SpeechToText(context);
    this.soundCleaning = new SoundCleaning(context);
    this.widgets = new Widgets(context);
    this.agents = new Agents(context);
  }

  /** The API key and the `auth` hook's headers, for one request. */
  async #credentials(context: AuthContext): Promise<Record<string, string | null | undefined>> {
    const headers: Record<string, string | null | undefined> = {};
    if (this.#apiKey !== null) headers['Authorization'] = `Bearer ${this.#apiKey}`;
    if (this.#auth) Object.assign(headers, await this.#auth(context));
    return headers;
  }

  /** The last rate-limit headers seen for each operation (`"textToSpeech.jobs.get"`, ...). */
  get rateLimits(): Readonly<Record<string, RateLimitInfo>> {
    return this.#limits.tracker.snapshot();
  }

  /**
   * A copy with some options changed. It shares this client's lifecycle and, when
   * the key, `baseURL` and `auth` are unchanged, its rate-limit state. Close this
   * client, not the copy.
   */
  withOptions(options: ClientOptions = {}): EchoNova {
    const changes = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as ClientOptions;
    const merged: InternalClientOptions = { ...this.#options, ...changes };
    const sameIdentity =
      merged.apiKey === this.#options.apiKey && merged.baseURL === this.#options.baseURL && merged.auth === this.#options.auth;
    merged._runtime = this.#runtime;
    merged._shared = { lifecycle: this.#lifecycle, limits: sameIdentity ? this.#limits : undefined };
    return new EchoNova(merged);
  }

  /**
   * Download a signed link (`audioUrl`, `outputUrl`) without sending your API
   * key, retrying transient failures. With `to` (Node.js, Bun, Deno), streams to
   * that file (or into that directory, keeping the link's file name) and resolves
   * to the path; otherwise resolves to the bytes. An expired link throws
   * `DownloadExpiredError`: get the job again for a fresh one.
   */
  download(url: string | null | undefined, options: DownloadOptions & { to: string }): Promise<string>;
  download(url: string | null | undefined, options?: DownloadOptions): Promise<Uint8Array>;
  download(url: string | null | undefined, options?: DownloadOptions): Promise<Uint8Array | string> {
    return downloadLink(
      {
        fetch: this.#fetch,
        userAgent: this.#userAgent,
        policy: this.#policy,
        runtime: this.#runtime,
        logger: this.#logger,
        closeSignal: this.#lifecycle.signal,
      },
      url,
      options,
    );
  }

  /**
   * Stop using this client: in-flight requests are cancelled and new ones throw
   * `UsageError`. Copies made with `withOptions()` close with it; closing a copy does nothing.
   */
  async close(): Promise<void> {
    if (this.#ownsLifecycle && !this.#lifecycle.signal.aborted) {
      this.#lifecycle.abort(new Errors.UsageError('the client was closed'));
    }
  }

  /** `await using client = new EchoNova()` closes the client at the end of the scope. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // --- For the streaming layer (internal; not part of the public API) ----------------------

  /** @internal The WebSocket base URL: `https` becomes `wss` and `http` becomes `ws`. */
  get _wsBaseURL(): string {
    return this.baseURL.replace(/^http/, 'ws');
  }

  /**
   * @internal Headers for one WebSocket upgrade: `defaultHeaders`, then the API key
   * (`Authorization`), then the `auth` hook's headers. Never log the result.
   */
  async _authHeaders(context: AuthContext = { method: 'GET', url: this._wsBaseURL }): Promise<Record<string, string>> {
    return mergeHeaders(this.#options.defaultHeaders, await this.#credentials(context));
  }

  /** @internal The `User-Agent` to send, or null in browsers (which don't allow setting it). */
  get _userAgent(): string | null {
    return this.#userAgent;
  }

  /** @internal The retry policy (maxRetries, backoff, the shared retry table). */
  get _retryPolicy(): RetryPolicy {
    return this.#policy;
  }

  /** @internal Per-operation rate-limit state, shared with `withOptions()` copies for the same key. */
  get _rateLimitTracker(): RateLimitTracker {
    return this.#limits.tracker;
  }

  /** @internal Whether calls wait for an exhausted rate-limit window before sending. */
  get _rateLimitPreflight(): boolean {
    return this.#rateLimitPreflight;
  }

  /** @internal Stream settings derived from this client: URL, credentials, User-Agent, retries. */
  _streamOptions(): StreamOptions {
    const stream = this.#options.stream ?? {};
    return {
      wsBaseURL: this._wsBaseURL,
      headers: () => this._authHeaders(),
      query: stream.query,
      userAgent: this._userAgent,
      usesApiKey: this.#apiKey !== null,
      retryPolicy: this._retryPolicy,
      logger: this._logger,
      keepalive: stream.keepalive,
      waitForSlot: stream.waitForSlot,
      openTimeout: stream.openTimeout,
    };
  }

  /** @internal The client's logger (already filtered by level). */
  get _logger(): Logger {
    return this.#logger;
  }

  /** @internal Clock, sleep and randomness (replaced in tests). */
  get _runtime(): Runtime {
    return this.#runtime;
  }

  /** @internal Aborts when the client is closed. */
  get _closeSignal(): AbortSignal {
    return this.#lifecycle.signal;
  }

  /** `EchoNova(baseURL='https://api.echonova.ai', apiKey='ek_…c21d')`. Never shows the key itself. */
  toString(): string {
    const key = redactKey(this.#apiKey);
    const auth = this.#auth ? ', auth=<hook>' : '';
    return `EchoNova(baseURL='${this.baseURL}', apiKey=${key === null ? 'null' : `'${key}'`}${auth})`;
  }

  toJSON(): Record<string, unknown> {
    return { baseURL: this.baseURL, apiKey: redactKey(this.#apiKey), timeout: this.timeout, maxRetries: this.maxRetries };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}
