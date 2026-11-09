/**
 * Transport rules shared by every WebSocket driver (sans-IO).
 *
 * - `encodeJson` checks the 64 KiB frame limit locally, so an oversized frame
 *   raises `UsageError` instead of the server closing the socket.
 * - `Liveness` decides when to send an app-level ping and when to give up on a
 *   silent connection.
 * - `AttemptLimiter` caps connection attempts per session object.
 * - `HandshakeRetry` decides whether a failed handshake is retried.
 *
 * Times are in milliseconds.
 */

import { buildStatusError, classifyResponse } from '../core/classifier.js';
import type { BodyBytes, HeadersLike } from '../core/envelope.js';
import type { RetryPolicy } from '../core/retry.js';
import { APIConnectionError, APITimeoutError, UsageError, type EchoNovaError } from '../errors.js';
import { redactURL } from './options.js';

export const MAX_JSON_FRAME_BYTES = 65_536;
export const MAX_INBOUND_BYTES = 16 * 1024 * 1024;
export const PING_FRAME = '{"type":"ping"}';

export type LinkAction = 'ping' | 'lost_pong' | 'lost_silence';

/** UTF-8 byte length of a string, without encoding it. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Serialize a JSON frame; throw `UsageError` if it is over the 64 KiB frame limit. Nothing is sent then. */
export function encodeJson(payload: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(payload);
  const size = utf8Length(text);
  if (size > MAX_JSON_FRAME_BYTES) {
    const kind = typeof payload['type'] === 'string' ? payload['type'] : 'frame';
    throw new UsageError(
      `the ${kind} frame is ${size.toLocaleString('en-US')} bytes; stream frames are limited to ` +
        `${MAX_JSON_FRAME_BYTES.toLocaleString('en-US')} bytes. Nothing was sent.`,
    );
  }
  return text;
}

/** Parse an inbound text frame. Anything that isn't a JSON object comes back without a `type`. */
export function decodeEvent(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { raw_text: text.slice(0, 4096) };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return { raw_value: value };
}

/**
 * Keepalive and liveness timers for one socket.
 *
 * The SDK sends `{"type":"ping"}` when it hasn't sent a data frame for
 * `keepalive` ms, so an open socket never reaches the stream's idle timeout.
 * The connection counts as lost when a ping gets no `pong` within
 * `pongTimeout`, or nothing at all arrives for `silenceTimeout`.
 * `keepalive: null` turns all of this off.
 */
export class Liveness {
  readonly keepalive: number | null;
  readonly pongTimeout: number;
  readonly silenceTimeout: number;
  lastSent: number;
  lastReceived: number;
  pingSentAt: number | null = null;

  constructor(now: number, options: { keepalive: number | null; pongTimeout: number; silenceTimeout: number }) {
    this.keepalive = options.keepalive;
    this.pongTimeout = options.pongTimeout;
    this.silenceTimeout = options.silenceTimeout;
    this.lastSent = now;
    this.lastReceived = now;
  }

  sent(now: number): void {
    this.lastSent = now;
  }

  pingSent(now: number): void {
    this.lastSent = now;
    if (this.pingSentAt === null) this.pingSentAt = now;
  }

  received(now: number): void {
    this.lastReceived = now;
  }

  pong(now: number): void {
    this.lastReceived = now;
    this.pingSentAt = null;
  }

  poll(now: number): LinkAction | null {
    if (this.keepalive === null) return null;
    if (this.pingSentAt !== null && now - this.pingSentAt >= this.pongTimeout) return 'lost_pong';
    if (now - this.lastReceived >= this.silenceTimeout) return 'lost_silence';
    if (this.pingSentAt === null && now - this.lastSent >= this.keepalive) return 'ping';
    return null;
  }

  nextDeadline(): number | null {
    if (this.keepalive === null) return null;
    const silence = this.lastReceived + this.silenceTimeout;
    const other = this.pingSentAt !== null ? this.pingSentAt + this.pongTimeout : this.lastSent + this.keepalive;
    return Math.min(silence, other);
  }

  describe(action: LinkAction): string {
    if (action === 'lost_pong') return `no pong within ${seconds(this.pongTimeout)} s of a ping`;
    return `nothing received for ${seconds(this.silenceTimeout)} s`;
  }
}

const seconds = (ms: number): string => String(Math.round(ms) / 1000);

/**
 * At most `maxAttempts` connection attempts per `window` ms, per session object.
 * This protects the API key's connection budget when something keeps failing.
 */
export class AttemptLimiter {
  readonly #attempts: number[] = [];

  constructor(
    readonly maxAttempts = 6,
    readonly window = 60_000,
  ) {}

  waitTime(now: number): number {
    while (this.#attempts.length > 0 && now - (this.#attempts[0] as number) >= this.window) this.#attempts.shift();
    if (this.#attempts.length < this.maxAttempts) return 0;
    return (this.#attempts[0] as number) + this.window - now;
  }

  record(now: number): void {
    this.#attempts.push(now);
  }

  error(): APIConnectionError {
    return new APIConnectionError(
      `not connecting: this session already made ${this.maxAttempts} connection attempts in the last ${seconds(this.window)} s`,
      { mayHaveExecuted: false, retryDisabledReason: 'attempt_limit' },
    );
  }
}

/**
 * Retry decisions for one connect call.
 *
 * Status errors follow the shared retry table's WS column. "Too many concurrent
 * streams" is retried only with `waitForSlot`, or automatically for up to
 * `slotWaitAfterLoss` ms when reconnecting after a dropped connection, in case
 * the dropped connection still counts against the limit for a while.
 */
export class HandshakeRetry {
  readonly policy: RetryPolicy;
  readonly started: number;
  retries = 0;
  readonly slotBudget: number | null;
  #waitingForSlot = false;

  constructor(
    policy: RetryPolicy,
    options: { now: number; waitForSlot: number | null; afterAbnormal: boolean; slotWaitAfterLoss: number },
  ) {
    this.policy = policy;
    this.started = options.now;
    const budgets = [options.waitForSlot, options.afterAbnormal ? options.slotWaitAfterLoss : null].filter(
      (b): b is number => typeof b === 'number' && b > 0,
    );
    this.slotBudget = budgets.length > 0 ? Math.max(...budgets) : null;
  }

  /** Whether a wait (for the attempt limiter) fits in the slot-wait budget. */
  mayWait(now: number, delay: number): boolean {
    return this.#waitingForSlot && this.slotBudget !== null && now + delay - this.started <= this.slotBudget;
  }

  /** The delay (ms) before the next attempt, or throw the handshake's error. */
  onStatus(status: number, headers: HeadersLike, body: BodyBytes, now: number): number {
    const error = buildStatusError(status, headers, body, { method: 'WS', transport: 'websocket' });
    const { rule, retryAfter } = classifyResponse(status, headers, body);
    const decision = this.policy.decideStatus('WS', rule, {
      retriesDone: this.retries,
      retryAfter,
      waitForSlot: this.slotBudget !== null,
    });
    if (rule.id === 'concurrent_streams' && this.slotBudget !== null) {
      if (decision.reason === 'retry' || decision.reason === 'max_retries') {
        const delay = this.policy.backoff(Math.min(this.retries + 1, 6)) * 1000;
        if (now + delay - this.started <= this.slotBudget) {
          this.retries += 1;
          this.#waitingForSlot = true;
          return delay;
        }
      }
      throw error;
    }
    this.#waitingForSlot = false;
    if (decision.retry) {
      this.retries += 1;
      return decision.delay * 1000;
    }
    throw error;
  }

  /** The delay (ms) before the next attempt, or throw a connection error. */
  onNetwork(cause: unknown, url: string, timedOut: boolean): number {
    this.#waitingForSlot = false;
    const decision = this.policy.decideTransport('WS', 'connect', { retriesDone: this.retries });
    if (decision.retry) {
      this.retries += 1;
      return decision.delay * 1000;
    }
    throw networkError(cause, url, timedOut);
  }
}

export function networkError(cause: unknown, url: string, timedOut: boolean): EchoNovaError {
  const where = redactURL(url);
  if (timedOut) {
    return new APITimeoutError(`timed out opening the stream at ${where}`, { kind: 'connect', mayHaveExecuted: false, cause });
  }
  const detail = cause instanceof Error ? cause.message || cause.name : String(cause);
  return new APIConnectionError(`could not open the stream at ${where}: ${detail}`, { mayHaveExecuted: false, cause });
}
