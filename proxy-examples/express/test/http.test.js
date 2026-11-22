// REST relay: allow-list, key injection, header filtering, auth, quota, streaming, errors.

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';

import { ConfigError, InMemoryJobOwners, createProxy, makeSettings, settingsFromEnv } from '../src/index.js';
import { REST_ROUTES } from '../src/routes.js';
import { API_KEY, AUTH, MiB, ORIGIN, UPSTREAM_RID, USER_TOKEN, closedPort, startProxy } from './helpers.js';

const JOB_ID = '65a1b2c3d4e5f60718293a4b';

/** @param {string} path */
const concrete = (path) => path.replace('{jobId}', JOB_ID);

/**
 * The Idempotency-Key the proxy sends upstream for a user's key (the tests' secret is 'test-secret').
 * @param {string} user
 * @param {string} key
 */
const scoped = (user, key) => createHmac('sha256', 'test-secret').update(`${user}\0${key}`).digest('hex');

/**
 * @param {string} url
 * @param {RequestInit & { duplex?: string }} [init]
 */
const call = (url, init = {}) =>
  fetch(url, /** @type {RequestInit} */ ({ ...init, headers: { ...AUTH, ...(init.headers ?? {}) } }));

/**
 * @param {number} total
 * @param {{ size?: number, gate?: Promise<void> }} [options]
 */
async function* chunks(total, { size = 64 * 1024, gate } = {}) {
  const block = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) block[i] = i % 256;
  let sent = 0;
  let first = true;
  while (sent < total) {
    const piece = block.subarray(0, Math.min(size, total - sent));
    yield piece;
    sent += piece.length;
    if (gate && first) {
      first = false;
      // The first chunk must reach the API before we send the second: nothing is buffered.
      await Promise.race([
        gate,
        new Promise((_, reject) => setTimeout(() => reject(new Error('upload buffered')), 10_000)),
      ]);
    }
  }
}

/** @param {number} total @param {number} [size] */
function expectedSha(total, size = 64 * 1024) {
  const block = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) block[i] = i % 256;
  const digest = createHash('sha256');
  for (let sent = 0; sent < total; sent += size) digest.update(block.subarray(0, Math.min(size, total - sent)));
  return digest.digest('hex');
}

v8.setFlagsFromString('--expose-gc');
const gc = /** @type {(options: object) => void} */ (vm.runInNewContext('gc'));

/** Live memory (JS heap + buffers, after a full GC): what the process holds, not its garbage. */
function live() {
  gc({ type: 'major', execution: 'sync', flavor: 'last-resort' });
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/** Peak growth of live memory while fn runs, sampled every 25 ms. @param {() => Promise<void>} fn */
async function peakGrowth(fn) {
  const base = live();
  let peak = base;
  const timer = setInterval(() => {
    peak = Math.max(peak, live());
  }, 25);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  return peak - base;
}

describe('REST relay', () => {
  /** @type {Awaited<ReturnType<typeof startProxy>>} */
  let h;
  before(async () => {
    h = await startProxy();
  });
  after(async () => {
    await h.close();
  });
  const reset = () => {
    h.fake.requests.length = 0;
    h.fake.respond = null;
  };

  test('every allowed route is forwarded', async () => {
    reset();
    for (const [method, path] of REST_ROUTES) {
      if (path.includes('{jobId}')) await h.jobs.record(path.split('/')[2], JOB_ID, 'demo-user'); // DELETE releases it
      const response = await call(`${h.base}${concrete(path)}?limit=5`, { method });
      assert.equal(response.status, 200, `${method} ${path}`);
      await response.arrayBuffer();
      const seen = h.fake.requests.at(-1);
      assert.deepEqual([seen?.method, seen?.path, seen?.query], [method, concrete(path), 'limit=5']);
    }
  });

  test('anything else is 404 and never reaches upstream', async () => {
    reset();
    for (const path of [
      '/v1/widgets/w1/tickets',
      '/v1/unknown',
      '/v2/text-to-speech/sync',
      '/v1/text-to-speech/jobs/..%2F..%2Fwidgets%2Fw1%2Ftickets',
      '/stream-token-x',
    ]) {
      const response = await call(h.base + path, { method: 'POST' });
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), {
        data: null,
        success: false,
        statusCode: 404,
        errorMessage: 'Route not found',
      });
    }
    const outside = await call(`${h.origin}/v1/text-to-speech/voices`);
    assert.equal(outside.status, 404);
    assert.equal(h.fake.requests.length, 0);
  });

  test('a wrong method is 405 with Allow', async () => {
    reset();
    const response = await call(`${h.base}/v1/text-to-speech/jobs/abc`, { method: 'PUT' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, DELETE');
    assert.equal((await response.json()).statusCode, 405);
    const stream = await call(`${h.base}/v1/text-to-speech/stream`);
    assert.equal(stream.status, 426);
    assert.equal(h.fake.requests.length, 0);
  });

  test('the key is injected and app credentials are stripped', async () => {
    reset();
    const response = await call(`${h.base}/v1/text-to-speech/sync`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hello', voiceId: 'v1' }),
      headers: {
        'content-type': 'application/json',
        cookie: 'session=abc; other=1',
        'x-forwarded-for': '10.0.0.1',
        'proxy-authorization': 'Basic Zm9vOmJhcg==',
        'x-custom-hop': '1',
        'x-api-key': 'ek_REDACTED_from_the_app',
        'x-request-id': 'app-req-7',
        'user-agent': 'echonova-js/0.1.0',
        'idempotency-key': '4b6f2c1e-1d2a-4e7b-9a3c-2f1e0d9c8b7a',
      },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const seen = h.fake.requests.at(-1);
    assert.ok(seen);
    assert.equal(seen.headers['idempotency-key'], scoped('demo-user', '4b6f2c1e-1d2a-4e7b-9a3c-2f1e0d9c8b7a'));
    assert.equal(seen.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(seen.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length, 1);
    for (const name of ['cookie', 'x-forwarded-for', 'proxy-authorization', 'x-custom-hop', 'x-api-key']) {
      assert.equal(seen.headers[name], undefined, name);
    }
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.headers['x-request-id'], 'app-req-7');
    assert.match(String(seen.headers['user-agent']), /^echonova-js\/0\.1\.0 echonova-proxy\//);
    assert.equal(seen.headers['accept-encoding'], 'identity');
    // The key never comes back.
    assert.ok(!text.includes(API_KEY));
    for (const [, value] of response.headers) assert.ok(!value.includes(API_KEY));
  });

  test('only safe response headers come back', async () => {
    reset();
    const response = await call(`${h.base}/v1/text-to-speech/voices`);
    await response.arrayBuffer();
    const headers = response.headers;
    assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(headers.get('x-request-id'), UPSTREAM_RID);
    assert.deepEqual(
      [headers.get('x-ratelimit-limit'), headers.get('x-ratelimit-remaining'), headers.get('x-ratelimit-reset')],
      ['100', '99', '60'],
    );
    assert.equal(headers.get('cache-control'), 'no-store');
    for (const name of ['set-cookie', 'x-powered-by', 'access-control-allow-origin', 'x-internal-trace', 'server']) {
      assert.equal(headers.get(name), null, name);
    }
  });

  test('status, body and Retry-After are preserved', async () => {
    reset();
    h.fake.respond = (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '17' });
      res.end(JSON.stringify({ data: null, success: false, statusCode: 429, errorMessage: 'ThrottlerException' }));
    };
    const response = await call(`${h.base}/v1/speech-to-text`, { method: 'POST', body: 'x' });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '17');
    assert.equal((await response.json()).errorMessage, 'ThrottlerException');
    assert.ok(response.headers.get('x-request-id')); // the proxy's own id when upstream sends none
  });

  test('an export download keeps Content-Disposition', async () => {
    reset();
    await h.jobs.record('speech-to-text', 'abc', 'demo-user');
    h.fake.respond = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/x-subrip',
        'content-disposition': "attachment; filename*=UTF-8''call.srt",
      });
      res.end('1\n00:00:00,000 --> 00:00:01,000\nhi\n');
    };
    const response = await call(`${h.base}/v1/speech-to-text/jobs/abc/export?format=srt`);
    assert.equal(response.headers.get('content-disposition'), "attachment; filename*=UTF-8''call.srt");
    assert.ok((await response.text()).startsWith('1\n'));
  });

  test('the user must authenticate', async () => {
    reset();
    const url = `${h.base}/v1/text-to-speech/voices`;
    const responses = [
      await fetch(url),
      await fetch(url, { headers: { authorization: 'Bearer wrong-token' } }),
      await fetch(url, { headers: { authorization: `Bearer ${API_KEY}` } }),
      await fetch(`${url}?access_token=${USER_TOKEN}`), // REST never takes URL tokens
    ];
    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        data: null,
        success: false,
        statusCode: 401,
        errorMessage: 'Unauthorized',
      });
    }
    const cookie = await fetch(url, { headers: { cookie: `session=${USER_TOKEN}` } });
    assert.equal(cookie.status, 200);
    await cookie.arrayBuffer();
    assert.equal(h.fake.requests.length, 1);
  });

  test('an upload is streamed chunked, not buffered', async () => {
    reset();
    const total = 150 * MiB;
    /** @type {Response | undefined} */
    let response;
    const growth = await peakGrowth(async () => {
      response = await call(`${h.base}/v1/speech-to-text`, {
        method: 'POST',
        body: /** @type {any} */ (chunks(total, { gate: h.fake.firstChunk.promise })),
        duplex: 'half',
        redirect: 'error', // keeps fetch (the test's client) from holding a copy of the upload
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
      });
      await response.arrayBuffer();
    });
    assert.equal(response?.status, 200);
    const seen = h.fake.requests.at(-1);
    assert.ok(seen);
    assert.equal(seen.headers['transfer-encoding'], 'chunked');
    assert.equal(seen.headers['content-length'], undefined);
    assert.equal(seen.bodyBytes, total);
    assert.equal(seen.bodySha256, expectedSha(total));
    assert.ok(seen.chunks > 100);
    assert.ok(growth < 32 * MiB, `live memory grew ${(growth / MiB).toFixed(1)} MiB for a 150 MiB upload`);
  });

  test('an upload with Content-Length keeps it', async () => {
    reset();
    const body = Buffer.alloc(3 * MiB, 'a');
    const response = await call(`${h.base}/v1/sound-cleaning`, { method: 'POST', body });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    const seen = h.fake.requests.at(-1);
    assert.equal(seen?.headers['content-length'], String(body.length));
    assert.equal(seen?.headers['transfer-encoding'], undefined);
    assert.equal(seen?.bodyBytes, body.length);
  });

  test('a download is streamed, not buffered', async () => {
    reset();
    await h.jobs.record('speech-to-text', 'abc', 'demo-user');
    const total = 64 * MiB;
    /** @type {() => void} */
    let release = () => {};
    const released = new Promise((r) => {
      release = () => r(undefined);
    });
    h.fake.respond = async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const block = Buffer.alloc(256 * 1024, 'z');
      res.write(block);
      await Promise.race([released, new Promise((r) => setTimeout(r, 10_000))]); // held until the app has the first bytes
      for (let i = 1; i < total / block.length; i += 1) {
        if (!res.write(block)) await new Promise((r) => res.once('drain', r));
      }
      res.end();
    };
    let received = 0;
    const growth = await peakGrowth(async () => {
      const response = await call(`${h.base}/v1/speech-to-text/jobs/abc/export`);
      assert.equal(response.status, 200);
      assert.ok(response.body);
      for await (const chunk of response.body) {
        received += chunk.length;
        release();
      }
    });
    assert.equal(received, total);
    assert.ok(growth < 32 * MiB, `live memory grew ${(growth / MiB).toFixed(1)} MiB for a 64 MiB download`);
  });

  test('an upstream redirect is never followed', async () => {
    reset();
    h.fake.respond = (_req, res) => {
      res.writeHead(302, { location: 'https://elsewhere.example.com/collect' });
      res.end();
    };
    const response = await call(`${h.base}/v1/text-to-speech/sync`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).errorMessage, 'Bad gateway: unexpected redirect from the EchoNova API');
    assert.equal(response.headers.get('location'), null);
    assert.equal(h.fake.requests.length, 1);
  });

  test('an upstream cut mid-body fails the download', async () => {
    reset();
    h.fake.respond = (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write(Buffer.alloc(10, 'x'));
      setTimeout(() => res.socket?.destroy(), 50);
    };
    const response = await call(`${h.base}/v1/text-to-speech/voices`);
    await assert.rejects(response.arrayBuffer());
  });

  test('CORS for listed origins only', async () => {
    reset();
    const url = `${h.base}/v1/text-to-speech/sync`;
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.match(String(preflight.headers.get('access-control-allow-methods')), /POST/);
    assert.match(String(preflight.headers.get('access-control-allow-headers')), /Authorization/);
    assert.match(String(preflight.headers.get('access-control-allow-headers')), /Idempotency-Key/);

    const allowed = await call(url, { method: 'POST', body: '{}', headers: { origin: ORIGIN } });
    assert.equal(allowed.status, 200);
    await allowed.arrayBuffer();
    assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(String(allowed.headers.get('access-control-expose-headers')), /X-Request-Id/);
    assert.match(String(allowed.headers.get('access-control-expose-headers')), /Retry-After/);

    // A page on another site can't even send a request with your users' cookies.
    const evil = await call(url, { method: 'POST', body: '{}', headers: { origin: 'https://evil.example.org' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const evilPreflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.org', 'access-control-request-method': 'POST' },
    });
    assert.equal(evilPreflight.status, 403);
    assert.equal(h.fake.requests.length, 1);
  });

  test('healthz', async () => {
    const response = await fetch(`${h.origin}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  test('the stream-token endpoint', async () => {
    const response = await call(`${h.base}/stream-token`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).expiresIn, 60);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${h.base}/stream-token`, { method: 'POST' })).status, 401);
  });

  test('logs never contain secrets or bodies', async () => {
    reset();
    h.logs.length = 0;
    const secretText = 'my private sentence 12345';
    const response = await call(`${h.base}/v1/text-to-speech/sync?voice=private-query`, {
      method: 'POST',
      body: JSON.stringify({ text: secretText, voiceId: 'v' }),
    });
    await response.arrayBuffer();
    await (await call(`${h.base}/v1/unknown`)).arrayBuffer();
    const text = h.logs.join('\n');
    assert.match(text, /"event":"http"/);
    assert.match(text, /"route":"\/v1\/text-to-speech\/sync"/);
    for (const secret of [API_KEY, USER_TOKEN, secretText, 'private-query']) assert.ok(!text.includes(secret), secret);
  });
});

test('a custom authenticate hook, and the quota', async () => {
  /** @type {import('../src/hooks.js').Authenticate} */
  const authenticate = async (req) =>
    /** @type {Record<string, string>} */ ({ 'Bearer alice-token': 'alice', 'Bearer bob-token': 'bob' })[
      req.headers.authorization ?? ''
    ] ?? null;
  const h = await startProxy({ requestsPerMinute: 3 }, { authenticate });
  try {
    const url = `${h.base}/v1/text-to-speech/voices`;
    const alice = { authorization: 'Bearer alice-token' };
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await fetch(url, { headers: alice });
      await response.arrayBuffer();
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    const limited = await fetch(url, { headers: alice });
    assert.equal((await limited.json()).errorMessage, 'Too many requests');
    const retryAfter = Number(limited.headers.get('retry-after'));
    assert.ok(retryAfter >= 1 && retryAfter <= 60);
    // Quotas are per user.
    assert.equal((await fetch(url, { headers: { authorization: 'Bearer bob-token' } })).status, 200);
    assert.equal((await fetch(url, { headers: AUTH })).status, 401); // the demo token means nothing to this hook
    assert.equal(h.fake.requests.length, 4);
  } finally {
    await h.close();
  }
});

describe('job ownership', () => {
  /** @type {import('../src/hooks.js').Authenticate} */
  const authenticate = async (req) =>
    /** @type {Record<string, string>} */ ({ 'Bearer alice-token': 'alice', 'Bearer bob-token': 'bob' })[
      req.headers.authorization ?? ''
    ] ?? null;
  const alice = { authorization: 'Bearer alice-token' };
  const bob = { authorization: 'Bearer bob-token' };
  /** @type {Awaited<ReturnType<typeof startProxy>>} */
  let h;
  before(async () => {
    h = await startProxy({}, { authenticate });
  });
  after(async () => {
    await h.close();
  });

  /**
   * Make the fake API answer the next calls with a job-creating body.
   * @param {Record<string, unknown>} data
   * @param {number} [status]
   */
  const creates = (data, status = 200) => {
    h.fake.respond = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data, success: true, statusCode: status, errorMessage: null }));
    };
  };
  /** @param {string} path @param {Record<string, string>} who @param {string} [method] */
  const send = async (path, who, method = 'GET') => {
    const response = await fetch(h.base + path, { method, headers: who });
    return { status: response.status, body: await response.text() };
  };

  test("another user's job is 404 for get, delete and export, and never reaches the API", async () => {
    creates({ jobId: 'stt-alice-1', status: 'processing' });
    assert.equal((await send('/v1/speech-to-text', alice, 'POST')).status, 200);
    h.fake.respond = null;
    const before = h.fake.requests.length;
    for (const [method, path] of [
      ['GET', '/v1/speech-to-text/jobs/stt-alice-1'],
      ['DELETE', '/v1/speech-to-text/jobs/stt-alice-1'],
      ['GET', '/v1/speech-to-text/jobs/stt-alice-1/export'],
    ]) {
      const response = await send(path, bob, method);
      assert.equal(response.status, 404, `${method} ${path}`);
      // The API's own answer for an unknown job: Bob can't tell that the job exists.
      assert.deepEqual(JSON.parse(response.body), {
        data: null,
        success: false,
        statusCode: 404,
        errorMessage: 'STT Job not found',
      });
    }
    assert.equal(h.fake.requests.length, before);
    assert.equal((await send('/v1/speech-to-text/jobs/stt-alice-1', alice)).status, 200);
    assert.equal((await send('/v1/speech-to-text/jobs/stt-alice-1/export', alice)).status, 200);
    assert.equal((await send('/v1/speech-to-text/jobs/never-made', alice)).status, 404);
    assert.equal(h.fake.requests.length, before + 2);
  });

  test('every job-creating route records its job, a failed call does not', async () => {
    creates({ jobId: 'tts-sync-1', status: 'completed', audioUrl: 'https://storage.example.com/a.wav' });
    await send('/v1/text-to-speech/sync', alice, 'POST');
    creates({ jobId: 'stt-sync-1', status: 'processing', resultUrl: '/v1/speech-to-text/jobs/stt-sync-1' }, 202);
    await send('/v1/speech-to-text/sync', alice, 'POST');
    creates({ id: 'clean-1', status: 'completed' });
    await send('/v1/sound-cleaning', alice, 'POST');
    creates({ jobId: 'tts-async-1', status: 'processing' });
    await send('/v1/text-to-speech', alice, 'POST');
    creates({ jobId: 'tts-refused-1' }, 402);
    await send('/v1/text-to-speech', alice, 'POST');
    h.fake.respond = null;
    for (const [product, id] of [
      ['text-to-speech', 'tts-sync-1'],
      ['speech-to-text', 'stt-sync-1'],
      ['sound-cleaning', 'clean-1'],
      ['text-to-speech', 'tts-async-1'],
    ]) {
      assert.equal((await send(`/v1/${product}/jobs/${id}`, alice)).status, 200, id);
      assert.equal((await send(`/v1/${product}/jobs/${id}`, bob)).status, 404, id);
    }
    assert.equal((await send('/v1/text-to-speech/jobs/tts-refused-1', alice)).status, 404);
    // Jobs are per product: a TTS job id doesn't open the STT routes.
    assert.equal((await send('/v1/speech-to-text/jobs/tts-sync-1', alice)).status, 404);
  });

  test('a deleted job is forgotten', async () => {
    await h.jobs.record('sound-cleaning', 'clean-del-1', 'alice');
    assert.equal((await send('/v1/sound-cleaning/jobs/clean-del-1', alice, 'DELETE')).status, 200);
    assert.equal(await h.jobs.isOwner('sound-cleaning', 'clean-del-1', 'alice'), false);
  });

  test("a co-owner's delete leaves the job for the other owner", async () => {
    // The API returns the same job for the same input, so Alice and Bob both own it.
    creates({ jobId: 'tts-shared-1', status: 'processing' });
    await send('/v1/text-to-speech', alice, 'POST');
    await send('/v1/text-to-speech', bob, 'POST');
    h.fake.respond = null;
    const path = '/v1/text-to-speech/jobs/tts-shared-1';
    const before = h.fake.requests.length;
    const deleted = await send(path, bob, 'DELETE');
    assert.equal(deleted.status, 200);
    assert.deepEqual(JSON.parse(deleted.body), {
      success: true,
      statusCode: 200,
      errorMessage: null,
      data: { deleted: true },
    });
    assert.equal(h.fake.requests.length, before); // answered by the proxy: the job stays at EchoNova for Alice
    assert.equal((await send(path, bob)).status, 404);
    assert.equal((await send(path, alice)).status, 200);
    // The last owner's delete reaches the API.
    assert.equal((await send(path, alice, 'DELETE')).status, 200);
    assert.equal(h.fake.requests.at(-1)?.method, 'DELETE');
    assert.equal((await send(path, alice)).status, 404);
  });

  test('the job lists are not forwarded', async () => {
    const before = h.fake.requests.length;
    for (const product of ['text-to-speech', 'speech-to-text', 'sound-cleaning']) {
      const response = await send(`/v1/${product}/jobs?limit=5`, alice);
      assert.equal(response.status, 404, product);
      assert.equal(JSON.parse(response.body).errorMessage, 'Route not found');
    }
    assert.equal(h.fake.requests.length, before);
  });

  test('idempotency keys are scoped to the user, and stable per user', async () => {
    h.fake.respond = null;
    const idempotencyKey = '4b6f2c1e-1d2a-4e7b-9a3c-2f1e0d9c8b7a';
    /** @param {Record<string, string>} who @param {string} value */
    const forwarded = async (who, value) => {
      await (
        await fetch(`${h.base}/v1/text-to-speech/sync`, {
          method: 'POST',
          body: '{}',
          headers: { ...who, 'content-type': 'application/json', 'idempotency-key': value },
        })
      ).arrayBuffer();
      return h.fake.requests.at(-1)?.headers['idempotency-key'];
    };
    const first = await forwarded(alice, idempotencyKey);
    assert.equal(await forwarded(alice, idempotencyKey), first); // a retry gets the first result
    assert.notEqual(await forwarded(bob, idempotencyKey), first); // Bob can't replay Alice's key
    assert.notEqual(await forwarded(alice, `${idempotencyKey}x`), first);
    assert.equal(first, scoped('alice', idempotencyKey));
    assert.match(String(first), /^[0-9a-f]{64}$/); // a key the API accepts
    // A key the API would refuse is left as it is, so the app gets the API's own 400.
    assert.equal(await forwarded(alice, 'has space'), 'has space');
    assert.equal(await forwarded(alice, 'k'.repeat(201)), 'k'.repeat(201));
  });
});

test('the in-memory job store is bounded and fails closed', async () => {
  const jobs = new InMemoryJobOwners({ maxJobs: 2 });
  await jobs.record('text-to-speech', 'a', 'alice');
  await jobs.record('text-to-speech', 'b', 'alice');
  await jobs.record('text-to-speech', 'a', 'bob'); // the same job for the same input: both own it
  await jobs.record('text-to-speech', 'c', 'alice'); // evicts b, the oldest
  assert.equal(jobs.owners.size, 2);
  assert.equal(await jobs.isOwner('text-to-speech', 'b', 'alice'), false);
  assert.equal(await jobs.isOwner('text-to-speech', 'a', 'alice'), true);
  assert.equal(await jobs.isOwner('text-to-speech', 'a', 'bob'), true);
  assert.equal(await jobs.isOwner('speech-to-text', 'a', 'alice'), false);
});

test('the upload cap', async () => {
  const h = await startProxy({ maxUploadBytes: MiB });
  try {
    const url = `${h.base}/v1/speech-to-text/sync`;
    const declared = await call(url, { method: 'POST', body: Buffer.alloc(MiB + 1) });
    assert.equal(declared.status, 413);
    assert.equal(h.fake.requests.length, 0);
    const streamed = await call(url, { method: 'POST', body: /** @type {any} */ (chunks(2 * MiB)), duplex: 'half' });
    assert.equal(streamed.status, 413);
    assert.equal((await streamed.json()).errorMessage, 'Request body too large');
    assert.ok(h.fake.requests.every((r) => r.bodyBytes <= 2 * MiB));
  } finally {
    await h.close();
  }
});

test('an unreachable upstream is 503, safe to retry', async () => {
  const h = await startProxy({ upstreamUrl: `http://127.0.0.1:${await closedPort()}` });
  try {
    const response = await call(`${h.base}/v1/text-to-speech/sync`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).errorMessage, /temporarily unavailable/);
  } finally {
    await h.close();
  }
});

test('an upstream timeout is 504', async () => {
  const h = await startProxy({ readTimeoutMs: 300 });
  try {
    h.fake.respond = (_req, res) => {
      setTimeout(() => res.end('late'), 2000);
    };
    const response = await call(`${h.base}/v1/text-to-speech/voices`);
    assert.equal(response.status, 504);
  } finally {
    await h.close();
  }
});

test('the config refuses unsafe settings', () => {
  assert.throws(() => makeSettings({ apiKey: '  ' }), ConfigError);
  assert.throws(() => makeSettings({ apiKey: API_KEY, upstreamUrl: 'http://api.echonova.ai' }), ConfigError); // clear text
  assert.throws(() => makeSettings({ apiKey: API_KEY, upstreamUrl: 'https://api.echonova.ai/v1' }), ConfigError);
  assert.throws(() => createProxy(makeSettings({ apiKey: API_KEY })), ConfigError); // no auth hook, no demo token: fail closed
  const settings = settingsFromEnv({
    ECHONOVA_API_KEY: API_KEY,
    PROXY_ALLOWED_ORIGINS: 'https://a.example.com/, https://b.example.com',
  });
  assert.deepEqual(settings.allowedOrigins, new Set(['https://a.example.com', 'https://b.example.com']));
  assert.equal(settings.upstreamUrl, 'https://api.echonova.ai');
});
