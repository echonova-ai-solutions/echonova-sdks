import { describe, expect, it } from 'vitest';
import { buildStatusError, classifyResponse, executedFlag } from '../src/core/classifier.js';
import * as errors from '../src/errors.js';
import { envelope, loadSpec } from './helpers.js';

interface Vector {
  status: number;
  json: boolean;
  retry_after: boolean;
  message: string | null;
  expect_rule: string;
  expect_error: string;
}

interface CatalogEntry {
  operation_id: string;
  method: string;
  status: number;
  example: string;
  error_message: string;
  envelope: { docs?: string };
}

const VECTORS = loadSpec<{ vectors: Vector[] }>('error-rules.json').vectors;
const CATALOG = loadSpec<{ entries: CatalogEntry[] }>('fixtures/errors/catalog.json').entries;
const CATCH_ALLS = new Set(['client_error_other', 'server_error_other', 'rate_limited_other']);

// Which error family each documented status must land in.
const FAMILY: Record<number, Array<abstract new (...args: never[]) => unknown>> = {
  400: [errors.InvalidRequestError],
  401: [errors.AuthenticationError],
  402: [errors.InsufficientBalanceError],
  403: [errors.PermissionDeniedError],
  404: [errors.NotFoundError],
  // Agent call/chat limits are capacity limits; a request with the same Idempotency-Key still running is in progress.
  409: [errors.InvalidRequestError, errors.ConcurrencyLimitError, errors.RequestInProgressError],
  413: [errors.InvalidRequestError],
  415: [errors.InvalidRequestError],
  429: [errors.RateLimitError, errors.SpendingLimitError],
  500: [errors.ServerError],
  503: [errors.ServiceUnavailableError],
  504: [errors.GatewayError],
};

function response(vector: Vector): [Record<string, string>, Uint8Array] {
  const headers: Record<string, string> = { 'X-Request-Id': 'req-123', 'Content-Type': 'application/json' };
  if (vector.retry_after) headers['Retry-After'] = '30';
  if (vector.json) return [headers, envelope(vector.status, vector.message)];
  headers['Content-Type'] = 'text/plain';
  return [headers, new TextEncoder().encode('upstream request timeout')];
}

describe('shared rule vectors', () => {
  it.each(VECTORS.map((v) => [`${v.status}-${v.expect_rule}`, v] as const))('%s', (_id, vector) => {
    const [headers, body] = response(vector);
    expect(classifyResponse(vector.status, headers, body).rule.id).toBe(vector.expect_rule);
    const error = buildStatusError(vector.status, headers, body, { method: 'POST' });
    expect(error.name).toBe(vector.expect_error);
    expect(error.constructor).toBe(errors.ERROR_CLASSES[vector.expect_error as errors.ErrorClassName]);
    expect(error.rule).toBe(vector.expect_rule);
    expect(error.requestId).toBe('req-123');
  });
});

describe('error catalog', () => {
  it(`has ${CATALOG.length} documented errors`, () => {
    expect(CATALOG.length).toBeGreaterThan(0);
  });

  it.each(CATALOG.map((e) => [`${e.operation_id}-${e.status}-${e.example}`, e] as const))(
    '%s classifies to a specific rule',
    (_id, entry) => {
      const message = entry.error_message;
      const headers: Record<string, string> = { 'X-Request-Id': 'req-1' };
      if (entry.status === 429 && message !== 'Monthly spending limit exhausted') {
        headers['Retry-After'] = '12'; // the docs: a throttle 429 carries Retry-After, the spending 429 doesn't
      }
      const body = envelope(entry.status, message, { docs: entry.envelope.docs });
      const { rule } = classifyResponse(entry.status, headers, body);
      expect(CATCH_ALLS.has(rule.id), `documented error falls through to ${rule.id}`).toBe(false);
      const error = buildStatusError(entry.status, headers, body, { method: entry.method });
      const family = FAMILY[entry.status];
      expect(family, `no family for ${entry.status}`).toBeDefined();
      expect(family!.some((cls) => error instanceof cls)).toBe(true);
      expect(error.errorMessage).toBe(message); // kept verbatim, commas included
      expect(error.docsUrl).toBe(entry.envelope.docs ?? null);
    },
  );
});

describe('buildStatusError', () => {
  it('surfaces errorCode and builds the message', () => {
    const body = envelope(400, 'The file is not valid.', { errorCode: 'example_code' });
    const error = buildStatusError(400, { 'x-request-id': 'r-9' }, body, { method: 'POST' });
    expect(error).toBeInstanceOf(errors.InvalidRequestError);
    expect(error.errorCode).toBe('example_code');
    expect(error.message).toBe('400 [example_code] The file is not valid. (request_id: r-9)');
    expect(String(error)).toBe('InvalidRequestError: 400 [example_code] The file is not valid. (request_id: r-9)');
  });

  it('marks a non-JSON proxy timeout as possibly executed', () => {
    const body = new TextEncoder().encode('upstream request timeout');
    const error = buildStatusError(504, { 'content-type': 'text/plain' }, body, { method: 'POST' });
    expect(error).toBeInstanceOf(errors.GatewayError);
    expect(error.fromProxy).toBe(true);
    expect(error.mayHaveExecuted).toBe(true);
    expect(error.errorMessage).toBe('upstream request timeout');
  });

  it.each([
    ['POST', null],
    ['GET', false],
    ['DELETE', false],
  ] as const)('mayHaveExecuted only applies to POST (%s)', (method, expected) => {
    const error = buildStatusError(500, {}, envelope(500, 'Something went wrong'), { method });
    expect(error.mayHaveExecuted).toBe(expected);
  });

  it('carries Retry-After on a throttle', () => {
    const error = buildStatusError(429, { 'Retry-After': '17' }, envelope(429, 'ThrottlerException: Too Many Requests'), {
      method: 'GET',
    });
    expect(error).toBeInstanceOf(errors.RateLimitError);
    expect(error.retryAfter).toBe(17);
  });

  it('uses the reason phrase when the body is empty', () => {
    const error = buildStatusError(502, {}, new Uint8Array(), { method: 'GET', reasonPhrase: 'Bad Gateway' });
    expect(error).toBeInstanceOf(errors.GatewayError);
    expect(error.errorMessage).toBe('Bad Gateway');
  });

  it('reads Fetch Headers and records them', () => {
    const headers = new Headers({ 'X-Request-Id': 'abc', 'Retry-After': '5' });
    const error = buildStatusError(429, headers, envelope(429, 'ThrottlerException: Too Many Requests'), {
      method: 'GET',
      transport: 'websocket',
    });
    expect(error.requestId).toBe('abc');
    expect(error.headers['x-request-id']).toBe('abc');
    expect(error.transport).toBe('websocket');
  });

  it('classifies a rejected stream handshake (shape observed on the live API)', () => {
    const headers = { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'req-ws' };
    const body = JSON.stringify({
      data: null,
      statusCode: 401,
      success: false,
      errorMessage: 'Unauthorized',
      docs: 'https://echonova.ai/docs/developers/authentication',
    });
    const error = buildStatusError(401, headers, body, { method: 'WS', transport: 'websocket' });
    expect(error).toBeInstanceOf(errors.AuthenticationError);
    expect(error).toMatchObject({
      transport: 'websocket',
      requestId: 'req-ws',
      rule: 'unauthorized',
      mayHaveExecuted: false,
      docsUrl: 'https://echonova.ai/docs/developers/authentication',
    });
  });

  it('accepts a string body', () => {
    const error = buildStatusError(404, {}, JSON.stringify({ success: false, errorMessage: 'Voice not found' }), {
      method: 'POST',
    });
    expect(error).toBeInstanceOf(errors.VoiceNotFoundError);
  });
});

describe('executedFlag', () => {
  it('maps yes/no/unknown for POST and is false for anything else', () => {
    expect(executedFlag('yes', 'post')).toBe(true);
    expect(executedFlag('no', 'POST')).toBe(false);
    expect(executedFlag('unknown', 'POST')).toBeNull();
    expect(executedFlag('yes', 'GET')).toBe(false);
    expect(executedFlag('yes', 'WS')).toBe(false);
  });
});
