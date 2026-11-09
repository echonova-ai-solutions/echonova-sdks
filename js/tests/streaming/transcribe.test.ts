/** transcribeStream: segmentation, rollover, reconnect with replay of uncut audio. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InsufficientBalanceError, ProtocolError, StreamConnectionLostError, UsageError } from '../../src/errors.js';
import {
  transcribeStream,
  type AudioDropped,
  type Reconnected,
  type StreamOptions,
  type TranscribeEvent,
  type TranscribeStreamOptions,
  type Transcript,
} from '../../src/streaming/index.js';
import type { AudioSource } from '../../src/streaming/stt-session.js';
import { MockServer } from './mock-server.js';
import { concat, delay, optionsFor, pcm, waitFor } from './stream-helpers.js';

const FAST = { maxAttempts: 3, initialDelay: 10 };
const SEGMENT = 32_000; // bytes in one 1-second segment at 16 kHz

let server: MockServer;

beforeEach(async () => {
  server = await new MockServer().start();
});

afterEach(async () => {
  await server.stop();
});

async function* source(data: Uint8Array, chunk = 3_200, pause = 0): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += chunk) {
    if (pause) await delay(pause);
    yield data.subarray(i, i + chunk);
  }
}

async function run(
  audio: AudioSource,
  init: Partial<TranscribeStreamOptions> = {},
  options: StreamOptions = optionsFor(server),
): Promise<{ events: TranscribeEvent[]; error: unknown }> {
  const events: TranscribeEvent[] = [];
  try {
    for await (const event of transcribeStream(options, audio, { sampleRate: 16_000, language: 'ar', ...init })) {
      events.push(event);
    }
  } catch (error) {
    return { events, error };
  }
  return { events, error: null };
}

const transcripts = (events: TranscribeEvent[]): Transcript[] => events.filter((e): e is Transcript => e.type === 'transcript');
const reconnects = (events: TranscribeEvent[]): Reconnected[] => events.filter((e): e is Reconnected => e.type === 'reconnected');
const kinds = (events: TranscribeEvent[]): string[] => events.map((e) => e.type);
const sentAudio = (conn: number): Uint8Array => concat(server.sttConns[conn]!.audio);

describe('transcribeStream', () => {
  it('cuts its own segments', async () => {
    const audio = pcm(3.5);
    const { events, error } = await run(source(audio), { segmentSeconds: 1 });
    expect(error).toBeNull();
    expect(transcripts(events).map((t) => t.text)).toEqual(['segment 1', 'segment 2', 'segment 3', 'segment 4']);
    expect(transcripts(events).map((t) => t.index)).toEqual([0, 1, 2, 3]);
    expect(sentAudio(0)).toEqual(audio);
    expect(server.sttConns[0]!.received.map((f) => f['type'])).toEqual(['end_segment', 'end_segment', 'end_segment', 'stop']);
    expect(server.sttConns).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'session.saved', status: 'saved', jobId: server.sttConns[0]!.jobId });
  });

  it('accepts a whole buffer', async () => {
    const audio = pcm(1.2);
    const { events, error } = await run(audio, { language: 'en', segmentSeconds: 1 });
    expect(error).toBeNull();
    expect(transcripts(events)).toHaveLength(2);
    expect(sentAudio(0)).toEqual(audio);
  });

  it('rolls over before the session limit, holding one slot at a time', async () => {
    server.stt.maxSessionSeconds = 2;
    const audio = pcm(2);
    const { events, error } = await run(
      source(audio, 3_200, 40), // 0.8 s of sending: at least one rollover
      { terminology: { keywords: ['KYC'] }, segmentSeconds: 5, reconnect: FAST },
      optionsFor(server, { rolloverMargin: 1_600 }), // hand over 0.4 s into each session
    );
    expect(error).toBeNull();
    const rollovers = reconnects(events);
    expect(rollovers.length).toBeGreaterThan(0);
    expect(rollovers.every((r) => r.reason === 'rollover' && r.attempt === 0)).toBe(true);
    expect(server.sttConns).toHaveLength(rollovers.length + 1);
    expect(kinds(events)).not.toContain('audio.dropped');
    expect(concat(server.sttConns.map((c) => concat(c.audio)))).toEqual(audio); // nothing lost, nothing sent twice
    await waitFor(() => server.sttConns.every((c) => c.closeCode !== null));
    for (const conn of server.sttConns) {
      expect(conn.received[0]).toEqual({ type: 'terminology', terminology: { keywords: ['KYC'] } });
      expect(conn.closeCode).toBe(1000); // each session stopped cleanly
    }
    expect(transcripts(events).reduce((n, t) => n + t.durationSeconds, 0)).toBeCloseTo(2);
    expect(transcripts(events).map((t) => t.index)).toEqual(transcripts(events).map((_, i) => i));
    expect(events.filter((e) => e.type === 'session.saved')).toHaveLength(server.sttConns.length);
  });

  it('reconnects after a drop and replays only the uncut audio', async () => {
    server.stt.actions.push({ kind: 'abort', after: SEGMENT + 16_000 }); // half-way through segment 2
    const audio = pcm(3);
    const { events, error } = await run(source(audio, 3_200, 5), {
      terminology: { keywords: ['KYC'] },
      segmentSeconds: 1,
      reconnect: FAST,
    });
    expect(error).toBeNull();
    expect(kinds(events).slice(0, 2)).toEqual(['transcript', 'reconnected']);
    expect(events[1]).toMatchObject({ reason: 'connection_lost', attempt: 1 });
    expect(sentAudio(1)).toEqual(audio.subarray(SEGMENT)); // replayed from the last cut, not from the start
    expect(concat([sentAudio(0).subarray(0, SEGMENT), sentAudio(1)])).toEqual(audio);
    expect(server.sttConns[1]!.received[0]!['type']).toBe('terminology'); // terminology re-sent
    expect(transcripts(events).reduce((n, t) => n + t.durationSeconds, 0)).toBeCloseTo(3);
  });

  it('reports cut segments that got no result as dropped', async () => {
    server.stt.actions.push({ kind: 'abort_on_cut', after: 2 });
    const audio = pcm(3);
    const { events, error } = await run(source(audio, 3_200, 5), { segmentSeconds: 1, reconnect: FAST });
    expect(error).toBeNull();
    const dropped = events.filter((e): e is AudioDropped => e.type === 'audio.dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.segmentMarks.map((m) => [m.index, m.audioOffsetSeconds, m.durationSeconds])).toEqual([[1, 2, 1]]);
    expect(dropped[0]!.seconds).toBe(1);
    expect(kinds(events).indexOf('audio.dropped')).toBeLessThan(kinds(events).indexOf('reconnected'));
    expect(sentAudio(1)).toEqual(audio.subarray(2 * SEGMENT));
    expect(transcripts(events).reduce((n, t) => n + t.durationSeconds, 0)).toBeCloseTo(2);
  });

  it.each([
    ['restart', 'server_restarting'],
    ['upstream', 'upstream_error'],
  ] as const)('reconnects after a %s close', async (kind, reason) => {
    server.stt.actions.push({ kind, after: 8_000 });
    const { events, error } = await run(source(pcm(1.5), 3_200, 5), { segmentSeconds: 1, reconnect: FAST });
    expect(error).toBeNull();
    expect(reconnects(events).map((r) => r.reason)).toEqual([reason]);
    expect(server.sttConns).toHaveLength(2);
  });

  it('never reconnects after a billing close, and drains first', async () => {
    server.stt.failAfterSegments = [1, 'insufficient_balance'];
    const { events, error } = await run(source(pcm(3), 3_200, 5), { segmentSeconds: 1, reconnect: FAST });
    expect(error).toBeInstanceOf(InsufficientBalanceError);
    expect(transcripts(events).map((t) => t.text)).toEqual(['segment 1']);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'insufficient_balance' });
    expect(server.sttConns).toHaveLength(1);
  });

  it('never reconnects after a protocol close', async () => {
    setTimeout(() => {
      for (const ws of server.live) ws.close(1008, 'invalid_message');
    }, 100);
    const { events, error } = await run(source(pcm(2), 3_200, 10), { segmentSeconds: 1, reconnect: FAST });
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).closeCode).toBe(1008);
    expect(reconnects(events)).toEqual([]);
    expect(server.sttConns).toHaveLength(1);
  });

  it('gives up after maxAttempts reconnects in a row', async () => {
    server.stt.actions.push(...Array.from({ length: 3 }, () => ({ kind: 'abort' as const, after: 4_000 })));
    const { events, error } = await run(source(pcm(3), 3_200, 5), {
      segmentSeconds: 10,
      reconnect: { maxAttempts: 2, initialDelay: 10 },
    });
    expect(error).toBeInstanceOf(StreamConnectionLostError);
    expect(reconnects(events).map((r) => r.attempt)).toEqual([1, 2]);
    expect(server.sttConns).toHaveLength(3);
  });

  it('opens a new session after the server ends one at max_duration, and replays the dropped open segment', async () => {
    server.stt.enforceMaxDuration = 250;
    const audio = pcm(1);
    const { events, error } = await run(source(audio, 3_200, 50), {
      segmentSeconds: 5,
      reconnect: { maxAttempts: 0, initialDelay: 10 }, // not counted as a failure
    });
    expect(error).toBeNull();
    const reasons = reconnects(events).map((r) => r.reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons)).toEqual(new Set(['max_duration']));
    const last = sentAudio(server.sttConns.length - 1);
    expect(last.subarray(last.length - 3_200)).toEqual(audio.subarray(audio.length - 3_200));
  });

  it('checks its arguments before connecting', async () => {
    expect(() => transcribeStream(optionsFor(server), new Uint8Array(0), { sampleRate: 16_000, language: 'ar', segmentSeconds: 0 })).toThrow(
      UsageError,
    );
    expect(() => transcribeStream(optionsFor(server), new Uint8Array(0), { sampleRate: 16_000.5, language: 'ar' })).toThrow(UsageError);
    expect(server.attempts).toEqual([]);
  });

  it('paces a file at 1x with realtime', async () => {
    const audio = pcm(0.4);
    const started = Date.now();
    const { events, error } = await run(source(audio), { realtime: true });
    expect(error).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(300); // no faster than it would play
    expect(sentAudio(0)).toEqual(audio);
    expect(transcripts(events)).toHaveLength(1);
  });

  it('closes the session when the consumer stops early', async () => {
    let produced = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        produced += 1;
        await delay(5);
        yield pcm(0.1);
      }
    }
    for await (const event of transcribeStream(optionsFor(server), endless(), { sampleRate: 16_000, language: 'ar', segmentSeconds: 0.5 })) {
      if (event.type === 'transcript') break;
    }
    await waitFor(() => server.sttConns[0]?.closeCode !== null);
    expect(server.sttConns).toHaveLength(1);
    const after = produced;
    await delay(50);
    expect(produced - after).toBeLessThanOrEqual(1); // the source is no longer pulled
  });

  it('stops with an AbortSignal', async () => {
    const controller = new AbortController();
    async function* slow(): AsyncGenerator<Uint8Array> {
      for (;;) {
        await delay(10);
        yield pcm(0.1);
      }
    }
    setTimeout(() => controller.abort(new Error('stop now')), 150);
    const { error } = await run(slow(), { signal: controller.signal });
    expect(error).toMatchObject({ message: 'stop now' });
    await waitFor(() => server.sttConns[0]?.closeCode !== null);
  });
});
