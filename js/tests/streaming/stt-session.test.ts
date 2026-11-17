/** Speech to Text sessions against the mock server. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APITimeoutError,
  InsufficientBalanceError,
  InvalidRequestError,
  PermissionDeniedError,
  SessionEndedError,
  SpendingLimitError,
  StreamConnectionLostError,
  UpstreamError,
  UsageError,
} from '../../src/errors.js';
import { connectStt, type SttEvent, type SttSession } from '../../src/streaming/index.js';
import { MAX_FRAME_BYTES } from '../../src/streaming/pcm-framer.js';
import { MockServer } from './mock-server.js';
import { captureLogger, concat, delay, optionsFor, pcm, waitFor } from './stream-helpers.js';

let server: MockServer;

beforeEach(async () => {
  server = await new MockServer().start();
});

afterEach(async () => {
  await server.stop();
});

const open = (init: Partial<Parameters<typeof connectStt>[1]> = {}, overrides = {}): Promise<SttSession> =>
  connectStt(optionsFor(server, overrides), { sampleRate: 16_000, language: 'ar', ...init });

/** Every event, and the error iteration ended with (if any). */
async function drain(stt: SttSession): Promise<{ events: SttEvent[]; error: unknown }> {
  const events: SttEvent[] = [];
  try {
    for await (const event of stt) events.push(event);
  } catch (error) {
    return { events, error };
  }
  return { events, error: null };
}

const texts = (events: SttEvent[]): string[] => events.flatMap((e) => (e.type === 'transcript' ? [e.text] : []));

async function rejects(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('did not reject');
}

describe('SttSession', () => {
  it('resolves connect after session.started, with the session and job ids', async () => {
    server.stt.startedDelay = 200;
    const stt = await open();
    try {
      expect(stt.sessionId).toBe(server.sttConns[0]!.sessionId);
      expect(stt.jobId).toBe(server.sttConns[0]!.jobId);
      expect(stt.maxSessionSeconds).toBe(1500);
      expect(stt.state).toBe('open');
      expect(server.sttConns[0]!.query).toEqual({ sample_rate: '16000', language: 'ar', encoding: 'pcm_s16le' });
    } finally {
      await stt.stop();
    }
  });

  it('transcribes segments, stops, and reports session.saved', async () => {
    const stt = await open({ language: 'en' });
    await stt.sendAudio(pcm(1));
    const first = await stt.endSegment();
    const empty = await stt.endSegment();
    await stt.sendAudio(pcm(0.02)); // 20 ms: too short for a transcript
    const short = await stt.endSegment();
    await stt.sendAudio(pcm(0.5));
    const summary = await stt.stop();
    const { events, error } = await drain(stt);
    expect(error).toBeNull();
    expect([first.index, first.audioOffsetSeconds, first.expectResult]).toEqual([0, 1, true]);
    expect(empty.expectResult).toBe(false);
    expect(short.expectResult).toBe(false);
    expect(texts(events)).toEqual(['segment 1', 'segment 2']);
    expect(events.filter((e) => e.type === 'transcript').map((e) => (e as { index: number }).index)).toEqual([0, 1]);
    expect(events.slice(-2).map((e) => e.type)).toEqual(['session.ended', 'session.saved']);
    expect(events.at(-1)).toMatchObject({ type: 'session.saved', status: 'saved', jobId: stt.jobId });
    expect(summary).toEqual({
      reason: 'stopped',
      totalSeconds: 1.5,
      creditsConsumed: summary.creditsConsumed,
      sessionId: stt.sessionId,
      jobId: server.sttConns[0]!.jobId,
      savedStatus: 'saved',
    });
    expect(stt.closed).toBe(true);
  });

  it.each([
    ['auto', 'empty'],
    ['failed', 'failed'],
    [null, null],
  ] as const)('reports savedStatus when the server says %s', async (scripted, expected) => {
    server.stt.savedStatus = scripted;
    const stt = await open();
    const summary = await stt.stop();
    expect(summary.savedStatus).toBe(expected);
    expect(summary.jobId).toBe(server.sttConns[0]!.jobId);
  });

  it('splits large writes into frames that fit the 64 KiB limit', async () => {
    const stt = await open({ sampleRate: 48_000 });
    const big = pcm(2, 48_000); // 192 KB in one call
    await stt.sendAudio(big);
    await stt.stop();
    expect(concat(server.sttConns[0]!.audio)).toEqual(big);
    expect(server.sttConns[0]!.audio.every((f) => f.length <= MAX_FRAME_BYTES && f.length % 2 === 0)).toBe(true);
    await waitFor(() => server.sttConns[0]!.closeCode !== null);
    expect(server.sttConns[0]!.closeCode).toBe(1000);
  });

  it('sets terminology at connect and later', async () => {
    const stt = await open({ terminology: { keywords: ['KYC'] } });
    await stt.sendAudio(pcm(0.5));
    await stt.endSegment();
    expect(await stt.setTerminology(null)).toMatchObject({ type: 'terminology.set', active: false });
    expect(await rejects(stt.setTerminology({ keywords: 'KYC' } as never))).toBeInstanceOf(InvalidRequestError);
    await stt.sendAudio(pcm(0.5));
    await stt.stop();
    const { events } = await drain(stt);
    const transcripts = events.filter((e) => e.type === 'transcript');
    expect(transcripts[0]).toMatchObject({ terminology: { mapperStatus: 'applied' } });
    expect(transcripts[1]).toMatchObject({ terminology: null });
    expect(server.sttConns[0]!.received[0]).toEqual({ type: 'terminology', terminology: { keywords: ['KYC'] } });
  });

  it('fails connect on invalid terminology, and closes the half-configured session', async () => {
    const error = await rejects(open({ terminology: { keywords: 'KYC' } as never }));
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as Error).message).toMatch(/keywords/);
    await waitFor(() => server.sttConns[0]!.closeCode !== null);
    expect(server.sttConns[0]!.closeCode).toBe(1000);
  });

  it('fails connect when the speech service is unreachable', async () => {
    server.stt.upstreamUnreachable = true;
    const error = (await rejects(open())) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.errorMessage).toBe('speech service unavailable');
    expect(error.closeCode).toBe(1011);
  });

  it('classifies handshake rejections', async () => {
    server.rejections.push({ status: 403, message: 'This API key does not have access to Speech-to-Text services' });
    expect(await rejects(open())).toBeInstanceOf(PermissionDeniedError);
  });

  it('checks arguments before connecting', async () => {
    expect(await rejects(open({ sampleRate: 16_000.5 }))).toBeInstanceOf(UsageError);
    expect(await rejects(open({ language: '' }))).toBeInstanceOf(UsageError);
    expect(await rejects(open({ language: 5 as unknown as string }))).toBeInstanceOf(UsageError);
    expect(server.attempts).toEqual([]);
  });

  it.each([
    [undefined, { sample_rate: '16000', encoding: 'pcm_s16le' }],
    ['auto', { sample_rate: '16000', language: 'auto', encoding: 'pcm_s16le' }],
  ] as const)('language %s: the server default applies when it is left out', async (language, query) => {
    const stt = await open({ language });
    try {
      expect(server.sttConns[0]!.query).toEqual(query);
    } finally {
      await stt.stop();
    }
  });

  it.each([
    ['insufficient_balance', InsufficientBalanceError],
    ['spending_limit', SpendingLimitError],
    ['upstream_error', UpstreamError],
  ] as const)('drains every event, then raises, on %s', async (reason, ErrorClass) => {
    server.stt.failAfterSegments = [2, reason];
    const stt = await open();
    for (let i = 0; i < 3; i++) {
      try {
        await stt.sendAudio(pcm(0.5));
        await stt.endSegment();
      } catch (error) {
        expect(error).toBeInstanceOf(ErrorClass);
        break;
      }
    }
    const { events, error } = await drain(stt);
    expect(texts(events)).toEqual(['segment 1', 'segment 2']); // paid for: never lost
    const ended = events.find((e) => e.type === 'session.ended');
    expect(ended).toMatchObject({ reason });
    expect(events.at(-1)?.type).toBe('session.saved');
    expect(error).toBeInstanceOf(ErrorClass);
    expect(await rejects(stt.stop())).toBeInstanceOf(ErrorClass);
  });

  it('reports a segment failure as a non-fatal event', async () => {
    server.stt.segmentErrors = new Set([1]);
    const stt = await open();
    await stt.sendAudio(pcm(0.5));
    await stt.endSegment();
    await stt.sendAudio(pcm(0.5));
    await stt.stop();
    const { events, error } = await drain(stt);
    expect(error).toBeNull();
    expect(events[0]).toMatchObject({ type: 'error', code: 'upstream_error' });
    expect(texts(events)).toEqual(['segment 2']);
  });

  it('treats max_duration as a normal end', async () => {
    server.stt.enforceMaxDuration = 200;
    const stt = await open();
    await stt.sendAudio(pcm(0.5));
    const { events, error } = await drain(stt);
    expect(error).toBeNull();
    expect(events.find((e) => e.type === 'session.ended')).toMatchObject({ reason: 'max_duration' });
    const sendError = await rejects(stt.sendAudio(pcm(0.1)));
    expect(sendError).toBeInstanceOf(SessionEndedError);
    expect((sendError as Error).message).toMatch(/max_duration/);
  });

  it('drains then raises when the connection drops', async () => {
    server.stt.actions.push({ kind: 'abort', after: 20_000 });
    const stt = await open();
    await stt.sendAudio(pcm(0.5));
    await stt.endSegment();
    const sendError = await rejects(
      (async () => {
        for (let i = 0; i < 20; i++) {
          await stt.sendAudio(pcm(0.1));
          await delay(10);
        }
      })(),
    );
    expect(sendError instanceof StreamConnectionLostError || sendError instanceof SessionEndedError).toBe(true);
    const { events, error } = await drain(stt);
    expect(texts(events)).toEqual(['segment 1']);
    expect(error).toBeInstanceOf(StreamConnectionLostError);
  });

  it('times out stop()', async () => {
    server.stt.drainDelay = 1_000;
    const stt = await open();
    await stt.sendAudio(pcm(0.2));
    const error = (await rejects(stt.stop({ timeoutMs: 200 }))) as APITimeoutError;
    expect(error).toBeInstanceOf(APITimeoutError);
    expect(error.kind).toBe('stop_drain');
  });

  it('warns when closed without stop()', async () => {
    const { lines, logger } = captureLogger();
    const stt = await open({}, { logger });
    await stt.sendAudio(pcm(0.2));
    await stt.close();
    expect(lines.some((l) => l.startsWith('warn:') && l.includes('without stop()'))).toBe(true);
    expect(await rejects(stt.sendAudio(pcm(0.1)))).toBeInstanceOf(SessionEndedError);
  });

  it('closes on await using', async () => {
    let session: SttSession;
    {
      await using stt = await open();
      session = stt;
    }
    expect(session.closed).toBe(true);
  });

  it('feeds from an iterable, dropping an odd trailing byte, then stops', async () => {
    const { lines, logger } = captureLogger();
    const stt = await open({}, { logger });
    const chunks = [pcm(0.31).subarray(0, 9_601), pcm(0.3)]; // odd-length chunk: one byte carried, then dropped at the end
    const feeding = stt.feedFrom(chunks);
    const { events, error } = await drain(stt);
    const summary = await feeding;
    expect(error).toBeNull();
    expect(summary.reason).toBe('stopped');
    expect(concat(server.sttConns[0]!.audio).length).toBe(9_600 + 9_600);
    expect(texts(events)).toEqual(['segment 1']);
    expect(lines.some((l) => l.includes('trailing byte'))).toBe(true);
  });

  it('feeds from an async iterable, a ReadableStream and a whole buffer', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield pcm(0.2);
      yield pcm(0.2);
    }
    const a = await open();
    expect((await a.feedFrom(source())).reason).toBe('stopped');
    const b = await open();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pcm(0.2));
        controller.close();
      },
    });
    expect((await b.feedFrom(stream)).reason).toBe('stopped');
    const c = await open();
    expect((await c.feedFrom(pcm(0.35))).reason).toBe('stopped');
    expect(server.sttConns[2]!.audio.length).toBe(4); // 100 ms frames
    expect(concat(server.sttConns[2]!.audio)).toEqual(pcm(0.35));
  });

  it('does not crash the process when an unawaited feedFrom fails', async () => {
    server.stt.failAfterSegments = [1, 'insufficient_balance'];
    const stt = await open();
    void stt.feedFrom([pcm(0.5), pcm(0.5)]);
    await stt.endSegment().catch(() => {});
    const { error } = await drain(stt);
    expect(error).toBeInstanceOf(InsufficientBalanceError);
  });

  it('lists only transcripts with transcripts()', async () => {
    const stt = await open();
    await stt.sendAudio(pcm(0.5));
    await stt.endSegment();
    await stt.stop();
    const out: string[] = [];
    for await (const t of stt.transcripts()) out.push(t.text);
    expect(out).toEqual(['segment 1']);
  });
});
