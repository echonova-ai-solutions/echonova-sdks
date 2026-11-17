/**
 * Clocks, sleeps and randomness used by the client. Tests replace them to run
 * retries, rate-limit waits and job polling without real waiting.
 */

export interface Runtime {
  /** Monotonic time in seconds. */
  clock(): number;
  /** Wall-clock time, for `sentAt` and job timestamps. */
  now(): Date;
  /** Wait `ms` milliseconds; rejects with the signal's reason if it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** A number in [0, 1), for jitter. */
  random(): number;
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

export const defaultRuntime: Runtime = {
  clock: () => performance.now() / 1000,
  now: () => new Date(),
  sleep: defaultSleep,
  random: Math.random,
};

/** A random UUID v4 (`crypto.randomUUID()`, with a fallback for insecure browser contexts). */
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
