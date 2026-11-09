// The client opens streams with its own URL, credentials, default headers and stream settings.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import EchoNova from '../../src/index.js';
import { Audio } from '../../src/streaming/index.js';
import { MockServer } from './mock-server.js';
import { pcm, TEST_KEY } from './stream-helpers.js';

let server: MockServer;

beforeEach(async () => {
  server = await new MockServer().start();
});

afterEach(async () => {
  await server.stop();
});

const clientFor = (options: ConstructorParameters<typeof EchoNova>[0] = {}) =>
  new EchoNova({ apiKey: TEST_KEY, baseURL: server.httpURL, ...options });

describe('client streaming wiring', () => {
  it('textToSpeech.connect uses the client key, default headers and User-Agent', async () => {
    const client = clientFor({ defaultHeaders: { 'X-Trace': 't-1' } });
    const tts = await client.textToSpeech.connect({ voiceId: 'v1', speed: 1.2 });
    try {
      const result = await tts.synthesize('Hello').result;
      expect(result.outcome).toBe('completed');
    } finally {
      await tts.close();
    }
    const headers = server.attempts[0]!.headers;
    expect(headers['Authorization']).toBe(`Bearer ${TEST_KEY}`);
    expect(headers['X-Trace']).toBe('t-1');
    expect(headers['User-Agent']).toMatch(/^echonova-js\//);
    expect(server.attempts[0]!.path).toBe('/v1/text-to-speech/stream');
  });

  it('textToSpeech.speak returns Audio', async () => {
    const audio = await clientFor().textToSpeech.speak('Hello', { voiceId: 'v1' });
    expect(audio).toBeInstanceOf(Audio);
    expect(audio.sampleRate).toBe(22_050);
  });

  it('proxy mode sends the auth hook headers and the stream query', async () => {
    const client = new EchoNova({
      baseURL: server.httpURL,
      auth: async () => ({ Authorization: 'Bearer app-session' }),
      stream: { query: async () => ({ access_token: 'short-lived' }) },
    });
    const tts = await client.textToSpeech.connect({ voiceId: 'v1' });
    await tts.close();
    expect(server.attempts[0]!.headers['Authorization']).toBe('Bearer app-session');
    expect(server.attempts[0]!.query).toMatchObject({ access_token: 'short-lived' });
  });

  it('speechToText.connect and transcribeStream', async () => {
    const client = clientFor();
    const stt = await client.speechToText.connect({ sampleRate: 16_000, language: 'ar' });
    expect(stt.sessionId).toBeTruthy();
    await stt.stop();
    expect(server.sttConns[0]!.query).toMatchObject({ sample_rate: '16000', language: 'ar', encoding: 'pcm_s16le' });

    const kinds: string[] = [];
    for await (const event of client.speechToText.transcribeStream([pcm(1)], { sampleRate: 16_000, language: 'en' })) {
      kinds.push(event.type);
    }
    expect(kinds).toContain('transcript');
  });
});
