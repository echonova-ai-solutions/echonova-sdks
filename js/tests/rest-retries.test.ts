// Retries, rate limits and per-call options, end to end through the resources.
import { describe, expect, it, vi } from 'vitest';
import * as errors from '../src/errors.js';
import {
  caught,
  fail,
  JOB_ID,
  makeClient,
  ok,
  partsOf,
  refused,
  reset,
  settle,
  SteppedTime,
  WAV,
  type Handler,
} from './rest-support.js';

const JOB = { id: JOB_ID, status: 'completed', text: 'hi', voiceId: 'v' };
const THROTTLED = { 'Retry-After': '5' };

function sequence(...replies: Array<Response | Error>): Handler {
  return () => replies.shift() ?? ok(JOB);
}

// textToSpeech.generate, speechToText.transcribe and soundCleaning.clean send an Idempotency-Key,
// so they are retried: see idempotency.test.ts.
describe('a POST without an Idempotency-Key that may have run is never sent again', () => {
  it.each([
    ['textToSpeech.jobs.create', (c: any) => c.textToSpeech.jobs.create({ text: 'hi', voiceId: 'v' })],
    ['speechToText.jobs.create', (c: any) => c.speechToText.jobs.create({ file: WAV, language: 'en' })],
    ['widgets.createTicket', (c: any) => c.widgets.createTicket('wdg_1')],
    ['agents.sessions.start', (c: any) => c.agents.sessions.start('agent-1', { channel: 'voice' })],
  ])('%s after a lost response', async (_name, call) => {
    const { client, requests, time } = makeClient(sequence(reset()));
    const error = (await caught(call(client))) as errors.APIConnectionError;
    expect(error).toBeInstanceOf(errors.APIConnectionError);
    expect(error.mayHaveExecuted).toBe(true);
    expect(error.sentAt).toEqual(time.start);
    expect(error.message).toContain('It may have run and been charged');
    expect(requests).toHaveLength(1);
  });

  it('a retried agent session start would open a second session, so it is not retried even with retries left', async () => {
    const { client, requests } = makeClient(sequence(reset(), ok({ id: 's2', status: 'active', token: 't' })), { maxRetries: 5 });
    const error = (await caught(client.agents.sessions.start('agent-1'))) as errors.APIConnectionError;
    expect(error.mayHaveExecuted).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('nor after a 500 or an ingress timeout', async () => {
    for (const reply of [fail(500, 'Something went wrong'), new Response('upstream request timeout', { status: 504 })]) {
      const { client, requests } = makeClient(sequence(reply));
      const error = (await caught(client.agents.sessions.start('agent-1'))) as errors.APIStatusError;
      expect(error).toBeInstanceOf(errors.ServerError);
      expect(requests).toHaveLength(1);
    }
  });

  it('is retried when it certainly did not run: refused connection, refunded 503, live sessions unavailable', async () => {
    const { client, requests } = makeClient(
      sequence(
        refused(),
        fail(503, 'Live sessions are not available right now. Try again later.'),
        ok({ id: 's1', status: 'active', token: 't', wsUrl: 'wss://rooms.example.com' }),
      ),
    );
    const session = await client.agents.sessions.start('agent-1');
    expect(session.id).toBe('s1');
    expect(requests).toHaveLength(3);
  });

  it('re-sends the same upload on a retry', async () => {
    const { client, requests } = makeClient(sequence(refused(), fail(503, 'Audio processing is temporarily unavailable.'), ok({ jobId: JOB_ID, status: 'pending' })));
    await client.speechToText.jobs.create({ file: WAV, language: 'ar', identifySpeakers: true });
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const { fields, file } = await partsOf(request);
      expect(fields).toEqual({ language: 'ar', identify_speakers: 'true' });
      expect(new Uint8Array(await file!.arrayBuffer())).toEqual(WAV);
    }
  });

  it('GETs and DELETEs are retried after a lost response; a DELETE that then finds nothing was already deleted', async () => {
    const { client, requests } = makeClient(sequence(reset(), ok(JOB), reset(), fail(404, 'TTS Job not found')));
    expect((await client.textToSpeech.jobs.get(JOB_ID)).id).toBe(JOB_ID);
    const deleted = await client.textToSpeech.jobs.delete(JOB_ID);
    expect(deleted).toEqual({ deleted: true, alreadyDeleted: true, requestId: 'req-err' });
    expect(requests.map((r) => r.method)).toEqual(['GET', 'GET', 'DELETE', 'DELETE']);
  });
});

describe('rate limits', () => {
  it('a throttle block is shared: other callers on that operation wait for it instead of sending', async () => {
    const time = new SteppedTime();
    const { client, requests } = makeClient(sequence(fail(429, 'ThrottlerException: Too Many Requests', THROTTLED)), { time });
    const first = client.textToSpeech.jobs.get(JOB_ID);
    await settle();
    expect(requests).toHaveLength(1); // throttled; now waiting Retry-After
    const second = client.textToSpeech.jobs.get(JOB_ID);
    const other = client.speechToText.jobs.get(JOB_ID);
    await settle();
    expect(requests.slice(1).map((r) => r.url.pathname)).toEqual([`/v1/speech-to-text/jobs/${JOB_ID}`]);
    await time.advance(6);
    await Promise.all([first, second, other]);
    expect(requests).toHaveLength(4);
    expect(time.sleeps[0]).toBeCloseTo(5500); // Retry-After + jitter
    expect(time.sleeps[1]).toBeCloseTo(5000); // the second caller waited for the block, not a 429 of its own
  });

  it('preflight waits for the window to reset when the last response said none remain', async () => {
    const limits = { 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '20' };
    const { client, time, requests } = makeClient(sequence(ok(JOB, limits), ok(JOB)));
    await client.textToSpeech.jobs.get(JOB_ID);
    await client.textToSpeech.jobs.get(JOB_ID);
    expect(time.sleeps).toEqual([20_000]);
    expect(requests).toHaveLength(2);
    expect(client.rateLimits).toEqual({ 'textToSpeech.jobs.get': { limit: 100, remaining: 0, resetSeconds: 20 } });
  });

  it('preflight can be turned off', async () => {
    const limits = { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '20' };
    const { client, time } = makeClient(sequence(ok(JOB, limits), ok(JOB)), { rateLimitPreflight: false });
    await client.textToSpeech.jobs.get(JOB_ID);
    await client.textToSpeech.jobs.get(JOB_ID);
    expect(time.sleeps).toEqual([]);
  });

  it('the spending limit is never retried', async () => {
    const { client, requests } = makeClient(sequence(fail(429, 'Monthly spending limit exhausted')));
    expect(await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }))).toBeInstanceOf(errors.SpendingLimitError);
    expect(requests).toHaveLength(1);
  });
});

describe('per-call options', () => {
  it('maxRetries and headers', async () => {
    const { client, requests } = makeClient(sequence(fail(500, 'Something went wrong')), {
      defaultHeaders: { 'X-Team': 'voice', 'X-Trace': 'a' },
    });
    await caught(client.textToSpeech.jobs.get(JOB_ID, { maxRetries: 0, headers: { 'X-Trace': 'b' } }));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('x-team')).toBe('voice');
    expect(requests[0]!.headers.get('x-trace')).toBe('b');
  });

  it('timeout per attempt', async () => {
    const seen: number[] = [];
    const { client } = makeClient(() => ok(JOB), { onRequest: (r) => void seen.push(r.timeout) });
    await client.textToSpeech.jobs.get(JOB_ID);
    await client.textToSpeech.jobs.get(JOB_ID, { timeout: 1234 });
    await client.withOptions({ timeout: 777 }).textToSpeech.jobs.get(JOB_ID);
    expect(seen).toEqual([50_000, 1234, 777]);
  });

  it('a deadline stops retries that would run past it', async () => {
    const { client, requests, time } = makeClient(sequence(fail(429, 'ThrottlerException: Too Many Requests', { 'Retry-After': '30' })), {
      deadline: 10_000,
    });
    expect(await caught(client.textToSpeech.jobs.get(JOB_ID))).toBeInstanceOf(errors.RateLimitError);
    expect(requests).toHaveLength(1);
    expect(time.sleeps).toEqual([]);
  });

  it('a deadline caps each attempt and is total', async () => {
    const seen: number[] = [];
    const { client } = makeClient(() => ok(JOB), { onRequest: (r) => void seen.push(r.timeout) });
    await client.textToSpeech.jobs.get(JOB_ID, { deadline: 4000 });
    expect(seen).toEqual([4000]);
  });

  it('a deadline that passes during backoff ends the call', async () => {
    const { client, requests } = makeClient(sequence(fail(502, 'Bad Gateway'), fail(502, 'Bad Gateway'), ok(JOB)));
    const error = await caught(client.textToSpeech.jobs.get(JOB_ID, { deadline: 200 }));
    expect(error).toBeInstanceOf(errors.GatewayError);
    expect(requests).toHaveLength(1); // the 375 ms backoff would pass the deadline
  });

  it('a signal cancels the call', async () => {
    const controller = new AbortController();
    const { client, requests } = makeClient(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.init.signal?.addEventListener('abort', () => reject(request.init.signal?.reason));
        }),
    );
    const pending = client.textToSpeech.jobs.get(JOB_ID, { signal: controller.signal });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    controller.abort(new Error('user cancelled'));
    expect(await caught(pending)).toMatchObject({ message: 'user cancelled' });
  });
});

describe('response metadata', () => {
  it('withResponse() gives the result with the response, request ID and rate limit', async () => {
    const limits = { 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '42', 'X-RateLimit-Reset': '17' };
    const { client, requests } = makeClient(() => ok(JOB, limits, 'req-77'));
    const call = client.textToSpeech.jobs.get(JOB_ID);
    const { data, response, requestId, rateLimit } = await call.withResponse();
    expect(data.id).toBe(JOB_ID);
    expect(data.requestId).toBe('req-77');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ratelimit-remaining')).toBe('42');
    expect(requestId).toBe('req-77');
    expect(rateLimit).toEqual({ limit: 100, remaining: 42, resetSeconds: 17 });
    expect((await call).id).toBe(JOB_ID); // awaiting it too shares the one request
    expect(requests).toHaveLength(1);
  });

  it('works for pages and exports', async () => {
    const { client } = makeClient((request) =>
      request.url.pathname.endsWith('/export')
        ? new Response('hello', { headers: { 'X-Request-Id': 'rx' } })
        : ok({ items: [JOB], total: 1 }),
    );
    const page = await client.textToSpeech.jobs.list().withResponse();
    expect(page.data.items).toHaveLength(1);
    const text = await client.speechToText.jobs.export(JOB_ID, { format: 'txt' }).withResponse();
    expect(text).toMatchObject({ data: 'hello', requestId: 'rx' });
  });

  it('errors carry the request ID and server message unchanged', async () => {
    const message = 'text must be shorter than or equal to 500 characters, voiceId must be a string';
    const { client } = makeClient(() => fail(400, message));
    const error = (await caught(client.textToSpeech.generate({ text: 'x', voiceId: 'v' }))) as errors.InvalidRequestError;
    expect(error).toBeInstanceOf(errors.InvalidRequestError);
    expect(error.errorMessage).toBe(message);
    expect(error.requestId).toBe('req-err');
    expect(error.mayHaveExecuted).toBe(false);
  });
});
