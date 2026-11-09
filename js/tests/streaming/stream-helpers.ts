/** Helpers shared by the streaming tests. */

import { RetryPolicy } from '../../src/core/retry.js';
import type { Clock, StreamOptions } from '../../src/streaming/options.js';
import { TEST_KEY } from '../helpers.js';
import type { MockServer } from './mock-server.js';

export { TEST_KEY };

/** The real retry table, with tiny backoff delays so tests stay fast. */
export class FastRetry extends RetryPolicy {
  constructor() {
    super({ random: () => 0 });
  }

  override backoff(): number {
    return 0.01;
  }
}

/** A manual clock: timers fire only when the test advances time. */
export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; seq: number; fn: () => void }>();

  constructor(start = 1_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), seq: id, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pending(): number {
    return this.#timers.size;
  }

  /** The time of the next timer, or null. */
  nextAt(): number | null {
    let next: number | null = null;
    for (const timer of this.#timers.values()) if (next === null || timer.at < next) next = timer.at;
    return next;
  }

  /** Move time forward, firing due timers in order (and letting promise callbacks run between them). */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await flush();
      let due: { id: number; at: number; seq: number; fn: () => void } | null = null;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && (due === null || timer.at < due.at || (timer.at === due.at && timer.seq < due.seq))) {
          due = { id, ...timer };
        }
      }
      if (due === null) break;
      this.#timers.delete(due.id);
      this.#now = Math.max(this.#now, due.at);
      due.fn();
    }
    this.#now = target;
    await flush();
  }
}

/** Let pending promise callbacks run. */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function optionsFor(server: MockServer, overrides: Partial<StreamOptions> = {}): StreamOptions {
  return {
    wsBaseURL: server.url,
    headers: () => ({ Authorization: `Bearer ${TEST_KEY}` }),
    userAgent: 'echonova-js/test',
    openTimeout: 3_000,
    closeTimeout: 1_000,
    retryPolicy: new FastRetry(),
    sessionStartTimeout: 3_000,
    ...overrides,
  };
}

/** Wait (in real time) until `predicate` holds. */
export async function waitFor(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Test audio: a repeating ramp of whole 16-bit samples. */
export function pcm(seconds: number, sampleRate = 16_000): Uint8Array {
  const count = Math.floor(seconds * sampleRate);
  const out = new Uint8Array(count * 2);
  for (let i = 0; i < out.length; i++) out[i] = i % 251;
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Capture what the SDK logs. */
export function captureLogger(): { lines: string[]; logger: { error(m: string): void; warn(m: string): void; info(m: string): void; debug(m: string): void } } {
  const lines: string[] = [];
  const push = (level: string) => (message: string) => lines.push(`${level}: ${message}`);
  return { lines, logger: { error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug') } };
}
