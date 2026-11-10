/** Text to Speech sessions against the mock server. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APIConnectionError,
  AuthenticationError,
  ConcurrencyLimitError,
  FeatureNotEnabledError,
  InsufficientBalanceError,
  InvalidRequestError,
  ProtocolError,
  RateLimitError,
  SessionEndedError,
  SessionExpiredError,
  SpendingLimitError,
  StreamConnectionLostError,
  UpstreamError,
  UsageError,
  VoiceNotFoundError,
  type APIStatusError,
} from '../../src/errors.js';
import { connectTts, speak, type Synthesis, type TtsSession } from '../../src/streaming/index.js';
import { chargeStateOf } from '../../src/streaming/stream-errors.js';
import { MockServer, type Rejection } from './mock-server.js';
import { TEST_KEY, delay, optionsFor, waitFor } from './stream-helpers.js';

let server: MockServer;

beforeEach(async () => {
  server = await new MockServer().start();
});

afterEach(async () => {
  await server.stop();
});

const frames = (conn = 0): Array<Record<string, unknown>> =>
  (server.ttsConns[conn]?.received ?? []).filter((f): f is Record<string, unknown> => !(f instanceof Uint8Array));
const synthFrames = (conn = 0): Array<Record<string, unknown>> => frames(conn).filter((f) => f['type'] === 'synthesize');
const frameTypes = (conn = 0): unknown[] => frames(conn).map((f) => f['type']);
const count = (items: unknown[], value: unknown): number => items.filter((i) => i === value).length;

async function firstChunk(synth: Synthesis): Promise<Uint8Array> {
  const result = await synth[Symbol.asyncIterator]().next();
  if (result.done) throw new Error('no audio');
  return result.value;
}

async function chunks(synth: Synthesis): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of synth) out.push(chunk);
  return out;
}

async function rejects(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('did not reject');
}

async function withTts<T>(body: (tts: TtsSession) => Promise<T>, overrides = {}, init = {}): Promise<T> {
  const tts = await connectTts(optionsFor(server, overrides), { voiceId: 'v1', ...init });
  try {
    return await body(tts);
  } finally {
    await tts.close();
  }
}

describe('TtsSession', () => {
  it('streams audio at the sample rate from start, and sends only the options set', async () => {
    await withTts(
      async (tts) => {
        const synth = tts.synthesize('Hello there', { numSteps: 32 });
        const audio = await chunks(synth);
        const result = await synth.result;
        expect(audio).toHaveLength(3);
        expect(audio.every((c) => c.length === 960 && c.byteOffset === 0)).toBe(true);
        expect(synth.sampleRate).toBe(22_050); // from start, never a constant
        expect(result).toMatchObject({ outcome: 'completed', charged: true, characters: 11, creditsConsumed: 11 });
        expect(synth.metrics.ttfb).not.toBeNull();
        expect(synthFrames()[0]).toEqual({
          type: 'synthesize',
          requestId: synth.requestId,
          text: 'Hello there',
          voiceId: 'v1',
          speed: 1.1,
          numSteps: 32,
        });
      },
      {},
      { speed: 1.1 },
    );
    const headers = server.attempts[0]!.headers;
    expect(headers['Authorization']).toBe(`Bearer ${TEST_KEY}`);
    expect(headers['User-Agent']).toBe('echonova-js/test');
    expect(server.attempts[0]!.path).toBe('/v1/text-to-speech/stream');
  });

  it('supersedes the running synthesis without sending cancel', async () => {
    await withTts(async (tts) => {
      const first = tts.synthesize('[slow] first');
      await firstChunk(first);
      const second = tts.synthesize('second');
      expect(await chunks(second)).toHaveLength(3);
      const result = await first.result;
      expect(result.outcome).toBe('superseded');
      expect(result.charged).toBe(true);
      expect(result.creditsConsumed).toBeGreaterThanOrEqual(1); // the share of audio sent
    });
    expect(frameTypes()).not.toContain('cancel'); // the server replaced it
  });

  it('cancels once, reports the share charged, and never sends cancel when idle', async () => {
    await withTts(async (tts) => {
      const synth = tts.synthesize('[slow] long text');
      await firstChunk(synth);
      synth.cancel();
      const result = await synth.result;
      expect(result).toMatchObject({ outcome: 'cancelled', charged: true });
      expect(result.creditsConsumed).toBeGreaterThanOrEqual(1);
      expect(count(frameTypes(), 'cancel')).toBe(1);
      tts.cancel(); // nothing running: must not send another cancel
      await delay(50);
      expect(count(frameTypes(), 'cancel')).toBe(1);
    });
  });

  it('cancels when the loop breaks', async () => {
    await withTts(async (tts) => {
      const synth = tts.synthesize('[slow] text');
      for await (const chunk of synth) {
        expect(chunk.length).toBeGreaterThan(0);
        break;
      }
      expect((await synth.result).outcome).toBe('cancelled');
      expect(count(frameTypes(), 'cancel')).toBe(1);
    });
  });

  it('cancels on await using', async () => {
    await withTts(async (tts) => {
      let handle: Synthesis;
      {
        await using synth = tts.synthesize('[slow] text');
        handle = synth;
        await firstChunk(synth);
      }
      expect((await handle.result).outcome).toBe('cancelled');
    });
  });

  it('a session is disposable with await using', async () => {
    let session: TtsSession;
    {
      await using tts = await connectTts(optionsFor(server), { voiceId: 'v1' });
      session = tts;
      expect((await tts.synthesize('hi').result).outcome).toBe('completed');
    }
    expect(session.closed).toBe(true);
    await waitFor(() => server.ttsConns[0]?.closeCode !== null);
    expect(server.ttsConns[0]!.closeCode).toBe(1000);
  });

  it('plays enqueued texts in order, one at a time', async () => {
    await withTts(async (tts) => {
      const handles = ['one', 'two', 'three'].map((text) => tts.enqueue(text));
      const outcomes = await Promise.all(handles.map(async (h) => (await h.result).outcome));
      expect(outcomes).toEqual(['completed', 'completed', 'completed']);
    });
    expect(synthFrames().map((f) => f['text'])).toEqual(['one', 'two', 'three']);
  });

  it('speakStream splits text into sentences', async () => {
    const audio = await withTts(async (tts) => {
      const out: Uint8Array[] = [];
      for await (const chunk of tts.speakStream('First one. Second one! مرحبا؟ ')) out.push(chunk);
      return out;
    });
    expect(synthFrames().map((f) => f['text'])).toEqual(['First one.', 'Second one!', 'مرحبا؟']);
    expect(audio).toHaveLength(9);
  });

  it('speakStream audio is at the session sampleRate, known before each first chunk', async () => {
    await withTts(async (tts) => {
      expect(tts.sampleRate).toBeNull(); // no synthesis has started yet
      const rates: Array<number | null> = [];
      for await (const _chunk of tts.speakStream('First one. Second one.')) rates.push(tts.sampleRate);
      expect(rates).toEqual(Array(6).fill(22_050));
      server.tts.sampleRate = 16_000;
      const later = tts.synthesize('Later');
      await later.result;
      expect(later.sampleRate).toBe(16_000);
      expect(tts.sampleRate).toBe(16_000); // the most recent start
    });
  });

  it('speakStream speaks LLM deltas', async () => {
    async function* deltas(): AsyncGenerator<string> {
      for (const piece of ['Hel', 'lo world. How ', 'are you', '? Bye']) {
        await delay(10);
        yield piece;
      }
    }
    const audio = await withTts(async (tts) => {
      const out: Uint8Array[] = [];
      for await (const chunk of tts.speakStream(deltas())) out.push(chunk);
      return out;
    });
    expect(synthFrames().map((f) => f['text'])).toEqual(['Hello world.', 'How are you?', 'Bye']);
    expect(audio).toHaveLength(9);
  });

  it('interrupt ends speakStream and drops the queue', async () => {
    const audio = await withTts(async (tts) => {
      const out: Uint8Array[] = [];
      for await (const chunk of tts.speakStream('[slow] one. [slow] two. [slow] three.')) {
        out.push(chunk);
        if (out.length === 2) tts.interrupt();
      }
      await delay(100);
      return out;
    });
    expect(audio.length).toBeLessThanOrEqual(3);
    expect(synthFrames().map((f) => f['text'])).toEqual(['[slow] one.']);
    expect(frameTypes()).toContain('cancel');
  });

  it('resends a pre-audio upstream_error once, never more', async () => {
    let synth!: Synthesis;
    await withTts(async (tts) => {
      synth = tts.synthesize('[upstream_pre] hello');
      expect(await chunks(synth)).toHaveLength(3);
      expect((await synth.result).outcome).toBe('completed');
      const failing = tts.synthesize('[upstream_pre_always] hello');
      expect(await rejects(failing.result)).toBeInstanceOf(UpstreamError);
      expect(failing.chargeState).toBe('no');
      expect(failing.charged).toBe(false);
    });
    const sent = synthFrames();
    expect(sent.slice(0, 2).map((f) => f['requestId'])).toEqual([synth.requestId, synth.requestId]); // same request twice
    expect(sent).toHaveLength(4); // the always-failing one also twice
  });

  it('keeps the audio of a mid-stream upstream_error, then throws; charged, never resent', async () => {
    await withTts(async (tts) => {
      const synth = tts.synthesize('[upstream_mid] text');
      const received: Uint8Array[] = [];
      const error = await rejects(
        (async () => {
          for await (const chunk of synth) received.push(chunk);
        })(),
      );
      expect(error).toBeInstanceOf(UpstreamError);
      expect(received).toHaveLength(1);
      expect(synth.chargeState).toBe('yes');
      expect(chargeStateOf(error)).toBe('yes');
      expect(synth.creditsConsumed).toBeGreaterThanOrEqual(1);
      expect(synthFrames()).toHaveLength(1);
    });
  });

  it('loses the request on a dropped connection and reconnects lazily', async () => {
    await withTts(async (tts) => {
      const synth = tts.synthesize('[drop] text');
      expect(await rejects(chunks(synth))).toBeInstanceOf(StreamConnectionLostError);
      expect(synth.state).toBe('lost');
      expect(synth.chargeState).toBe('yes');
      await waitFor(() => !tts.connected);
      expect(server.ttsConns).toHaveLength(1);
      expect((await tts.synthesize('again').result).outcome).toBe('completed');
    });
    expect(server.ttsConns).toHaveLength(2);
  });

  it('reconnects silently after the server idle close (4008)', async () => {
    server.tts.idleTimeout = 150;
    await withTts(
      async (tts) => {
        await waitFor(() => !tts.connected && server.ttsConns[0]?.closeCode !== null);
        expect(server.ttsConns[0]!.closeCode).toBe(4008);
        expect((await tts.synthesize('hello').result).outcome).toBe('completed');
      },
      { keepalive: null },
    );
    expect(server.ttsConns).toHaveLength(2);
  });

  it('keeps an idle socket open with JSON pings', async () => {
    server.tts.idleTimeout = 300;
    await withTts(
      async (tts) => {
        await delay(800);
        expect(tts.connected).toBe(true);
        expect(count(frameTypes(), 'ping')).toBeGreaterThanOrEqual(5);
        expect((await tts.synthesize('hello').result).outcome).toBe('completed');
      },
      { keepalive: 50 },
    );
    expect(server.ttsConns).toHaveLength(1);
  });

  it('treats a ping without pong as a lost connection; the unstarted request is charge-unknown and not resent', async () => {
    server.tts.answerPings = false;
    await withTts(
      async (tts) => {
        const synth = tts.synthesize('[nostart] text');
        const error = await rejects(synth.result);
        expect(error).toBeInstanceOf(StreamConnectionLostError);
        expect((error as Error).message).toMatch(/no pong/);
        expect(synth.chargeState).toBe('unknown');
      },
      { keepalive: 50, pongTimeout: 200 },
    );
    expect(synthFrames()).toHaveLength(1);
  });

  it('fails the session on a billing close (4002)', async () => {
    await withTts(async (tts) => {
      const synth = tts.synthesize('[close:4002] text');
      expect(await rejects(synth.result)).toBeInstanceOf(InsufficientBalanceError);
      expect(() => tts.synthesize('more')).toThrow(SessionEndedError);
    });
  });

  it.each([
    ['[close:1002] text', 1002],
    ['[close:1008] text', 1008],
    ['[bad_utf8] text', 1007],
  ])('raises ProtocolError for %s', async (text, code) => {
    await withTts(async (tts) => {
      const synth = tts.synthesize(text);
      const error = await rejects(synth.result);
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).closeCode).toBe(code);
      expect(() => tts.synthesize('more')).toThrow(SessionEndedError);
    });
  });

  it('cancels the running synthesis when a newer one is rejected', async () => {
    await withTts(async (tts) => {
      const first = tts.synthesize('[slow] first');
      await firstChunk(first);
      const rejected = tts.synthesize('   ');
      expect(await rejects(rejected.result)).toBeInstanceOf(InvalidRequestError);
      expect((await first.result).outcome).toBe('superseded'); // stopped, as the caller asked
    });
    expect(count(frameTypes(), 'cancel')).toBe(1);
  });

  it('reports the server session limit mid-synthesis, then reconnects', async () => {
    server.tts.maxDuration = 300;
    await withTts(async (tts) => {
      const synth = tts.synthesize('[slow] long');
      expect(await rejects(chunks(synth))).toBeInstanceOf(SessionExpiredError);
      expect(synth.state).toBe('lost');
      expect(synth.chargeState).toBe('yes');
      expect((await tts.synthesize('next').result).outcome).toBe('completed');
    });
    expect(server.ttsConns[0]!.closeCode).toBe(4008);
  });

  it('rejects requests one by one without ending the session', async () => {
    await withTts(async (tts) => {
      expect(await rejects(tts.synthesize('hi', { voiceId: 'missing' }).result)).toBeInstanceOf(VoiceNotFoundError);
      expect(await rejects(tts.synthesize('   ').result)).toBeInstanceOf(InvalidRequestError);
      expect((await tts.synthesize('still fine').result).outcome).toBe('completed');
    });
  });

  it('raises UsageError for an oversized frame before sending anything', async () => {
    await withTts(async (tts) => {
      expect(() => tts.synthesize('hi', { extraBody: { padding: 'x'.repeat(70_000) } })).toThrow(UsageError);
    });
    expect(synthFrames()).toEqual([]);
  });

  it('rotates an idle socket before the session limit', async () => {
    await withTts(
      async (tts) => {
        await waitFor(() => !tts.connected && server.ttsConns[0]?.closeCode !== null);
        expect(server.ttsConns[0]!.closeCode).toBe(1000); // closed by the SDK
        expect((await tts.synthesize('hello').result).outcome).toBe('completed');
      },
      { rotateAfter: 200 },
    );
    expect(server.ttsConns).toHaveLength(2);
  });

  it('waits for the running synthesis before rotating', async () => {
    server.tts.frames = 10;
    server.tts.frameInterval = 30;
    await withTts(
      async (tts) => {
        const synth = tts.synthesize('takes 0.3 s');
        expect(await chunks(synth)).toHaveLength(10); // not cut off by the rotation
        expect((await synth.result).outcome).toBe('completed');
        await waitFor(() => !tts.connected && server.ttsConns[0]?.closeCode !== null);
        expect(server.ttsConns[0]!.closeCode).toBe(1000);
      },
      { rotateAfter: 100 },
    );
    expect(server.ttsConns).toHaveLength(1);
  });

  it('limits connection attempts per session', async () => {
    await withTts(
      async (tts) => {
        expect(await rejects(tts.synthesize('[drop] x').result)).toBeInstanceOf(StreamConnectionLostError);
        const synth = tts.synthesize('needs a new socket');
        const error = await rejects(synth.result);
        expect(error).toBeInstanceOf(APIConnectionError);
        expect((error as APIConnectionError).retryDisabledReason).toBe('attempt_limit');
        expect(synth.chargeState).toBe('no');
      },
      { maxConnectAttempts: 1 },
    );
  });

  it('fails the synthesis when the headers provider throws on a reconnect', async () => {
    let calls = 0;
    const options = optionsFor(server, {
      headers: () => {
        calls += 1;
        if (calls > 1) throw new Error('token refresh failed');
        return { Authorization: `Bearer ${TEST_KEY}` };
      },
    });
    const tts = await connectTts(options, { voiceId: 'v1' });
    try {
      expect(await rejects(tts.synthesize('[drop] x').result)).toBeInstanceOf(StreamConnectionLostError);
      const synth = tts.synthesize('after the drop');
      const error = await rejects(synth.result);
      expect(error).toBeInstanceOf(APIConnectionError);
      expect((error as Error).message).toMatch(/token refresh failed/);
      expect(synth.chargeState).toBe('no');
    } finally {
      await tts.close();
    }
  });

  it('ends a running synthesis as cancelled when the session closes', async () => {
    const tts = await connectTts(optionsFor(server), { voiceId: 'v1' });
    const synth = tts.synthesize('[slow] long');
    await firstChunk(synth);
    const queued = tts.enqueue('later');
    await tts.close();
    expect((await synth.result).outcome).toBe('cancelled');
    expect(synth.charged).toBeNull(); // the server never confirmed a cost
    expect(synth.chargeState).toBe('yes');
    expect(queued.state).toBe('cancelled');
    expect(() => tts.synthesize('after')).toThrow(SessionEndedError);
  });

  it('retries "Too many concurrent streams" after an abnormal loss', async () => {
    await withTts(async (tts) => {
      expect(await rejects(tts.synthesize('[drop] x').result)).toBeInstanceOf(StreamConnectionLostError);
      await waitFor(() => !tts.connected);
      server.rejections.push(
        { status: 429, message: 'Too many concurrent streams' },
        { status: 429, message: 'Too many concurrent streams' },
      );
      expect((await tts.synthesize('back').result).outcome).toBe('completed');
    });
    expect(server.attempts.map((a) => a.rejected)).toEqual([null, 429, 429, null]);
  });
});

describe('handshake', () => {
  it.each([
    [{ status: 401, message: 'Unauthorized' }, AuthenticationError],
    [{ status: 402, message: 'Insufficient subscription balance' }, InsufficientBalanceError],
    [{ status: 429, message: 'Monthly spending limit exhausted' }, SpendingLimitError],
    [{ status: 429, message: 'Too many concurrent streams' }, ConcurrencyLimitError],
    [{ status: 503, message: 'Streaming is not enabled' }, FeatureNotEnabledError],
    [{ status: 429, message: 'ThrottlerException: Too Many Requests', retryAfter: '120' }, RateLimitError],
  ] as const)('does not retry %o', async (rejection: Rejection, ErrorClass) => {
    server.rejections.push(rejection);
    const error = (await rejects(connectTts(optionsFor(server), { voiceId: 'v1' }))) as APIStatusError;
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.statusCode).toBe(rejection.status);
    expect(error.transport).toBe('websocket');
    expect(error.requestId).toMatch(/^req-/);
    expect(server.attempts).toHaveLength(1);
  });

  it.each([
    [{ status: 429, message: 'ThrottlerException: Too Many Requests', retryAfter: '0' }],
    [{ status: 503, message: '<html>upstream busy</html>', jsonBody: false }],
  ])('retries %o', async (rejection: Rejection) => {
    server.rejections.push(rejection);
    const tts = await connectTts(optionsFor(server), { voiceId: 'v1' });
    await tts.close();
    expect(server.attempts.map((a) => a.rejected)).toEqual([rejection.status, null]);
  });

  it('retries "Too many concurrent streams" with waitForSlot', async () => {
    server.rejections.push(...Array.from({ length: 3 }, () => ({ status: 429, message: 'Too many concurrent streams' })));
    const tts = await connectTts(optionsFor(server), { voiceId: 'v1', waitForSlot: 5_000 });
    await tts.close();
    expect(server.attempts.map((a) => a.rejected)).toEqual([429, 429, 429, null]);
  });

  it('calls an async headers provider before every attempt', async () => {
    let calls = 0;
    const options = optionsFor(server, {
      headers: async () => {
        calls += 1;
        await delay(1);
        return { Authorization: `Bearer ek_async_${calls}` };
      },
    });
    server.rejections.push({ status: 503, message: '<html>busy</html>', jsonBody: false });
    const tts = await connectTts(options, { voiceId: 'v1' });
    await tts.close();
    expect(server.attempts.map((a) => a.headers['Authorization'])).toEqual(['Bearer ek_async_1', 'Bearer ek_async_2']);
  });

  it('can be aborted with a signal', async () => {
    const controller = new AbortController();
    server.rejections.push(...Array.from({ length: 5 }, () => ({ status: 429, message: 'Too many concurrent streams' })));
    const pending = connectTts(optionsFor(server), { voiceId: 'v1', waitForSlot: 60_000, signal: controller.signal });
    await waitFor(() => server.attempts.length >= 1);
    controller.abort(new Error('user gave up'));
    expect(await rejects(pending)).toMatchObject({ message: 'user gave up' });
  });
});

describe('speak', () => {
  it('returns the whole synthesis as Audio over its own socket', async () => {
    const audio = await speak(optionsFor(server), 'hello', { voiceId: 'v1' });
    expect(audio.sampleRate).toBe(22_050);
    expect(audio.pcm.length).toBe(3 * 960);
    expect(audio.duration).toBeCloseTo((3 * 960) / 44_100);
    const again = await speak(optionsFor(server), 'hello', { voiceId: 'v1', speed: 1.5 });
    expect(again.pcm).toEqual(audio.pcm);
    expect(synthFrames(1)[0]!['speed']).toBe(1.5);
    await waitFor(() => server.ttsConns.every((c) => c.closeCode !== null));
    expect(server.ttsConns.map((c) => c.closeCode)).toEqual([1000, 1000]);
  });

  it('throws the synthesis error', async () => {
    expect(await rejects(speak(optionsFor(server), 'hi', { voiceId: 'missing' }))).toBeInstanceOf(VoiceNotFoundError);
  });
});
