// Cloudflare Workers (workerd): detection, the stream transport it selects, and REST uploads,
// which can't use `redirect: 'error'` there.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as errors from '../../src/errors.js';
import { isBrowserLike, isWorkerd, runtimeInfo } from '../../src/runtime/detect.js';
import { nodeTransport } from '../../src/runtime/ws-node.js';
import { detectEnvironment, selectTransport, workersTransport } from '../../src/runtime/ws-select.js';
import { caught, JOB_ID, makeClient, ok, WAV } from '../rest-support.js';
import { FakeClock } from '../streaming/stream-helpers.js';

const asWorkerd = (): void => {
  vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detecting Cloudflare Workers', () => {
  it('by navigator.userAgent, ahead of the process.versions.node that nodejs_compat adds', () => {
    expect(runtimeInfo().name).toBe('node'); // this test process
    asWorkerd();
    expect(isWorkerd()).toBe(true);
    expect(runtimeInfo()).toEqual({ name: 'workerd', version: null, platform: null });
    expect(isBrowserLike()).toBe(false);
  });

  it('by the WebSocketPair global', () => {
    vi.stubGlobal('WebSocketPair', function WebSocketPair() {});
    expect(runtimeInfo().name).toBe('workerd');
  });

  it('names workerd in the User-Agent', async () => {
    asWorkerd();
    const { client, requests } = makeClient(() => ok({ items: [], total: 0 }));
    await client.textToSpeech.voices.list();
    expect(requests[0]!.headers.get('user-agent')).toMatch(/^echonova-js\/\S+ \(workerd\)$/);
  });
});

describe('the stream transport on Workers', () => {
  it('is the fetch() upgrade, which sends headers', () => {
    expect(selectTransport({ usesApiKey: true }, { browser: false, runtime: 'workerd' })).toBe(workersTransport);
    expect(workersTransport.sendsHeaders).toBe(true);
    asWorkerd();
    expect(detectEnvironment()).toEqual({ browser: false, runtime: 'workerd' });
    expect(selectTransport()).toBe(workersTransport);
    expect(selectTransport()).not.toBe(nodeTransport);
  });

  it('loads its code on first use and upgrades through the global fetch', async () => {
    const fetch = vi.fn(async () => new Response('{"statusCode":401}', { status: 401, headers: { 'X-Request-Id': 'req-1' } }));
    vi.stubGlobal('fetch', fetch);
    const error = await caught(
      workersTransport.open({
        url: 'wss://api.example.com/v1/text-to-speech/stream',
        headers: { Authorization: 'Bearer ek_REDACTED_workers_test' },
        openTimeout: 1_000,
        maxPayload: 1024,
        clock: new FakeClock(),
      }),
    );
    expect(error).toMatchObject({ name: 'HandshakeRejection', status: 401, headers: { 'x-request-id': 'req-1' } });
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/v1/text-to-speech/stream', expect.objectContaining({ redirect: 'manual' }));
  });

  it('other runtimes without a WebSocket client still get a clear UnsupportedEnvironmentError', () => {
    expect(() => selectTransport({}, { browser: false, runtime: 'edge' })).toThrow(/Cloudflare Workers or a browser \(proxy mode\)/);
  });
});

describe('uploads on Workers', () => {
  it("use redirect: 'manual', since workerd rejects 'error'; elsewhere 'error'", async () => {
    const elsewhere = makeClient(() => ok({ jobId: JOB_ID, status: 'pending' }));
    await elsewhere.client.speechToText.jobs.create({ file: WAV, language: 'en' });
    expect(elsewhere.requests[0]!.init.redirect).toBe('error');

    asWorkerd();
    const workers = makeClient(() => ok({ jobId: JOB_ID, status: 'pending' }));
    await workers.client.speechToText.jobs.create({ file: WAV, language: 'en' });
    expect(workers.requests[0]!.init.redirect).toBe('manual');
  });

  it('still refuse a redirect: the 3xx fails as a ProtocolError and is not sent again', async () => {
    asWorkerd();
    const { client, requests } = makeClient(() => new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example.com/' } }));
    const error = (await caught(client.speechToText.transcribe({ file: WAV, language: 'en' }))) as errors.ProtocolError;
    expect(error).toBeInstanceOf(errors.ProtocolError);
    expect(error.statusCode).toBe(307);
    expect(requests).toHaveLength(1);
  });
});
