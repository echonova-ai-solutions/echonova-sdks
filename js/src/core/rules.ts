/**
 * The shared error-classification and retry rules (`spec/error-rules.json`).
 *
 * The data is the same in every EchoNova SDK; `rules.generated.ts` holds this
 * package's copy. This module only parses it and answers "which rule matches
 * this response?". Deciding whether to retry is in `retry.ts`.
 */

import { RULES_DATA } from './rules.generated.js';
import { strip } from './text.js';

export type RetryFlag = boolean | 'once' | 'opt_in';
export type Delay = 'none' | 'backoff' | 'retry_after' | 'retry_after_or_backoff';
export type Executed = 'no' | 'yes' | 'unknown';
export type Phase = 'connect' | 'send_incomplete' | 'no_response' | 'malformed_success';

/**
 * The retry column for a POST sent with an `Idempotency-Key` to an operation that
 * accepts one (ADR 0014): sending it again can't run it twice.
 */
export const POST_IDEMPOTENT = 'POST_IDEMPOTENT';

// --- Shape of the JSON data -----------------------------------------------------------------

export interface RetryColumnsData {
  GET: RetryFlag;
  DELETE: RetryFlag;
  POST: RetryFlag;
  POST_IDEMPOTENT: RetryFlag;
  WS: RetryFlag;
  delay: Delay;
}

export interface RuleMatchData {
  status?: number | number[];
  status_range?: [number, number];
  message_equals?: string;
  message_prefix?: string;
  message_suffix?: string;
  message_contains?: string;
  json?: boolean;
  retry_after?: boolean;
}

export interface RuleData {
  id: string;
  row: string;
  match: RuleMatchData;
  error: string;
  retry: RetryColumnsData;
  may_have_executed: Executed;
  blocks_bucket?: boolean;
  from_proxy?: boolean;
}

export interface TransportRuleData {
  row: string;
  phase: string;
  error: string;
  retry: RetryColumnsData;
  may_have_executed: Executed;
}

export interface RulesData {
  version: number;
  taxonomy: Record<string, string | null>;
  transport: TransportRuleData[];
  rules: RuleData[];
  defaults: {
    max_retries: number;
    backoff: { initial_seconds: number; multiplier: number; max_seconds: number; jitter: [number, number] };
    retry_after_jitter_seconds: [number, number];
    max_retry_after_seconds: number;
    ws_handshake_max_retry_after_seconds: number;
  };
}

// --- Parsed rules ---------------------------------------------------------------------------

export class RetryColumns {
  readonly get: RetryFlag;
  readonly delete: RetryFlag;
  readonly post: RetryFlag;
  /** A POST that carries an `Idempotency-Key` (see `POST_IDEMPOTENT`). */
  readonly postIdempotent: RetryFlag;
  readonly ws: RetryFlag;
  readonly delay: Delay;

  constructor(get: RetryFlag, del: RetryFlag, post: RetryFlag, postIdempotent: RetryFlag, ws: RetryFlag, delay: Delay) {
    this.get = get;
    this.delete = del;
    this.post = post;
    this.postIdempotent = postIdempotent;
    this.ws = ws;
    this.delay = delay;
  }

  /** The retry flag for a REST method, `"POST_IDEMPOTENT"`, or `"WS"` for a WebSocket handshake. */
  forMethod(method: string): RetryFlag {
    const upper = method.toUpperCase();
    if (upper === 'GET' || upper === 'HEAD') return this.get;
    if (upper === 'DELETE') return this.delete;
    if (upper === 'WS') return this.ws;
    if (upper === POST_IDEMPOTENT) return this.postIdempotent;
    return this.post; // POST, and any other method, is treated as non-idempotent
  }

  static parse(data: RetryColumnsData): RetryColumns {
    const missing = (['GET', 'DELETE', 'POST', POST_IDEMPOTENT, 'WS', 'delay'] as const).filter((c) => !(c in data));
    if (missing.length > 0) throw new Error(`retry columns missing ${missing.join(', ')}`);
    return new RetryColumns(data.GET, data.DELETE, data.POST, data.POST_IDEMPOTENT, data.WS, data.delay);
  }
}

export interface MatchInput {
  isJson: boolean;
  message: string | null;
  hasRetryAfter: boolean;
}

export class Rule {
  readonly id: string;
  readonly row: string;
  readonly error: string;
  readonly retry: RetryColumns;
  readonly mayHaveExecuted: Executed;
  readonly statuses: ReadonlySet<number> | null;
  readonly statusRange: readonly [number, number] | null;
  readonly messageEquals: string | null;
  readonly messagePrefix: string | null;
  readonly messageSuffix: string | null;
  readonly messageContains: string | null;
  readonly json: boolean | null;
  readonly retryAfter: boolean | null;
  readonly blocksBucket: boolean;
  readonly fromProxy: boolean;

  constructor(data: RuleData) {
    const match = data.match;
    this.id = data.id;
    this.row = data.row;
    this.error = data.error;
    this.retry = RetryColumns.parse(data.retry);
    this.mayHaveExecuted = data.may_have_executed;
    this.statuses =
      match.status === undefined ? null : new Set(Array.isArray(match.status) ? match.status : [match.status]);
    this.statusRange = match.status_range ? [Number(match.status_range[0]), Number(match.status_range[1])] : null;
    this.messageEquals = match.message_equals ?? null;
    this.messagePrefix = match.message_prefix ?? null;
    this.messageSuffix = match.message_suffix ?? null;
    this.messageContains = match.message_contains ?? null;
    this.json = match.json ?? null;
    this.retryAfter = match.retry_after ?? null;
    this.blocksBucket = Boolean(data.blocks_bucket);
    this.fromProxy = Boolean(data.from_proxy);
  }

  matches(status: number, input: MatchInput): boolean {
    if (this.statuses !== null && !this.statuses.has(status)) return false;
    if (this.statusRange !== null && !(this.statusRange[0] <= status && status <= this.statusRange[1])) return false;
    if (this.json !== null && this.json !== input.isJson) return false;
    if (this.retryAfter !== null && this.retryAfter !== input.hasRetryAfter) return false;
    const text = input.message === null ? null : strip(input.message);
    const checks: Array<[string | null, (t: string, v: string) => boolean]> = [
      [this.messageEquals, (t, v) => t === v],
      [this.messagePrefix, (t, v) => t.startsWith(v)],
      [this.messageSuffix, (t, v) => t.endsWith(v)],
      [this.messageContains, (t, v) => t.includes(v)],
    ];
    for (const [expected, check] of checks) {
      if (expected !== null && (text === null || !check(text, expected))) return false;
    }
    return true;
  }
}

export interface TransportRule {
  readonly row: string;
  readonly phase: string;
  readonly error: string;
  readonly retry: RetryColumns;
  readonly mayHaveExecuted: Executed;
}

export interface Defaults {
  readonly maxRetries: number;
  readonly backoffInitial: number;
  readonly backoffMultiplier: number;
  readonly backoffMax: number;
  readonly backoffJitter: readonly [number, number];
  readonly retryAfterJitter: readonly [number, number];
  readonly maxRetryAfter: number;
  readonly wsMaxRetryAfter: number;
}

export class RuleSet {
  constructor(
    readonly version: number,
    readonly taxonomy: Readonly<Record<string, string | null>>,
    readonly rules: readonly Rule[],
    readonly transport: ReadonlyMap<string, TransportRule>,
    readonly defaults: Defaults,
  ) {}

  classify(status: number, input: MatchInput): Rule {
    for (const rule of this.rules) {
      if (rule.matches(status, input)) return rule;
    }
    throw new RangeError(`no error rule matches status ${status}`); // the rules end with catch-alls
  }

  transportRule(phase: string): TransportRule {
    const row = this.transport.get(phase);
    if (!row) throw new RangeError(`unknown failure phase ${phase}`);
    return row;
  }
}

export function parseRules(data: RulesData): RuleSet {
  const defaults = data.defaults;
  const backoff = defaults.backoff;
  const transport = new Map<string, TransportRule>();
  for (const row of data.transport) {
    transport.set(row.phase, {
      row: row.row,
      phase: row.phase,
      error: row.error,
      retry: RetryColumns.parse(row.retry),
      mayHaveExecuted: row.may_have_executed,
    });
  }
  return new RuleSet(
    Number(data.version),
    { ...data.taxonomy },
    data.rules.map((rule) => new Rule(rule)),
    transport,
    {
      maxRetries: Number(defaults.max_retries),
      backoffInitial: Number(backoff.initial_seconds),
      backoffMultiplier: Number(backoff.multiplier),
      backoffMax: Number(backoff.max_seconds),
      backoffJitter: [Number(backoff.jitter[0]), Number(backoff.jitter[1])],
      retryAfterJitter: [Number(defaults.retry_after_jitter_seconds[0]), Number(defaults.retry_after_jitter_seconds[1])],
      maxRetryAfter: Number(defaults.max_retry_after_seconds),
      wsMaxRetryAfter: Number(defaults.ws_handshake_max_retry_after_seconds),
    },
  );
}

let cached: RuleSet | undefined;

/** The rules bundled with this package (parsed once). */
export function loadRules(): RuleSet {
  cached ??= parseRules(RULES_DATA);
  return cached;
}
