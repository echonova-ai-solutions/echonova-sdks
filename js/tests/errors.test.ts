import { describe, expect, expectTypeOf, it } from 'vitest';
import { EchoNova } from '../src/client.js';
import * as errors from '../src/errors.js';
import * as pkg from '../src/index.js';

describe('error classes', () => {
  it('are all exported and reachable as EchoNova statics', () => {
    for (const [name, cls] of Object.entries(errors.ERROR_CLASSES)) {
      expect((pkg as Record<string, unknown>)[name], name).toBe(cls);
      expect((EchoNova as unknown as Record<string, unknown>)[name], name).toBe(cls);
    }
  });

  it('narrow with instanceof, including through the client statics', () => {
    const err: unknown = new errors.RateLimitError({ retryAfter: 2 });
    if (!(err instanceof EchoNova.RateLimitError)) throw new Error('expected a RateLimitError');
    expectTypeOf(err).toEqualTypeOf<errors.RateLimitError>();
    expect(err.retryAfter).toBe(2);
    const other: unknown = new errors.APIConnectionError('x', { mayHaveExecuted: true });
    if (!(other instanceof errors.APIConnectionError)) throw new Error('expected an APIConnectionError');
    expectTypeOf(other.mayHaveExecuted).toEqualTypeOf<boolean | null>();
  });

  it('set name and keep the prototype chain', () => {
    const error = new errors.RateLimitError({ statusCode: 429, errorMessage: 'slow down', retryAfter: 3 });
    expect(error.name).toBe('RateLimitError');
    expect(error).toBeInstanceOf(errors.RateLimitError);
    expect(error).toBeInstanceOf(errors.APIStatusError);
    expect(error).toBeInstanceOf(errors.EchoNovaError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(errors.BillingError);
    expect(error instanceof EchoNova.RateLimitError).toBe(true);
    expect(error.stack?.startsWith('RateLimitError: 429 slow down')).toBe(true);
    expect(Object.prototype.toString.call(error)).toBe('[object Error]');
  });

  it('match instances from another copy of the package by brand', () => {
    // What an error thrown by the CommonJS build looks like to the ESM build: same
    // brand symbols (Symbol.for), different prototype objects.
    const foreignProto = Object.create(Error.prototype) as Record<symbol, unknown>;
    for (const name of ['EchoNovaError', 'APIStatusError', 'BillingError', 'SpendingLimitError']) {
      foreignProto[Symbol.for(`echonova.error:${name}`)] = true;
    }
    const foreign = Object.create(foreignProto) as object;
    expect(foreign instanceof errors.SpendingLimitError).toBe(true);
    expect(foreign instanceof errors.BillingError).toBe(true);
    expect(foreign instanceof errors.EchoNovaError).toBe(true);
    expect(foreign instanceof errors.RateLimitError).toBe(false);
    expect(foreign instanceof errors.InsufficientBalanceError).toBe(false);
    expect({} instanceof errors.EchoNovaError).toBe(false);
    expect((null as unknown) instanceof errors.EchoNovaError).toBe(false);
  });

  it('do not let user subclasses match by brand', () => {
    class MyError extends errors.RateLimitError {}
    expect(new MyError() instanceof MyError).toBe(true);
    expect(new errors.RateLimitError() instanceof MyError).toBe(false);
    expect(new MyError() instanceof errors.RateLimitError).toBe(true);
    expect(new MyError().name).toBe('RateLimitError');
  });

  it('APIStatusError has camelCase fields with null defaults', () => {
    const error = new errors.APIStatusError();
    expect(error).toMatchObject({
      statusCode: null,
      errorMessage: null,
      errorCode: null,
      requestId: null,
      docsUrl: null,
      headers: {},
      rawBody: null,
      transport: 'http',
      retryAfter: null,
      mayHaveExecuted: false,
      rule: null,
      closeCode: null,
      sessionId: null,
      sentAt: null,
      fromProxy: false,
      retryDisabledReason: null,
    });
    expect(error.message).toBe('no error message');
  });

  it('describes stream closes', () => {
    const error = new errors.SpendingLimitError({ closeCode: 4029, errorCode: 'spending_limit', errorMessage: 'limit', transport: 'websocket' });
    expect(error.message).toBe('close 4029 [spending_limit] limit');
  });

  it('keeps an explicit null mayHaveExecuted (unknown)', () => {
    expect(new errors.APIConnectionError('x', { mayHaveExecuted: null }).mayHaveExecuted).toBeNull();
    expect(new errors.APIConnectionError('x').mayHaveExecuted).toBe(false);
  });

  it('carry the extra fields of the other families', () => {
    const cause = new Error('socket hang up');
    const timeout = new errors.APITimeoutError('t', { kind: 'read', mayHaveExecuted: true, cause });
    expect(timeout).toMatchObject({ kind: 'read', mayHaveExecuted: true, retryDisabledReason: null });
    expect(timeout.cause).toBe(cause);
    expect(new errors.StreamClosedError('c', { closeCode: 4008, reason: 'idle_timeout' })).toMatchObject({
      closeCode: 4008,
      reason: 'idle_timeout',
      sessionId: null,
    });
    expect(new errors.JobFailedError('f', { job: { id: 'j' } }).job).toEqual({ id: 'j' });
    expect(new errors.JobWaitTimeoutError('w', { jobId: 'j' })).toMatchObject({ jobId: 'j', lastJob: null });
    expect(new errors.DownloadExpiredError('d', { url: 'https://example.com/a.wav' }).url).toBe('https://example.com/a.wav');
    expect(new errors.WebhookVerificationError('v', { reason: 'signature' }).reason).toBe('signature');
  });
});
