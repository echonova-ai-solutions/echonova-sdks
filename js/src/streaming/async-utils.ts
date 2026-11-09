/** Small async building blocks for the stream sessions. */

import { abortReason } from '../runtime/ws-transport.js';
import type { Clock } from './options.js';

/**
 * Something changed. `wait()` resolves on the next `notify()`. Waiters re-check
 * their condition after waking, so a missed notify is never a problem as long as
 * the condition is checked before waiting.
 */
export class Signal {
  #promise: Promise<void> | null = null;
  #resolve: (() => void) | null = null;

  wait(): Promise<void> {
    if (this.#promise === null) {
      this.#promise = new Promise<void>((resolve) => {
        this.#resolve = resolve;
      });
    }
    return this.#promise;
  }

  notify(): void {
    const resolve = this.#resolve;
    this.#promise = null;
    this.#resolve = null;
    resolve?.();
  }
}

/** One holder at a time, in arrival order. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await task();
    } finally {
      release();
    }
  }
}

/** Wait `ms` on `clock`. Rejects with the abort reason if `signal` aborts first. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clock.clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = clock.setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolve on the next `signal.notify()` or after `ms`, whichever comes first. Returns true if notified. */
export function waitOrTimeout(signal: Signal, clock: Clock, ms: number | null): Promise<boolean> {
  if (ms === null) return signal.wait().then(() => true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const timer = clock.setTimeout(
      () => {
        if (done) return;
        done = true;
        resolve(false);
      },
      Math.max(0, ms),
    );
    void signal.wait().then(() => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      resolve(true);
    });
  });
}

/** `promise`, or nothing after `ms` (the timer is cleared either way). */
export async function raceTimeout<T>(promise: Promise<T>, clock: Clock, ms: number): Promise<T | undefined> {
  let timer: unknown = null;
  const timeout = new Promise<undefined>((resolve) => {
    timer = clock.setTimeout(() => resolve(undefined), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clock.clearTimeout(timer);
  }
}

/** Mark a promise as handled (its rejection is reported elsewhere) and return it unchanged. */
export function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/** A random UUID v4. */
export function randomId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: <T extends Uint8Array>(a: T) => T } })
    .crypto;
  if (typeof cryptoObj?.randomUUID === 'function') return cryptoObj.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoObj?.getRandomValues === 'function') cryptoObj.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An AbortSignal that aborts when any of `signals` does. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any.call(AbortSignal, signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** An unbounded FIFO with an async `next()`. */
export class AsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<(item: T) => void> = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }

  next(): Promise<T> {
    if (this.#items.length > 0) return Promise.resolve(this.#items.shift() as T);
    return new Promise<T>((resolve) => this.#waiters.push(resolve));
  }
}
