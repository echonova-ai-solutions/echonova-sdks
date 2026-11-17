/**
 * Decide whether a failed attempt may be retried, and after how long.
 *
 * Pure logic over the shared retry table in `spec/error-rules.json`. The table
 * never retries a POST that may already have run, because it would run and be
 * charged again; the exception is a POST that carries an `Idempotency-Key`
 * (method `POST_IDEMPOTENT`, ADR 0014), which the server runs at most once.
 */

import { loadRules, type Delay, type Executed, type Phase, type RetryFlag, type Rule, type RuleSet } from './rules.js';

export type RetryReason =
  | 'retry'
  | 'not_retryable'
  | 'not_opted_in'
  | 'max_retries'
  | 'body_not_replayable'
  | 'retry_after_too_long'
  | 'missing_retry_after';

export interface RetryDecision {
  retry: boolean;
  /** Seconds to wait before the retry (0 when not retrying). */
  delay: number;
  row: string;
  mayHaveExecuted: Executed;
  reason: RetryReason;
}

export interface RetryPolicyOptions {
  maxRetries?: number | undefined;
  /** Longest `Retry-After` (seconds) the SDK waits for on REST; longer ones raise. */
  maxRetryAfter?: number | undefined;
  rules?: RuleSet | undefined;
  /** Random source in [0, 1), for jitter. */
  random?: (() => number) | undefined;
}

export interface DecideStatusOptions {
  retriesDone: number;
  retryAfter: number | null;
  bodyReplayable?: boolean | undefined;
  waitForSlot?: boolean | undefined;
}

export interface DecideTransportOptions {
  retriesDone: number;
  bodyReplayable?: boolean | undefined;
}

export class RetryPolicy {
  readonly rules: RuleSet;
  readonly maxRetries: number;
  readonly maxRetryAfter: number;
  readonly #random: () => number;

  constructor(options: RetryPolicyOptions = {}) {
    this.rules = options.rules ?? loadRules();
    const defaults = this.rules.defaults;
    this.maxRetries = options.maxRetries ?? defaults.maxRetries;
    this.maxRetryAfter = options.maxRetryAfter ?? defaults.maxRetryAfter;
    this.#random = options.random ?? Math.random;
  }

  /** Delay in seconds before retry number `retryNumber` (1-based), with jitter. */
  backoff(retryNumber: number): number {
    const d = this.rules.defaults;
    const base = Math.min(d.backoffMax, d.backoffInitial * d.backoffMultiplier ** (retryNumber - 1));
    const [low, high] = d.backoffJitter;
    return base * (low + (high - low) * this.#random());
  }

  #retryAfterDelay(retryAfter: number): number {
    const [low, high] = this.rules.defaults.retryAfterJitter;
    return retryAfter + low + (high - low) * this.#random();
  }

  /** Decide for an HTTP error status (`method` is GET/DELETE/POST/POST_IDEMPOTENT, or WS for a handshake). */
  decideStatus(method: string, rule: Rule, options: DecideStatusOptions): RetryDecision {
    const flag = rule.retry.forMethod(method);
    const maxRetryAfter = method.toUpperCase() === 'WS' ? this.rules.defaults.wsMaxRetryAfter : this.maxRetryAfter;
    return this.#decide(flag, rule.retry.delay, {
      row: rule.row,
      executed: rule.mayHaveExecuted,
      retriesDone: options.retriesDone,
      retryAfter: options.retryAfter,
      bodyReplayable: options.bodyReplayable ?? true,
      optedIn: options.waitForSlot ?? false,
      maxRetryAfter,
    });
  }

  /** Decide for a failure without an HTTP status (connect error, timeout, broken body...). */
  decideTransport(method: string, phase: Phase, options: DecideTransportOptions): RetryDecision {
    const row = this.rules.transportRule(phase);
    return this.#decide(row.retry.forMethod(method), row.retry.delay, {
      row: row.row,
      executed: row.mayHaveExecuted,
      retriesDone: options.retriesDone,
      retryAfter: null,
      bodyReplayable: options.bodyReplayable ?? true,
      optedIn: false,
      maxRetryAfter: this.maxRetryAfter,
    });
  }

  #decide(
    flag: RetryFlag,
    delayKind: Delay,
    ctx: {
      row: string;
      executed: Executed;
      retriesDone: number;
      retryAfter: number | null;
      bodyReplayable: boolean;
      optedIn: boolean;
      maxRetryAfter: number;
    },
  ): RetryDecision {
    const no = (reason: RetryReason): RetryDecision => ({
      retry: false,
      delay: 0,
      row: ctx.row,
      mayHaveExecuted: ctx.executed,
      reason,
    });

    if (flag === false || delayKind === 'none') return no('not_retryable');
    if (flag === 'opt_in' && !ctx.optedIn) return no('not_opted_in');
    if (flag === 'once' && ctx.retriesDone >= 1) return no('max_retries');
    if (ctx.retriesDone >= this.maxRetries) return no('max_retries');
    if (!ctx.bodyReplayable) return no('body_not_replayable');

    let delay: number;
    if ((delayKind === 'retry_after' || delayKind === 'retry_after_or_backoff') && ctx.retryAfter !== null) {
      if (ctx.retryAfter > ctx.maxRetryAfter) return no('retry_after_too_long');
      delay = this.#retryAfterDelay(ctx.retryAfter);
    } else if (delayKind === 'retry_after') {
      return no('missing_retry_after');
    } else {
      delay = this.backoff(ctx.retriesDone + 1);
    }
    return { retry: true, delay, row: ctx.row, mayHaveExecuted: ctx.executed, reason: 'retry' };
  }
}
