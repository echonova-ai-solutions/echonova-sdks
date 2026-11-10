/** TtsProtocol as a pure state machine, driven with a fake clock (milliseconds). */

import { describe, expect, it } from 'vitest';
import {
  APITimeoutError,
  InsufficientBalanceError,
  InvalidRequestError,
  ProtocolError,
  ServerRestartingError,
  SessionEndedError,
  SessionExpiredError,
  StreamConnectionLostError,
  UpstreamError,
  UsageError,
  VoiceNotFoundError,
} from '../../src/errors.js';
import { CloseInfo, chargeStateOf } from '../../src/streaming/stream-errors.js';
import {
  SentenceSplitter,
  TtsProtocol,
  outboundText,
  type SynthesisCore,
  type TtsProtocolOptions,
} from '../../src/streaming/tts-protocol.js';
import type { SynthesisOptions } from '../../src/streaming/types.js';

const T0 = 100_000;

class Harness {
  readonly p: TtsProtocol;
  now = T0;
  readonly wire: Array<Record<string, unknown>> = [];

  constructor(options: Partial<TtsProtocolOptions> = {}) {
    let n = 0;
    this.p = new TtsProtocol({ voiceId: 'v1', newRequestId: () => `r${++n}`, ...options });
    this.p.connectionOpened(this.now);
  }

  /** Send everything the protocol has queued; return the frames sent. */
  flush(): Array<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = [];
    for (let item = this.p.nextOutbound(this.now); item !== null; item = this.p.nextOutbound(this.now)) {
      sent.push(JSON.parse(outboundText(item)) as Record<string, unknown>);
      this.p.sent(item, this.now);
    }
    this.wire.push(...sent);
    return sent;
  }

  synth(text = 'hello', options: SynthesisOptions = {}): SynthesisCore {
    return this.p.synthesize(text, options, this.now);
  }

  event(type: string, fields: Record<string, unknown> = {}): void {
    this.p.receiveEvent({ type, ...fields }, this.now);
  }

  start(rid: string, sampleRate = 24_000): void {
    this.event('start', { requestId: rid, sampleRate, encoding: 'pcm_s16le', channels: 1 });
  }

  audio(n = 1): void {
    for (let i = 0; i < n; i++) this.p.receiveBinary(new Uint8Array(20).fill(1), this.now);
  }

  done(rid: string): void {
    this.event('done', { requestId: rid, durationSeconds: 1.5, characters: 5, creditsConsumed: 5 });
  }

  tick(ms: number): void {
    this.now += ms;
    this.p.tick(this.now);
  }
}

describe('TtsProtocol', () => {
  it('runs the happy path and reports metrics', () => {
    const h = new Harness();
    const core = h.synth('hello', { speed: 1.2 });
    expect(core.state).toBe('queued');
    expect(h.flush()).toEqual([{ type: 'synthesize', requestId: 'r1', text: 'hello', voiceId: 'v1', speed: 1.2 }]);
    expect(core.state).toBe('sent');
    h.now += 200;
    h.start('r1', 22_050);
    h.now += 50;
    h.audio(3);
    h.done('r1');
    expect(core.state).toBe('completed');
    expect(core.sampleRate).toBe(22_050);
    expect(core.chunks).toHaveLength(3);
    const result = core.result();
    expect([result.outcome, result.charged, result.creditsConsumed, result.characters]).toEqual(['completed', true, 5, 5]);
    expect(core.metrics()).toMatchObject({ timeToStart: 200, ttfb: 250, frames: 3, audioBytes: 60 });
  });

  it('keeps the sample rate of the latest start for the session', () => {
    const h = new Harness();
    expect(h.p.sampleRate).toBeNull(); // nothing started yet
    h.p.enqueue('one', {}, h.now);
    h.p.enqueue('two', {}, h.now);
    h.flush();
    h.start('r1', 22_050);
    expect(h.p.sampleRate).toBe(22_050); // known before the first audio frame
    h.audio();
    h.done('r1');
    h.flush();
    h.start('r2', 16_000);
    expect(h.p.sampleRate).toBe(16_000);
    h.start('zzz', 8_000); // a start for a request this session doesn't track: its audio is dropped
    h.event('start', { requestId: 'r2', sampleRate: 0 }); // not a usable rate
    expect(h.p.sampleRate).toBe(16_000);
    h.p.connectionClosed(new CloseInfo(1006), h.now);
    expect(h.p.sampleRate).toBe(16_000); // kept across reconnects
  });

  it('sends only the options that are set, and merges the session defaults', () => {
    const p = new TtsProtocol({ voiceId: 'v1', defaults: { speed: 0.9, normalize: undefined }, newRequestId: () => 'a' });
    p.connectionOpened(T0);
    p.synthesize('x', { numSteps: 32, tashkeel: undefined, voiceId: 'v2' }, T0);
    const item = p.nextOutbound(T0);
    expect(JSON.parse(outboundText(item!))).toEqual({
      type: 'synthesize',
      requestId: 'a',
      text: 'x',
      voiceId: 'v2',
      speed: 0.9,
      numSteps: 32,
    });
    expect(() => p.synthesize('x', { pitch: 2 } as SynthesisOptions, T0)).toThrow(/pitch/);
    expect(() => p.synthesize(42 as unknown as string, {}, T0)).toThrow(UsageError);
  });

  it('raises UsageError for a frame over 64 KiB, and queues nothing', () => {
    const h = new Harness();
    expect(() => h.synth('x', { extraBody: { blob: 'y'.repeat(70_000) } })).toThrow(UsageError);
    expect(h.flush()).toEqual([]);
  });

  describe('supersede', () => {
    it('ends the running synthesis on cancelled, with its final cost', () => {
      const h = new Harness();
      const a = h.synth('first');
      h.flush();
      h.start('r1');
      h.audio(2);
      const b = h.synth('second');
      expect(a.state).toBe('cancelling');
      expect(h.flush().map((f) => f['type'])).toEqual(['synthesize']); // the server cancels A itself: no cancel frame
      h.audio(2); // A's audio still in flight: dropped
      expect(a.droppedFrames).toBe(2);
      expect(a.chunks).toHaveLength(2);
      h.event('cancelled', { requestId: 'r1', creditsConsumed: 2 });
      expect(a.state).toBe('superseded');
      expect(a.result()).toMatchObject({ outcome: 'superseded', charged: true, creditsConsumed: 2 });
      h.start('r2');
      h.audio(1);
      expect(b.chunks).toHaveLength(1);
      expect(b.state).toBe('streaming');
    });

    it('ends it on a newer start even without cancelled (resolved locally: cost unknown)', () => {
      const h = new Harness();
      const a = h.synth('first');
      h.flush();
      h.start('r1');
      h.synth('second');
      h.flush();
      h.start('r2');
      expect(a.state).toBe('superseded');
      expect(a.charged).toBeNull();
      expect(a.chargeState).toBe('yes'); // it had started
      h.event('cancelled', { requestId: 'r1' }); // late: ignored
      expect(a.state).toBe('superseded');
    });

    it('reports an unstarted superseded request as charge unknown', () => {
      const h = new Harness();
      const a = h.synth('first');
      h.flush();
      h.synth('second');
      h.flush();
      h.start('r2');
      expect(a.state).toBe('superseded');
      expect(a.chargeState).toBe('unknown');
    });
  });

  it('drops and counts orphan frames', () => {
    const h = new Harness();
    h.audio(2); // nothing started
    const a = h.synth();
    h.flush();
    h.start('r1');
    h.done('r1');
    h.audio(1); // after done
    h.start('zzz'); // a start for something we never sent
    h.audio(1);
    expect(h.p.orphanFrames).toBe(4);
    expect(a.chunks).toHaveLength(0);
  });

  it('ignores duplicate and unknown done/cancelled', () => {
    const h = new Harness();
    const a = h.synth();
    h.flush();
    h.start('r1');
    h.done('r1');
    h.done('r1');
    h.event('cancelled', { requestId: 'r1' });
    h.done('unknown');
    expect(a.state).toBe('completed');
  });

  describe('cancel', () => {
    it('never sends cancel when nothing is in flight', () => {
      const h = new Harness();
      h.p.cancelActive(h.now);
      h.p.interrupt(h.now);
      expect(h.flush()).toEqual([]);
      const a = h.synth();
      h.flush();
      h.start('r1');
      h.done('r1');
      h.p.cancel(a, h.now); // finished: nothing to cancel
      h.p.cancelActive(h.now);
      expect(h.flush()).toEqual([]);
    });

    it('drops a queued request locally', () => {
      const h = new Harness();
      const a = h.synth();
      h.p.cancel(a, h.now);
      expect(a.state).toBe('cancelled');
      expect(a.charged).toBe(false);
      expect(h.flush()).toEqual([]);
    });

    it('sends one cancel for a request in flight; cancelled reports the share charged', () => {
      const h = new Harness();
      const a = h.synth();
      h.flush();
      h.start('r1');
      h.audio(1);
      h.p.cancel(a, h.now);
      h.p.cancel(a, h.now);
      expect(h.flush()).toEqual([{ type: 'cancel' }]);
      h.event('cancelled', { requestId: 'r1', creditsConsumed: 1 });
      expect(a.state).toBe('cancelled');
      expect(a.result()).toMatchObject({ outcome: 'cancelled', charged: true, creditsConsumed: 1 });
      expect(a.chargeState).toBe('yes');
    });

    it('reports charged=false for a cancelled without creditsConsumed (cancelled before it was charged)', () => {
      const h = new Harness();
      const a = h.synth();
      h.flush();
      h.p.cancel(a, h.now);
      h.flush();
      h.event('cancelled', { requestId: 'r1' });
      expect(a.result()).toMatchObject({ outcome: 'cancelled', charged: false, creditsConsumed: null });
      expect(a.chargeState).toBe('no');
    });

    it.each([
      [true, 'yes'],
      [false, 'unknown'],
    ] as const)('treats a cancel not acknowledged within 5 s as done (started=%s)', (started, chargeState) => {
      const h = new Harness();
      const a = h.synth();
      h.flush();
      if (started) h.start('r1');
      h.p.cancel(a, h.now);
      h.flush();
      expect(h.p.nextDeadline()).toBe(h.now + 5_000);
      h.tick(4_900);
      expect(a.state).toBe('cancelling');
      h.tick(200);
      expect(a.state).toBe('cancelled');
      expect(a.charged).toBeNull(); // resolved locally
      expect(a.chargeState).toBe(chargeState);
    });

    it('is sent after the request when it arrives while the request is being written', () => {
      const h = new Harness();
      const a = h.synth('a');
      const item = h.p.nextOutbound(h.now);
      expect(item).not.toBeNull();
      h.p.cancel(a, h.now);
      h.p.sent(item!, h.now);
      expect(a.state).toBe('cancelling');
      expect(h.flush()).toEqual([{ type: 'cancel' }]);
    });
  });

  it('fails a request with no start within 30 s, and cancels it', () => {
    const h = new Harness();
    const a = h.synth();
    h.flush();
    h.tick(29_000);
    expect(a.state).toBe('sent');
    h.tick(1_000);
    expect(a.state).toBe('failed');
    expect(a.error).toBeInstanceOf(APITimeoutError);
    expect(a.chargeState).toBe('unknown');
    expect(h.flush()).toEqual([{ type: 'cancel' }]);
    h.event('cancelled', { requestId: 'r1' }); // late ack: ignored
    expect(a.state).toBe('failed');
  });

  describe('connection loss and charge state', () => {
    it('marks the running request lost (charged: yes) and keeps queued ones', () => {
      const h = new Harness();
      const started = h.synth('a');
      h.flush();
      h.start('r1');
      const queued = h.p.enqueue('b', {}, h.now);
      h.p.connectionClosed(new CloseInfo(1006), h.now);
      expect(started.state).toBe('lost');
      expect(started.error).toBeInstanceOf(StreamConnectionLostError);
      expect(started.chargeState).toBe('yes');
      expect(chargeStateOf(started.error)).toBe('yes');
      expect((started.error as StreamConnectionLostError).mayHaveExecuted).toBe(true);
      expect(queued.state).toBe('queued'); // never sent: survives the reconnect
      expect(queued.chargeState).toBe('no');
      expect(h.p.afterAbnormal).toBe(true);
    });

    it('never resends a request that was sent but not started', () => {
      const h = new Harness();
      const a = h.synth('a');
      h.flush();
      h.p.connectionClosed(new CloseInfo(1006), h.now);
      expect(a.state).toBe('lost');
      expect(a.chargeState).toBe('unknown');
      expect(chargeStateOf(a.error)).toBe('unknown');
      h.p.connectionOpened(h.now);
      expect(h.flush()).toEqual([]); // probably charged: never sent again automatically
    });

    it('marks a request written while the socket closed as lost (charge unknown)', () => {
      const h = new Harness();
      const a = h.synth('a');
      const item = h.p.nextOutbound(h.now)!;
      h.p.connectionClosed(new CloseInfo(1006), h.now);
      h.p.sent(item, h.now);
      expect(a.state).toBe('lost');
      expect(a.chargeState).toBe('unknown');
    });

    it('requeues a request that could not be written; it goes out on the next socket', () => {
      const h = new Harness();
      const a = h.synth('a');
      const item = h.p.nextOutbound(h.now)!;
      h.p.connectionClosed(new CloseInfo(1006), h.now);
      h.p.requeue(item, h.now);
      h.p.connectionOpened(h.now);
      expect(h.flush().map((f) => f['requestId'])).toEqual(['r1']);
      expect(a.state).toBe('sent');
    });
  });

  describe('upstream errors', () => {
    it('resends a pre-audio upstream_error once (refunded: charge no)', () => {
      const h = new Harness();
      const a = h.synth('a');
      h.flush();
      h.event('error', { code: 'upstream_error', message: 'could not synthesize this text', requestId: 'r1' });
      expect(a.state).toBe('queued');
      expect(a.chargeState).toBe('no');
      expect(h.flush().map((f) => f['requestId'])).toEqual(['r1']);
      h.event('error', { code: 'upstream_error', message: 'could not synthesize this text', requestId: 'r1' });
      expect(a.state).toBe('failed');
      expect(a.error).toBeInstanceOf(UpstreamError);
      expect(a.chargeState).toBe('no');
      expect(h.flush()).toEqual([]);
    });

    it('fails a mid-stream upstream_error, charged for the share sent, never resent', () => {
      const h = new Harness();
      const a = h.synth('a');
      h.flush();
      h.start('r1');
      h.audio(1);
      h.event('error', { code: 'upstream_error', message: 'stopped during this synthesis', requestId: 'r1', creditsConsumed: 3 });
      expect(a.state).toBe('failed');
      expect(a.chargeState).toBe('yes');
      expect(a.charged).toBe(true);
      expect(a.creditsConsumed).toBe(3);
      expect(a.chunks).toHaveLength(1); // audio already received is kept
      expect(h.flush()).toEqual([]);
    });

    it('attributes an error without requestId to the only request in flight', () => {
      const h = new Harness();
      const a = h.synth('a');
      h.flush();
      h.event('error', { code: 'upstream_error', message: 'x' });
      expect(a.state).toBe('queued'); // resent
      expect(a.resends).toBe(1);
    });
  });

  describe('rejections', () => {
    it('cancels the running request when a newer one is rejected (the caller asked it to stop)', () => {
      const h = new Harness();
      const a = h.synth('a');
      h.flush();
      h.start('r1');
      const b = h.synth('');
      h.flush();
      h.event('error', { code: 'validation_failed', message: 'text must be 1 to 500 characters', requestId: 'r2' });
      expect(b.state).toBe('failed');
      expect(b.error).toBeInstanceOf(InvalidRequestError);
      expect(b.chargeState).toBe('no');
      expect(h.flush()).toEqual([{ type: 'cancel' }]);
      h.event('cancelled', { requestId: 'r1', creditsConsumed: 1 });
      expect(a.state).toBe('superseded');
    });

    it('does not cancel when a newer request is pending', () => {
      const h = new Harness();
      h.synth('a');
      h.flush();
      h.start('r1');
      h.synth('');
      h.flush();
      h.synth('c'); // pending, will replace A on the server
      h.event('error', { code: 'validation_failed', message: 'bad', requestId: 'r2' });
      expect(h.flush().map((f) => f['type'])).toEqual(['synthesize']);
    });

    it('fails the new request on voice_not_found; the running one gets its own cancelled', () => {
      const h = new Harness();
      const a = h.synth('a');
      h.flush();
      h.start('r1');
      const b = h.synth('b', { voiceId: 'missing' });
      h.flush();
      h.event('cancelled', { requestId: 'r1', creditsConsumed: 1 });
      h.event('error', { code: 'voice_not_found', message: 'Voice not found', requestId: 'r2' });
      expect(a.state).toBe('superseded');
      expect(b.error).toBeInstanceOf(VoiceNotFoundError);
    });
  });

  it('attaches an unattributable error to the next close', () => {
    const h = new Harness();
    const a = h.synth('a');
    h.flush();
    h.event('error', { code: 'invalid_message', message: 'frame is not valid JSON' });
    expect(a.state).toBe('sent');
    h.p.connectionClosed(new CloseInfo(1008, 'invalid_message'), h.now);
    expect(a.error).toBeInstanceOf(ProtocolError);
    expect((a.error as ProtocolError).errorMessage).toBe('frame is not valid JSON');
    expect(h.p.fatal).toBeInstanceOf(ProtocolError);
    expect(() => h.synth('again')).toThrow(SessionEndedError);
  });

  it('holds an unmatched error for 1 s', () => {
    const h = new Harness();
    h.event('error', { code: 'invalid_message', message: 'x' });
    expect(h.p.nextDeadline()).toBe(h.now + 1_000);
    h.tick(1_000);
    expect(h.p.nextDeadline()).toBeNull();
  });

  it.each([1002, 1007, 1008, 1009])('fails everything on a protocol close %i', (code) => {
    const h = new Harness();
    const a = h.synth('a');
    h.flush();
    h.start('r1');
    const queued = h.p.enqueue('b', {}, h.now);
    h.p.connectionClosed(new CloseInfo(code), h.now);
    expect(a.state).toBe('failed');
    expect(a.error).toBeInstanceOf(ProtocolError);
    expect(queued.error).toBeInstanceOf(ProtocolError);
    expect(h.p.fatal).toBeInstanceOf(ProtocolError);
  });

  it('fails everything on a billing close', () => {
    const h = new Harness();
    const a = h.synth('a');
    h.flush();
    h.start('r1');
    const queued = h.p.enqueue('b', {}, h.now);
    h.p.connectionClosed(new CloseInfo(4002, 'insufficient_balance'), h.now);
    expect(a.error).toBeInstanceOf(InsufficientBalanceError);
    expect(a.state).toBe('failed');
    expect(queued.error).toBeInstanceOf(InsufficientBalanceError);
    expect(queued.chargeState).toBe('no');
    expect(h.p.nextOutbound(h.now)).toBeNull();
  });

  it('treats session expiry and restart closes as lazy reconnects', () => {
    const h = new Harness();
    const a = h.synth('a');
    h.flush();
    h.p.connectionClosed(new CloseInfo(4008, 'max_duration'), h.now);
    expect(a.error).toBeInstanceOf(SessionExpiredError);
    expect(h.p.fatal).toBeNull();
    expect(h.p.afterAbnormal).toBe(false);
    h.p.connectionOpened(h.now);
    const b = h.synth('b');
    h.flush();
    h.p.connectionClosed(new CloseInfo(1001, 'server_restarting'), h.now);
    expect(b.error).toBeInstanceOf(ServerRestartingError);
    expect(h.p.afterAbnormal).toBe(true);
  });

  it('ends in-flight requests as cancelled on a local close (cost unknown)', () => {
    const h = new Harness();
    const a = h.synth('a');
    h.flush();
    h.start('r1');
    const queued = h.p.enqueue('b', {}, h.now);
    h.p.close(h.now);
    expect(queued.state).toBe('cancelled');
    h.p.connectionClosed(new CloseInfo(1000, '', true), h.now);
    expect(a.state).toBe('cancelled');
    expect(a.charged).toBeNull();
    expect(a.chargeState).toBe('yes');
  });

  it('sends the next queued request only after done', () => {
    const h = new Harness();
    const a = h.p.enqueue('a', {}, h.now);
    const b = h.p.enqueue('b', {}, h.now);
    expect(h.flush().map((f) => f['text'])).toEqual(['a']);
    h.start('r1');
    expect(h.flush()).toEqual([]);
    h.done('r1');
    expect(h.flush().map((f) => f['text'])).toEqual(['b']);
    expect(a.state).toBe('completed');
    expect(b.state).toBe('sent');
  });

  it('clears the queue on synthesize', () => {
    const h = new Harness();
    const a = h.p.enqueue('a', {}, h.now);
    h.flush();
    const b = h.p.enqueue('b', {}, h.now);
    const c = h.synth('c');
    expect(b.state).toBe('superseded');
    expect(b.charged).toBe(false);
    expect(a.state).toBe('cancelling');
    expect(h.flush().map((f) => f['text'])).toEqual(['c']);
    expect(c.state).toBe('sent');
  });

  it('interrupt cancels and drops the queue', () => {
    const h = new Harness();
    const a = h.p.enqueue('a', {}, h.now);
    const b = h.p.enqueue('b', {}, h.now);
    h.flush();
    h.start('r1');
    h.p.interrupt(h.now);
    expect(b.state).toBe('cancelled');
    expect(h.flush()).toEqual([{ type: 'cancel' }]);
    h.event('cancelled', { requestId: 'r1', creditsConsumed: 1 });
    expect(a.state).toBe('cancelled');
    expect(h.p.idle).toBe(true);
  });

  it('keeps unknown events', () => {
    const h = new Harness();
    h.event('brand.new', { x: 1 });
    expect(h.p.unknownEvents[0]).toMatchObject({ type: 'unknown', eventType: 'brand.new', raw: { type: 'brand.new', x: 1 } });
  });
});

describe('SentenceSplitter', () => {
  it('splits at sentence marks followed by whitespace, and at newlines', () => {
    const splitter = new SentenceSplitter();
    const text = 'Hello there. It costs 3.5 dollars! Really? مرحبا، كيف حالك؟ تمام؛ شكرا\nnext line';
    expect([...splitter.push(text), ...splitter.flush()]).toEqual([
      'Hello there.',
      'It costs 3.5 dollars!',
      'Really?',
      'مرحبا،',
      'كيف حالك؟',
      'تمام؛',
      'شكرا',
      'next line',
    ]);
  });

  it('streams deltas', () => {
    const splitter = new SentenceSplitter();
    const out: string[] = [];
    for (const delta of ['Hel', 'lo.', ' How a', 're you', '? Fine', '...']) out.push(...splitter.push(delta));
    expect(out).toEqual(['Hello.', 'How are you?']);
    expect(splitter.flush()).toEqual(['Fine...']);
  });

  it('caps the length and skips punctuation-only pieces', () => {
    const splitter = new SentenceSplitter(500);
    const long = `${'word '.repeat(150).trim()}.`;
    const pieces = [...splitter.push(`${long} ... `), ...splitter.flush()];
    expect(pieces.every((p) => p.length <= 500)).toBe(true);
    expect(pieces.join(' ').split(/\s+/)).toEqual(long.split(/\s+/));
    expect(new SentenceSplitter().push('! ? ')).toEqual([]);
    expect(new SentenceSplitter().push('x'.repeat(1200)).map((p) => p.length)).toEqual([500, 500]);
  });

  it('never splits a surrogate pair', () => {
    const text = `${'a'.repeat(499)}😀${'b'.repeat(10)}`;
    const pieces = [...new SentenceSplitter().push(text)];
    expect(pieces[0]).toBe('a'.repeat(499));
  });
});
