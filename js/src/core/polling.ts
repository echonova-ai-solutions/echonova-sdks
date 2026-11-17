/** `jobs.wait()` and `jobs.findCandidates()`. */

import {
  APIConnectionError,
  JobFailedError,
  JobWaitTimeoutError,
  ProtocolError,
  RateLimitError,
  RequestTimeoutError,
  ServerError,
  UsageError,
} from '../errors.js';
import type { Logger } from './logger.js';
import type { Page } from './pagination.js';
import type { Runtime } from './runtime.js';

export const TTS_POLL_INTERVAL_MS = 3000;
export const STT_POLL_INTERVAL_MS = 5000;
export const CLEAN_POLL_INTERVAL_MS = 5000;
export const MIN_POLL_INTERVAL_MS = 1000;
export const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
/** Polls per minute per job-get endpoint, below the API's 100 per minute per key. */
export const POLL_RATE = 80;
export const CANDIDATE_WINDOW_MS = 5000;
export const CANDIDATE_PAGE_SIZE = 100;
export const CANDIDATE_MAX_PAGES = 10;

/**
 * The one wait budget of a synchronous call (ADR 0014), shared by its two waits: resending
 * while the first request with its key is still running (an in-progress 409), and polling
 * the job after a `202 Processing`. It starts at the first of them and never runs past the
 * call's deadline. Times are monotonic milliseconds.
 */
export class WaitBudget {
  /** When the call's deadline passes, if it has one. The transport sets it. */
  deadlineAt: number | null = null;
  #endsAt: number | null = null;

  constructor(readonly ms: number) {}

  /** When the budget ends, starting it at `now` if nothing has started it yet. */
  endsAt(now: number): number {
    this.#endsAt ??= Math.min(now + this.ms, this.deadlineAt ?? Infinity);
    return this.#endsAt;
  }
}

/** A sliding-window limit shared by every `wait()` on one client, so many waiters can't exhaust a key. */
export class PollLimiter {
  readonly #clock: () => number;
  readonly #rate: number;
  readonly #period: number;
  readonly #slots = new Map<string, number[]>();

  /** `clock` returns monotonic seconds. */
  constructor(options: { clock: () => number; rate?: number; periodSeconds?: number }) {
    this.#clock = options.clock;
    this.#rate = options.rate ?? POLL_RATE;
    this.#period = options.periodSeconds ?? 60;
  }

  /** Reserve the next free slot for `bucket` and return the seconds to wait for it. */
  reserve(bucket: string): number {
    const now = this.#clock();
    let slots = this.#slots.get(bucket);
    if (!slots) this.#slots.set(bucket, (slots = []));
    while (slots.length > this.#rate && slots[0]! <= now - this.#period) slots.shift();
    let at = Math.max(now, slots.at(-1) ?? now);
    if (slots.length >= this.#rate) at = Math.max(at, slots[slots.length - this.#rate]! + this.#period);
    slots.push(at);
    return at - now;
  }
}

export interface WaitOptions {
  /** Milliseconds between polls (±10% jitter). Defaults to 3000 for Text to Speech and 5000 for Speech to Text. At least 1000. */
  pollInterval?: number | undefined;
  /** Give up after this many milliseconds with `JobWaitTimeoutError`. Default 20 minutes. */
  timeoutMs?: number | undefined;
  /** Throw `JobFailedError` for a failed job (default), or return it. */
  raiseOnFailure?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

interface PolledJob {
  readonly id?: unknown;
  readonly status?: string;
  readonly error?: string | null;
}

/** Errors that may clear by themselves: polling continues after them. */
const isTransient = (error: unknown): boolean =>
  error instanceof APIConnectionError ||
  error instanceof RateLimitError ||
  error instanceof RequestTimeoutError ||
  error instanceof ServerError ||
  error instanceof ProtocolError;

export async function waitForJob<J extends PolledJob>(ctx: {
  jobId: string;
  get: (signal: AbortSignal | undefined) => PromiseLike<J>;
  defaultInterval: number;
  options: WaitOptions;
  limiter: PollLimiter;
  bucket: string;
  runtime: Runtime;
  logger: Logger;
}): Promise<J> {
  const { jobId, options, runtime } = ctx;
  const interval = options.pollInterval ?? ctx.defaultInterval;
  if (!(interval >= MIN_POLL_INTERVAL_MS)) {
    throw new UsageError(`pollInterval must be at least ${MIN_POLL_INTERVAL_MS} ms; the API asks clients not to poll faster`);
  }
  const timeout = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (!(timeout >= 0)) throw new UsageError('timeoutMs must not be negative');
  const signal = options.signal;
  const deadline = runtime.clock() + timeout / 1000;
  let lastJob: J | null = null;
  let lastError: unknown;

  const giveUp = (): JobWaitTimeoutError =>
    new JobWaitTimeoutError(
      `job ${jobId} is still ${lastJob?.status ?? 'unknown'} after ${timeout / 1000} s; calling wait() again is safe`,
      { jobId, lastJob, cause: lastError },
    );

  for (;;) {
    signal?.throwIfAborted();
    const delay = ctx.limiter.reserve(ctx.bucket);
    if (delay > 0) {
      if (runtime.clock() + delay > deadline) throw giveUp();
      await runtime.sleep(delay * 1000, signal);
    }
    let pause = Math.max(MIN_POLL_INTERVAL_MS, interval * (0.9 + 0.2 * runtime.random()));
    try {
      const job = await ctx.get(signal);
      lastJob = job;
      lastError = undefined;
      if (job.status === 'completed') return job;
      if (job.status === 'failed') {
        if (options.raiseOnFailure ?? true) {
          throw new JobFailedError(`job ${jobId} failed: ${job.error || 'no error message'}`, { job });
        }
        return job;
      }
      // Any other status, known or not, means "not finished yet".
    } catch (error) {
      if (!isTransient(error) || signal?.aborted) throw error;
      lastError = error;
      if (error instanceof RateLimitError && error.retryAfter) pause = Math.max(pause, error.retryAfter * 1000);
      ctx.logger.debug(`polling job ${jobId} failed (${(error as Error).name}); polling again in ${(pause / 1000).toFixed(1)} s`);
    }
    if (runtime.clock() + pause / 1000 > deadline) throw giveUp();
    await runtime.sleep(pause, signal);
  }
}

interface CandidateJob {
  readonly id: string;
  readonly createdAt?: string | null;
  readonly text?: string | null;
  readonly stream?: unknown;
}

function toTime(value: Date | string | number, what: string): number {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new UsageError(`${what} must be a Date, such as the sentAt of an APIConnectionError`);
  }
  return time;
}

/**
 * Jobs created at or after `sentAt` minus 5 s, newest first, scanning at most 10
 * pages of 100. Jobs made on a stream are skipped. Never picks one for you.
 */
export async function findCandidates<J extends CandidateJob>(ctx: {
  listPage: (offset: number) => PromiseLike<Page<J>>;
  sentAt: Date | string | number;
  text?: string | undefined;
}): Promise<J[]> {
  const earliest = toTime(ctx.sentAt, 'sentAt') - CANDIDATE_WINDOW_MS;
  const wanted = ctx.text?.trim();
  const found: J[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let pages = 0; pages < CANDIDATE_MAX_PAGES; pages += 1) {
    const page = await ctx.listPage(offset);
    let reachedOlder = false;
    for (const job of page.items) {
      const created = job.createdAt ? Date.parse(job.createdAt) : Number.NaN;
      if (Number.isNaN(created)) continue;
      if (created < earliest) {
        reachedOlder = true;
        continue;
      }
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      if (job.stream != null) continue; // made on a stream: a lost REST request never made it
      if (wanted !== undefined && (job.text ?? '').trim() !== wanted) continue;
      found.push(job);
    }
    if (reachedOlder || !page.hasNextPage()) break;
    offset = page.nextOffset;
  }
  return found;
}
