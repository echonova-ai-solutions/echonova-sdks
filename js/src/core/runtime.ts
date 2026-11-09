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
