/**
 * `transcribeStream`: transcribe an audio source of any length over Speech to Text sessions.
 *
 * - It cuts its own segments every `segmentSeconds` of audio, so it always
 *   knows where each cut fell.
 * - Shortly before a session's time limit it rolls over: it cuts, stops the
 *   session, waits for its last transcripts and opens a new one. Audio that
 *   arrives meanwhile is buffered (bounded) and sent to the new session.
 * - After a dropped connection (1001, 1006 or 1011) it reconnects and replays the
 *   audio sent since the last cut. A segment is charged when its transcript is
 *   sent, so audio that was never cut into a segment can be replayed without
 *   paying twice. Segments that were cut but got no result are not replayed; they
 *   are reported as `AudioDropped`.
 * - It never reconnects after a billing or protocol close (4002, 4029, 1008, 1009).
 *
 * Built only on the public `SttSession` calls.
 */

import {
  EchoNovaError,
  ServerRestartingError,
  SessionEndedError,
  SessionExpiredError,
  StreamConnectionLostError,
  UpstreamError,
  UsageError,
} from '../errors.js';
import { abortReason } from '../runtime/ws-transport.js';
import { AsyncQueue, Signal, sleep, waitOrTimeout } from './async-utils.js';
import { BYTES_PER_SAMPLE } from './audio.js';
import { AttemptLimiter } from './link-rules.js';
import {
  reconnectDelay,
  resolveReconnectPolicy,
  resolveStreamOptions,
  type ReconnectPolicy,
  type ResolvedReconnectPolicy,
  type ResolvedStreamOptions,
  type StreamOptions,
} from './options.js';
import { SegmentPlan, type Piece } from './stt-protocol.js';
import { SttSession, audioChunks, sttQuery, type AudioSource } from './stt-session.js';
import type { AudioDropped, Reconnected, SegmentMark, SttEvent, StreamTerminology, TranscribeEvent } from './types.js';
import type { Language } from '../types/models.js';

/** Audio held while a session is being replaced, before the source is paused. */
const MAX_BUFFER_SECONDS = 60;

export interface TranscribeStreamOptions {
  sampleRate: number;
  /** `auto` (the API's default when left out), `ar` or `en`. Every session it opens uses the same. */
  language?: Language | undefined;
  terminology?: StreamTerminology | null | undefined;
  encoding?: string | undefined;
  /** Cut a segment every this many seconds of audio. Default 14, just under the server's 15 s cut. */
  segmentSeconds?: number | undefined;
  reconnect?: ReconnectPolicy | undefined;
  /** Send no faster than real time, to simulate a live source with a file. Default false. */
  realtime?: boolean | undefined;
  waitForSlot?: number | null | undefined;
  /** Stop: the iterator throws the abort reason and the session is closed. */
  signal?: AbortSignal | undefined;
}

/** `[reason, countsAsFailure, afterAbnormalLoss]` when a new session should be opened. */
export function reconnectReason(error: unknown, summaryReason: string | null): [string, boolean, boolean] | null {
  if (error instanceof ServerRestartingError) return ['server_restarting', true, true];
  if (error instanceof StreamConnectionLostError) return ['connection_lost', true, true];
  if (error instanceof UpstreamError && error.closeCode === 1011) return ['upstream_error', true, false];
  if (error instanceof SessionExpiredError) return ['session_expired', true, false];
  if (error instanceof SessionEndedError && (summaryReason === 'max_duration' || summaryReason === 'idle_timeout')) {
    return [summaryReason, false, false];
  }
  return null;
}

const EOF = Symbol('eof');
const ROLLOVER = Symbol('rollover');
const SESSION_DOWN = Symbol('session down');
type Item = Uint8Array | typeof EOF | typeof ROLLOVER | typeof SESSION_DOWN;

type Output = { kind: 'event'; event: TranscribeEvent } | { kind: 'failure'; error: unknown } | { kind: 'end' };

/** Internal: the consumer stopped iterating. */
class Stopped extends Error {}

class Transcriber {
  readonly #options: ResolvedStreamOptions;
  readonly #source: AudioSource;
  readonly #sampleRate: number;
  readonly #language: Language | undefined;
  readonly #terminology: StreamTerminology | null;
  readonly #encoding: string;
  readonly #waitForSlot: number | null;
  readonly #reconnect: ResolvedReconnectPolicy;
  readonly #realtime: boolean;
  readonly #userSignal: AbortSignal | undefined;
  readonly #plan: SegmentPlan;
  readonly #limiter: AttemptLimiter;
  readonly #bufferLimit: number;
  readonly #out = new AsyncQueue<Output>();
  readonly #changed = new Signal();
  readonly #abort = new AbortController();
  #session: SttSession | null = null;
  #forwarder: Promise<void> | null = null;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #sourceDone = false;
  #sourceError: { error: unknown } | null = null;
  #stopping = false;
  #failures = 0;
  #index = 0;
  #audioSeconds = 0;
  #paceStart: number | null = null;

  constructor(options: ResolvedStreamOptions, source: AudioSource, init: TranscribeStreamOptions) {
    const encoding = init.encoding ?? 'pcm_s16le';
    sttQuery(init.sampleRate, init.language, encoding); // validate before anything starts
    const segmentSeconds = init.segmentSeconds ?? 14;
    if (typeof segmentSeconds !== 'number' || !(segmentSeconds > 0)) throw new UsageError('segmentSeconds must be positive');
    this.#options = options;
    this.#source = source;
    this.#sampleRate = init.sampleRate;
    this.#language = init.language;
    this.#terminology = init.terminology ?? null;
    this.#encoding = encoding;
    this.#waitForSlot = init.waitForSlot ?? null;
    this.#reconnect = resolveReconnectPolicy(init.reconnect);
    this.#realtime = init.realtime ?? false;
    this.#userSignal = init.signal;
    this.#plan = new SegmentPlan(init.sampleRate, segmentSeconds);
    this.#limiter = new AttemptLimiter(options.maxConnectAttempts, options.connectWindow);
    this.#bufferLimit = Math.floor(init.sampleRate * BYTES_PER_SAMPLE * MAX_BUFFER_SECONDS);
  }

  async *run(): AsyncGenerator<TranscribeEvent, void, undefined> {
    const signal = this.#userSignal;
    if (signal?.aborted) throw abortReason(signal);
    const onAbort = (): void => this.#out.push({ kind: 'failure', error: abortReason(signal as AbortSignal) });
    signal?.addEventListener('abort', onAbort, { once: true });
    const driver = this.#drive();
    try {
      for (;;) {
        const item = await this.#out.next();
        if (item.kind === 'end') return;
        if (item.kind === 'failure') throw item.error;
        yield item.event;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#stopping = true;
      this.#abort.abort(new Stopped('transcribeStream stopped'));
      this.#notify();
      await this.#shutdown();
      await driver;
    }
  }

  #notify(): void {
    this.#changed.notify();
  }

  #emit(event: TranscribeEvent): void {
    this.#out.push({ kind: 'event', event });
  }

  #checkStopping(): void {
    if (this.#stopping) throw new Stopped('transcribeStream stopped');
  }

  async #drive(): Promise<void> {
    try {
      await this.#main();
      this.#out.push({ kind: 'end' });
    } catch (error) {
      this.#out.push(this.#stopping ? { kind: 'end' } : { kind: 'failure', error });
    }
  }

  async #main(): Promise<void> {
    void this.#readSource();
    this.#session = await this.#open(false);
    for (;;) {
      const item = await this.#nextItem();
      if (item === EOF) break;
      if (item === ROLLOVER) {
        await this.#rollover();
        continue;
      }
      if (item === SESSION_DOWN) {
        await this.#recover(this.#sessionError());
        continue;
      }
      for (const piece of this.#plan.split(item)) {
        await this.#deliver(piece);
        const delay = this.#pace(piece.data);
        if (delay > 10) await sleep(this.#options.clock, delay, this.#abort.signal);
      }
    }
    if (this.#plan.finish()) this.#options.logger.warn('dropped 1 trailing byte: audio must be whole 16-bit samples');
    await this.#finish();
  }

  // --- Source -----------------------------------------------------------------------------

  async #readSource(): Promise<void> {
    try {
      for await (const chunk of audioChunks(this.#source, this.#sampleRate)) {
        if (this.#stopping) break;
        await this.#push(chunk.slice()); // a copy: the caller may reuse its buffer
      }
    } catch (error) {
      this.#sourceError = { error };
    } finally {
      this.#sourceDone = true;
      this.#notify();
    }
  }

  async #push(chunk: Uint8Array): Promise<void> {
    while (this.#buffered >= this.#bufferLimit && !this.#stopping) await this.#changed.wait();
    this.#chunks.push(chunk);
    this.#buffered += chunk.length;
    this.#notify();
  }

  async #nextItem(): Promise<Item> {
    const { clock } = this.#options;
    for (;;) {
      this.#checkStopping();
      const session = this.#session as SttSession;
      const chunk = this.#chunks.shift();
      if (chunk !== undefined) {
        this.#buffered -= chunk.length;
        this.#notify();
        return chunk;
      }
      if (this.#sourceError !== null) throw this.#sourceError.error;
      if (this.#sourceDone) return EOF;
      if (session.closed) return SESSION_DOWN;
      const deadline = this.#rolloverAt(session);
      if (deadline !== null && clock.now() >= deadline) return ROLLOVER;
      await waitOrTimeout(this.#changed, clock, deadline === null ? null : Math.max(0, deadline - clock.now()) + 1);
    }
  }

  #rolloverAt(session: SttSession): number | null {
    const started = session.startedAt;
    const max = session.maxSessionSeconds;
    if (started === null || max === null) return null;
    return started + Math.max(0, max * 1000 - this.#options.rolloverMargin);
  }

  /** Milliseconds to wait so audio goes out no faster than real time (`realtime: true`). */
  #pace(piece: Uint8Array): number {
    if (!this.#realtime) return 0;
    const now = this.#options.clock.now();
    this.#paceStart ??= now;
    this.#audioSeconds += piece.length / (this.#sampleRate * BYTES_PER_SAMPLE);
    return Math.max(0, this.#audioSeconds * 1000 - (now - this.#paceStart));
  }

  // --- Sessions ---------------------------------------------------------------------------

  #sessionError(): unknown {
    const session = this.#session as SttSession;
    if (session.failure !== null) return session.failure;
    return new SessionEndedError(`the Speech to Text session ended (${session.summary?.reason ?? 'closed'})`);
  }

  async #deliver(piece: Piece): Promise<void> {
    this.#plan.delivered(piece.data);
    let data = piece.data;
    for (;;) {
      const session = this.#session as SttSession;
      try {
        if (data.length > 0) await session.sendAudio(data);
        if (piece.cut) this.#plan.cut(await session.endSegment());
        return;
      } catch (error) {
        if (!(error instanceof EchoNovaError)) throw error;
        await this.#recover(error);
        data = new Uint8Array(0); // the replay after the reconnect included it
      }
    }
  }

  async #open(afterAbnormal: boolean): Promise<SttSession> {
    this.#checkStopping();
    const session = new SttSession(
      this.#options,
      {
        sampleRate: this.#sampleRate,
        language: this.#language,
        terminology: this.#terminology,
        encoding: this.#encoding,
        waitForSlot: this.#waitForSlot,
      },
      { limiter: this.#limiter },
    );
    await session._start({ afterAbnormal, signal: this.#abort.signal });
    this.#plan.newSession();
    this.#forwarder = this.#forward(session);
    return session;
  }

  async #forward(session: SttSession): Promise<void> {
    try {
      for await (const event of session) {
        const forwarded = this.#forwardEvent(event);
        if (forwarded !== null) this.#emit(forwarded);
      }
    } catch {
      // the driver sees the failure when it next sends, and decides
    } finally {
      this.#notify();
    }
  }

  #forwardEvent(event: SttEvent): TranscribeEvent | null {
    switch (event.type) {
      case 'transcript':
        this.#plan.result();
        this.#failures = 0;
        return Object.freeze({ ...event, index: this.#index++ });
      case 'error':
        if (event.code === 'upstream_error') this.#plan.result(); // this segment failed; the session goes on
        return event;
      case 'session.saved':
      case 'unknown':
        return event;
      default:
        return null;
    }
  }

  async #joinForwarder(): Promise<void> {
    const forwarder = this.#forwarder;
    this.#forwarder = null;
    if (forwarder !== null) await forwarder;
  }

  /** Close the current session and wait until all of its events have been passed on. */
  async #endSession(): Promise<void> {
    const session = this.#session;
    if (session !== null && !session.closed) await session.close();
    await this.#joinForwarder();
    const dropped = this.#plan.takeDropped();
    if (dropped.length > 0) this.#emit(audioDropped(dropped));
  }

  async #recover(error: unknown): Promise<void> {
    const { clock, logger } = this.#options;
    for (;;) {
      this.#checkStopping();
      const decision = reconnectReason(error, this.#session?.summary?.reason ?? null);
      if (decision === null) throw error;
      const [reason, counted, abnormal] = decision;
      await this.#endSession();
      if (counted) {
        this.#failures += 1;
        if (this.#failures > this.#reconnect.maxAttempts) throw error;
        await sleep(clock, reconnectDelay(this.#reconnect, this.#failures), this.#abort.signal);
      }
      logger.info(`Speech to Text stream reconnecting (${reason})`);
      const session = await this.#open(abnormal);
      this.#session = session;
      this.#emit(reconnected(reason, session.sessionId, this.#failures));
      const replay = this.#plan.replay();
      try {
        if (replay.length > 0) await session.sendAudio(replay);
        return;
      } catch (next) {
        if (!(next instanceof EchoNovaError)) throw next;
        error = next;
      }
    }
  }

  async #rollover(): Promise<void> {
    const session = this.#session as SttSession;
    try {
      if (this.#plan.uncutBytes > 0) this.#plan.cut(await session.endSegment());
      await session.stop();
    } catch (error) {
      if (!(error instanceof EchoNovaError)) throw error;
      await this.#recover(error);
      return;
    }
    await this.#endSession();
    const next = await this.#open(false);
    this.#session = next;
    this.#emit(reconnected('rollover', next.sessionId, 0));
  }

  async #finish(): Promise<void> {
    for (;;) {
      const session = this.#session as SttSession;
      try {
        const summary = await session.stop();
        if (summary.reason === 'max_duration' && this.#plan.uncutBytes > 0) {
          await this.#joinForwarder(); // every result of this session has been counted
          if (!this.#plan.tailAnswered) {
            // the session hit its time limit while stopping and the last segment got no result: resend it
            throw new SessionEndedError('the Speech to Text session ended (max_duration) before its last segment');
          }
        }
        break;
      } catch (error) {
        if (!(error instanceof EchoNovaError)) throw error;
        await this.#recover(error);
      }
    }
    await this.#endSession();
  }

  async #shutdown(): Promise<void> {
    const session = this.#session;
    if (session !== null && !session.closed) {
      try {
        await session.close();
      } catch {
        // already failing
      }
    }
    await this.#forwarder;
  }
}

function reconnected(reason: string, sessionId: string | null, attempt: number): Reconnected {
  return Object.freeze({ type: 'reconnected', reason, sessionId, attempt });
}

function audioDropped(marks: SegmentMark[]): AudioDropped {
  return Object.freeze({
    type: 'audio.dropped',
    segmentMarks: Object.freeze([...marks]),
    seconds: marks.reduce((total, mark) => total + mark.durationSeconds, 0),
  });
}

/**
 * Transcribe `source` (PCM16LE mono chunks, or a whole buffer) and yield events
 * as they arrive: `Transcript`, plus `StreamErrorEvent` (one segment failed),
 * `SessionSaved` (each session's job), `Reconnected` and `AudioDropped`.
 * Arguments are checked now; nothing connects until iteration starts.
 */
export function transcribeStream(
  options: StreamOptions | ResolvedStreamOptions,
  source: AudioSource,
  init: TranscribeStreamOptions,
): AsyncGenerator<TranscribeEvent, void, undefined> {
  return new Transcriber(resolveStreamOptions(options), source, init).run();
}
