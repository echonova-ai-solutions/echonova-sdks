/**
 * Track EchoNova's per-key, per-endpoint rate limits on the client side.
 *
 * The API allows 100 requests per 60 s for each key on each endpoint. After a
 * throttle 429, every caller on that endpoint waits out `Retry-After` before
 * sending again, instead of each one finding out separately.
 * `X-RateLimit-Reset` and `Retry-After` are read as seconds from now.
 */

import { header, type HeadersLike } from './envelope.js';
import { parseFloatStrict, parseIntStrict } from './text.js';

export interface RateLimitInfo {
  readonly limit: number | null;
  readonly remaining: number | null;
  /** Seconds until the window resets, as of when the response arrived. */
  readonly resetSeconds: number | null;
}

const int = (value: string | null): number | null => (value === null ? null : parseIntStrict(value));
const float = (value: string | null): number | null => (value === null ? null : parseFloatStrict(value));

export function parseRateLimit(headers: HeadersLike): RateLimitInfo | null {
  const limit = int(header(headers, 'x-ratelimit-limit'));
  const remaining = int(header(headers, 'x-ratelimit-remaining'));
  const resetSeconds = float(header(headers, 'x-ratelimit-reset'));
  if (limit === null && remaining === null && resetSeconds === null) return null;
  return { limit, remaining, resetSeconds };
}

interface Bucket {
  info: RateLimitInfo | null;
  windowEndsAt: number | null;
  blockedUntil: number;
}

const monotonicSeconds = (): number => performance.now() / 1000;

/** `b` if it is greater than `a`, else `a` (so a NaN never wins). */
const larger = (a: number, b: number): number => (b > a ? b : a);

/** Per-bucket state. A bucket is one API operation (the server counts per key per endpoint). */
export class RateLimitTracker {
  readonly #clock: () => number;
  readonly #buckets = new Map<string, Bucket>();

  /** `clock` returns the current time in seconds (monotonic). */
  constructor(options: { clock?: (() => number) | undefined } = {}) {
    this.#clock = options.clock ?? monotonicSeconds;
  }

  #bucket(name: string): Bucket {
    let state = this.#buckets.get(name);
    if (!state) {
      state = { info: null, windowEndsAt: null, blockedUntil: 0 };
      this.#buckets.set(name, state);
    }
    return state;
  }

  observe(bucket: string, headers: HeadersLike): RateLimitInfo | null {
    const info = parseRateLimit(headers);
    if (info === null) return null;
    const state = this.#bucket(bucket);
    state.info = info;
    state.windowEndsAt = info.resetSeconds === null ? null : this.#clock() + info.resetSeconds;
    return info;
  }

  /** Record a throttle 429: nothing goes to this bucket for `seconds`. */
  block(bucket: string, seconds: number): void {
    const state = this.#bucket(bucket);
    state.blockedUntil = larger(state.blockedUntil, this.#clock() + seconds);
  }

  /** Seconds to wait before sending to `bucket` (0 when it's clear). */
  waitTime(bucket: string, options: { preflight?: boolean | undefined } = {}): number {
    const state = this.#buckets.get(bucket);
    if (!state) return 0;
    const now = this.#clock();
    let wait = state.blockedUntil - now;
    if ((options.preflight ?? true) && state.info !== null && state.info.remaining === 0 && state.windowEndsAt !== null) {
      wait = larger(wait, state.windowEndsAt - now);
    }
    return larger(0, wait);
  }

  last(bucket: string): RateLimitInfo | null {
    return this.#buckets.get(bucket)?.info ?? null;
  }

  snapshot(): Record<string, RateLimitInfo> {
    const out: Record<string, RateLimitInfo> = {};
    for (const [name, state] of this.#buckets) {
      if (state.info !== null) out[name] = state.info;
    }
    return out;
  }
}
