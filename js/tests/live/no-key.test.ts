// Live, free, no key needed: a made-up key is rejected over REST and on both stream handshakes.
import { afterAll, describe, expect } from 'vitest';
import type EchoNova from '../../src/index.js';
import { AuthenticationError } from '../../src/index.js';
import { clientFor, liveTest, madeUpKey, note, rejection, since } from './support.js';

let client: EchoNova | null = null;
const rejected = (): EchoNova => (client ??= clientFor(madeUpKey()));

afterAll(async () => {
  await client?.close();
});

describe('a made-up key', () => {
  liveTest('(1) a REST call is rejected with AuthenticationError', [], async () => {
    const started = performance.now();
    const error = await rejection(rejected().textToSpeech.voices.list(), AuthenticationError);
    note(`voices.list with a made-up key: ${error.statusCode} in ${since(started)}, request ${error.requestId}`);
    expect(error.statusCode).toBe(401);
    expect(error.transport).toBe('http');
    expect(error.requestId).toBeTruthy();
    expect(error.mayHaveExecuted).toBe(false);
  });

  liveTest('(2) the Text to Speech stream handshake is rejected with AuthenticationError', [], async () => {
    const started = performance.now();
    // The voice is only used once something is synthesized; the handshake fails first.
    const error = await rejection(rejected().textToSpeech.connect({ voiceId: '0'.repeat(24) }), AuthenticationError);
    note(`Text to Speech handshake with a made-up key: ${error.statusCode} in ${since(started)}, request ${error.requestId}`);
    expect(error.statusCode).toBe(401);
    expect(error.transport).toBe('websocket');
    expect(error.requestId).toBeTruthy();
  });

  liveTest('(2) the Speech to Text stream handshake is rejected with AuthenticationError', [], async () => {
    const started = performance.now();
    const error = await rejection(rejected().speechToText.connect({ sampleRate: 16_000, language: 'en' }), AuthenticationError);
    note(`Speech to Text handshake with a made-up key: ${error.statusCode} in ${since(started)}, request ${error.requestId}`);
    expect(error.statusCode).toBe(401);
    expect(error.transport).toBe('websocket');
    expect(error.requestId).toBeTruthy();
  });
});
