// ADR 0014, end to end through the resources: the Idempotency-Key that textToSpeech.generate,
// speechToText.transcribe and soundCleaning.clean send, the retries it makes safe, the in-progress
// 409s (waited out), and the wait for the job after a `202 Processing` answer. All on a fake clock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoNova } from '../src/client.js';
import { PollLimiter } from '../src/core/polling.js';
import type { Runtime } from '../src/core/runtime.js';
import * as errors from '../src/errors.js';
import * as sdk from '../src/index.js';
import {
  caught,
  exampleFor,
  fail,
  JOB_ID,
  makeClient,
  ok,
  OPENAPI,
  partsOf,
  refused,
  reset,
  resolve,
  schemaProperties,
  settle,
  SteppedTime,
  WAV,
  type Captured,
  type Handler,
} from './rest-support.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IN_PROGRESS = 'A request with this Idempotency-Key is still running.';
const STARTING = 'The same request is still being started. Send it again in a few seconds.';
const KEY_REUSED = 'This Idempotency-Key was already used for a different request.';

const TTS_RESULT = { jobId: JOB_ID, status: 'completed', audioUrl: 'https://storage.example.com/a.wav', creditsConsumed: 3 };
const STT_RESULT = { jobId: JOB_ID, status: 'completed', transcription: 'مرحبا', language: 'ar', segments: [], speakers: [] };
const CLEAN_RESULT = { id: JOB_ID, status: 'completed', fileName: 'a.wav', creditsConsumed: 1 };

type Call = (client: any, options?: object) => PromiseLike<any>;

/** The three operations that send an Idempotency-Key, each with a 200 result. */
const IDEMPOTENT: Array<[string, Call, object]> = [
  ['textToSpeech.generate', (c, o) => c.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, o), TTS_RESULT],
  ['speechToText.transcribe', (c, o) => c.speechToText.transcribe({ file: WAV, language: 'ar' }, o), STT_RESULT],
  ['soundCleaning.clean', (c, o) => c.soundCleaning.clean({ file: WAV }, o), CLEAN_RESULT],
];

/** A stepped clock whose sleeps also end when their signal aborts, as the real ones do. */
class AbortableTime extends SteppedTime {
  override runtime(): Partial<Runtime> {
    const base = super.runtime();
    return {
      ...base,
      sleep: (ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          signal?.throwIfAborted();
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          void base.sleep!(ms).then(resolve);
        }),
    };
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

function sequence(...replies: Array<Response | Error>): Handler {
  return () => replies.shift() ?? fail(500, 'no reply left');
}

const keysOf = (requests: Captured[]): Array<string | null> => requests.map((r) => r.headers.get('idempotency-key'));

describe('every call sends an Idempotency-Key', () => {
  it.each(IDEMPOTENT)('%s: a new random key per call', async (_name, call, result) => {
    const { client, requests } = makeClient(() => ok(result));
    await call(client);
    await call(client);
    const [first, second] = keysOf(requests);
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(first).not.toBe(second);
  });

  it.each(IDEMPOTENT)('%s: the caller key, verbatim', async (_name, call, result) => {
    const { client, requests } = makeClient(() => ok(result));
    await call(client, { idempotencyKey: 'Order-42/attempt:A_b' });
    expect(keysOf(requests)).toEqual(['Order-42/attempt:A_b']);
  });

  it('takes the key from an Idempotency-Key header when the option is not set', async () => {
    const { client, requests } = makeClient(sequence(fail(500, 'Something went wrong'), ok(TTS_RESULT)));
    await client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { headers: { 'idempotency-key': 'from-header' } });
    expect(keysOf(requests)).toEqual(['from-header', 'from-header']); // and it is retried with it
  });

  it('the option wins over a header', async () => {
    const { client, requests } = makeClient(() => ok(TTS_RESULT));
    await client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { idempotencyKey: 'opt', headers: { 'Idempotency-Key': 'hdr' } });
    expect(keysOf(requests)).toEqual(['opt']);
  });

  it('a header removed with null sends no key, and the call is then retried like any POST', async () => {
    const { client, requests } = makeClient(sequence(fail(500, 'Something went wrong'), ok(TTS_RESULT)));
    const error = await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { headers: { 'Idempotency-Key': null } }));
    expect(error).toBeInstanceOf(errors.ServerError);
    expect(error.idempotencyKey).toBeUndefined();
    expect(keysOf(requests)).toEqual([null]);
  });

  it.each([[''], [' padded '], ['tab\tinside'], ['ключ'], [42]])('refuses the key %j before sending anything', async (key) => {
    const { client, requests } = makeClient(() => ok(TTS_RESULT));
    const error = await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { idempotencyKey: key as string }));
    expect(error).toBeInstanceOf(errors.UsageError);
    expect(error.message).toMatch(/idempotencyKey/);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['textToSpeech.jobs.create', (c: any) => c.textToSpeech.jobs.create({ text: 'hi', voiceId: 'v' })],
    ['speechToText.jobs.create', (c: any) => c.speechToText.jobs.create({ file: WAV, language: 'ar' })],
    ['agents.sessions.start', (c: any) => c.agents.sessions.start('agent-1')],
    ['textToSpeech.jobs.get', (c: any) => c.textToSpeech.jobs.get(JOB_ID)],
  ])('%s sends none', async (_name, call) => {
    const { client, requests } = makeClient(() => ok({ jobId: JOB_ID, id: JOB_ID, status: 'pending', token: 't' }));
    await call(client);
    expect(keysOf(requests)).toEqual([null]);
  });
});

describe('a call with a key is retried when repeating it is harmless', () => {
  it.each(IDEMPOTENT)('%s: after a lost response, a 500, 502, 503 and 504, with the same key', async (_name, call, result) => {
    const { client, requests, time } = makeClient(
      sequence(
        reset(),
        fail(500, 'Something went wrong'),
        fail(502, 'Bad Gateway'),
        fail(503, 'Database unavailable'),
        new Response('upstream request timeout', { status: 504 }),
        fail(504, 'Database timed out'),
        ok(result),
      ),
      { maxRetries: 6 },
    );
    const data = await call(client);
    expect(data.status).toBe('completed');
    expect(requests).toHaveLength(7);
    const keys = keysOf(requests);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(UUID);
    expect(time.sleeps).toEqual([375, 750, 1500, 3000, 6000, 6000]); // backoff, capped at 8 s × 0.75
  });

  it('re-sends the same upload on each attempt', async () => {
    const { client, requests } = makeClient(sequence(reset(), fail(500, 'Something went wrong'), ok(STT_RESULT)));
    await client.speechToText.transcribe({ file: WAV, language: 'en', identifySpeakers: true });
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const { fields, file } = await partsOf(request);
      expect(fields).toEqual({ language: 'en', identify_speakers: 'true' });
      expect(new Uint8Array(await file!.arrayBuffer())).toEqual(WAV);
    }
  });

  it('a stream upload that was read is not sent again; the error says so and carries the key', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(WAV);
        controller.close();
      },
    });
    const { client, requests } = makeClient(async (request) => {
      await new Response(request.init.body as BodyInit).arrayBuffer(); // the server reads the upload
      return fail(500, 'Something went wrong');
    });
    const error = await caught(client.soundCleaning.clean({ file: stream }, { idempotencyKey: 'k-stream' }));
    expect(error).toBeInstanceOf(errors.ServerError);
    expect(error.retryDisabledReason).toBe('body_not_replayable');
    expect(error.idempotencyKey).toBe('k-stream');
    expect(requests).toHaveLength(1);
  });

  it('honours maxRetries', async () => {
    const { client, requests } = makeClient(sequence(fail(500, 'Something went wrong'), ok(TTS_RESULT)));
    const error = await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { maxRetries: 0 }));
    expect(error).toBeInstanceOf(errors.ServerError);
    expect(error.mayHaveExecuted).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it('honours the deadline', async () => {
    const { client, requests } = makeClient(sequence(fail(502, 'Bad Gateway'), ok(TTS_RESULT)));
    const error = await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { deadline: 200 }));
    expect(error).toBeInstanceOf(errors.GatewayError);
    expect(requests).toHaveLength(1); // the 375 ms backoff would pass the deadline
  });

  it('a signal aborts the backoff', async () => {
    const time = new AbortableTime();
    const controller = new AbortController();
    const { client, requests } = makeClient(sequence(fail(500, 'Something went wrong'), ok(TTS_RESULT)), { time });
    const pending = client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { signal: controller.signal });
    pending.then(undefined, () => undefined);
    await settle();
    expect(time.sleeps).toEqual([375]);
    controller.abort(new Error('user cancelled'));
    expect(await caught(pending)).toMatchObject({ message: 'user cancelled' });
    await time.advance(1);
    expect(requests).toHaveLength(1);
  });

  it('when the retries run out, the lost response says to send it again with the key', async () => {
    const { client, requests } = makeClient(sequence(reset(), reset(), reset()));
    const error = (await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }))) as errors.APIConnectionError;
    expect(error).toBeInstanceOf(errors.APIConnectionError);
    expect(error.mayHaveExecuted).toBe(true);
    expect(error.idempotencyKey).toBe(requests[0]!.headers.get('idempotency-key'));
    expect(error.message).toContain('send it again with the same idempotencyKey');
    expect(requests).toHaveLength(3);
  });

  it('a hook that drops the key turns the retries off', async () => {
    const { client, requests } = makeClient(sequence(fail(500, 'Something went wrong'), ok(TTS_RESULT)), {
      onRequest: (request) => void request.headers.delete('Idempotency-Key'),
    });
    expect(await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }))).toBeInstanceOf(errors.ServerError);
    expect(requests).toHaveLength(1);
  });

  it.each([
    ['textToSpeech.jobs.create', (c: any) => c.textToSpeech.jobs.create({ text: 'hi', voiceId: 'v' })],
    ['speechToText.jobs.create', (c: any) => c.speechToText.jobs.create({ file: WAV, language: 'ar' })],
  ])('async job creation (%s) is still never retried after a 500 or a lost response', async (_name, call) => {
    for (const reply of [fail(500, 'Something went wrong'), reset()]) {
      const { client, requests } = makeClient(sequence(reply, ok({ jobId: JOB_ID, status: 'pending' })));
      const error = await caught(call(client));
      expect(error.mayHaveExecuted).not.toBe(false);
      expect(error.idempotencyKey).toBeUndefined();
      expect(requests).toHaveLength(1);
    }
  });
});

describe('the idempotency 409s', () => {
  it.each([[IN_PROGRESS], [STARTING]])('"%s" is sent again with the same key', async (message) => {
    const { client, requests, time } = makeClient(sequence(fail(409, message), fail(409, message, { 'Retry-After': '2' }), ok(TTS_RESULT)));
    const result = await client.textToSpeech.generate({ text: 'hi', voiceId: 'v' });
    expect(result.jobId).toBe(JOB_ID);
    expect(new Set(keysOf(requests)).size).toBe(1);
    expect(time.sleeps).toEqual([5000, 5000]); // every 5 s; a shorter Retry-After doesn't shorten it
  });

  it('raises RequestInProgressError, with the key, when it is still running past waitTimeout', async () => {
    const { client, requests, time } = makeClient(() => fail(409, IN_PROGRESS));
    const error = (await caught(
      client.speechToText.transcribe({ file: WAV }, { idempotencyKey: 'k-busy', waitTimeout: 12_000 }),
    )) as errors.RequestInProgressError;
    expect(error).toBeInstanceOf(errors.RequestInProgressError);
    expect(error).toBeInstanceOf(errors.APIStatusError);
    expect(error.name).toBe('RequestInProgressError');
    expect(error.rule).toBe('idempotency_in_progress');
    expect(error.mayHaveExecuted).toBe(true);
    expect(error.idempotencyKey).toBe('k-busy');
    // Sent at 0, 5 and 10 s; a resend at 15 s would land past the 12 s budget.
    expect(time.sleeps).toEqual([5000, 5000]);
    expect(keysOf(requests)).toEqual(Array(3).fill('k-busy'));
    expect(EchoNova.RequestInProgressError).toBe(errors.RequestInProgressError);
    expect(sdk.RequestInProgressError).toBe(errors.RequestInProgressError);
  });

  it('a key reused for a different request is an InvalidRequestError, never retried', async () => {
    const { client, requests } = makeClient(sequence(fail(409, KEY_REUSED), ok(CLEAN_RESULT)));
    const error = await caught(client.soundCleaning.clean({ file: WAV }, { idempotencyKey: 'k-reused' }));
    expect(error).toBeInstanceOf(errors.InvalidRequestError);
    expect(error.rule).toBe('idempotency_key_reused');
    expect(error.mayHaveExecuted).toBe(false);
    expect(error.idempotencyKey).toBe('k-reused');
    expect(requests).toHaveLength(1);
  });

  it('without a key (async job creation), the in-progress 409 is not retried', async () => {
    const { client, requests } = makeClient(sequence(fail(409, STARTING), ok({ jobId: JOB_ID, status: 'pending' })));
    expect(await caught(client.textToSpeech.jobs.create({ text: 'hi', voiceId: 'v' }))).toBeInstanceOf(errors.RequestInProgressError);
    expect(requests).toHaveLength(1);
  });
});

describe('a first request with the key that is still running is waited for', () => {
  const busy = (headers: Record<string, string> = {}) => fail(409, IN_PROGRESS, headers);
  const generate = (client: any, options: object = {}) => client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, options);

  it.each([[IN_PROGRESS], [STARTING]])('"%s": sent again exactly every 5 s until it answers', async (message) => {
    const { client, requests, time } = makeClient(
      sequence(fail(409, message), fail(409, message), fail(409, message), fail(409, message), fail(409, message), ok(TTS_RESULT)),
    );
    time.random = 0.99; // no jitter on the resends
    expect((await generate(client)).jobId).toBe(JOB_ID);
    expect(time.sleeps).toEqual([5000, 5000, 5000, 5000, 5000]);
    expect(new Set(keysOf(requests)).size).toBe(1);
    expect(requests).toHaveLength(6);
  });

  it('the resends do not count against maxRetries: a 500 afterwards is still retried', async () => {
    const { client, requests, time } = makeClient(sequence(busy(), busy(), busy(), fail(500, 'Something went wrong'), ok(TTS_RESULT)), {
      maxRetries: 1,
    });
    expect((await generate(client)).jobId).toBe(JOB_ID);
    expect(time.sleeps).toEqual([5000, 5000, 5000, 375]);
    expect(requests).toHaveLength(5);
  });

  it.each([
    ['8', [8000, 8000]],
    ['3', [5000, 5000]],
    ['90', [90_000, 90_000]], // longer than the 60 s a retry may wait: still waited for, within the budget
  ] as const)('waits Retry-After when it is longer than 5 s (Retry-After: %s)', async (retryAfter, sleeps) => {
    const { client, time } = makeClient(sequence(busy({ 'Retry-After': retryAfter }), busy({ 'Retry-After': retryAfter }), ok(TTS_RESULT)), {
      maxRetries: 0,
    });
    await generate(client);
    expect(time.sleeps).toEqual(sleeps);
  });

  it.each([
    [fail(400, 'text must be a string'), errors.InvalidRequestError],
    [fail(500, 'Something went wrong'), errors.ServerError],
    [fail(409, KEY_REUSED), errors.InvalidRequestError],
  ] as const)('the first other answer decides the call (%#)', async (reply, ErrorClass) => {
    const { client, requests } = makeClient(sequence(busy(), busy(), reply), { maxRetries: 0 });
    const error = await caught(generate(client, { idempotencyKey: 'k-then' }));
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.idempotencyKey).toBe('k-then');
    expect(requests).toHaveLength(3);
  });

  it('a lost response afterwards is retried as usual, with the same key', async () => {
    const { client, requests } = makeClient(sequence(busy(), busy(), reset(), ok(TTS_RESULT)), { maxRetries: 1 });
    expect((await generate(client)).jobId).toBe(JOB_ID);
    expect(new Set(keysOf(requests)).size).toBe(1);
    expect(requests).toHaveLength(4);
  });

  it('the budget is 20 minutes by default, and no resend lands at its end', async () => {
    const { client, requests, time } = makeClient(() => busy());
    expect(await caught(generate(client))).toBeInstanceOf(errors.RequestInProgressError);
    expect(requests).toHaveLength(240); // at 0, 5, ... 1195 s: a resend at 1200 s would land at the end
    expect(time.sleeps.reduce((a, b) => a + b, 0)).toBe(1_195_000);
  });

  it('the deadline caps the budget', async () => {
    const { client, requests, time } = makeClient(() => busy());
    expect(await caught(generate(client, { deadline: 8_000 }))).toBeInstanceOf(errors.RequestInProgressError);
    expect(time.sleeps).toEqual([5000]); // the next resend, at 10 s, would be past 8 s
    expect(requests).toHaveLength(2);
  });

  it('shares one budget with a 202 that follows: the polls get what is left', async () => {
    let posts = 0;
    const { client, requests, time } = makeClient((request) => {
      if (request.method === 'POST') return (posts += 1) <= 2 ? busy() : processing();
      return ok({ id: JOB_ID, status: 'processing' });
    });
    const error = await caught(generate(client, { waitTimeout: 20_000 }));
    expect(error).toBeInstanceOf(errors.JobWaitTimeoutError);
    expect(error.message).toContain('after 10 s'); // the 202 came at 10 s of a 20 s budget
    expect(time.sleeps).toEqual([5000, 5000, 3000, 3000, 3000]); // polls at 10, 13, 16 and 19 s
    expect(requests.map((r) => r.method)).toEqual(['POST', 'POST', 'POST', 'GET', 'GET', 'GET', 'GET']);
  });

  it('the signal aborts the wait', async () => {
    const time = new AbortableTime();
    const controller = new AbortController();
    const { client, requests } = makeClient(() => busy(), { time, maxRetries: 0 });
    const pending = generate(client, { signal: controller.signal });
    pending.then(undefined, () => undefined);
    await settle();
    expect(time.sleeps).toEqual([5000]);
    controller.abort(new Error('user cancelled'));
    expect(await caught(pending)).toMatchObject({ message: 'user cancelled' });
    await time.advance(10);
    expect(requests).toHaveLength(1);
  });

  it('a stream upload that was read is not sent again: RequestInProgressError at once', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(WAV);
        controller.close();
      },
    });
    const { client, requests } = makeClient(async (request) => {
      await new Response(request.init.body as BodyInit).arrayBuffer();
      return busy();
    });
    const error = await caught(client.soundCleaning.clean({ file: stream }));
    expect(error).toBeInstanceOf(errors.RequestInProgressError);
    expect(error.retryDisabledReason).toBe('body_not_replayable');
    expect(requests).toHaveLength(1);
  });
});

describe('errors carry the key', () => {
  it.each(IDEMPOTENT)('%s: status and connection errors', async (_name, call) => {
    const status = makeClient(() => fail(400, 'text must be a string'));
    const invalid = await caught(call(status.client, { idempotencyKey: 'k-400' }));
    expect(invalid).toBeInstanceOf(errors.InvalidRequestError);
    expect(invalid.idempotencyKey).toBe('k-400');

    const lost = makeClient(() => reset());
    const connection = await caught(call(lost.client, { maxRetries: 0 }));
    expect(connection).toBeInstanceOf(errors.APIConnectionError);
    expect(connection.idempotencyKey).toMatch(UUID);
    expect(connection.idempotencyKey).toBe(lost.requests[0]!.headers.get('idempotency-key'));
  });

  it('as an own, enumerable property, and only on these calls', async () => {
    const { client } = makeClient(() => fail(401, 'Unauthorized'));
    const keyed = await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { idempotencyKey: 'k' }));
    expect(Object.keys(keyed)).toContain('idempotencyKey');
    const plain = await caught(client.textToSpeech.jobs.get(JOB_ID));
    expect(plain).toBeInstanceOf(errors.AuthenticationError);
    expect(plain.idempotencyKey).toBeUndefined();
    expect('idempotencyKey' in plain).toBe(false);
    expect(new errors.APIConnectionError('x').idempotencyKey).toBeUndefined();
  });

  it('a refused connection is retried too (nothing was sent)', async () => {
    const { client, requests } = makeClient(sequence(refused(), ok(TTS_RESULT)));
    await client.textToSpeech.generate({ text: 'hi', voiceId: 'v' });
    expect(new Set(keysOf(requests)).size).toBe(1);
    expect(requests).toHaveLength(2);
  });
});

// --- 202 Processing ------------------------------------------------------------------------------

function processing(jobId = JOB_ID, service = 'text-to-speech', requestId = 'req-202'): Response {
  const data = { jobId, status: 'processing', resultUrl: `/v1/${service}/jobs/${jobId}` };
  return new Response(JSON.stringify({ data, success: true, statusCode: 202, errorMessage: null }), {
    status: 202,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
  });
}

/** POSTs answer `post`; job GETs walk through `jobs` (the last one repeats), each with its own request ID. */
function server(post: () => Response | Error, ...jobs: Array<object | Response | Error>): Handler {
  let polls = 0;
  return (request) => {
    if (request.method === 'POST') return post();
    const next = jobs[Math.min(polls, jobs.length - 1)]!;
    polls += 1;
    if (next instanceof Response) return next.clone();
    if (next instanceof Error) return next;
    return ok(next, {}, `req-poll-${polls}`);
  };
}

const jobExample = (schema: string, extra: object): Record<string, unknown> => ({
  ...exampleFor(resolve({ $ref: `#/components/schemas/${schema}` })),
  id: JOB_ID,
  ...extra,
});

const fieldsOf = (schema: string): string[] => Object.keys(schemaProperties({ $ref: `#/components/schemas/${schema}` }));

describe('202 Processing: the call waits for its job', () => {
  it.each([
    ['textToSpeech.generate', 'text-to-speech', 'V1TtsJobResponseDto', 'V1TtsSyncResponseDto', 3000, (c: any) => c.textToSpeech.generate({ text: 'hi', voiceId: 'v' })],
    ['speechToText.transcribe', 'speech-to-text', 'V1SttJobResponseDto', 'V1SttSyncResponseDto', 5000, (c: any) => c.speechToText.transcribe({ file: WAV })],
  ] as const)('%s polls the job and returns it as the result a 200 would have', async (_name, service, jobSchema, resultSchema, interval, call) => {
    const done = jobExample(jobSchema, { status: 'completed', error: null });
    const { client, requests, time } = makeClient(
      server(() => processing(JOB_ID, service), { id: JOB_ID, status: 'processing' }, { id: JOB_ID, status: 'processing' }, done),
    );
    const result = await call(client);
    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      `POST /v1/${service}/sync`,
      `GET /v1/${service}/jobs/${JOB_ID}`,
      `GET /v1/${service}/jobs/${JOB_ID}`,
      `GET /v1/${service}/jobs/${JOB_ID}`,
    ]);
    expect(time.sleeps).toEqual([interval, interval]);
    // The job's JSON plus jobId, with the last poll's request ID: every field of a 200's result, and more.
    expect(result).toEqual({ ...done, jobId: JOB_ID, requestId: 'req-poll-3' });
    for (const field of fieldsOf(resultSchema)) expect(result).toHaveProperty(field);
  });

  it('soundCleaning.clean polls every 5 s and returns the job', async () => {
    const done = jobExample('V1CleanJobResponseDto', { status: 'completed' });
    const { client, requests, time } = makeClient(server(() => processing(JOB_ID, 'sound-cleaning'), { id: JOB_ID, status: 'pending' }, done));
    const job = await client.soundCleaning.clean({ file: WAV });
    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      'POST /v1/sound-cleaning',
      `GET /v1/sound-cleaning/jobs/${JOB_ID}`,
      `GET /v1/sound-cleaning/jobs/${JOB_ID}`,
    ]);
    expect(time.sleeps).toEqual([5000]);
    expect(job).toEqual({ ...done, jobId: JOB_ID, requestId: 'req-poll-2' });
  });

  it('withResponse() gives the last poll', async () => {
    const { client } = makeClient(server(() => processing(), { ...TTS_RESULT, id: JOB_ID, jobId: undefined }));
    const { data, response, requestId } = await client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }).withResponse();
    expect(response.status).toBe(200);
    expect(requestId).toBe('req-poll-1');
    expect(data.requestId).toBe('req-poll-1');
    expect(data.audioUrl).toBe(TTS_RESULT.audioUrl);
  });

  it('the upload is sent once: a 202 is never answered by uploading again', async () => {
    const { client, requests } = makeClient(server(() => processing(JOB_ID, 'speech-to-text'), { id: JOB_ID, status: 'completed', transcription: 'x' }));
    const result = await client.speechToText.transcribe({ file: WAV, language: 'en' }, { idempotencyKey: 'k-202' });
    expect(result.transcription).toBe('x');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(keysOf(requests)).toEqual(['k-202', null]); // polls send no key
  });

  it("polls send the caller's extra headers, except Idempotency-Key", async () => {
    const { client, requests } = makeClient(server(() => processing(), { id: JOB_ID, status: 'completed', audioUrl: 'u' }), {
      defaultHeaders: { 'X-Team': 'voice' },
    });
    await client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { headers: { 'X-Trace': 't1', 'idempotency-key': 'k-hdr' } });
    const [post, poll] = requests;
    expect([post!.headers.get('x-trace'), post!.headers.get('x-team'), post!.headers.get('idempotency-key')]).toEqual(['t1', 'voice', 'k-hdr']);
    expect([poll!.headers.get('x-trace'), poll!.headers.get('x-team'), poll!.headers.get('idempotency-key')]).toEqual(['t1', 'voice', null]);
  });

  it('a failed job raises JobFailedError with the job', async () => {
    const failed = { id: JOB_ID, status: 'failed', error: 'voice unavailable', text: 'hi', voiceId: 'v' };
    const { client } = makeClient(server(() => processing(), { id: JOB_ID, status: 'processing' }, failed));
    const error = (await caught(
      client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { idempotencyKey: 'k-failed' }),
    )) as errors.JobFailedError;
    expect(error).toBeInstanceOf(errors.JobFailedError);
    expect('idempotencyKey' in error).toBe(false); // it carries the job instead
    expect(error.message).toContain('voice unavailable');
    expect(error.job).toMatchObject({ ...failed, requestId: 'req-poll-2' });
  });

  it('past waitTimeout it raises JobWaitTimeoutError with the job ID and the last job', async () => {
    const { client, requests, time } = makeClient(server(() => processing(), { id: JOB_ID, status: 'processing' }));
    const error = (await caught(
      client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { waitTimeout: 10_000, idempotencyKey: 'k-slow' }),
    )) as errors.JobWaitTimeoutError;
    expect(error).toBeInstanceOf(errors.JobWaitTimeoutError);
    expect('idempotencyKey' in error).toBe(false); // it carries the job ID and the last job instead
    expect(error.jobId).toBe(JOB_ID);
    expect(error.lastJob).toMatchObject({ id: JOB_ID, status: 'processing' });
    expect(time.sleeps).toEqual([3000, 3000, 3000]);
    expect(requests.filter((r) => r.method === 'GET')).toHaveLength(4); // at 0, 3, 6 and 9 s
  });

  it('waits up to 20 minutes by default', async () => {
    const { client, requests, time } = makeClient(server(() => processing(JOB_ID, 'sound-cleaning'), { id: JOB_ID, status: 'processing' }));
    const error = await caught(client.soundCleaning.clean({ file: WAV }));
    expect(error).toBeInstanceOf(errors.JobWaitTimeoutError);
    expect(error.message).toContain('after 1200 s');
    expect(time.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_200_000);
    expect(requests.filter((r) => r.method === 'GET').length).toBe(241); // at 0, 5, ... 1200 s
  });

  it('the deadline caps the wait', async () => {
    const { client, time } = makeClient(server(() => processing(), { id: JOB_ID, status: 'processing' }));
    const error = await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { deadline: 7_000 }));
    expect(error).toBeInstanceOf(errors.JobWaitTimeoutError);
    expect(time.sleeps).toEqual([3000, 3000]);
  });

  it.each([[-1], [Number.NaN], ['10' as unknown as number]])('refuses waitTimeout %j before sending', async (waitTimeout) => {
    const { client, requests } = makeClient(() => processing());
    expect(await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { waitTimeout }))).toBeInstanceOf(errors.UsageError);
    expect(requests).toHaveLength(0);
  });

  it('the signal aborts the wait', async () => {
    const time = new AbortableTime();
    const controller = new AbortController();
    const { client, requests } = makeClient(server(() => processing(), { id: JOB_ID, status: 'processing' }), { time });
    const pending = client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { signal: controller.signal });
    pending.then(undefined, () => undefined);
    await settle();
    expect(requests.map((r) => r.method)).toEqual(['POST', 'GET']);
    controller.abort(new Error('user cancelled'));
    expect(await caught(pending)).toMatchObject({ message: 'user cancelled' });
    await time.advance(10);
    expect(requests).toHaveLength(2);
  });

  it('keeps polling through transient errors; other errors end the call and carry the key', async () => {
    const transient = makeClient(
      server(() => processing(), fail(503, 'Database unavailable'), { id: JOB_ID, status: 'completed', audioUrl: 'u' }),
      { maxRetries: 0 },
    );
    expect((await transient.client.textToSpeech.generate({ text: 'hi', voiceId: 'v' })).audioUrl).toBe('u');

    const gone = makeClient(server(() => processing(), fail(404, 'TTS Job not found')));
    const error = await caught(gone.client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { idempotencyKey: 'k-gone' }));
    expect(error).toBeInstanceOf(errors.JobNotFoundError);
    expect(error.idempotencyKey).toBe('k-gone');
  });

  it('polls share the per-route limiter with jobs.wait()', async () => {
    const reserve = vi.spyOn(PollLimiter.prototype, 'reserve');
    const { client } = makeClient(server(() => processing(JOB_ID, 'speech-to-text'), { id: JOB_ID, status: 'completed' }));
    await client.speechToText.transcribe({ file: WAV });
    expect(reserve.mock.calls).toEqual([['speechToText.jobs.get']]);
  });

  it('a 202 without a jobId is a protocol error (sent again once, with the same key)', async () => {
    const empty = () => new Response(JSON.stringify({ data: { status: 'processing' }, success: true }), { status: 202 });
    const { client, requests } = makeClient(server(empty));
    const error = await caught(client.textToSpeech.generate({ text: 'hi', voiceId: 'v' }, { idempotencyKey: 'k-bad' }));
    expect(error).toBeInstanceOf(errors.ProtocolError);
    expect(error.message).toContain("missing 'jobId'");
    expect(error.idempotencyKey).toBe('k-bad');
    expect(keysOf(requests)).toEqual(['k-bad', 'k-bad']);
  });
});
