/** Transport selection, and the browser transport in proxy mode (with a fake `WebSocket` global). */

import WS from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APIConnectionError, UnsupportedEnvironmentError } from '../../src/errors.js';
import { browserTransport } from '../../src/runtime/ws-browser.js';
import { nodeTransport } from '../../src/runtime/ws-node.js';
import { selectTransport } from '../../src/runtime/ws-select.js';
import type { WsTransport } from '../../src/runtime/ws-transport.js';
import { connectStt, connectTts } from '../../src/streaming/index.js';
import { MockServer } from './mock-server.js';
import { optionsFor, pcm } from './stream-helpers.js';

describe('selectTransport', () => {
  it('uses ws on Node, Bun and Deno', () => {
    for (const runtime of ['node', 'bun', 'deno'] as const) {
      expect(selectTransport({}, { browser: false, runtime })).toBe(nodeTransport);
    }
  });

  it('uses the native WebSocket in a browser, in proxy mode only', () => {
    expect(selectTransport({}, { browser: true, runtime: 'browser' })).toBe(browserTransport);
    expect(() => selectTransport({ usesApiKey: true }, { browser: true, runtime: 'browser' })).toThrow(UnsupportedEnvironmentError);
  });

  it('is unsupported anywhere else', () => {
    for (const runtime of ['edge', 'unknown'] as const) {
      expect(() => selectTransport({}, { browser: false, runtime })).toThrow(UnsupportedEnvironmentError);
    }
  });

  it('prefers a custom transport', () => {
    const custom: WsTransport = { name: 'custom', sendsHeaders: true, open: () => Promise.reject(new Error('unused')) };
    expect(selectTransport({ transport: custom }, { browser: false, runtime: 'edge' })).toBe(custom);
  });
});

describe('browser proxy mode (fake WebSocket global)', () => {
  let server: MockServer;
  const constructed: string[] = [];
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const globals = ['window', 'document', 'navigator', 'WebSocket'] as const;

  /** A browser-like WebSocket: a URL only, no way to set headers. */
  class FakeBrowserWebSocket extends WS {
    constructor(url: string) {
      super(url);
      constructed.push(url);
    }
  }

  beforeEach(async () => {
    server = await new MockServer().start();
    constructed.length = 0;
    for (const name of globals) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    const define = (name: string, value: unknown): void => {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    };
    define('window', {});
    define('document', {});
    define('navigator', { userAgent: 'FakeBrowser/1.0' });
    define('WebSocket', FakeBrowserWebSocket);
  });

  afterEach(async () => {
    for (const name of globals) {
      const descriptor = saved[name];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    await server.stop();
  });

  const proxyOptions = (overrides = {}) =>
    optionsFor(server, {
      // An auth hook's headers can't be sent by a browser; the token goes in the query instead.
      headers: () => ({ Authorization: 'Bearer app-session' }),
      query: async () => ({ access_token: 'tok-123' }),
      ...overrides,
    });

  it('authenticates Text to Speech with the query token, sending no headers', async () => {
    const tts = await connectTts(proxyOptions(), { voiceId: 'v1' });
    try {
      const synth = tts.synthesize('Hello');
      const chunks: Uint8Array[] = [];
      for await (const chunk of synth) chunks.push(chunk);
      expect(chunks).toHaveLength(3);
      expect((await synth.result).outcome).toBe('completed');
    } finally {
      await tts.close();
    }
    expect(constructed).toEqual([`${server.url}/v1/text-to-speech/stream?access_token=tok-123`]);
    expect(server.attempts[0]!.query).toEqual({ access_token: 'tok-123' });
    expect(server.attempts[0]!.headers['Authorization']).toBeUndefined();
  });

  it('merges the token with the Speech to Text query', async () => {
    const stt = await connectStt(proxyOptions(), { sampleRate: 16_000, language: 'en' });
    await stt.sendAudio(pcm(0.5));
    const summary = await stt.stop();
    expect(summary.reason).toBe('stopped');
    expect(server.sttConns[0]!.query).toEqual({
      sample_rate: '16000',
      language: 'en',
      encoding: 'pcm_s16le',
      access_token: 'tok-123',
    });
  });

  it('reports a refused handshake as APIConnectionError, without retrying or leaking the token', async () => {
    server.rejections.push({ status: 401, message: 'Unauthorized' });
    let error: unknown = null;
    try {
      await connectTts(proxyOptions(), { voiceId: 'v1' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(APIConnectionError);
    expect((error as APIConnectionError).retryDisabledReason).toBe('handshake_status_unavailable');
    expect((error as Error).message).toMatch(/Browsers don't say why a WebSocket handshake failed/);
    expect((error as Error).message).not.toContain('tok-123');
    expect(server.attempts).toHaveLength(1);
  });

  it('refuses to stream with an API key', async () => {
    let error: unknown = null;
    try {
      await connectTts(proxyOptions({ usesApiKey: true }), { voiceId: 'v1' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnsupportedEnvironmentError);
    expect(server.attempts).toEqual([]);
  });
});
