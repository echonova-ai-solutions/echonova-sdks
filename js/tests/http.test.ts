import { describe, expect, it, vi } from 'vitest';
import { failurePhase, HttpTransport, type FetchLike, type RequestSpec } from '../src/core/http.js';
import { makeLogger } from '../src/core/logger.js';
import { RateLimitTracker } from '../src/core/ratelimit.js';
import { RetryPolicy } from '../src/core/retry.js';
import { loadRules } from '../src/core/rules.js';
import * as errors from '../src/errors.js';
import { envelope, loadSpec, success } from './helpers.js';

type Reply = Response | Error | ((init: RequestInit) => Response | Promise<Response>);

function systemError(code: string): TypeError {
  const cause = Object.assign(new Error(code), { code });
  return new TypeError('fetch failed', { cause });
}

function setup(replies: Reply[], options: { maxRetries?: number; preflight?: boolean } = {}) {
  const queue = [...replies];
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  // A fake clock in seconds that the fake sleep advances.
  const time = { now: 0 };
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, init });
    const reply = queue.shift();
    if (reply === undefined) throw new Error('unexpected request');
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(init);
    return reply;
  };
  const tracker = new RateLimitTracker({ clock: () => time.now });
  const transport = new HttpTransport({
    baseURL: 'https://api.echonova.ai',
    fetch,
    timeout: null,
    maxRetries: options.maxRetries ?? 2,
    defaultHeaders: {},
    authHeaders: () => ({ Authorization: 'Bearer ek_test' }),
    userAgent: 'echonova-js/test',
    logger: makeLogger('off'),
    rateLimitPreflight: options.preflight ?? true,
    tracker,
    policy: new RetryPolicy({ maxRetries: options.maxRetries ?? 2, random: () => 0.5 }),
    sleep: async (ms) => {
      sleeps.push(ms);
      time.now += ms / 1000;
    },
  });
  return { transport, sent, sleeps, tracker, time };
}

const json = (status: number, body: Uint8Array | string, headers: Record<string, string> = {}) =>
  new Response(body as BodyInit, { status, headers: { 'Content-Type': 'application/json', ...headers } });
const ok = (data: unknown, headers: Record<string, string> = {}) => json(200, success(data), headers);
const fail = (status: number, message: string | null, headers: Record<string, string> = {}) =>
  json(status, envelope(status, message), headers);

const GET: RequestSpec = { method: 'GET', path: '/v1/text-to-speech/jobs/abc', bucket: 'tts.jobs.get' };
const POST: RequestSpec = { method: 'POST', path: '/v1/text-to-speech/sync', bucket: 'tts.generate', json: { text: 'hi' } };
const DELETE: RequestSpec = { method: 'DELETE', path: '/v1/text-to-speech/jobs/abc', bucket: 'tts.jobs.delete' };

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (error: unknown) => error,
  );
}

describe('success', () => {
  it('unwraps the envelope and returns metadata', async () => {
    const { transport, sent } = setup([ok({ jobId: 'j1' }, { 'X-Request-Id': 'r1', 'X-RateLimit-Remaining': '5' })]);
    const result = await transport.request({ ...GET, query: { limit: 20, offset: undefined, flag: true } });
    expect(result).toMatchObject({ data: { jobId: 'j1' }, status: 200, requestId: 'r1', attempts: 1, alreadyDeleted: false });
    expect(result.rateLimit).toEqual({ limit: null, remaining: 5, resetSeconds: null });
    expect(sent[0]!.url).toBe('https://api.echonova.ai/v1/text-to-speech/jobs/abc?limit=20&flag=true');
  });

  it('returns raw bytes for file downloads', async () => {
    const { transport } = setup([new Response('1\n00:00:00,000 --> 00:00:01,000\nhi\n', { status: 200 })]);
    const result = await transport.request<Uint8Array>({ ...GET, responseType: 'bytes' });
    expect(new TextDecoder().decode(result.data)).toContain('-->');
  });
});

describe('retries', () => {
  it('retries GET on a 500 with backoff', async () => {
    const { transport, sent, sleeps } = setup([fail(500, 'Something went wrong'), ok(1)]);
    const result = await transport.request(GET);
    expect(result.attempts).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sleeps).toEqual([375]);
  });

  it('gives up after maxRetries', async () => {
    const { transport, sent } = setup([fail(502, 'Bad Gateway'), fail(502, 'Bad Gateway'), fail(502, 'Bad Gateway')]);
    const error = await caught(transport.request(GET));
    expect(error).toBeInstanceOf(errors.GatewayError);
    expect(sent).toHaveLength(3);
  });

  it('honours a per-request maxRetries', async () => {
    const { transport, sent } = setup([fail(500, 'Something went wrong')]);
    await caught(transport.request({ ...GET, maxRetries: 0 }));
    expect(sent).toHaveLength(1);
  });

  it('does not retry POST on a 500 and reports it may have run', async () => {
    const { transport, sent } = setup([fail(500, 'Something went wrong', { 'X-Request-Id': 'r5' })]);
    const error = (await caught(transport.request(POST))) as errors.ServerError;
    expect(error).toBeInstanceOf(errors.ServerError);
    expect(error.mayHaveExecuted).toBeNull();
    expect(error.requestId).toBe('r5');
    expect(error.sentAt).toBeInstanceOf(Date);
    expect(sent).toHaveLength(1);
  });

  it('does not retry POST after an ingress timeout', async () => {
    const { transport, sent } = setup([new Response('upstream request timeout', { status: 504 })]);
    const error = (await caught(transport.request(POST))) as errors.GatewayError;
    expect(error).toMatchObject({ fromProxy: true, mayHaveExecuted: true, rule: 'ingress_timeout' });
    expect(sent).toHaveLength(1);
  });

  it('retries POST on a refunded 503', async () => {
    const { transport, sent } = setup([fail(503, 'Speech generation is temporarily unavailable. Please try again.'), ok(1)]);
    await transport.request(POST);
    expect(sent).toHaveLength(2);
  });

  it('retries POST on a 408 and when the connection is refused', async () => {
    const { transport, sent } = setup([json(408, ''), systemError('ECONNREFUSED'), ok(1)]);
    await transport.request(POST);
    expect(sent).toHaveLength(3);
  });

  it('does not retry POST when the response was lost', async () => {
    const { transport, sent } = setup([systemError('ECONNRESET')]);
    const error = (await caught(transport.request(POST))) as errors.APIConnectionError;
    expect(error).toBeInstanceOf(errors.APIConnectionError);
    expect(error).not.toBeInstanceOf(errors.APITimeoutError);
    expect(error.mayHaveExecuted).toBe(true);
    expect(error.sentAt).toBeInstanceOf(Date);
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.message).toBe(
      'No response from POST /v1/text-to-speech/sync after the request was sent: TypeError: fetch failed. ' +
        'It may have run and been charged: check recent jobs before sending it again.',
    );
    expect(sent).toHaveLength(1);
  });

  it('reports the first attempt time as sentAt', async () => {
    const { transport } = setup([fail(500, 'Something went wrong'), fail(500, 'Something went wrong'), fail(500, 'Something went wrong')]);
    const before = Date.now();
    const error = (await caught(transport.request(GET))) as errors.ServerError;
    expect(error.sentAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(error.sentAt!.getTime()).toBeLessThanOrEqual(before + 50);
  });

  it('sends Accept */* for raw downloads', async () => {
    const { transport, sent } = setup([new Response('x'), ok(1)]);
    await transport.request({ ...GET, responseType: 'bytes' });
    await transport.request(GET);
    expect(new Headers(sent[0]!.init.headers).get('accept')).toBe('*/*');
    expect(new Headers(sent[1]!.init.headers).get('accept')).toBe('application/json');
  });

  it('treats an unidentified fetch failure as a lost response (browsers)', async () => {
    const { transport, sent } = setup([new TypeError('Failed to fetch')]);
    const error = (await caught(transport.request(POST))) as errors.APIConnectionError;
    expect(error.mayHaveExecuted).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('reports a POST that could not connect as not executed', async () => {
    const { transport, sent } = setup([systemError('ENOTFOUND'), systemError('ENOTFOUND'), systemError('ENOTFOUND')]);
    const error = (await caught(transport.request(POST))) as errors.APIConnectionError;
    expect(error.mayHaveExecuted).toBe(false);
    expect(error.message).toBe('Could not connect to POST /v1/text-to-speech/sync: TypeError: fetch failed');
    expect(sent).toHaveLength(3);
  });

  it('retries GET when the response was lost', async () => {
    const { transport, sent } = setup([systemError('ECONNRESET'), ok(1)]);
    await transport.request(GET);
    expect(sent).toHaveLength(2);
  });

  it('never retries an unreplayable body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const { transport, sent } = setup([systemError('ECONNREFUSED')]);
    const error = (await caught(transport.request({ ...POST, json: undefined, body: stream }))) as errors.APIConnectionError;
    expect(error.retryDisabledReason).toBe('body_not_replayable');
    expect(error.mayHaveExecuted).toBe(false);
    expect((sent[0]!.init as { duplex?: string }).duplex).toBe('half');
    expect(sent).toHaveLength(1);
  });

  it('says why a retryable status was not retried', async () => {
    const { transport, sent } = setup([fail(503, 'Audio processing is temporarily unavailable. Please try again.')]);
    const spec = { ...POST, json: undefined, body: new Uint8Array([1]), bodyReplayable: false };
    const error = (await caught(transport.request(spec))) as errors.ServiceUnavailableError;
    expect(error).toBeInstanceOf(errors.ServiceUnavailableError);
    expect(error.retryDisabledReason).toBe('body_not_replayable');
    expect(sent).toHaveLength(1);
  });
});

describe('the safety invariant, end to end', () => {
  const vectors = loadSpec<{ vectors: Array<{ status: number; json: boolean; retry_after: boolean; message: string | null; expect_rule: string }> }>(
    'error-rules.json',
  ).vectors;
  const rules = loadRules();

  it.each(vectors.map((v) => [v.expect_rule, v] as const))('POST is sent once when it may have run (%s)', async (id, v) => {
    const rule = rules.rules.find((r) => r.id === id)!;
    const reply = () => {
      const headers: Record<string, string> = v.retry_after ? { 'Retry-After': '1' } : {};
      return v.json ? fail(v.status, v.message, headers) : new Response('proxy error', { status: v.status, headers });
    };
    const { transport, sent } = setup([reply(), reply(), reply(), reply()], { maxRetries: 3 });
    await transport.request(POST).catch(() => undefined);
    if (rule.mayHaveExecuted !== 'no') expect(sent).toHaveLength(1);
  });
});

describe('throttling', () => {
  it('waits Retry-After plus jitter and blocks the bucket', async () => {
    const { transport, sent, sleeps, tracker, time } = setup([
      fail(429, 'ThrottlerException: Too Many Requests', { 'Retry-After': '12' }),
      ok(1),
    ]);
    await transport.request(GET);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeCloseTo(12_500);
    expect(sent).toHaveLength(2);
    expect(time.now).toBeCloseTo(12.5);
    expect(tracker.waitTime('tts.jobs.get')).toBe(0);
  });

  it('blocks the bucket for other callers while a retry waits', async () => {
    const { transport, tracker } = setup([fail(429, 'ThrottlerException: Too Many Requests', { 'Retry-After': '12' })], {
      maxRetries: 0,
    });
    await caught(transport.request(GET));
    expect(tracker.waitTime('tts.jobs.get', { preflight: false })).toBe(12);
    expect(tracker.waitTime('tts.jobs.list')).toBe(0);
  });

  it('waits out a block before sending on the same bucket', async () => {
    const { transport, sent, sleeps, tracker } = setup([ok(1)]);
    tracker.block('tts.jobs.get', 30);
    await transport.request(GET);
    expect(sleeps).toEqual([30_000]);
    expect(sent).toHaveLength(1);
  });

  it('refuses to send when the block is longer than the cap', async () => {
    const { transport, sent, tracker } = setup([ok(1)]);
    tracker.block('tts.jobs.get', 3600);
    const error = (await caught(transport.request(GET))) as errors.RateLimitError;
    expect(error).toBeInstanceOf(errors.RateLimitError);
    expect(error.retryAfter).toBe(3600);
    expect(error.message).toBe('the rate limit for tts.jobs.get clears in 3600 s, beyond what this call may wait; nothing was sent');
    expect(sent).toHaveLength(0);
  });

  it('preflight waits for the window when nothing remains', async () => {
    const replies = [ok(1, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '20' }), ok(2)];
    const { transport, sleeps } = setup(replies);
    await transport.request(GET);
    expect((await transport.request(GET)).data).toBe(2);
    expect(sleeps).toEqual([20_000]);
  });

  it('preflight can be turned off', async () => {
    const replies = [ok(1, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '20' }), ok(2)];
    const { transport, sleeps } = setup(replies, { preflight: false });
    await transport.request(GET);
    await transport.request(GET);
    expect(sleeps).toEqual([]);
  });

  it('does not retry a throttle whose Retry-After exceeds the cap', async () => {
    const { transport, sent } = setup([fail(429, 'ThrottlerException: Too Many Requests', { 'Retry-After': '61' })]);
    const error = (await caught(transport.request(GET))) as errors.RateLimitError;
    expect(error.retryAfter).toBe(61);
    expect(sent).toHaveLength(1);
  });

  it('never retries the spending limit', async () => {
    const { transport, sent } = setup([fail(429, 'Monthly spending limit exhausted')]);
    expect(await caught(transport.request(GET))).toBeInstanceOf(errors.SpendingLimitError);
    expect(sent).toHaveLength(1);
  });
});

describe('malformed responses', () => {
  it('retries a malformed GET success once', async () => {
    const { transport, sent } = setup([json(200, '<html>'), json(200, '<html>')], { maxRetries: 5 });
    const error = (await caught(transport.request(GET))) as errors.ProtocolError;
    expect(error).toBeInstanceOf(errors.ProtocolError);
    expect(error.mayHaveExecuted).toBe(false);
    expect(sent).toHaveLength(2);
  });

  it('never retries a malformed POST success, which ran', async () => {
    const { transport, sent } = setup([json(200, '{"data": null, "success": false}', { 'X-Request-Id': 'rx' })]);
    const error = (await caught(transport.request(POST))) as errors.ProtocolError;
    expect(error).toMatchObject({
      mayHaveExecuted: true,
      statusCode: 200,
      requestId: 'rx',
      rule: 'malformed_success',
      errorMessage: 'unexpected response body: 2xx response with success=false',
    });
    expect(sent).toHaveLength(1);
  });

  it('treats a redirect as a protocol error', async () => {
    const { transport, sent } = setup([new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com' } })]);
    const error = (await caught(transport.request(POST))) as errors.ProtocolError;
    expect(error).toBeInstanceOf(errors.ProtocolError);
    expect(error.statusCode).toBe(302);
    expect(error.errorMessage).toBe('unexpected HTTP 302');
    expect(error.mayHaveExecuted).toBeNull();
    expect(sent).toHaveLength(1);
  });
});

describe('DELETE', () => {
  it('treats 404 after a lost response as already deleted', async () => {
    const { transport } = setup([systemError('ECONNRESET'), fail(404, 'TTS Job not found')]);
    const result = await transport.request(DELETE);
    expect(result).toMatchObject({ alreadyDeleted: true, data: { deleted: true }, attempts: 2 });
  });

  it('remembers the lost response across later retries', async () => {
    const { transport } = setup(
      [systemError('ECONNRESET'), fail(503, 'The stored file could not be deleted. Try again.'), fail(404, 'TTS Job not found')],
      { maxRetries: 3 },
    );
    expect(await transport.request(DELETE)).toMatchObject({ alreadyDeleted: true, attempts: 3 });
  });

  it('only treats a job-not-found 404 as already deleted', async () => {
    const { transport } = setup([systemError('ECONNRESET'), fail(404, 'Route not found')]);
    const error = await caught(transport.request(DELETE));
    expect(error).toBeInstanceOf(errors.NotFoundError);
    expect(error).not.toBeInstanceOf(errors.JobNotFoundError);
  });

  it('reports a plain 404', async () => {
    const { transport } = setup([fail(404, 'TTS Job not found')]);
    expect(await caught(transport.request(DELETE))).toBeInstanceOf(errors.JobNotFoundError);
  });

  it('retries a failed storage delete', async () => {
    const { transport, sent } = setup([fail(503, 'The stored file could not be deleted. Try again.'), ok({ deleted: true })]);
    await transport.request(DELETE);
    expect(sent).toHaveLength(2);
  });
});

describe('timeouts and cancellation', () => {
  const hang: Reply = (init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

  it('times out an attempt and does not retry a POST', async () => {
    const { transport, sent } = setup([hang]);
    const error = (await caught(transport.request({ ...POST, timeout: 20 }))) as errors.APITimeoutError;
    expect(error).toBeInstanceOf(errors.APITimeoutError);
    expect(error.kind).toBe('total');
    expect(error.mayHaveExecuted).toBe(true);
    expect(error.message).toContain('20 ms');
    expect(sent).toHaveLength(1);
  });

  it('retries a GET that timed out', async () => {
    const { transport, sent } = setup([hang, ok(1)]);
    expect((await transport.request({ ...GET, timeout: 20 })).data).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('uses the operation default when nothing else is set', async () => {
    const { transport } = setup([hang]);
    const error = (await caught(transport.request({ ...POST, defaultTimeout: 15 }))) as errors.APITimeoutError;
    expect(error.message).toContain('15 ms');
  });

  it('rethrows the caller abort reason without retrying', async () => {
    const controller = new AbortController();
    const { transport, sent } = setup([hang, ok(1)]);
    const pending = transport.request({ ...GET, signal: controller.signal });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const reason = new Error('user cancelled');
    controller.abort(reason);
    expect(await caught(pending)).toBe(reason);
    expect(sent).toHaveLength(1);
  });

  it('does not send when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const { transport } = setup([hang]);
    expect(await caught(transport.request({ ...GET, signal: controller.signal }))).toMatchObject({ message: 'stop' });
  });
});

describe('failurePhase', () => {
  it.each([
    [systemError('ECONNREFUSED'), 'connect'],
    [systemError('ENOTFOUND'), 'connect'],
    [systemError('UND_ERR_CONNECT_TIMEOUT'), 'connect'],
    [systemError('CERT_HAS_EXPIRED'), 'connect'],
    [systemError('ERR_TLS_CERT_ALTNAME_INVALID'), 'connect'],
    [systemError('ECONNRESET'), 'no_response'],
    [systemError('UND_ERR_SOCKET'), 'no_response'],
    [new TypeError('Failed to fetch'), 'no_response'],
    ['weird', 'no_response'],
  ] as const)('%s -> %s', (error, phase) => {
    expect(failurePhase(error)).toBe(phase);
  });
});
