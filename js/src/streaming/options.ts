/**
 * Connection settings shared by every stream session.
 *
 * The client builds a `StreamOptions` from its own configuration (URL,
 * credentials, User-Agent, retries). All durations are in milliseconds.
 */

import type { Logger } from '../core/logger.js';
import { RetryPolicy } from '../core/retry.js';
import { UsageError } from '../errors.js';
import type { WsTransport } from '../runtime/ws-transport.js';

export const TTS_PATH = '/v1/text-to-speech/stream';
export const STT_PATH = '/v1/speech-to-text/stream';
export const DEFAULT_WS_BASE_URL = 'wss://api.echonova.ai';

export type StringMap = Readonly<Record<string, string>>;
/** Returns the headers for a connection attempt (called before every attempt). */
export type HeadersProvider = () => StringMap | Promise<StringMap>;
/** Returns query parameters added to the stream URL (called before every attempt). */
export type QueryProvider = () => StringMap | Promise<StringMap>;

/** Monotonic time in milliseconds, and timers. Inject a fake one in tests. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
};

const silent: Logger = { error() {}, warn() {}, info() {}, debug() {} };

export interface StreamOptions {
  /** `wss://api.echonova.ai` by default. An `https://` URL is turned into `wss://`. */
  wsBaseURL?: string | undefined;
  /** Headers for the upgrade request, including `Authorization`. Not sent by browsers. */
  headers?: HeadersProvider | undefined;
  /**
   * Query parameters added to the stream URL, for proxy mode in browsers, where
   * headers can't be set: for example `{ access_token: '<short-lived token>' }`.
   * They are never logged or put in error messages.
   */
  query?: QueryProvider | undefined;
  userAgent?: string | null | undefined;
  /** True when `headers` carries an EchoNova API key. Browsers then refuse to stream (it can't be sent safely). */
  usesApiKey?: boolean | undefined;
  /** Opening handshake timeout. Default 10 s. */
  openTimeout?: number | undefined;
  /** How long a clean close may take before the socket is dropped. Default 5 s. */
  closeTimeout?: number | undefined;
  /** Send a JSON ping after this long without sending anything. Default 30 s; `null` turns keepalive and liveness off. */
  keepalive?: number | null | undefined;
  /** A ping without a pong for this long means the connection is lost. Default 15 s. */
  pongTimeout?: number | undefined;
  /** Nothing received for this long means the connection is lost. Default 60 s. */
  silenceTimeout?: number | undefined;
  retryPolicy?: RetryPolicy | undefined;
  /** Keep retrying "Too many concurrent streams" for up to this long. Default off. */
  waitForSlot?: number | null | undefined;
  /** The same, automatically, when reconnecting after a dropped connection. Default 90 s. */
  reconnectSlotWait?: number | undefined;
  /** At most this many connection attempts per `connectWindow`, per session object. Default 6 per 60 s. */
  maxConnectAttempts?: number | undefined;
  connectWindow?: number | undefined;
  /** Speech to Text: wait this long for `session.started` / `terminology.set`. Default 10 s. */
  sessionStartTimeout?: number | undefined;
  /** Text to Speech: a synthesis with no `start` this long after sending fails. Default 30 s. */
  synthesisStartTimeout?: number | undefined;
  /** Text to Speech: a cancel the server hasn't confirmed after this long counts as done. Default 5 s. */
  cancelAckTimeout?: number | undefined;
  /** Text to Speech: reopen an idle socket after this long, before the server's 30-minute limit. Default 28 min. */
  rotateAfter?: number | undefined;
  /** `transcribeStream`: hand over to a new session this long before the session limit. Default 30 s. */
  rolloverMargin?: number | undefined;
  clock?: Clock | undefined;
  /** A custom WebSocket transport. Chosen from the runtime by default. */
  transport?: WsTransport | undefined;
  logger?: Logger | undefined;
}

export interface ResolvedStreamOptions {
  readonly wsBaseURL: string;
  readonly headers: HeadersProvider;
  readonly query: QueryProvider | null;
  readonly userAgent: string | null;
  readonly usesApiKey: boolean;
  readonly openTimeout: number;
  readonly closeTimeout: number;
  readonly keepalive: number | null;
  readonly pongTimeout: number;
  readonly silenceTimeout: number;
  readonly retryPolicy: RetryPolicy;
  readonly waitForSlot: number | null;
  readonly reconnectSlotWait: number;
  readonly maxConnectAttempts: number;
  readonly connectWindow: number;
  readonly sessionStartTimeout: number;
  readonly synthesisStartTimeout: number;
  readonly cancelAckTimeout: number;
  readonly rotateAfter: number;
  readonly rolloverMargin: number;
  readonly clock: Clock;
  readonly transport: WsTransport | null;
  readonly logger: Logger;
}

const RESOLVED = Symbol('echonova.streamOptions.resolved');

function duration(name: string, value: number | undefined, fallback: number, allowZero = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new UsageError(`${name} must be a positive number of milliseconds`);
  }
  return value;
}

/** Fill in the defaults and check the values. Idempotent. */
export function resolveStreamOptions(options: StreamOptions | ResolvedStreamOptions = {}): ResolvedStreamOptions {
  if ((options as { [RESOLVED]?: boolean })[RESOLVED]) return options as ResolvedStreamOptions;
  const o = options as StreamOptions;
  const keepalive = o.keepalive === null ? null : duration('keepalive', o.keepalive, 30_000);
  const waitForSlot = o.waitForSlot == null ? null : duration('waitForSlot', o.waitForSlot, 0, true);
  const maxConnectAttempts = o.maxConnectAttempts ?? 6;
  if (!Number.isInteger(maxConnectAttempts) || maxConnectAttempts < 1) {
    throw new UsageError('maxConnectAttempts must be a whole number, 1 or more');
  }
  const resolved: ResolvedStreamOptions & { [RESOLVED]: true } = {
    wsBaseURL: o.wsBaseURL?.trim() || DEFAULT_WS_BASE_URL,
    headers: o.headers ?? (() => ({})),
    query: o.query ?? null,
    userAgent: o.userAgent ?? null,
    usesApiKey: o.usesApiKey ?? false,
    openTimeout: duration('openTimeout', o.openTimeout, 10_000),
    closeTimeout: duration('closeTimeout', o.closeTimeout, 5_000),
    keepalive,
    pongTimeout: duration('pongTimeout', o.pongTimeout, 15_000),
    silenceTimeout: duration('silenceTimeout', o.silenceTimeout, 60_000),
    retryPolicy: o.retryPolicy ?? new RetryPolicy(),
    waitForSlot,
    reconnectSlotWait: duration('reconnectSlotWait', o.reconnectSlotWait, 90_000, true),
    maxConnectAttempts,
    connectWindow: duration('connectWindow', o.connectWindow, 60_000),
    sessionStartTimeout: duration('sessionStartTimeout', o.sessionStartTimeout, 10_000),
    synthesisStartTimeout: duration('synthesisStartTimeout', o.synthesisStartTimeout, 30_000),
    cancelAckTimeout: duration('cancelAckTimeout', o.cancelAckTimeout, 5_000),
    rotateAfter: duration('rotateAfter', o.rotateAfter, 28 * 60_000),
    rolloverMargin: duration('rolloverMargin', o.rolloverMargin, 30_000, true),
    clock: o.clock ?? systemClock,
    transport: o.transport ?? null,
    logger: o.logger ?? silent,
    [RESOLVED]: true,
  };
  streamURL(resolved.wsBaseURL, TTS_PATH); // fail early on a bad URL
  return resolved;
}

/**
 * The stream URL for `path` (which starts with `/v1/`). A base URL that already
 * ends in `/v1` is not doubled. `http(s)` becomes `ws(s)`.
 */
export function streamURL(base: string, path: string, query: Readonly<Record<string, string | number>> = {}): string {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    throw new UsageError(`wsBaseURL must be a wss:// (or https://) URL, got ${JSON.stringify(base)}`);
  }
  const scheme = ({ 'https:': 'wss:', 'http:': 'ws:' } as Record<string, string>)[url.protocol] ?? url.protocol;
  if ((scheme !== 'ws:' && scheme !== 'wss:') || !url.host) {
    throw new UsageError(`wsBaseURL must be a wss:// (or https://) URL, got ${JSON.stringify(base)}`);
  }
  let basePath = url.pathname.replace(/\/+$/, '');
  if (basePath.endsWith('/v1') && path.startsWith('/v1/')) basePath = basePath.slice(0, -3);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.append(key, String(value));
  const search = params.toString();
  return `${scheme}//${url.host}${basePath}${path}${search ? `?${search}` : ''}`;
}

/** A URL without its query string, for messages and logs (the query may carry a token). */
export function redactURL(url: string): string {
  const at = url.indexOf('?');
  return at === -1 ? url : url.slice(0, at);
}

/** How `transcribeStream` reconnects after a dropped connection. Times in milliseconds. */
export interface ReconnectPolicy {
  /** Reconnects in a row without a transcript in between. Default 3. */
  maxAttempts?: number | undefined;
  /** Default 500 ms, doubling up to `maxDelay`. */
  initialDelay?: number | undefined;
  /** Default 8 s. */
  maxDelay?: number | undefined;
}

export interface ResolvedReconnectPolicy {
  readonly maxAttempts: number;
  readonly initialDelay: number;
  readonly maxDelay: number;
}

export function resolveReconnectPolicy(policy: ReconnectPolicy = {}): ResolvedReconnectPolicy {
  const maxAttempts = policy.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0) {
    throw new UsageError('reconnect.maxAttempts must be a whole number, 0 or more');
  }
  return {
    maxAttempts,
    initialDelay: duration('reconnect.initialDelay', policy.initialDelay, 500, true),
    maxDelay: duration('reconnect.maxDelay', policy.maxDelay, 8_000, true),
  };
}

/** Milliseconds before reconnect number `attempt` (1-based). */
export function reconnectDelay(policy: ResolvedReconnectPolicy, attempt: number): number {
  return Math.min(policy.maxDelay, policy.initialDelay * 2 ** Math.max(0, attempt - 1));
}
