// WebSocket pass-through: auth on the upgrade, frames both ways, close codes, refused handshakes.

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';

import { mintStreamToken } from '../src/tokens.js';
import {
  API_KEY,
  AUTH,
  ORIGIN,
  UPSTREAM_RID,
  USER_TOKEN,
  closeWs,
  closed,
  closedPort,
  inbox,
  openWs,
  startProxy,
  upgradeHeaders,
} from './helpers.js';

const TTS = '/v1/text-to-speech/stream';
const STT = '/v1/speech-to-text/stream';
const SECRET = Buffer.from('test-secret');

/**
 * Expect the upgrade to be refused; return the HTTP answer.
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
 */
async function refused(url, headers = AUTH) {
  try {
    const ws = await openWs(url, headers);
    ws.terminate();
  } catch (err) {
    return /** @type {any} */ (err);
  }
  throw new Error('the upgrade was accepted');
}

/** @param {number} i @param {number} size */
const burstFrame = (i, size) => {
  const frame = Buffer.alloc(4 * size);
  for (let j = 0; j < size; j += 1) frame.writeUInt32BE(i, j * 4);
  return frame;
};

describe('WebSocket relay', () => {
  /** @type {Awaited<ReturnType<typeof startProxy>>} */
  let h;
  before(async () => {
    h = await startProxy({ maxStreamsPerUser: 100, maxStreamsTotal: 100 }); // limits have their own tests
  });
  after(async () => {
    await h.close();
  });
  const reset = () => {
    h.fake.wsHandshakes.length = 0;
    h.fake.wsCloses.length = 0;
    h.fake.wsReject = null;
    h.fake.burstSent = 0;
  };

  test('text and binary frames are relayed in order both ways', async () => {
    reset();
    const ws = await openWs(h.wsUrl(TTS));
    const messages = inbox(ws);
    for (let i = 0; i < 50; i += 1) {
      ws.send(JSON.stringify({ type: 'synthesize', text: `part ${i}` }));
      ws.send(Buffer.alloc(1000 + i, i));
    }
    for (let i = 0; i < 50; i += 1) {
      const text = await messages.next();
      assert.equal(text.isBinary, false);
      assert.deepEqual(JSON.parse(text.data.toString()), { type: 'synthesize', text: `part ${i}` });
      const binary = await messages.next();
      assert.equal(binary.isBinary, true);
      assert.deepEqual(binary.data, Buffer.alloc(1000 + i, i));
    }
    // A large burst from upstream: 2,000 frames of 32 KiB arrive complete and in order.
    ws.send(JSON.stringify({ type: 'burst', count: 2000, size: 8192 }));
    for (let i = 0; i < 2000; i += 1) {
      const frame = await messages.next();
      assert.equal(frame.isBinary, true);
      assert.ok(frame.data.equals(burstFrame(i, 8192)), `frame ${i}`);
    }
    assert.deepEqual(JSON.parse((await messages.next()).data.toString()), { type: 'done' });
    await closeWs(ws);
  });

  test('backpressure when the app reads slowly', async () => {
    reset();
    const [frames, size] = [2000, 16384]; // 2,000 frames of 64 KiB: 125 MiB
    const ws = await openWs(h.wsUrl(TTS));
    const messages = inbox(ws);
    ws.send(JSON.stringify({ type: 'burst', count: frames, size }));
    ws.pause(); // the app reads nothing for a second
    await sleep(1000);
    const inFlight = h.fake.burstSent;
    assert.ok(inFlight < frames / 2, `upstream sent ${inFlight} frames: the proxy read ahead`);
    ws.resume();
    for (let i = 0; i < frames; i += 1) {
      assert.ok((await messages.next(10_000)).data.equals(burstFrame(i, size)), `frame ${i}`);
    }
    assert.deepEqual(JSON.parse((await messages.next()).data.toString()), { type: 'done' });
    await closeWs(ws);
  });

  test('backpressure when upstream reads slowly', async () => {
    reset();
    const frames = 2000;
    const frame = Buffer.alloc(65536, 7); // 125 MiB in 64 KiB frames
    const ws = await openWs(h.wsUrl(TTS));
    const messages = inbox(ws);
    ws.send(JSON.stringify({ type: 'pause', seconds: 1.5 }));
    let sent = 0;
    const pump = (async () => {
      for (let i = 0; i < frames; i += 1) {
        await new Promise((resolve) => ws.send(frame, resolve)); // resolves once written out
        sent += 1;
      }
    })();
    await sleep(1000); // upstream reads nothing for this long
    assert.ok(sent < frames / 2, `the app sent ${sent} frames: the proxy buffered them`);
    for (let i = 0; i < frames; i += 1) {
      assert.ok((await messages.next(10_000)).data.equals(frame)); // echoed once upstream reads again
    }
    await pump;
    await closeWs(ws);
  });

  test('upstream gets the key and only the documented query', async () => {
    reset();
    const token = mintStreamToken('demo-user', SECRET, 60);
    const ws = await openWs(
      `${h.wsUrl(STT)}?sample_rate=16000&language=ar&encoding=pcm_s16le&access_token=${token}&debug=1`,
      { cookie: `session=${USER_TOKEN}`, 'x-request-id': 'app-ws-1' },
    );
    assert.equal(upgradeHeaders.get(ws)?.['x-request-id'], 'app-ws-1');
    assert.deepEqual(JSON.parse((await inbox(ws).next()).data.toString()), { type: 'session.started' }); // sent first
    await closeWs(ws);
    const seen = h.fake.wsHandshakes.at(-1);
    assert.ok(seen);
    assert.equal(seen.path, STT);
    assert.equal(seen.query, 'sample_rate=16000&language=ar&encoding=pcm_s16le');
    assert.equal(seen.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers['x-request-id'], 'app-ws-1');

    const tts = await openWs(`${h.wsUrl(TTS)}?sample_rate=16000`);
    await closeWs(tts);
    assert.equal(h.fake.wsHandshakes.at(-1)?.query, ''); // the TTS stream takes no query
  });

  test("a Speech to Text session's job is recorded as the user's before the app sees its id", async () => {
    reset();
    const ws = await openWs(h.wsUrl(STT));
    const messages = inbox(ws);
    assert.equal(JSON.parse((await messages.next()).data.toString()).type, 'session.started');
    assert.equal(await h.jobs.isOwner('speech-to-text', 'stt-stream-1', 'demo-user'), false);
    // The fake API echoes text frames, so this comes back from upstream like the real message.
    ws.send(JSON.stringify({ type: 'session.saved', jobId: 'stt-stream-1', status: 'saved' }));
    assert.equal(JSON.parse((await messages.next()).data.toString()).jobId, 'stt-stream-1');
    assert.equal(await h.jobs.isOwner('speech-to-text', 'stt-stream-1', 'demo-user'), true);
    // Frames keep their order around the one held for the record.
    ws.send(JSON.stringify({ type: 'session.started', jobId: 'stt-stream-2' }));
    ws.send('after');
    assert.equal(JSON.parse((await messages.next()).data.toString()).jobId, 'stt-stream-2');
    assert.equal((await messages.next()).data.toString(), 'after');
    await closeWs(ws);
    // The app's own frames going up are never taken as a job id.
    const tts = await openWs(h.wsUrl(TTS));
    tts.send(JSON.stringify({ type: 'session.saved', jobId: 'tts-stream-1' }));
    await inbox(tts).next();
    await closeWs(tts);
    assert.equal(await h.jobs.isOwner('speech-to-text', 'tts-stream-1', 'demo-user'), false);
  });

  test('user auth on the upgrade', async () => {
    reset();
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { authorization: `Bearer ${API_KEY}` }]) {
      const error = await refused(h.wsUrl(TTS), headers);
      assert.equal(error.status, 401);
      assert.equal(JSON.parse(error.body).errorMessage, 'Unauthorized');
    }
    // Browsers: a cookie, or a short-lived token in the URL.
    await closeWs(await openWs(h.wsUrl(TTS), { cookie: `session=${USER_TOKEN}` }));
    await closeWs(await openWs(`${h.wsUrl(TTS)}?access_token=${mintStreamToken('demo-user', SECRET, 60)}`, {}));
    const expired = mintStreamToken('demo-user', SECRET, -1);
    const forged = mintStreamToken('demo-user', Buffer.from('other-secret'), 60);
    for (const bad of [expired, forged, USER_TOKEN]) {
      assert.equal((await refused(`${h.wsUrl(TTS)}?access_token=${bad}`, {})).status, 401);
    }
    assert.equal(h.fake.wsHandshakes.length, 2);
  });

  test('a stream token from the proxy opens a stream', async () => {
    const response = await fetch(`${h.base}/stream-token`, { method: 'POST', headers: AUTH });
    const { token } = await response.json();
    const ws = await openWs(`${h.wsUrl(TTS)}?access_token=${token}`, {});
    ws.send('hello');
    assert.equal((await inbox(ws).next()).data.toString(), 'hello');
    await closeWs(ws);
  });

  for (const [code, reason] of /** @type {Array<[number, string]>} */ ([
    [4002, 'insufficient_balance'],
    [4029, 'spending_limit'],
    [1011, 'upstream_error'],
    [1008, 'invalid_message'],
    [4008, 'max_duration'],
    [1001, 'server_restarting'],
    [1000, 'stopped'],
  ])) {
    test(`upstream close ${code} reaches the app`, async () => {
      const ws = await openWs(`${h.wsUrl(STT)}?sample_rate=16000&language=en`);
      const messages = inbox(ws);
      const end = closed(ws);
      assert.equal(JSON.parse((await messages.next()).data.toString()).type, 'session.started');
      ws.send(JSON.stringify({ type: 'close', code, reason }));
      assert.deepEqual(JSON.parse((await messages.next()).data.toString()), { type: 'error', code: 'bye' }); // last message first
      assert.deepEqual(await end, [code, reason]);
    });
  }

  test('an upstream drop without a close frame is a drop for the app', async () => {
    const ws = await openWs(h.wsUrl(TTS));
    const end = closed(ws);
    ws.send(JSON.stringify({ type: 'drop' }));
    assert.equal((await end)[0], 1006);
  });

  for (const [code, reason] of /** @type {Array<[number, string]>} */ ([
    [1000, 'done'],
    [4000, 'user left'],
    [1001, 'page closed'],
  ])) {
    test(`app close ${code} reaches upstream`, async () => {
      reset();
      h.fake.wsClosed = (() => {
        /** @type {() => void} */
        let resolve = () => {};
        const promise = new Promise((r) => {
          resolve = () => r(undefined);
        });
        return { promise, resolve };
      })();
      const ws = await openWs(h.wsUrl(TTS));
      const messages = inbox(ws);
      ws.send('last words');
      assert.equal((await messages.next()).data.toString(), 'last words');
      await closeWs(ws, code, reason);
      await h.fake.wsClosed.promise;
      assert.deepEqual(h.fake.wsCloses, [[code, reason]]);
    });
  }

  for (const [status, message, headers] of /** @type {Array<[number, string, Record<string, string>]>} */ ([
    [429, 'Too many concurrent streams', {}],
    [429, 'ThrottlerException: Too Many Requests', { 'retry-after': '42' }],
    [401, 'Unauthorized', {}],
    [402, 'Insufficient subscription balance', {}],
    [400, 'sample_rate must be an integer', {}],
    [503, 'Streaming is not enabled', {}],
  ])) {
    test(`a refused upstream handshake (${status} ${message}) is mirrored`, async () => {
      reset();
      const body = {
        data: null,
        success: false,
        statusCode: status,
        errorMessage: message,
        docs: 'https://x.example.com',
      };
      h.fake.wsReject = [status, body, headers];
      const error = await refused(`${h.wsUrl(STT)}?sample_rate=16000&language=ar`);
      assert.equal(error.status, status);
      assert.deepEqual(JSON.parse(error.body), body);
      assert.match(error.headers['content-type'], /^application\/json/);
      assert.equal(error.headers['x-request-id'], UPSTREAM_RID);
      assert.equal(error.headers['retry-after'], headers['retry-after']);
      assert.equal(error.headers['x-internal-trace'], undefined);
    });
  }

  test('stream paths only', async () => {
    reset();
    assert.equal((await refused(h.wsUrl('/v1/text-to-speech/sync'))).status, 404);
    assert.equal((await refused(h.wsUrl('/v1/widgets/w1/tickets'))).status, 404);
    assert.equal(h.fake.wsHandshakes.length, 0);
  });

  test('a cross-site WebSocket is refused', async () => {
    reset();
    const error = await refused(h.wsUrl(TTS), { cookie: `session=${USER_TOKEN}`, origin: 'https://evil.example.org' });
    assert.equal(error.status, 403);
    await closeWs(await openWs(h.wsUrl(TTS), { cookie: `session=${USER_TOKEN}`, origin: ORIGIN }));
    assert.equal(h.fake.wsHandshakes.length, 1);
  });

  test('WebSocket logs have no tokens', async () => {
    h.logs.length = 0;
    const token = mintStreamToken('demo-user', SECRET, 60);
    const ws = await openWs(`${h.wsUrl(TTS)}?access_token=${token}`, {});
    const end = closed(ws);
    ws.send('private words');
    await inbox(ws).next();
    await closeWs(ws);
    await end;
    await refused(`${h.wsUrl(TTS)}?access_token=bad-token-value`, {});
    await sleep(100);
    const text = h.logs.join('\n');
    assert.match(text, /"event":"ws.close"/);
    for (const secret of [token, 'bad-token-value', API_KEY, 'private words'])
      assert.ok(!text.includes(secret), secret);
  });
});

test('an unreachable upstream refuses with 503', async () => {
  const h = await startProxy({ upstreamUrl: `http://127.0.0.1:${await closedPort()}` });
  try {
    const error = await refused(h.wsUrl(TTS));
    assert.equal(error.status, 503);
    assert.match(JSON.parse(error.body).errorMessage, /temporarily unavailable/);
  } finally {
    await h.close();
  }
});

test('the per-user stream limit, and its release', async () => {
  const h = await startProxy({ maxStreamsPerUser: 1 });
  try {
    const first = await openWs(h.wsUrl(TTS));
    const error = await refused(`${h.wsUrl(STT)}?sample_rate=16000&language=ar`);
    assert.equal(error.status, 429);
    assert.equal(JSON.parse(error.body).errorMessage, 'Too many concurrent streams');
    assert.equal(error.headers['retry-after'], undefined);
    await closeWs(first);
    await sleep(200); // the proxy releases the slot when the stream ends
    await closeWs(await openWs(h.wsUrl(TTS)));
  } finally {
    await h.close();
  }
});

test('the total stream limit', async () => {
  const h = await startProxy({ maxStreamsPerUser: 5, maxStreamsTotal: 1 });
  try {
    const first = await openWs(h.wsUrl(TTS));
    assert.equal((await refused(h.wsUrl(TTS))).status, 429);
    await closeWs(first);
  } finally {
    await h.close();
  }
});

test('a failing hook is a plain 500', async () => {
  const h = await startProxy(
    {},
    {
      authenticate: async () => {
        throw new Error('session store down: secret-detail');
      },
    },
  );
  try {
    const error = await refused(h.wsUrl(TTS));
    assert.equal(error.status, 500);
    assert.ok(!error.body.includes('secret-detail'));
    const response = await fetch(`${h.base}/v1/text-to-speech/voices`, { headers: AUTH });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).errorMessage, 'Internal server error');
  } finally {
    await h.close();
  }
});

test('stopping the proxy closes open streams with 1012, on both sides', async () => {
  const h = await startProxy();
  try {
    const ws = await openWs(h.wsUrl(TTS));
    const end = closed(ws);
    await h.close();
    assert.equal((await end)[0], 1012);
    await h.fake.wsClosed.promise;
    assert.equal(h.fake.wsCloses[0]?.[0], 1012);
  } finally {
    await h.close().catch(() => {});
  }
});
