/** The Link driver and the handshake loop, on a fake clock with a fake transport (no sockets, no real time). */

import { describe, expect, it } from 'vitest';
import {
  APIConnectionError,
  ConcurrencyLimitError,
  RateLimitError,
  ServiceUnavailableError,
  UsageError,
} from '../../src/errors.js';
import {
  HandshakeRejection,
  WsOpenFailure,
  type WsHandlers,
  type WsOpenRequest,
  type WsSocket,
  type WsTransport,
} from '../../src/runtime/ws-transport.js';
import { AttemptLimiter } from '../../src/streaming/link-rules.js';
import { Link, LinkClosed, openLink } from '../../src/streaming/link.js';
import { resolveStreamOptions, type StreamOptions } from '../../src/streaming/options.js';
import type { CloseInfo } from '../../src/streaming/stream-errors.js';
import { envelope } from '../helpers.js';
import { FakeClock, FastRetry, flush } from './stream-helpers.js';

class FakeSocket implements WsSocket {
  readonly sent: Array<string | Uint8Array> = [];
  readonly responseHeaders = { 'x-request-id': 'req-fake' };
  handlers: WsHandlers | null = null;
  closeRequested: { code: number; reason: string } | null = null;
  answerClose = true;
  #closed = false;
  #buffer: Array<(h: WsHandlers) => void> = [];

  start(handlers: WsHandlers): void {
    this.handlers = handlers;
    for (const event of this.#buffer.splice(0)) event(handlers);
  }

  #emit(event: (h: WsHandlers) => void): void {
    if (this.handlers) event(this.handlers);
    else this.#buffer.push(event);
  }

  text(data: string): void {
    this.#emit((h) => h.text(data));
  }

  closeFromServer(code: number, reason = ''): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#emit((h) => h.close(code, reason));
  }

  trySend(data: string | Uint8Array): Promise<void> | null {
    if (this.#closed) return null;
    this.sent.push(data);
    return Promise.resolve();
  }

  close(code: number, reason: string): void {
    this.closeRequested = { code, reason };
    if (this.answerClose) queueMicrotask(() => this.closeFromServer(code, reason));
  }

  terminate(): void {
    this.closeFromServer(1006);
  }
}

type Outcome = 'ok' | HandshakeRejection | WsOpenFailure;

class FakeTransport implements WsTransport {
  readonly name = 'fake';
  readonly sendsHeaders = true;
  readonly requests: WsOpenRequest[] = [];
  readonly sockets: FakeSocket[] = [];
  attemptTimes: number[] = [];

  constructor(
    readonly clock: FakeClock,
    readonly outcomes: Outcome[] = [],
    readonly fallback: Outcome = 'ok',
  ) {}

  async open(request: WsOpenRequest): Promise<WsSocket> {
    this.requests.push(request);
    this.attemptTimes.push(this.clock.now());
    const outcome = this.outcomes.shift() ?? this.fallback;
    if (outcome !== 'ok') throw outcome;
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return socket;
  }
}

const json = (status: number, message: string): Uint8Array => envelope(status, message);
const throttle = (retryAfter: string): HandshakeRejection =>
  new HandshakeRejection(429, { 'retry-after': retryAfter, 'x-request-id': 'req-1' }, json(429, 'ThrottlerException: Too Many Requests'));
const busy = (): HandshakeRejection => new HandshakeRejection(429, { 'x-request-id': 'req-2' }, json(429, 'Too many concurrent streams'));

function setup(overrides: Partial<StreamOptions> = {}, outcomes: Outcome[] = [], fallback: Outcome = 'ok') {
  const clock = new FakeClock();
  const transport = new FakeTransport(clock, outcomes, fallback);
  const options = resolveStreamOptions({
    wsBaseURL: 'wss://api.example.test',
    headers: () => ({ Authorization: 'Bearer ek_test', 'user-agent': 'from-headers' }),
    userAgent: 'echonova-js/test',
    retryPolicy: new FastRetry(),
    clock,
    transport,
    ...overrides,
  });
  const limiter = new AttemptLimiter(options.maxConnectAttempts, options.connectWindow);
  return { clock, transport, options, limiter };
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

async function openAttached(overrides: Partial<StreamOptions> = {}) {
  const env = setup(overrides);
  const link = await openLink(env.options, '/v1/text-to-speech/stream', {}, { limiter: env.limiter });
  const closes: CloseInfo[] = [];
  const texts: string[] = [];
  link.attach({ onText: (t) => texts.push(t), onBinary: () => {}, onClosed: (info) => closes.push(info) });
  return { ...env, link, closes, texts, socket: env.transport.sockets[0] as FakeSocket };
}

describe('Link keepalive and liveness (fake clock)', () => {
  it('sends a JSON ping after 30 s without sending, and stays up while pongs come back', async () => {
    const { clock, link, socket } = await openAttached();
    await clock.advance(29_990);
    expect(socket.sent).toEqual([]);
    await clock.advance(20);
    expect(socket.sent).toEqual(['{"type":"ping"}']);
    socket.text('{"type":"pong"}');
    link.pong();
    await clock.advance(30_000);
    expect(socket.sent).toEqual(['{"type":"ping"}', '{"type":"ping"}']);
    expect(link.closed).toBe(false);
  });

  it('postpones the ping while data is being sent', async () => {
    const { clock, link, socket } = await openAttached();
    await clock.advance(20_000);
    await link.send('{"type":"cancel"}');
    await clock.advance(10_010);
    expect(socket.sent).toEqual(['{"type":"cancel"}']);
    await clock.advance(20_000);
    expect(socket.sent).toEqual(['{"type":"cancel"}', '{"type":"ping"}']);
  });

  it('drops the connection when a ping gets no pong within 15 s', async () => {
    const { clock, link, closes, socket } = await openAttached();
    await clock.advance(30_005);
    expect(socket.sent).toEqual(['{"type":"ping"}']);
    await clock.advance(14_990);
    expect(link.closed).toBe(false);
    await clock.advance(10);
    expect(link.closed).toBe(true);
    expect(closes[0]).toMatchObject({ code: 1006, local: false, lostReason: 'no pong within 15 s of a ping' });
    expect(closes[0]!.abnormal).toBe(true);
  });

  it('drops the connection after 60 s with nothing received', async () => {
    const { clock, closes, link } = await openAttached({ pongTimeout: 120_000 });
    await clock.advance(59_000);
    expect(link.closed).toBe(false);
    await clock.advance(1_001);
    expect(closes[0]).toMatchObject({ code: 1006, lostReason: 'nothing received for 60 s' });
  });

  it('turns everything off with keepalive null', async () => {
    const { clock, socket, link } = await openAttached({ keepalive: null });
    expect(clock.pending).toBe(0);
    await clock.advance(10 * 60_000);
    expect(socket.sent).toEqual([]);
    expect(link.closed).toBe(false);
  });
});

describe('Link sending and closing', () => {
  it('raises UsageError for an oversized JSON frame and sends nothing', async () => {
    const { link, socket } = await openAttached();
    expect(() => link.sendJson({ type: 'terminology', terminology: 'x'.repeat(70_000) })).toThrow(UsageError);
    expect(socket.sent).toEqual([]);
  });

  it('runs the commit callback synchronously, in order', async () => {
    const { link } = await openAttached();
    const order: string[] = [];
    const first = link.send('a', () => order.push('a committed'));
    order.push('after send');
    await first;
    expect(order).toEqual(['a committed', 'after send']);
  });

  it('rejects sends after close with LinkClosed', async () => {
    const { link, socket } = await openAttached();
    socket.closeFromServer(1000);
    await expect(link.send('x')).rejects.toBeInstanceOf(LinkClosed);
  });

  it('delivers events that arrived before attach, in order', async () => {
    const { options, limiter, transport } = setup();
    const link = await openLink(options, '/v1/speech-to-text/stream', {}, { limiter });
    const socket = transport.sockets[0] as FakeSocket;
    socket.text('one');
    socket.text('two');
    socket.closeFromServer(1000, 'stopped');
    const seen: string[] = [];
    link.attach({ onText: (t) => seen.push(t), onBinary: () => {}, onClosed: (info) => seen.push(`close ${info.code}`) });
    expect(seen).toEqual(['one', 'two', 'close 1000']);
    expect(link.handshakeRequestId).toBe('req-fake');
  });

  it('reports its own clean close even when the server never answers it', async () => {
    const { clock, link, socket, closes } = await openAttached({ closeTimeout: 2_000 });
    socket.answerClose = false;
    const closing = link.close(1000, 'bye');
    await clock.advance(2_000);
    await closing;
    expect(socket.closeRequested).toEqual({ code: 1000, reason: 'bye' });
    expect(closes[0]).toMatchObject({ code: 1000, local: true, lostReason: null });
  });

  it('sends the User-Agent option, replacing one from the headers provider', async () => {
    const { transport } = await openAttached();
    expect(transport.requests[0]!.headers).toEqual({ Authorization: 'Bearer ek_test', 'User-Agent': 'echonova-js/test' });
    expect(transport.requests[0]!.url).toBe('wss://api.example.test/v1/text-to-speech/stream');
  });
});

describe('handshake retries (fake clock)', () => {
  it('waits out a throttle Retry-After, then connects', async () => {
    const { clock, transport, options, limiter } = setup({}, [throttle('3')]);
    const opening = settle(openLink(options, '/v1/text-to-speech/stream', {}, { limiter }));
    await clock.advance(2_999);
    expect(transport.requests).toHaveLength(1);
    await clock.advance(1);
    const { value, error } = await opening;
    expect(error).toBeUndefined();
    expect(value).toBeInstanceOf(Link);
    expect(transport.attemptTimes.map((t) => t - transport.attemptTimes[0]!)).toEqual([0, 3_000]);
  });

  it('does not wait out a Retry-After over 30 s', async () => {
    const { transport, options, limiter } = setup({}, [throttle('31')]);
    const { error } = await settle(openLink(options, '/v1/text-to-speech/stream', {}, { limiter }));
    expect(error).toBeInstanceOf(RateLimitError);
    expect(transport.requests).toHaveLength(1);
  });

  it('retries a concurrency 429 for up to 90 s after an abnormal loss, then raises it', async () => {
    const { clock, transport, options, limiter } = setup({}, [], busy());
    const started = clock.now();
    const opening = settle(openLink(options, '/v1/text-to-speech/stream', {}, { limiter, afterAbnormal: true }));
    await clock.advance(120_000);
    const { error } = await opening;
    expect(error).toBeInstanceOf(ConcurrencyLimitError);
    const last = transport.attemptTimes.at(-1)! - started;
    expect(last).toBeLessThanOrEqual(90_000);
    expect(last).toBeGreaterThanOrEqual(60_000); // it waited for the attempt limiter, within the budget
    // never more than 6 attempts in any 60 s window
    for (const t of transport.attemptTimes) {
      expect(transport.attemptTimes.filter((u) => u >= t && u < t + 60_000).length).toBeLessThanOrEqual(6);
    }
  });

  it('does not retry a concurrency 429 on a fresh connect', async () => {
    const { transport, options, limiter } = setup({}, [busy()]);
    const { error } = await settle(openLink(options, '/v1/text-to-speech/stream', {}, { limiter }));
    expect(error).toBeInstanceOf(ConcurrencyLimitError);
    expect(transport.requests).toHaveLength(1);
  });

  it('retries network failures twice, then raises APIConnectionError', async () => {
    const failure = new WsOpenFailure('ECONNREFUSED', { cause: new Error('connect ECONNREFUSED') });
    const { clock, transport, options, limiter } = setup({}, [], failure);
    const opening = settle(openLink(options, '/v1/text-to-speech/stream', {}, { limiter }));
    await clock.advance(1_000);
    const { error } = await opening;
    expect(error).toBeInstanceOf(APIConnectionError);
    expect((error as APIConnectionError).mayHaveExecuted).toBe(false);
    expect(transport.requests).toHaveLength(3);
  });

  it('stops at 6 attempts per 60 s for retryable failures', async () => {
    const html = new HandshakeRejection(503, {}, new TextEncoder().encode('<html>busy</html>'));
    const { clock, transport, options } = setup();
    const limiter = new AttemptLimiter(6, 60_000);
    for (let i = 0; i < 3; i++) {
      transport.outcomes.push(html, html, html);
      const opening = settle(openLink(options, '/v1/text-to-speech/stream', {}, { limiter }));
      await clock.advance(100);
      const { error } = await opening;
      if (i < 2) expect(error).toBeInstanceOf(ServiceUnavailableError);
      else {
        expect(error).toBeInstanceOf(APIConnectionError);
        expect((error as APIConnectionError).retryDisabledReason).toBe('attempt_limit');
      }
    }
    expect(transport.requests).toHaveLength(6);
  });

  it('can be aborted while waiting', async () => {
    const { clock, options, limiter } = setup({}, [throttle('10')]);
    const controller = new AbortController();
    const opening = settle(openLink(options, '/v1/text-to-speech/stream', {}, { limiter, signal: controller.signal }));
    await clock.advance(1_000);
    controller.abort(new Error('cancelled by caller'));
    await flush();
    const { error } = await opening;
    expect(error).toMatchObject({ message: 'cancelled by caller' });
  });

  it('adds the query provider to the URL', async () => {
    const { transport } = await openAttached({ query: async () => ({ access_token: 'tok' }) });
    expect(transport.requests[0]!.url).toBe('wss://api.example.test/v1/text-to-speech/stream?access_token=tok');
  });
});
