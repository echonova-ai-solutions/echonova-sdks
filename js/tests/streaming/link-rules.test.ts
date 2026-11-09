/** Transport rules: frame limits, keepalive/liveness timing, attempt limits, handshake retries, closes, URLs. */

import { describe, expect, it } from 'vitest';
import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  ConcurrencyLimitError,
  FeatureNotEnabledError,
  InsufficientBalanceError,
  InvalidRequestError,
  ProtocolError,
  RateLimitError,
  ServerRestartingError,
  ServiceUnavailableError,
  SessionExpiredError,
  SpendingLimitError,
  StreamClosedError,
  StreamConnectionLostError,
  UpstreamError,
  UsageError,
  VoiceNotFoundError,
  type EchoNovaError,
} from '../../src/errors.js';
import {
  AttemptLimiter,
  HandshakeRetry,
  Liveness,
  MAX_JSON_FRAME_BYTES,
  decodeEvent,
  encodeJson,
  utf8Length,
} from '../../src/streaming/link-rules.js';
import { resolveStreamOptions, streamURL } from '../../src/streaming/options.js';
import { CloseInfo, closeError, errorFromFrame } from '../../src/streaming/stream-errors.js';
import { protocolCloseCode } from '../../src/runtime/ws-node.js';
import { envelope } from '../helpers.js';
import { FastRetry } from './stream-helpers.js';

describe('frames', () => {
  it('raises UsageError for JSON frames over 64 KiB', () => {
    const overhead = encodeJson({ type: 'terminology', terminology: '' }).length;
    const fits = { type: 'terminology', terminology: 'x'.repeat(MAX_JSON_FRAME_BYTES - overhead) };
    expect(utf8Length(encodeJson(fits))).toBe(MAX_JSON_FRAME_BYTES);
    expect(() => encodeJson({ type: 'terminology', terminology: 'x'.repeat(MAX_JSON_FRAME_BYTES - overhead + 1) })).toThrow(
      /65,537 bytes.*Nothing was sent/,
    );
  });

  it('counts UTF-8 bytes', () => {
    expect(() => encodeJson({ type: 'x', text: 'ع'.repeat(40_000) })).toThrow(UsageError); // 80 KB in UTF-8
    for (const text of ['abc', 'عربي', '😀x', 'é', '\ud800']) expect(utf8Length(text)).toBe(Buffer.byteLength(text));
  });

  it('decodes inbound frames without throwing', () => {
    expect(decodeEvent('{"type":"pong"}')).toEqual({ type: 'pong' });
    expect(decodeEvent('not json')).toEqual({ raw_text: 'not json' });
    expect(decodeEvent('[1]')).toEqual({ raw_value: [1] });
  });
});

describe('Liveness (fake clock, ms)', () => {
  const make = (keepalive: number | null = 30_000): Liveness =>
    new Liveness(0, { keepalive, pongTimeout: 15_000, silenceTimeout: 60_000 });

  it('pings after 30 s without sending', () => {
    const live = make();
    expect(live.poll(29_999)).toBeNull();
    expect(live.nextDeadline()).toBe(30_000);
    expect(live.poll(30_000)).toBe('ping');
  });

  it('postpones the ping when data is sent', () => {
    const live = make();
    live.sent(20_000);
    live.received(20_000);
    expect(live.poll(30_000)).toBeNull();
    expect(live.poll(50_000)).toBe('ping');
  });

  it('loses the connection when a ping gets no pong within 15 s', () => {
    const live = make();
    live.pingSent(30_000);
    live.received(40_000); // other traffic doesn't count as the pong
    expect(live.poll(44_999)).toBeNull();
    expect(live.nextDeadline()).toBe(45_000);
    expect(live.poll(45_000)).toBe('lost_pong');
    expect(live.describe('lost_pong')).toBe('no pong within 15 s of a ping');
  });

  it('clears the ping on pong', () => {
    const live = make();
    live.pingSent(30_000);
    live.pong(31_000);
    expect(live.poll(45_000)).toBeNull();
    expect(live.poll(60_000)).toBe('ping');
  });

  it('loses the connection after 60 s of silence', () => {
    const live = make();
    live.sent(55_000); // still sending, but hearing nothing
    expect(live.poll(59_999)).toBeNull();
    expect(live.poll(60_000)).toBe('lost_silence');
    expect(live.describe('lost_silence')).toBe('nothing received for 60 s');
  });

  it('is off with keepalive null', () => {
    const live = make(null);
    expect(live.poll(1_000_000)).toBeNull();
    expect(live.nextDeadline()).toBeNull();
  });
});

describe('AttemptLimiter', () => {
  it('allows at most 6 attempts per 60 s', () => {
    const limiter = new AttemptLimiter(6, 60_000);
    for (let i = 0; i < 6; i++) {
      expect(limiter.waitTime(i * 1_000)).toBe(0);
      limiter.record(i * 1_000);
    }
    expect(limiter.waitTime(10_000)).toBe(50_000);
    expect(limiter.waitTime(60_000)).toBe(0); // the first attempt left the window
    const error = limiter.error();
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error.retryDisabledReason).toBe('attempt_limit');
  });
});

describe('HandshakeRetry', () => {
  const retry = (options: Partial<{ waitForSlot: number | null; afterAbnormal: boolean }> = {}): HandshakeRetry =>
    new HandshakeRetry(new FastRetry(), {
      now: 0,
      waitForSlot: options.waitForSlot ?? null,
      afterAbnormal: options.afterAbnormal ?? false,
      slotWaitAfterLoss: 90_000,
    });

  const thrown = (fn: () => unknown): EchoNovaError => {
    try {
      fn();
    } catch (error) {
      return error as EchoNovaError;
    }
    throw new Error('did not throw');
  };

  it('never retries a 401, and keeps the request id', () => {
    const error = thrown(() => retry().onStatus(401, { 'X-Request-Id': 'r1' }, envelope(401, 'Unauthorized'), 0));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({ transport: 'websocket', requestId: 'r1', statusCode: 401 });
  });

  it.each([
    [402, 'Insufficient subscription balance', InsufficientBalanceError],
    [429, 'Monthly spending limit exhausted', SpendingLimitError],
    [503, 'Streaming is not enabled', FeatureNotEnabledError],
    [403, 'This API key does not have access to Text-to-Speech services', Error],
    [400, 'sample_rate must be an integer from 8000 to 48000', InvalidRequestError],
  ] as const)('never retries %i %s', (status, message, ErrorClass) => {
    expect(() => retry().onStatus(status, {}, envelope(status, message), 0)).toThrow(ErrorClass);
  });

  it('waits Retry-After for a throttle 429, then gives up after 2 retries', () => {
    const policy = retry();
    const body = envelope(429, 'ThrottlerException: Too Many Requests');
    expect(policy.onStatus(429, { 'Retry-After': '3' }, body, 0)).toBe(3_000);
    expect(policy.onStatus(429, { 'Retry-After': '3' }, body, 3_000)).toBe(3_000);
    expect(() => policy.onStatus(429, { 'Retry-After': '3' }, body, 6_000)).toThrow(RateLimitError);
  });

  it('does not wait out a Retry-After over 30 s', () => {
    const body = envelope(429, 'ThrottlerException: Too Many Requests');
    const error = thrown(() => retry().onStatus(429, { 'Retry-After': '45' }, body, 0));
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(45);
  });

  it('retries "Too many concurrent streams" only with waitForSlot', () => {
    const body = envelope(429, 'Too many concurrent streams');
    expect(() => retry().onStatus(429, {}, body, 0)).toThrow(ConcurrencyLimitError);
    const waiting = retry({ waitForSlot: 5_000 });
    let now = 0;
    for (let i = 0; i < 10; i++) now += waiting.onStatus(429, {}, body, now);
    expect(now).toBeGreaterThan(0);
    expect(() => retry({ waitForSlot: 5_000 }).onStatus(429, {}, body, 10_000)).toThrow(ConcurrencyLimitError);
  });

  it('retries "Too many concurrent streams" for up to 90 s after an abnormal loss', () => {
    const body = envelope(429, 'Too many concurrent streams');
    const policy = retry({ afterAbnormal: true });
    expect(policy.onStatus(429, {}, body, 1_000)).toBeGreaterThan(0);
    expect(policy.mayWait(1_000, 30_000)).toBe(true);
    expect(policy.mayWait(1_000, 95_000)).toBe(false);
    expect(() => policy.onStatus(429, {}, body, 89_999)).toThrow(ConcurrencyLimitError);
  });

  it('retries a non-JSON 503 twice', () => {
    const policy = retry();
    const html = new TextEncoder().encode('<html>busy</html>');
    expect(policy.onStatus(503, {}, html, 0)).toBeGreaterThanOrEqual(0);
    expect(policy.onStatus(503, {}, html, 0)).toBeGreaterThanOrEqual(0);
    expect(() => policy.onStatus(503, {}, html, 0)).toThrow(ServiceUnavailableError);
  });

  it('retries network errors twice, then raises without the query string', () => {
    const policy = retry();
    const url = 'ws://x/stream?access_token=secret';
    expect(policy.onNetwork(new Error('refused'), url, false)).toBeGreaterThanOrEqual(0);
    expect(policy.onNetwork(new Error('refused'), url, false)).toBeGreaterThanOrEqual(0);
    const error = thrown(() => policy.onNetwork(new Error('refused'), url, false));
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(error.message).toBe('could not open the stream at ws://x/stream: refused');
    expect(error.message).not.toContain('secret');
  });

  it('raises APITimeoutError for handshake timeouts', () => {
    const policy = retry();
    policy.retries = 2;
    const error = thrown(() => policy.onNetwork(new Error('timed out'), 'ws://x', true));
    expect(error).toBeInstanceOf(APITimeoutError);
    expect((error as APITimeoutError).kind).toBe('connect');
  });
});

describe('error frames and closes', () => {
  it('maps error frames to classes', () => {
    const error = errorFromFrame({ type: 'error', code: 'upstream_error', message: 'boom', requestId: 'r' });
    expect(error).toBeInstanceOf(UpstreamError);
    expect([error.errorCode, error.errorMessage, error.requestId, error.transport]).toEqual(['upstream_error', 'boom', 'r', 'websocket']);
    expect(errorFromFrame({ type: 'error', code: 'voice_not_found', message: 'x' })).toBeInstanceOf(VoiceNotFoundError);
    expect(errorFromFrame({ type: 'error', code: 'brand_new' }).constructor.name).toBe('APIStatusError');
  });

  it.each([
    [new CloseInfo(1000), true, null],
    [new CloseInfo(1000), false, StreamClosedError],
    [new CloseInfo(1006), false, StreamConnectionLostError],
    [new CloseInfo(1000, '', false, 'no pong within 15 s'), false, StreamConnectionLostError],
    [new CloseInfo(1001), false, ServerRestartingError],
    [new CloseInfo(1002), false, ProtocolError],
    [new CloseInfo(1007), false, ProtocolError],
    [new CloseInfo(1008, 'invalid_message'), false, ProtocolError],
    [new CloseInfo(1009), false, ProtocolError],
    [new CloseInfo(1011), false, UpstreamError],
    [new CloseInfo(4002), true, InsufficientBalanceError],
    [new CloseInfo(4029), true, SpendingLimitError],
    [new CloseInfo(4008, 'max_duration'), true, null],
    [new CloseInfo(4008, 'idle_timeout'), false, SessionExpiredError],
    [new CloseInfo(4999), false, StreamClosedError],
    [new CloseInfo(1000, '', true), false, null],
  ] as const)('maps close %o (ended normally: %s)', (info, ended, expected) => {
    const error = closeError(info, { endedNormally: ended });
    if (expected === null) expect(error).toBeNull();
    else {
      expect(error?.constructor).toBe(expected);
      if (info.lostReason === null && error !== null && 'closeCode' in error) expect(error.closeCode).toBe(info.code);
    }
  });

  it('attaches the preceding error frame to the close error', () => {
    const error = closeError(new CloseInfo(1008, 'frame_too_large'), {
      lastError: { type: 'error', code: 'frame_too_large', message: 'frames must be at most 64 KiB' },
    });
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error).toMatchObject({ errorCode: 'frame_too_large', errorMessage: 'frames must be at most 64 KiB', closeCode: 1008 });
  });

  it('flags abnormal closes', () => {
    expect(new CloseInfo(1006).abnormal).toBe(true);
    expect(new CloseInfo(1001).abnormal).toBe(true);
    expect(new CloseInfo(1000, '', false, 'silence').abnormal).toBe(true);
    expect(new CloseInfo(1011).abnormal).toBe(false);
    expect(new CloseInfo(4008).abnormal).toBe(false);
  });

  it('maps ws protocol errors to 1002/1007/1009', () => {
    const wsError = (code: string): Error => Object.assign(new Error(code), { code });
    expect(protocolCloseCode(wsError('WS_ERR_INVALID_UTF8'))).toBe(1007);
    expect(protocolCloseCode(wsError('WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'))).toBe(1009);
    expect(protocolCloseCode(wsError('WS_ERR_INVALID_OPCODE'))).toBe(1002);
    expect(protocolCloseCode(wsError('ECONNRESET'))).toBeNull();
    const withSymbol = Object.assign(new Error('x'), { [Symbol('status-code')]: 1007 });
    expect(protocolCloseCode(withSymbol)).toBe(1007);
  });
});

describe('stream URLs and options', () => {
  it.each([
    ['wss://api.echonova.ai', 'wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&language=ar'],
    ['https://api.echonova.ai/', 'wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&language=ar'],
    ['https://api.echonova.ai/v1', 'wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&language=ar'],
    ['http://127.0.0.1:9000', 'ws://127.0.0.1:9000/v1/speech-to-text/stream?sample_rate=16000&language=ar'],
    ['https://proxy.example/echonova', 'wss://proxy.example/echonova/v1/speech-to-text/stream?sample_rate=16000&language=ar'],
  ])('builds %s', (base, expected) => {
    expect(streamURL(base, '/v1/speech-to-text/stream', { sample_rate: 16000, language: 'ar' })).toBe(expected);
  });

  it('rejects a bad base URL and bad durations', () => {
    expect(() => streamURL('ftp://x', '/v1/text-to-speech/stream')).toThrow(UsageError);
    expect(() => resolveStreamOptions({ wsBaseURL: 'not a url' })).toThrow(UsageError);
    expect(() => resolveStreamOptions({ openTimeout: -1 })).toThrow(UsageError);
    expect(() => resolveStreamOptions({ maxConnectAttempts: 0 })).toThrow(UsageError);
  });

  it('fills in the defaults', () => {
    const o = resolveStreamOptions();
    expect(o).toMatchObject({
      wsBaseURL: 'wss://api.echonova.ai',
      openTimeout: 10_000,
      keepalive: 30_000,
      pongTimeout: 15_000,
      silenceTimeout: 60_000,
      reconnectSlotWait: 90_000,
      maxConnectAttempts: 6,
      connectWindow: 60_000,
      synthesisStartTimeout: 30_000,
      cancelAckTimeout: 5_000,
      rotateAfter: 28 * 60_000,
      rolloverMargin: 30_000,
      waitForSlot: null,
    });
    expect(resolveStreamOptions(o)).toBe(o);
    expect(resolveStreamOptions({ keepalive: null }).keepalive).toBeNull();
  });
});
