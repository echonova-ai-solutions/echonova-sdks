// Client-level REST behaviour: withOptions, close, hooks, proxy mode, the browser guard,
// redaction, and the hooks the streaming layer builds on.
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoNova } from '../src/client.js';
import * as errors from '../src/errors.js';
import type { RequestDetails } from '../src/core/http.js';
import {
  caught,
  fail,
  JOB_ID,
  makeClient,
  ok,
  reset,
  SIGNED_URL,
  TEST_KEY,
  WAV,
  type Captured,
} from './rest-support.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const JOB = { id: JOB_ID, status: 'completed', text: 'hi', voiceId: 'v' };

describe('withOptions()', () => {
  it('makes a copy with some options changed that shares the rate-limit state', async () => {
    const { client, requests } = makeClient(() => ok(JOB, { 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '9' }));
    const scoped = client.withOptions({ maxRetries: 5, timeout: 7000, defaultHeaders: { 'X-Scope': '1' } });
    expect(scoped).toBeInstanceOf(EchoNova);
    expect(scoped.maxRetries).toBe(5);
    expect(scoped.timeout).toBe(7000);
    expect(scoped.baseURL).toBe(client.baseURL);
    expect(String(scoped)).toBe(String(client));
    await scoped.textToSpeech.jobs.get(JOB_ID);
    expect(requests[0]!.headers.get('x-scope')).toBe('1');
    expect(requests[0]!.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(client.rateLimits).toEqual(scoped.rateLimits);
    expect(scoped._rateLimitTracker).toBe(client._rateLimitTracker);
  });

  it('a copy with another key or host gets its own rate-limit state', () => {
    const { client } = makeClient(() => ok(JOB));
    expect(client.withOptions({ baseURL: 'https://eu.example.com' })._rateLimitTracker).not.toBe(client._rateLimitTracker);
    expect(client.withOptions({ apiKey: 'ek_REDACTED_another_000000000000000000' })._rateLimitTracker).not.toBe(client._rateLimitTracker);
  });
});

describe('close()', () => {
  it('cancels in-flight requests and refuses new ones', async () => {
    const { client, requests } = makeClient(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.init.signal?.addEventListener('abort', () => reject(request.init.signal?.reason));
        }),
    );
    const pending = client.textToSpeech.generate({ text: 'hi', voiceId: 'v' });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await client.close();
    const error = (await caught(pending)) as errors.APIConnectionError;
    expect(error).toBeInstanceOf(errors.APIConnectionError);
    expect(error.message).toContain('client was closed');
    expect(error.mayHaveExecuted).toBeNull(); // the POST was sent: it may or may not have run
    expect(await caught(client.textToSpeech.jobs.get(JOB_ID))).toBeInstanceOf(errors.UsageError);
    expect(await caught(client.download(SIGNED_URL))).toBeInstanceOf(errors.UsageError);
    expect(client._closeSignal.aborted).toBe(true);
    await client.close(); // idempotent
  });

  it('closing a copy does nothing; closing the original closes its copies', async () => {
    const { client } = makeClient(() => ok(JOB));
    const copy = client.withOptions({ timeout: 1000 });
    await copy.close();
    expect((await copy.textToSpeech.jobs.get(JOB_ID)).id).toBe(JOB_ID);
    await client.close();
    expect(await caught(copy.textToSpeech.jobs.get(JOB_ID))).toBeInstanceOf(errors.UsageError);
  });

  it('await using closes the client at the end of the scope', async () => {
    let signal: AbortSignal | undefined;
    {
      await using client = makeClient(() => ok(JOB)).client;
      signal = client._closeSignal;
      expect(signal.aborted).toBe(false);
    }
    expect(signal.aborted).toBe(true);
  });
});

describe('hooks', () => {
  it('onRequest and onResponse see every attempt of an API call, but not downloads', async () => {
    const seen: string[] = [];
    const details: RequestDetails[] = [];
    let n = 0;
    const { client } = makeClient(
      (request) => (request.url.hostname === 'storage.example.com' ? new Response('x') : ++n === 1 ? fail(500, 'Something went wrong') : ok(JOB)),
      {
        onRequest: async (request) => {
          details.push(request);
          request.headers.set('traceparent', `00-${request.attempt}`);
          seen.push(`request ${request.attempt}`);
        },
        onResponse: async (response, request) => void seen.push(`response ${response.status} ${request.attempt}`),
      },
    );
    await client.textToSpeech.jobs.get(JOB_ID);
    await client.download(SIGNED_URL);
    expect(seen).toEqual(['request 1', 'response 500 1', 'request 2', 'response 200 2']);
    expect(details[0]).toMatchObject({ operation: 'textToSpeech.jobs.get', method: 'GET', url: `https://api.echonova.ai/v1/text-to-speech/jobs/${JOB_ID}`, timeout: 50_000 });
  });

  it('a header added by onRequest is sent', async () => {
    const { client, requests } = makeClient(() => ok(JOB), { onRequest: (r) => void r.headers.set('X-Trace', 'abc') });
    await client.textToSpeech.jobs.get(JOB_ID);
    expect(requests[0]!.headers.get('x-trace')).toBe('abc');
  });
});

describe('hooks for the streaming layer', () => {
  it('_wsBaseURL swaps the scheme and keeps the path', () => {
    expect(makeClient(() => ok(JOB)).client._wsBaseURL).toBe('wss://api.echonova.ai');
    const local = makeClient(() => ok(JOB), { baseURL: 'http://localhost:8080/echonova/' }).client;
    expect(local._wsBaseURL).toBe('ws://localhost:8080/echonova');
  });

  it('_authHeaders() gives the default headers and the key', async () => {
    const { client } = makeClient(() => ok(JOB), { defaultHeaders: { 'X-Team': 'voice', 'User-Agent': null } });
    expect(await client._authHeaders()).toEqual({ 'X-Team': 'voice', Authorization: `Bearer ${TEST_KEY}` });
  });

  it('_authHeaders() in proxy mode gives the hook headers and no key', async () => {
    vi.stubEnv('ECHONOVA_API_KEY', TEST_KEY);
    const auth = vi.fn(async () => ({ Authorization: 'Bearer session-1', 'X-Remove': null }));
    const { client } = makeClient(() => ok(JOB), { apiKey: undefined, baseURL: 'https://api.myapp.example.com/echonova', auth, defaultHeaders: { 'X-Remove': 'x' } });
    expect(await client._authHeaders()).toEqual({ Authorization: 'Bearer session-1' });
    expect(auth).toHaveBeenCalledWith({ method: 'GET', url: 'wss://api.myapp.example.com/echonova' });
  });

  it('exposes the user agent, retry policy and rate-limit settings', () => {
    const { client } = makeClient(() => ok(JOB), { maxRetries: 4, rateLimitPreflight: false });
    expect(client._userAgent).toMatch(/^echonova-js\/\S+ \(node\/\d/);
    expect(client._retryPolicy.maxRetries).toBe(4);
    expect(client._retryPolicy.maxRetryAfter).toBe(60);
    expect(client._rateLimitPreflight).toBe(false);
    expect(client._rateLimitTracker.waitTime('x')).toBe(0);
    expect(typeof client._runtime.sleep).toBe('function');
    expect(client._logger).toBeDefined();
  });
});

describe('proxy mode', () => {
  it('sends the hook headers, never a key, to your backend', async () => {
    vi.stubEnv('ECHONOVA_API_KEY', TEST_KEY);
    const auth = vi.fn(() => ({ Authorization: 'Bearer session-7' }));
    const { client, requests } = makeClient(() => ok({ jobId: JOB_ID, status: 'pending' }), {
      apiKey: undefined,
      baseURL: 'https://api.myapp.example.com/echonova',
      auth,
    });
    await client.speechToText.jobs.create({ file: WAV, language: 'en' });
    expect(requests[0]!.url.href).toBe('https://api.myapp.example.com/echonova/v1/speech-to-text');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer session-7');
    expect(String(client)).not.toContain('c21d');
  });

  it('works in a browser, where an API key is refused', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0' });
    expect(() => makeClient(() => ok(JOB))).toThrow(errors.UnsupportedEnvironmentError);
    const { client, requests } = makeClient(() => ok(JOB), {
      apiKey: null,
      baseURL: 'https://api.myapp.example.com',
      auth: () => ({ 'X-CSRF': 't' }),
    });
    await client.textToSpeech.jobs.get(JOB_ID);
    expect(requests[0]!.headers.has('user-agent')).toBe(false); // browsers set their own
    expect(requests[0]!.headers.get('x-csrf')).toBe('t');
    expect(client._userAgent).toBeNull();
  });
});

describe('the API key, bodies and signatures never leak', () => {
  const SECRET_TEXT = 'my private transcript text';

  function everything(request: Captured): Response | Error {
    const { pathname, hostname } = request.url;
    if (hostname === 'storage.example.com') return new Response(`<Error>${request.url.href}</Error>`, { status: 403 });
    if (pathname.endsWith('/sync') && request.method === 'POST') {
      return pathname.includes('text-to-speech') ? reset() : fail(400, 'Unsupported audio format');
    }
    if (pathname.endsWith('/voices')) return fail(429, 'ThrottlerException: Too Many Requests', { 'Retry-After': '1' });
    if (request.method === 'DELETE') return fail(500, 'Something went wrong');
    return ok({ ...JOB, text: SECRET_TEXT, audioUrl: SIGNED_URL });
  }

  it('in logs, errors, toString, JSON or inspect', async () => {
    const logs: unknown[] = [];
    const logger = { error: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), info: (...a: unknown[]) => logs.push(a), debug: (...a: unknown[]) => logs.push(a) };
    const { client } = makeClient(everything, { logLevel: 'debug', logger });
    const calls: Array<() => PromiseLike<unknown>> = [
      () => client.textToSpeech.generate({ text: SECRET_TEXT, voiceId: 'v' }),
      () => client.speechToText.transcribe({ file: WAV, language: 'ar', terminology: { keywords: [SECRET_TEXT] } }),
      () => client.textToSpeech.voices.list(),
      () => client.textToSpeech.jobs.delete(JOB_ID),
      () => client.textToSpeech.jobs.get(JOB_ID),
      () => client.textToSpeech.jobs.download(JOB_ID),
      () => client.download(SIGNED_URL),
    ];
    const failures: unknown[] = [];
    for (const call of calls) {
      try {
        await call();
      } catch (error) {
        failures.push(error);
      }
    }
    expect(failures).toHaveLength(6);
    expect(logs.length).toBeGreaterThan(0);
    const texts = [
      JSON.stringify(logs),
      String(client),
      JSON.stringify(client),
      inspect(client, { showHidden: true, depth: 6 }),
      inspect(client.textToSpeech, { showHidden: true, depth: 8 }),
      inspect(client.withOptions({ timeout: 5 }), { showHidden: true, depth: 8 }),
      ...failures.flatMap((e) => [String(e), inspect(e, { depth: 6 }), JSON.stringify(e)]),
    ];
    for (const text of texts) {
      expect(text).not.toContain(TEST_KEY);
      expect(text).not.toContain(TEST_KEY.slice(3, 20));
      expect(text).not.toContain('sig=');
      expect(text).not.toContain('REDACTED-secret-signature');
      expect(text).not.toContain(SECRET_TEXT);
    }
  });

  it('logs only the method, route, status, request ID, attempt and timing', async () => {
    const logs: string[] = [];
    const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: (m: string) => void logs.push(m) };
    const { client } = makeClient(() => ok(JOB, {}, 'req-5'), { logLevel: 'debug', logger });
    await client.textToSpeech.jobs.get(JOB_ID);
    expect(logs).toEqual([expect.stringMatching(/^\[echonova\] GET \/v1\/text-to-speech\/jobs\/\{jobId\} -> 200 request_id=req-5 attempt=1 elapsed=\d+ms$/)]);
  });
});
