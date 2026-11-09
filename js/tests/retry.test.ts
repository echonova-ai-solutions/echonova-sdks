import { describe, expect, it } from 'vitest';
import { RetryPolicy } from '../src/core/retry.js';
import { loadRules, type Phase, type Rule } from '../src/core/rules.js';

const RULES = loadRules();
const policy = (options: { maxRetries?: number } = {}) => new RetryPolicy({ random: () => 0.5, ...options });
const rule = (id: string): Rule => {
  const found = RULES.rules.find((r) => r.id === id);
  if (!found) throw new Error(`no rule ${id}`);
  return found;
};

describe('the safety invariant', () => {
  it.each(RULES.rules.map((r) => [r.id, r] as const))(
    'POST is never retried when it may have run (%s)',
    (_id, r) => {
      // No idempotency key: a POST that may have run is never sent again.
      for (const retryAfter of [null, 0, 1, 30]) {
        for (const waitForSlot of [false, true]) {
          const decision = policy({ maxRetries: 10 }).decideStatus('POST', r, { retriesDone: 0, retryAfter, waitForSlot });
          if (r.mayHaveExecuted !== 'no') expect(decision.retry).toBe(false);
          expect(decision.mayHaveExecuted).toBe(r.mayHaveExecuted);
        }
      }
    },
  );

  it.each(['connect', 'send_incomplete', 'no_response', 'malformed_success'] as const)(
    'POST is never retried after a %s failure that may have run',
    (phase) => {
      const decision = policy({ maxRetries: 10 }).decideTransport('POST', phase, { retriesDone: 0 });
      if (RULES.transportRule(phase).mayHaveExecuted !== 'no') expect(decision.retry).toBe(false);
    },
  );

  it('treats unknown methods like POST', () => {
    expect(policy().decideStatus('PATCH', rule('internal_error'), { retriesDone: 0, retryAfter: null }).retry).toBe(false);
    expect(policy().decideTransport('PUT', 'no_response', { retriesDone: 0 }).retry).toBe(false);
  });
});

describe('status table', () => {
  it.each([
    ['throttled', 'POST', true],
    ['throttled', 'GET', true],
    ['spending_limit', 'GET', false],
    ['insufficient_balance', 'POST', false],
    ['unauthorized', 'GET', false],
    ['unavailable_refunded', 'POST', true],
    ['unavailable_other', 'POST', false],
    ['unavailable_other', 'GET', true],
    ['storage_delete_failed', 'DELETE', true],
    ['storage_delete_failed', 'GET', false],
    ['ingress_unavailable', 'POST', true],
    ['internal_error', 'POST', false],
    ['internal_error', 'GET', true],
    ['bad_gateway', 'POST', false],
    ['ingress_timeout', 'POST', false],
    ['ingress_timeout', 'DELETE', true],
    ['request_timeout', 'POST', true],
    ['invalid_request', 'GET', false],
    ['concurrent_streams', 'GET', false],
    ['rate_limited_other', 'GET', false],
  ] as const)('%s %s -> %s', (id, method, retry) => {
    expect(policy().decideStatus(method, rule(id), { retriesDone: 0, retryAfter: 5 }).retry).toBe(retry);
  });
});

describe('delays', () => {
  it('waits Retry-After plus jitter on a throttle', () => {
    const decision = policy().decideStatus('GET', rule('throttled'), { retriesDone: 0, retryAfter: 12 });
    expect(decision.retry).toBe(true);
    expect(decision.delay).toBeCloseTo(12.5);
    expect(decision.row).toBe('R8');
  });

  it('does not wait for a Retry-After longer than the cap', () => {
    const decision = policy().decideStatus('GET', rule('throttled'), { retriesDone: 0, retryAfter: 61 });
    expect(decision).toMatchObject({ retry: false, reason: 'retry_after_too_long' });
  });

  it('needs Retry-After when the rule waits for it', () => {
    const decision = policy().decideStatus('GET', rule('throttled'), { retriesDone: 0, retryAfter: null });
    expect(decision).toMatchObject({ retry: false, reason: 'missing_retry_after' });
  });

  it('falls back to backoff when Retry-After is optional and missing', () => {
    const decision = policy().decideStatus('POST', rule('unavailable_refunded'), { retriesDone: 0, retryAfter: null });
    expect(decision.retry).toBe(true);
    expect(decision.delay).toBeCloseTo(0.375); // 0.5 * (0.5 + 0.5 * 0.5)
  });

  it('backoff grows and is capped', () => {
    const top = new RetryPolicy({ random: () => 1 });
    expect([1, 2, 3, 4, 5, 6].map((n) => top.backoff(n))).toEqual([0.5, 1, 2, 4, 8, 8]);
    expect(new RetryPolicy({ random: () => 0 }).backoff(1)).toBeCloseTo(0.25);
  });
});

describe('limits', () => {
  it('stops at maxRetries', () => {
    const p = policy({ maxRetries: 2 });
    expect(p.decideStatus('GET', rule('internal_error'), { retriesDone: 1, retryAfter: null }).retry).toBe(true);
    expect(p.decideStatus('GET', rule('internal_error'), { retriesDone: 2, retryAfter: null })).toMatchObject({
      retry: false,
      reason: 'max_retries',
    });
  });

  it('defaults to the shared maxRetries', () => {
    expect(new RetryPolicy().maxRetries).toBe(2);
    expect(new RetryPolicy().maxRetryAfter).toBe(60);
  });

  it('does not retry an unreplayable body', () => {
    const decision = policy().decideStatus('POST', rule('unavailable_refunded'), {
      retriesDone: 0,
      retryAfter: null,
      bodyReplayable: false,
    });
    expect(decision).toMatchObject({ retry: false, reason: 'body_not_replayable' });
  });
});

describe('transport phases', () => {
  it.each([
    ['connect', 'POST', true, 'no'],
    ['send_incomplete', 'POST', true, 'no'],
    ['no_response', 'POST', false, 'yes'],
    ['no_response', 'GET', true, 'yes'],
    ['no_response', 'DELETE', true, 'yes'],
    ['malformed_success', 'POST', false, 'yes'],
  ] as const)('%s %s', (phase: Phase, method, retry, executed) => {
    const decision = policy().decideTransport(method, phase, { retriesDone: 0 });
    expect(decision.retry).toBe(retry);
    expect(decision.mayHaveExecuted).toBe(executed);
  });

  it('retries a malformed success only once for GET', () => {
    const p = policy({ maxRetries: 5 });
    expect(p.decideTransport('GET', 'malformed_success', { retriesDone: 0 }).retry).toBe(true);
    expect(p.decideTransport('GET', 'malformed_success', { retriesDone: 1 }).retry).toBe(false);
  });

  it('rejects an unknown phase', () => {
    expect(() => policy().decideTransport('GET', 'bogus' as Phase, { retriesDone: 0 })).toThrow(RangeError);
  });
});

describe('WebSocket handshake', () => {
  it('retries a concurrency limit only when opted in', () => {
    const r = rule('concurrent_streams');
    expect(policy().decideStatus('WS', r, { retriesDone: 0, retryAfter: null }).retry).toBe(false);
    expect(policy().decideStatus('WS', r, { retriesDone: 0, retryAfter: null, waitForSlot: true }).retry).toBe(true);
  });

  it('has a shorter Retry-After cap', () => {
    const r = rule('throttled');
    expect(policy().decideStatus('WS', r, { retriesDone: 0, retryAfter: 30 }).retry).toBe(true);
    expect(policy().decideStatus('WS', r, { retriesDone: 0, retryAfter: 31 }).retry).toBe(false);
  });

  it.each(['unauthorized', 'insufficient_balance', 'spending_limit', 'streaming_disabled'])(
    'never retries account problems (%s)',
    (id) => {
      expect(policy().decideStatus('WS', rule(id), { retriesDone: 0, retryAfter: 1 }).retry).toBe(false);
    },
  );
});
