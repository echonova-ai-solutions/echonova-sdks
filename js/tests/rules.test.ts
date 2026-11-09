import { describe, expect, it } from 'vitest';
import { loadRules } from '../src/core/rules.js';
import { RULES_DATA } from '../src/core/rules.generated.js';
import { EchoNovaError, ERROR_CLASSES } from '../src/errors.js';
import { loadSpec } from './helpers.js';

const SPEC = loadSpec('error-rules.json');

describe('generated rules', () => {
  it('match spec/error-rules.json (run tools/gen_ts_rules.py if not)', () => {
    // The generator keeps only the keys the runtime uses (see RUNTIME_KEYS in tools/gen_ts_rules.py).
    const expected = {
      version: SPEC.version,
      taxonomy: SPEC.taxonomy,
      transport: SPEC.transport.map(({ description: _d, ...row }: Record<string, unknown>) => row),
      rules: SPEC.rules,
      defaults: SPEC.defaults,
    };
    expect(RULES_DATA).toEqual(expected);
  });
});

describe('taxonomy', () => {
  it('has exactly the classes in the shared taxonomy', () => {
    expect(new Set(Object.keys(ERROR_CLASSES))).toEqual(new Set(Object.keys(SPEC.taxonomy)));
  });

  it.each(Object.entries(SPEC.taxonomy as Record<string, string | null>))('%s extends %s', (name, parent) => {
    const cls = ERROR_CLASSES[name as keyof typeof ERROR_CLASSES];
    const base = Object.getPrototypeOf(cls);
    expect(base).toBe(parent === null ? Error : ERROR_CLASSES[parent as keyof typeof ERROR_CLASSES]);
    expect(cls.name).toBe(name);
    expect(cls.prototype.name).toBe(name);
  });

  it('keeps SpendingLimitError out of the RateLimitError family', () => {
    expect(ERROR_CLASSES.SpendingLimitError.prototype instanceof ERROR_CLASSES.RateLimitError).toBe(false);
    expect(ERROR_CLASSES.SpendingLimitError.prototype instanceof EchoNovaError).toBe(true);
  });
});

describe('rules', () => {
  const rules = loadRules();

  it('are well formed', () => {
    const ids = rules.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of rules.rules) {
      expect(Object.keys(rules.taxonomy)).toContain(rule.error);
      expect(rule.row.startsWith('R')).toBe(true);
    }
  });

  it('end with catch-alls, so every 4xx and 5xx classifies', () => {
    for (let status = 400; status < 600; status += 1) {
      expect(() => rules.classify(status, { isJson: true, message: 'anything', hasRetryAfter: false })).not.toThrow();
      expect(() => rules.classify(status, { isJson: false, message: null, hasRetryAfter: false })).not.toThrow();
    }
  });

  it('reject statuses no rule covers', () => {
    expect(() => rules.classify(302, { isJson: true, message: null, hasRetryAfter: false })).toThrow(RangeError);
  });

  it('parse the defaults', () => {
    expect(rules.defaults).toEqual({
      maxRetries: 2,
      backoffInitial: 0.5,
      backoffMultiplier: 2,
      backoffMax: 8,
      backoffJitter: [0.5, 1],
      retryAfterJitter: [0, 1],
      maxRetryAfter: 60,
      wsMaxRetryAfter: 30,
    });
  });

  it('trim the message before matching', () => {
    const rule = rules.classify(429, { isJson: true, message: '  Monthly spending limit exhausted\n', hasRetryAfter: false });
    expect(rule.id).toBe('spending_limit');
  });
});
