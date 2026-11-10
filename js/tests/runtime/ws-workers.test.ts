/**
 * The Cloudflare Workers transport: a `fetch()` upgrade, with a faked `fetch` and a fake
 * workerd socket (an `EventTarget` with `accept()`, no `onmessage` and no `bufferedAmount`),
 * then end to end against the mock server through a `fetch` that upgrades with `ws`.
 */

import WS from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InsufficientBalanceError } from '../../src/errors.js';
import { HandshakeRejection, WsOpenFailure, type WsHandlers, type WsOpenRequest, type WsSocket, type WsTransport } from '../../src/runtime/ws-transport.js';
import { openFetchUpgrade, type UpgradeFetch, type UpgradeResponse } from '../../src/runtime/ws-workers.js';
import { connectStt, connectTts } from '../../src/streaming/index.js';
import { MockServer } from '../streaming/mock-server.js';
import { FakeClock, flush, optionsFor, pcm } from '../streaming/stream-helpers.js';

/** A workerd client socket, as `response.webSocket` hands it over. */
class FakeWorkerSocket extends EventTarget {
  readyState = 1;
  #binaryType = 'blob';
  accepted = false;
  readonly sent: Array<string | ArrayBufferView | ArrayBuffer> = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];

  get binaryType(): string {
    return this.#binaryType;
  }

  set binaryType(value: string) {
    this.#binaryType = value;
  }

  accept(): void {
    this.accepted = true;
  }

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  message(data: unknown): void {
    this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }

  closed(code: number, reason: string): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
}

function upgraded(ws: FakeWorkerSocket, headers: Record<string, string> = {}): UpgradeResponse {
  // An EventTarget's addEventListener is typed for plain Events; the socket only dispatches the right ones.
  const webSocket = ws as unknown as NonNullable<UpgradeResponse['webSocket']>;
  return { status: 101, headers: new Headers({ Upgrade: 'websocket', ...headers }), body: null, webSocket };
}

function refused(status: number, body: string | Uint8Array, headers: Record<string, string> = {}): UpgradeResponse {
  return { status, headers: new Headers(headers), body: new Response(typeof body === 'string' ? body : body.slice()).body, webSocket: null };
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: (call: Call) => UpgradeResponse | Promise<UpgradeResponse>): { fetch: UpgradeFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return reply(call);
    },
  };
}

function request(clock: FakeClock, overrides: Partial<WsOpenRequest> = {}): WsOpenRequest {
  return {
    url: 'wss://api.example.com/v1/text-to-speech/stream',
    headers: { Authorization: 'Bearer ek_REDACTED_workers_test', 'User-Agent': 'echonova-js/test' },
    openTimeout: 5_000,
    maxPayload: 1024,
    clock,
    ...overrides,
  };
}

/** Collect what a socket delivers. */
function record(socket: WsSocket): { events: unknown[]; handlers: WsHandlers } {
  const events: unknown[] = [];
  const handlers: WsHandlers = {
    text: (data) => events.push(['text', data]),
    binary: (data) => events.push(['binary', [...data]]),
    close: (code, reason) => events.push(['close', code, reason]),
  };
  socket.start(handlers);
  return { events, handlers };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('openFetchUpgrade', () => {
  it('upgrades with fetch over https, sending the headers, and accepts the socket', async () => {
    const ws = new FakeWorkerSocket();
    const { fetch, calls } = fakeFetch(() => upgraded(ws, { 'X-Request-Id': 'req-101' }));
    const socket = await openFetchUpgrade(request(new FakeClock()), fetch);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example.com/v1/text-to-speech/stream');
    expect(calls[0]!.init.headers).toEqual({
      Authorization: 'Bearer ek_REDACTED_workers_test',
      'User-Agent': 'echonova-js/test',
      Upgrade: 'websocket',
    });
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(ws.accepted).toBe(true);
    expect(ws.binaryType).toBe('arraybuffer');
    expect(socket.responseHeaders).toMatchObject({ 'x-request-id': 'req-101', upgrade: 'websocket' });
  });

  it('turns ws:// into http://', async () => {
    const { fetch, calls } = fakeFetch(() => upgraded(new FakeWorkerSocket()));
    await openFetchUpgrade(request(new FakeClock(), { url: 'ws://127.0.0.1:8080/v1/speech-to-text/stream?sample_rate=16000' }), fetch);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8080/v1/speech-to-text/stream?sample_rate=16000');
  });

  it('delivers text, ArrayBuffer and Blob messages in order, buffered until start(), then the close', async () => {
    const ws = new FakeWorkerSocket();
    const socket = await openFetchUpgrade(request(new FakeClock()), fakeFetch(() => upgraded(ws)).fetch);
    ws.message('{"type":"start"}');
    ws.message(new Blob([new Uint8Array([1, 2])])); // needs an async conversion
    ws.message(new Uint8Array([3, 4]).buffer);
    ws.message('{"type":"done"}');
    ws.closed(4008, 'max_duration');
    await flush();
    const { events } = record(socket);
    expect(events).toEqual([
      ['text', '{"type":"start"}'],
      ['binary', [1, 2]],
      ['binary', [3, 4]],
      ['text', '{"type":"done"}'],
      ['close', 4008, 'max_duration'],
    ]);
  });

  it('sends without waiting, since a Worker socket has no bufferedAmount, and stops once closed', async () => {
    const ws = new FakeWorkerSocket();
    const socket = await openFetchUpgrade(request(new FakeClock()), fakeFetch(() => upgraded(ws)).fetch);
    record(socket);
    await socket.trySend('{"type":"ping"}'); // resolves at once: no drain polling
    await socket.trySend(new Uint8Array([1, 2]));
    expect(ws.sent).toEqual(['{"type":"ping"}', new Uint8Array([1, 2])]);
    ws.closed(1000, '');
    expect(socket.trySend('late')).toBeNull();
  });

  it('closes with 1009 when a message is over maxPayload', async () => {
    const ws = new FakeWorkerSocket();
    const socket = await openFetchUpgrade(request(new FakeClock(), { maxPayload: 4 }), fakeFetch(() => upgraded(ws)).fetch);
    const { events } = record(socket);
    ws.message('ok');
    ws.message('x'.repeat(5));
    ws.message('ignored after the close');
    ws.closed(1006, '');
    await flush();
    expect(events).toEqual([
      ['text', 'ok'],
      ['close', 1009, 'message too big'],
    ]);
    expect(ws.closes[0]).toEqual({ code: 1009, reason: 'message too big' });
  });

  it('still opens where binaryType has no setter (older compatibility dates)', async () => {
    const ws = new FakeWorkerSocket();
    Object.defineProperty(ws, 'binaryType', { get: () => 'arraybuffer' });
    const socket = await openFetchUpgrade(request(new FakeClock()), fakeFetch(() => upgraded(ws)).fetch);
    const { events } = record(socket);
    ws.message(new Uint8Array([9]).buffer);
    await flush();
    expect(events).toEqual([['binary', [9]]]);
  });

  it('reports a refused upgrade with its status, headers and body', async () => {
    const body = JSON.stringify({ data: null, statusCode: 402, success: false, errorMessage: 'Insufficient subscription balance' });
    const { fetch } = fakeFetch(() => refused(402, body, { 'Content-Type': 'application/json', 'X-Request-Id': 'req-402' }));
    const error = (await caught(openFetchUpgrade(request(new FakeClock()), fetch))) as HandshakeRejection;
    expect(error).toBeInstanceOf(HandshakeRejection);
    expect(error.status).toBe(402);
    expect(error.headers).toMatchObject({ 'content-type': 'application/json', 'x-request-id': 'req-402' });
    expect(new TextDecoder().decode(error.body)).toBe(body);
  });

  it('keeps at most 64 KiB of a refused upgrade body', async () => {
    const { fetch } = fakeFetch(() => refused(503, new Uint8Array(100 * 1024).fill(65)));
    const error = (await caught(openFetchUpgrade(request(new FakeClock()), fetch))) as HandshakeRejection;
    expect(error.body.length).toBe(64 * 1024);
  });

  it('does not follow a redirect: a 3xx is a refused upgrade', async () => {
    const { fetch, calls } = fakeFetch(() => refused(302, '', { Location: 'https://elsewhere.example.com/' }));
    const error = (await caught(openFetchUpgrade(request(new FakeClock()), fetch))) as HandshakeRejection;
    expect(error).toBeInstanceOf(HandshakeRejection);
    expect(error.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it('reports a fetch failure as WsOpenFailure', async () => {
    const { fetch } = fakeFetch(() => {
      throw new Error('Network connection lost.');
    });
    const error = (await caught(openFetchUpgrade(request(new FakeClock()), fetch))) as WsOpenFailure;
    expect(error).toBeInstanceOf(WsOpenFailure);
    expect(error.message).toBe('Network connection lost.');
    expect(error.timedOut).toBe(false);
  });

  /** A fetch that answers only when its signal aborts, as workerd does. */
  const hanging: UpgradeFetch = (_url, init) =>
    new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

  it('times out after openTimeout and aborts the fetch', async () => {
    const clock = new FakeClock();
    let signal: AbortSignal | null = null;
    const pending = caught(
      openFetchUpgrade(request(clock, { openTimeout: 2_000 }), (url, init) => {
        signal = init.signal ?? null;
        return hanging(url, init);
      }),
    );
    await clock.advance(1_999);
    expect(signal!.aborted).toBe(false);
    await clock.advance(1);
    const error = (await pending) as WsOpenFailure;
    expect(error).toBeInstanceOf(WsOpenFailure);
    expect(error.timedOut).toBe(true);
    expect(signal!.aborted).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it("rejects with the caller's abort reason, and doesn't fetch when already aborted", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const pending = caught(openFetchUpgrade(request(clock, { signal: controller.signal }), hanging));
    const reason = new Error('stop');
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(clock.pending).toBe(0);

    const { fetch, calls } = fakeFetch(() => upgraded(new FakeWorkerSocket()));
    expect(await caught(openFetchUpgrade(request(clock, { signal: controller.signal }), fetch))).toBe(reason);
    expect(calls).toEqual([]);
  });
});

/**
 * A `fetch` with workerd's upgrade semantics, built on `ws`: a 101 resolves with the open
 * socket as `webSocket`; a refused upgrade resolves with its status, headers and body.
 */
const upgradeOverWs: UpgradeFetch = (url, init) =>
  new Promise((resolve, reject) => {
    const { Upgrade: _upgrade, ...headers } = init.headers as Record<string, string>;
    const ws = new WS(url.replace(/^http/, 'ws'), { headers, perMessageDeflate: false });
    let responseHeaders: Record<string, string> = {};
    const flat = (source: Record<string, string | string[] | undefined>): Record<string, string> =>
      Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value)]));
    ws.on('upgrade', (response) => {
      responseHeaders = flat(response.headers);
    });
    ws.on('unexpected-response', (req, response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        req.destroy();
        resolve(refused(response.statusCode ?? 0, Buffer.concat(chunks), flat(response.headers)));
      });
    });
    ws.on('open', () => {
      // Like workerd, deliver nothing until the socket is accepted (the server may have sent
      // frames in the same packet as the 101).
      const socket = (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
      socket.pause();
      resolve({ status: 101, headers: new Headers(responseHeaders), body: null, webSocket: Object.assign(ws, { accept: () => socket.resume() }) });
    });
    ws.on('error', reject);
  });

describe('streams over the Workers transport (against the mock server)', () => {
  let server: MockServer;
  const transport: WsTransport = { name: 'workers', sendsHeaders: true, open: (r) => openFetchUpgrade(r, upgradeOverWs) };

  beforeEach(async () => {
    server = await new MockServer().start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('runs a Text to Speech synthesis, sending the API key', async () => {
    const tts = await connectTts(optionsFor(server, { transport }), { voiceId: 'v1' });
    try {
      const synth = tts.synthesize('Hello');
      const chunks: Uint8Array[] = [];
      for await (const chunk of synth) chunks.push(chunk);
      expect(chunks).toHaveLength(3);
      expect((await synth.result).outcome).toBe('completed');
    } finally {
      await tts.close();
    }
    expect(server.attempts[0]!.headers['Authorization']).toMatch(/^Bearer /);
  });

  it('runs a Speech to Text session to session.ended', async () => {
    const stt = await connectStt(optionsFor(server, { transport }), { sampleRate: 16_000, language: 'en' });
    await stt.sendAudio(pcm(0.5));
    const summary = await stt.stop();
    expect(summary.reason).toBe('stopped');
    expect(summary.savedStatus).toBe('saved');
  });

  it('raises a refused handshake like a REST error, with its status, body and request id', async () => {
    server.rejections.push({ status: 402, message: 'Insufficient subscription balance' });
    const error = (await caught(connectTts(optionsFor(server, { transport }), { voiceId: 'v1' }))) as InsufficientBalanceError;
    expect(error).toBeInstanceOf(InsufficientBalanceError);
    expect(error.statusCode).toBe(402);
    expect(error.transport).toBe('websocket');
    expect(error.rawBody).toContain('Insufficient subscription balance');
    expect(error.requestId).toMatch(/^req-/);
    expect(server.attempts).toHaveLength(1);
  });
});
