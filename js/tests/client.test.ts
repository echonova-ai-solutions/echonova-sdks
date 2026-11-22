import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoNova, redactKey, transportOf } from '../src/client.js';
import { UnsupportedEnvironmentError, UsageError } from '../src/errors.js';
import { resolveStreamOptions } from '../src/streaming/options.js';
import { VERSION } from '../src/version.js';
import { readFileSync } from 'node:fs';
import { success, TEST_KEY } from './helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function recordingFetch(body = success({ ok: true })) {
  const calls: Array<{ url: string; init: RequestInit; headers: Headers }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, headers: new Headers(init.headers) });
    return new Response(body, { status: 200, headers: { 'X-Request-Id': 'req-1' } });
  });
  return { fetch, calls };
}

describe('configuration', () => {
  it('reads the key from ECHONOVA_API_KEY and uses the default host', () => {
    vi.stubEnv('ECHONOVA_API_KEY', `  ${TEST_KEY}\n`);
    const client = new EchoNova();
    expect(client.baseURL).toBe('https://api.echonova.ai');
    expect(client.maxRetries).toBe(2);
    expect(client.timeout).toBeNull();
    expect(String(client)).toBe("EchoNova(baseURL='https://api.echonova.ai', apiKey='ek_…c21d')");
  });

  it('prefers explicit options over the environment', () => {
    vi.stubEnv('ECHONOVA_API_KEY', 'ek_other');
    vi.stubEnv('ECHONOVA_BASE_URL', 'https://env.example.com');
    const client = new EchoNova({ apiKey: TEST_KEY, baseURL: 'https://api.echonova.ai/', timeout: 5000, maxRetries: 0 });
    expect(client.baseURL).toBe('https://api.echonova.ai');
    expect(client.timeout).toBe(5000);
    expect(client.maxRetries).toBe(0);
  });

  it('reads ECHONOVA_BASE_URL', () => {
    vi.stubEnv('ECHONOVA_BASE_URL', 'https://proxy.example.com/echonova/');
    expect(new EchoNova({ apiKey: TEST_KEY }).baseURL).toBe('https://proxy.example.com/echonova');
  });

  it('requires a key or an auth hook', () => {
    vi.stubEnv('ECHONOVA_API_KEY', '');
    expect(() => new EchoNova()).toThrow(UsageError);
    expect(() => new EchoNova({ apiKey: '   ' })).toThrow(/ECHONOVA_API_KEY/);
    expect(() => new EchoNova({ baseURL: 'https://api.myapp.example.com' })).toThrow(/proxy mode/);
  });

  it('allows proxy mode: a custom baseURL and an auth hook, no key', () => {
    vi.stubEnv('ECHONOVA_API_KEY', '');
    const client = new EchoNova({ baseURL: 'https://api.myapp.example.com/echonova', auth: () => ({}) });
    expect(String(client)).toBe("EchoNova(baseURL='https://api.myapp.example.com/echonova', apiKey=null, auth=<hook>)");
  });

  it('never reads the environment key when an auth hook is set', async () => {
    vi.stubEnv('ECHONOVA_API_KEY', TEST_KEY);
    const { fetch, calls } = recordingFetch();
    const client = new EchoNova({ baseURL: 'https://api.myapp.example.com', auth: () => ({ 'X-Session': 's1' }), fetch });
    await transportOf(client).request({ method: 'GET', path: '/v1/x', bucket: 'x' });
    expect(calls[0]!.headers.has('authorization')).toBe(false);
    expect(calls[0]!.headers.get('x-session')).toBe('s1');
    expect(JSON.stringify(client)).not.toContain('c21d');
  });

  it('never carries the environment key into a withOptions() copy with an auth hook', async () => {
    vi.stubEnv('ECHONOVA_API_KEY', TEST_KEY);
    const { fetch, calls } = recordingFetch();
    const client = new EchoNova({ fetch });
    const auth = () => ({ 'X-Session': 's1' });
    const proxied = client.withOptions({ baseURL: 'https://api.myapp.example.com', auth });
    await transportOf(proxied).request({ method: 'GET', path: '/v1/x', bucket: 'x' });
    expect(calls[0]!.headers.has('authorization')).toBe(false);
    expect(String(proxied)).toContain('apiKey=null');
    // Also through a copy made before the auth hook was added, and after the variable is gone.
    const copy = client.withOptions({ maxRetries: 1 });
    vi.stubEnv('ECHONOVA_API_KEY', '');
    expect(String(copy)).not.toContain('apiKey=null');
    expect(String(copy.withOptions({ auth }))).toContain('apiKey=null');
  });

  it('keeps an explicit key in a withOptions() copy with an auth hook', () => {
    vi.stubEnv('ECHONOVA_API_KEY', TEST_KEY);
    const auth = () => ({ 'X-Extra': '1' });
    expect(String(new EchoNova({ apiKey: TEST_KEY }).withOptions({ auth }))).not.toContain('apiKey=null');
    expect(String(new EchoNova().withOptions({ apiKey: TEST_KEY, auth }))).not.toContain('apiKey=null');
  });

  it('warns when baseURL ends with /v1', () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    new EchoNova({ apiKey: TEST_KEY, baseURL: 'https://api.echonova.ai/v1/', logLevel: 'warn', logger });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('/v1'));
  });

  it.each([
    [{ apiKey: TEST_KEY, baseURL: 'http://api.example.com' }],
    [{ baseURL: 'http://proxy.example.com/echonova', auth: () => ({ 'X-Session': 's1' }) }],
  ])('warns once when credentials would go over plain http (%j)', (options) => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const client = new EchoNova({ ...options, logLevel: 'warn', logger });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/plain http.*unencrypted/));
    expect(logger.warn.mock.calls[0]![0]).not.toContain(TEST_KEY);
    resolveStreamOptions(client._streamOptions()); // the stream URL derives from baseURL: no second warning
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('reads plain http from ECHONOVA_BASE_URL too', () => {
    vi.stubEnv('ECHONOVA_BASE_URL', 'http://10.0.0.5:8080');
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    new EchoNova({ apiKey: TEST_KEY, logLevel: 'warn', logger });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('10.0.0.5:8080'));
  });

  it.each([['http://localhost:4010'], ['http://127.0.0.1:9000'], ['http://127.8.9.10'], ['http://[::1]:8080'], ['https://api.example.com']])(
    'stays silent for %s',
    (baseURL) => {
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      new EchoNova({ apiKey: TEST_KEY, baseURL, logLevel: 'warn', logger });
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it('reads ECHONOVA_LOG', () => {
    vi.stubEnv('ECHONOVA_LOG', 'warning');
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    new EchoNova({ apiKey: 'sk-something', logger });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it.each([
    [{ baseURL: 'not a url' }, /baseURL/],
    [{ baseURL: 'ftp://example.com' }, /http/],
    [{ baseURL: 'https://example.com/?a=1' }, /query/],
    [{ timeout: 0 }, /timeout/],
    [{ timeout: Number.NaN }, /timeout/],
    [{ maxRetries: -1 }, /maxRetries/],
    [{ maxRetries: 1.5 }, /maxRetries/],
  ])('rejects bad options %j', (options, message) => {
    expect(() => new EchoNova({ apiKey: TEST_KEY, ...options })).toThrow(message);
  });

  it('warns about a key without the ek_ prefix when logging is on', () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    new EchoNova({ apiKey: 'sk-something', logLevel: 'warn', logger });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ek_'));
    new EchoNova({ apiKey: 'sk-something', logger: { ...logger, warn: vi.fn() } }); // off by default
  });

  it('keeps the version in sync with package.json', () => {
    const pkgJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkgJson.version);
    expect(EchoNova.VERSION).toBe(pkgJson.version);
  });
});

describe('key redaction', () => {
  it('never shows the key in toString, JSON or inspect', () => {
    const client = new EchoNova({ apiKey: TEST_KEY });
    for (const text of [String(client), JSON.stringify(client), inspect(client), inspect(client, { showHidden: true, depth: 5 })]) {
      expect(text).not.toContain(TEST_KEY);
      expect(text).not.toContain(TEST_KEY.slice(3, 20));
    }
    expect(JSON.parse(JSON.stringify(client))).toMatchObject({ apiKey: 'ek_…c21d', baseURL: 'https://api.echonova.ai' });
    expect(Object.keys(client)).not.toContain('apiKey');
  });

  it('shows only the ek_ prefix and the last four characters', () => {
    expect(redactKey(TEST_KEY)).toBe('ek_…c21d');
    expect(redactKey('sk-something-else')).toBe('…else');
    expect(redactKey('ek_short')).toBe('…');
    expect(redactKey(null)).toBeNull();
    expect(redactKey('')).toBeNull();
  });
});

describe('browser guard', () => {
  const pretendBrowser = () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0' });
  };

  it('refuses an API key in a browser', () => {
    pretendBrowser();
    expect(() => new EchoNova({ apiKey: TEST_KEY })).toThrow(UnsupportedEnvironmentError);
  });

  it('allows it with dangerouslyAllowBrowser', () => {
    pretendBrowser();
    expect(() => new EchoNova({ apiKey: TEST_KEY, dangerouslyAllowBrowser: true })).not.toThrow();
  });

  it('allows proxy mode in a browser', () => {
    pretendBrowser();
    vi.stubEnv('ECHONOVA_API_KEY', '');
    const auth = () => ({ Authorization: 'Bearer session-1' });
    expect(() => new EchoNova({ baseURL: 'https://api.myapp.example.com', auth })).not.toThrow();
  });

  it('refuses a key in a browser worker', () => {
    vi.stubGlobal('WorkerGlobalScope', function WorkerGlobalScope() {});
    vi.stubGlobal('importScripts', () => {});
    expect(() => new EchoNova({ apiKey: TEST_KEY })).toThrow(UnsupportedEnvironmentError);
  });

  it('refuses a key in a React Native app, which has no document', () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    const error = (() => {
      try {
        new EchoNova({ apiKey: TEST_KEY });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(UnsupportedEnvironmentError);
    expect(String(error)).toMatch(/mobile app/);
    expect(String(error)).toMatch(/proxy mode/);
    expect(String(error)).not.toContain(TEST_KEY);
    expect(() => new EchoNova({ apiKey: TEST_KEY, dangerouslyAllowBrowser: true })).not.toThrow();
    vi.stubEnv('ECHONOVA_API_KEY', TEST_KEY);
    expect(() => new EchoNova({ baseURL: 'https://api.myapp.example.com', auth: () => ({}) })).not.toThrow();
  });

  it('does not treat Node as a browser', () => {
    expect(() => new EchoNova({ apiKey: TEST_KEY })).not.toThrow();
  });
});

describe('requests', () => {
  it('sends the key, a user agent and default headers to the configured host', async () => {
    const { fetch, calls } = recordingFetch();
    const client = new EchoNova({ apiKey: TEST_KEY, fetch, defaultHeaders: { 'X-Extra': '1' } });
    const result = await transportOf(client).request({ method: 'GET', path: '/v1/text-to-speech/voices', bucket: 'voices' });
    expect(result.data).toEqual({ ok: true });
    expect(result.requestId).toBe('req-1');
    expect(calls[0]!.url).toBe('https://api.echonova.ai/v1/text-to-speech/voices');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(calls[0]!.headers.get('user-agent')).toMatch(/^echonova-js\/\S+ \(node\/\d/);
    expect(calls[0]!.headers.get('x-extra')).toBe('1');
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('calls the auth hook on every attempt in proxy mode and sends no key', async () => {
    vi.stubEnv('ECHONOVA_API_KEY', '');
    const { fetch, calls } = recordingFetch();
    let n = 0;
    const auth = vi.fn(async () => ({ Authorization: `Bearer session-${++n}` }));
    const client = new EchoNova({ baseURL: 'https://api.myapp.example.com/echonova', auth, fetch });
    await transportOf(client).request({ method: 'POST', path: '/v1/text-to-speech', bucket: 'tts.jobs.create', json: { text: 'hi' } });
    await transportOf(client).request({ method: 'POST', path: '/v1/text-to-speech', bucket: 'tts.jobs.create', json: { text: 'hi' } });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.myapp.example.com/echonova/v1/text-to-speech',
      'https://api.myapp.example.com/echonova/v1/text-to-speech',
    ]);
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual(['Bearer session-1', 'Bearer session-2']);
    expect(auth).toHaveBeenCalledWith({ method: 'POST', url: 'https://api.myapp.example.com/echonova/v1/text-to-speech' });
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(calls[0]!.init.body).toBe('{"text":"hi"}');
  });

  it('lets a null default header remove an SDK header', async () => {
    const { fetch, calls } = recordingFetch();
    const client = new EchoNova({ apiKey: TEST_KEY, fetch, defaultHeaders: { 'User-Agent': null } });
    await transportOf(client).request({ method: 'GET', path: '/v1/x', bucket: 'x' });
    expect(calls[0]!.headers.has('user-agent')).toBe(false);
  });

  it('exposes the last rate-limit headers per operation', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(success([]), {
          headers: { 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '99', 'X-RateLimit-Reset': '60' },
        }),
    );
    const client = new EchoNova({ apiKey: TEST_KEY, fetch });
    await transportOf(client).request({ method: 'GET', path: '/v1/text-to-speech/jobs', bucket: 'textToSpeech.jobs.list' });
    expect(client.rateLimits).toEqual({ 'textToSpeech.jobs.list': { limit: 100, remaining: 99, resetSeconds: 60 } });
  });

  it('logs only safe request metadata', async () => {
    const { fetch } = recordingFetch();
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const client = new EchoNova({ apiKey: TEST_KEY, fetch, logLevel: 'debug', logger });
    await transportOf(client).request({
      method: 'POST',
      path: '/v1/text-to-speech/sync',
      bucket: 'tts.generate',
      json: { text: 'secret words' },
      query: { token: 'abc' },
    });
    const logged = JSON.stringify(logger.debug.mock.calls);
    expect(logged).toContain('POST /v1/text-to-speech/sync -> 200 request_id=req-1 attempt=1');
    expect(logged).not.toContain('secret words');
    expect(logged).not.toContain('token');
    expect(logged).not.toContain(TEST_KEY);
  });
});
