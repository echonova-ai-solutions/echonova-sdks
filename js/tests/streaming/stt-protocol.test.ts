/** SttProtocol and SegmentPlan as pure state machines. */

import { describe, expect, it } from 'vitest';
import {
  InsufficientBalanceError,
  InvalidRequestError,
  SessionEndedError,
  SessionExpiredError,
  SpendingLimitError,
  StreamConnectionLostError,
  UpstreamError,
  UsageError,
} from '../../src/errors.js';
import { MAX_FRAME_BYTES } from '../../src/streaming/pcm-framer.js';
import { CloseInfo } from '../../src/streaming/stream-errors.js';
import { SegmentPlan, SttProtocol } from '../../src/streaming/stt-protocol.js';
import type { SegmentMark } from '../../src/streaming/types.js';

const STARTED = {
  type: 'session.started',
  sessionId: 's1',
  language: 'ar',
  sampleRate: 16000,
  maxSessionSeconds: 1500,
  jobId: '66e3f2a1c9d4b8a1f0e12347',
};

function started(sampleRate = 16_000): SttProtocol {
  const p = new SttProtocol(sampleRate);
  p.receiveEvent(STARTED, 5_000);
  return p;
}

const transcript = (text = 'hi', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'transcript',
  segmentId: 'a'.repeat(24),
  text,
  durationSeconds: 1.0,
  creditsConsumed: 3.33,
  isFinal: true,
  ...extra,
});

const zeros = (n: number): Uint8Array => new Uint8Array(n);
const total = (frames: Uint8Array[]): number => frames.reduce((n, f) => n + f.length, 0);

describe('SttProtocol', () => {
  it('records session.started, including the job id', () => {
    const p = started();
    expect([p.state, p.sessionId, p.language, p.maxSessionSeconds, p.startedAt, p.jobId]).toEqual([
      'open',
      's1',
      'ar',
      1500,
      5_000,
      '66e3f2a1c9d4b8a1f0e12347',
    ]);
  });

  it('frames audio even and at most 64 KiB', () => {
    const p = started(48_000);
    const frames = p.pushAudio(zeros(300_001));
    expect(frames.every((f) => f.length % 2 === 0 && f.length <= MAX_FRAME_BYTES)).toBe(true);
    const { frames: flushed, mark } = p.cut();
    expect(total(frames) + total(flushed)).toBe(300_000); // the odd byte waits
    expect(mark.audioOffsetSeconds).toBeCloseTo(300_000 / 96_000);
  });

  it('marks segments, and expects no result for empty or < 50 ms ones', () => {
    const p = started();
    p.pushAudio(zeros(32_000));
    const first = p.cut().mark;
    expect(first).toEqual({ index: 0, audioOffsetSeconds: 1, durationSeconds: 1, expectResult: true });
    const empty = p.cut().mark;
    expect([empty.index, empty.expectResult]).toEqual([1, false]);
    p.pushAudio(zeros(1_598)); // 49.9 ms
    expect(p.cut().mark.expectResult).toBe(false);
    p.pushAudio(zeros(1_600)); // 50 ms
    const enough = p.cut().mark;
    expect(enough.expectResult).toBe(true);
    expect(enough.audioOffsetSeconds).toBeCloseTo((32_000 + 1_598 + 1_600) / 32_000);
  });

  it('keeps events in order, including session.saved', () => {
    const p = started();
    p.receiveEvent(transcript('  '), 6_000);
    p.receiveEvent({ type: 'terminology.set', active: true }, 6_000);
    p.receiveEvent({ type: 'error', code: 'upstream_error', message: 'segment failed' }, 6_000);
    p.receiveEvent(transcript('two', { terminology: { corrected: 'TWO' } }), 6_000);
    p.receiveEvent({ type: 'mystery', x: 1 }, 6_000);
    p.receiveEvent({ type: 'session.ended', reason: 'stopped', totalSeconds: 2, creditsConsumed: 6.7 }, 6_000);
    p.receiveEvent({ type: 'session.saved', jobId: '66e3f2a1c9d4b8a1f0e12347', status: 'saved' }, 6_000);
    const events = [...p.events];
    expect(events.map((e) => e.type)).toEqual([
      'transcript',
      'terminology.set',
      'error',
      'transcript',
      'unknown',
      'session.ended',
      'session.saved',
    ]);
    const [first, , error, second, unknown, , saved] = events;
    expect(first).toMatchObject({ type: 'transcript', text: '  ', index: 0 }); // passed through unchanged
    expect(second).toMatchObject({ index: 1, terminology: { corrected: 'TWO' }, sessionId: 's1' });
    expect(error).toMatchObject({ type: 'error', code: 'upstream_error' });
    expect((error as { error: unknown }).error).toBeInstanceOf(UpstreamError);
    expect(unknown).toMatchObject({ type: 'unknown', eventType: 'mystery' });
    expect(saved).toMatchObject({ type: 'session.saved', jobId: '66e3f2a1c9d4b8a1f0e12347', status: 'saved', sessionId: 's1' });
    expect(p.summary()).toEqual({
      reason: 'stopped',
      totalSeconds: 2,
      creditsConsumed: 6.7,
      sessionId: 's1',
      jobId: '66e3f2a1c9d4b8a1f0e12347',
      savedStatus: 'saved',
    });
  });

  it('reports savedStatus null when session.saved never came', () => {
    const p = started();
    p.receiveEvent({ type: 'session.ended', reason: 'stopped', totalSeconds: 0, creditsConsumed: 0 }, 6_000);
    p.connectionClosed(new CloseInfo(1000, 'stopped'));
    expect(p.summary()).toMatchObject({ savedStatus: null, jobId: STARTED.jobId });
  });

  it('answers a terminology frame with terminology.set or a rejection', () => {
    const p = started();
    p.beginTerminology({ keywords: ['KYC'] });
    p.receiveEvent({ type: 'terminology.set', active: true }, 6_000);
    expect(p.terminologyReply).toMatchObject({ type: 'terminology.set', active: true });
    p.beginTerminology({ keywords: 'nope' } as never);
    p.receiveEvent({ type: 'error', code: 'validation_failed', message: 'keywords must be a list' }, 6_000);
    expect(p.terminologyReply).toBeInstanceOf(InvalidRequestError);
    expect(p.events.some((e) => e.type === 'error')).toBe(false); // it was the reply, not a stream event
    expect(() => p.beginTerminology({ keywords: ['x'.repeat(70_000)] })).toThrow(UsageError);
  });

  it('stops normally', () => {
    const p = started();
    p.pushAudio(zeros(101));
    const { frames, dropped } = p.beginStop();
    expect([total(frames), dropped]).toEqual([100, 1]);
    expect(() => p.pushAudio(zeros(2))).toThrow(/stop/);
    p.receiveEvent({ type: 'session.ended', reason: 'stopped', totalSeconds: 0, creditsConsumed: 0 }, 7_000);
    p.connectionClosed(new CloseInfo(1000, 'stopped'));
    expect(p.fatal).toBeNull();
    expect(p.state).toBe('closed');
  });

  it.each([
    [4002, 'insufficient_balance', InsufficientBalanceError],
    [4029, 'spending_limit', SpendingLimitError],
  ] as const)('a billing close %i after session.ended is fatal, but events are kept', (code, reason, ErrorClass) => {
    const p = started();
    p.receiveEvent(transcript('paid for'), 6_000);
    p.receiveEvent({ type: 'error', code: reason, message: reason.replace('_', ' ') }, 6_000);
    p.receiveEvent({ type: 'session.ended', reason, totalSeconds: 1, creditsConsumed: 3 }, 6_000);
    p.connectionClosed(new CloseInfo(code, reason));
    expect(p.fatal).toBeInstanceOf(ErrorClass);
    expect((p.fatal as InsufficientBalanceError).errorMessage).toBe(reason.replace('_', ' '));
    expect(p.events[0]?.type).toBe('transcript'); // drained before the error is raised
    expect(() => p.pushAudio(zeros(2))).toThrow(ErrorClass);
  });

  it('treats max_duration as a normal end', () => {
    const p = started();
    p.receiveEvent({ type: 'session.ended', reason: 'max_duration', totalSeconds: 1, creditsConsumed: 3 }, 6_000);
    p.connectionClosed(new CloseInfo(4008, 'max_duration'));
    expect(p.fatal).toBeNull();
    expect(() => p.pushAudio(zeros(2))).toThrow(SessionEndedError);
    expect(() => p.pushAudio(zeros(2))).toThrow(/max_duration/);
  });

  it('treats 4008 without session.ended as expired', () => {
    const p = started();
    p.connectionClosed(new CloseInfo(4008, 'idle_timeout'));
    expect(p.fatal).toBeInstanceOf(SessionExpiredError);
  });

  it('treats a drop as connection lost', () => {
    const p = started();
    p.connectionClosed(new CloseInfo(1006));
    expect(p.fatal).toBeInstanceOf(StreamConnectionLostError);
  });

  it.each([1011, 1000])('an end before session.started (close %i) is an upstream error', (code) => {
    const p = new SttProtocol(16_000);
    p.receiveEvent({ type: 'error', code: 'upstream_error', message: 'speech service unavailable' }, 1_000);
    p.receiveEvent({ type: 'session.ended', reason: 'upstream_error', totalSeconds: 0, creditsConsumed: 0 }, 1_000);
    p.connectionClosed(new CloseInfo(code, 'upstream_error'));
    expect(p.fatal).toBeInstanceOf(UpstreamError);
    expect((p.fatal as UpstreamError).errorMessage).toBe('speech service unavailable');
    expect((p.fatal as UpstreamError).closeCode).toBe(code);
  });

  it('answers a waiting terminology with the close', () => {
    const p = started();
    p.beginTerminology(null);
    p.connectionClosed(new CloseInfo(1006));
    expect(p.terminologyReply).toBeInstanceOf(StreamConnectionLostError);
  });
});

const sessionMark = (expectResult: boolean): SegmentMark => ({
  index: 0,
  audioOffsetSeconds: 0,
  durationSeconds: 0,
  expectResult,
});

const fill = (byte: number, n: number): Uint8Array => new Uint8Array(n).fill(byte);

describe('SegmentPlan', () => {
  it('cuts every segment across chunks', () => {
    const plan = new SegmentPlan(8_000, 1); // 16,000 bytes per segment
    const pieces = [...plan.split(zeros(10_000)), ...plan.split(zeros(10_000)), ...plan.split(zeros(13_000))];
    expect(pieces.map((p) => [p.data.length, p.cut])).toEqual([
      [10_000, false],
      [6_000, true],
      [4_000, false],
      [12_000, true],
      [1_000, false],
    ]);
  });

  it('keeps samples aligned', () => {
    const plan = new SegmentPlan(8_000, 1);
    const pieces = [...plan.split(Uint8Array.of(1, 2, 3)), ...plan.split(Uint8Array.of(4))];
    expect(pieces.flatMap((p) => [...p.data])).toEqual([1, 2, 3, 4]);
    expect(pieces.every((p) => p.data.length % 2 === 0)).toBe(true);
    plan.split(Uint8Array.of(5));
    expect(plan.finish()).toBe(1);
  });

  it('replays only uncut audio and reports dropped segments', () => {
    const plan = new SegmentPlan(8_000, 1);
    const audio = new Uint8Array([...fill(65, 16_000), ...fill(66, 16_000), ...fill(67, 3_000)]);
    for (const piece of plan.split(audio)) {
      plan.delivered(piece.data);
      if (piece.cut) plan.cut(sessionMark(true));
    }
    expect(plan.replay()).toEqual(fill(67, 3_000));
    expect(plan.pending.map((m) => m.index)).toEqual([0, 1]);
    plan.result(); // segment 0 answered
    const dropped = plan.takeDropped();
    expect(dropped.map((m) => [m.index, m.audioOffsetSeconds, m.durationSeconds])).toEqual([[1, 2, 1]]);
    expect(plan.takeDropped()).toEqual([]);
  });

  it('ignores cuts that expect no result', () => {
    const plan = new SegmentPlan(8_000, 1);
    expect(plan.cut(sessionMark(false)).expectResult).toBe(false);
    expect(plan.pending).toEqual([]);
  });

  it('knows when the final segment was answered', () => {
    const plan = new SegmentPlan(8_000, 1);
    plan.cut(sessionMark(true));
    plan.result(); // answers the cut
    expect(plan.tailAnswered).toBe(false);
    plan.result(); // a result beyond every cut: the final segment from stop()
    expect(plan.tailAnswered).toBe(true);
    plan.newSession();
    expect(plan.tailAnswered).toBe(false);
  });
});
