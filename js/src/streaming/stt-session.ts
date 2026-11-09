/**
 * Speech to Text stream sessions.
 *
 * A session never reconnects on its own: a new connection is a new session with
 * a new `sessionId`. `transcribeStream` builds reconnects on top.
 *
 * ```ts
 * await using stt = await connectStt(options, { sampleRate: 16000, language: 'ar' });
 * const feeding = stt.feedFrom(micStream);
 * for await (const ev of stt) if (ev.type === 'transcript') console.log(ev.text);
 * console.log((await feeding).creditsConsumed);
 * ```
 */

import { APITimeoutError, SessionEndedError, StreamClosedError, UsageError, type EchoNovaError, type TimeoutKind } from '../errors.js';
import { abortReason } from '../runtime/ws-transport.js';
import { asBytes, iterFrames, type BytesLike } from './audio.js';
import { Mutex, Signal, handled, raceTimeout, waitOrTimeout } from './async-utils.js';
import { AttemptLimiter, decodeEvent } from './link-rules.js';
import { Link, LinkClosed, openLink } from './link.js';
import { STT_PATH, resolveStreamOptions, type ResolvedStreamOptions, type StreamOptions } from './options.js';
import type { CloseInfo } from './stream-errors.js';
import { SttProtocol, type SttState } from './stt-protocol.js';
import type { SegmentMark, SessionSummary, SttEvent, TerminologySet, StreamTerminology, Transcript } from './types.js';

const END_SEGMENT_FRAME = '{"type":"end_segment"}';
const STOP_FRAME = '{"type":"stop"}';
export const DEFAULT_STOP_TIMEOUT = 20_000;

/** Audio to send: a whole buffer, or chunks from a (async) iterable or a web `ReadableStream`. */
export type AudioSource =
  | BytesLike
  | Iterable<BytesLike>
  | AsyncIterable<BytesLike>
  | ReadableStream<BytesLike>;

export interface SttSessionInit {
  /** Sample rate of the audio you send, in Hz (8000 to 48000). Required: a mismatch gives wrong transcripts silently. */
  sampleRate: number;
  /** `ar` (Arabic and mixed Arabic/English) or `en` (wholly English speech). */
  language: string;
  terminology?: StreamTerminology | null | undefined;
  encoding?: string | undefined;
  /** Keep retrying "Too many concurrent streams" for up to this many ms. */
  waitForSlot?: number | null | undefined;
}

export function sttQuery(sampleRate: unknown, language: unknown, encoding: unknown): Record<string, string | number> {
  if (typeof sampleRate !== 'number' || !Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new UsageError('sampleRate must be a positive whole number (the Hz of the audio you send)');
  }
  if (typeof language !== 'string' || language.trim() === '') throw new UsageError('language is required (ar or en)');
  if (typeof encoding !== 'string' || encoding === '') throw new UsageError('encoding must be a string');
  return { sample_rate: sampleRate, language, encoding };
}

/** @internal Options `transcribeStream` passes to the sessions it opens. */
export interface SttSessionInternals {
  limiter?: AttemptLimiter | undefined;
}

/**
 * A Speech to Text stream. Create it with `connectStt()`.
 *
 * Send audio with `sendAudio()` (or `feedFrom()`), and iterate the session for
 * events. If the session ends abnormally, iteration yields every event already
 * received and then throws.
 */
export class SttSession implements AsyncIterable<SttEvent> {
  readonly #options: ResolvedStreamOptions;
  readonly #query: Record<string, string | number>;
  readonly #terminology: StreamTerminology | null;
  readonly #waitForSlot: number | null;
  readonly #limiter: AttemptLimiter;
  readonly #protocol: SttProtocol;
  readonly #changed = new Signal();
  readonly #outLock = new Mutex();
  readonly #terminologyLock = new Mutex();
  #link: Link | null = null;
  #readers = 0;
  /** The `X-Request-Id` of the handshake. Quote it when contacting support. */
  handshakeRequestId: string | null = null;

  /** @internal Use `connectStt()`. */
  constructor(options: StreamOptions | ResolvedStreamOptions, init: SttSessionInit, internals: SttSessionInternals = {}) {
    this.#options = resolveStreamOptions(options);
    this.#query = sttQuery(init.sampleRate, init.language, init.encoding ?? 'pcm_s16le');
    this.#terminology = init.terminology ?? null;
    this.#waitForSlot = init.waitForSlot ?? null;
    this.#limiter =
      internals.limiter ?? new AttemptLimiter(this.#options.maxConnectAttempts, this.#options.connectWindow);
    this.#protocol = new SttProtocol(init.sampleRate);
  }

  /** @internal Connect, and wait for `session.started` (and `terminology.set`). */
  async _start(options: { afterAbnormal?: boolean; signal?: AbortSignal | undefined } = {}): Promise<this> {
    const link = await openLink(this.#options, STT_PATH, this.#query, {
      limiter: this.#limiter,
      waitForSlot: this.#waitForSlot,
      afterAbnormal: options.afterAbnormal ?? false,
      signal: options.signal,
    });
    this.#link = link;
    this.handshakeRequestId = link.handshakeRequestId;
    link.attach({
      onText: (text) => this.#onText(text),
      onBinary: () => {},
      onClosed: (info) => this.#onClosed(info),
    });
    const protocol = this.#protocol;
    try {
      await this.#waitUntil(() => protocol.started || protocol.closed, this.#options.sessionStartTimeout, 'session_start', options.signal);
      if (!protocol.started) throw this.#startError();
      if (this.#terminology !== null) await this.setTerminology(this.#terminology, options.signal);
    } catch (error) {
      await link.close();
      throw error;
    }
    return this;
  }

  // --- State ------------------------------------------------------------------------------

  get sessionId(): string | null {
    return this.#protocol.sessionId;
  }

  /** The id this session's job gets once it is saved (from `session.started`, or `session.saved`). */
  get jobId(): string | null {
    return this.#protocol.jobId;
  }

  get language(): string | null {
    return this.#protocol.language;
  }

  get sampleRate(): number {
    return this.#protocol.sampleRate;
  }

  /** Seconds from `session.started` until the server ends the session. */
  get maxSessionSeconds(): number | null {
    return this.#protocol.maxSessionSeconds;
  }

  /** When `session.started` arrived, on the session clock (ms). */
  get startedAt(): number | null {
    return this.#protocol.startedAt;
  }

  get state(): SttState {
    return this.#protocol.state;
  }

  get closed(): boolean {
    return this.#protocol.closed;
  }

  /** The error that ended the session, if it ended abnormally. */
  get failure(): EchoNovaError | null {
    return this.#protocol.fatal;
  }

  /** Totals from `session.ended` (and `session.saved`), once they have arrived. */
  get summary(): SessionSummary | null {
    return this.#protocol.summary();
  }

  get audioSecondsSent(): number {
    return this.#protocol.framer.secondsEmitted;
  }

  // --- Sending ----------------------------------------------------------------------------

  /** Send PCM16LE mono audio. The input is copied. Waits while the socket's send buffer is full. */
  sendAudio(audio: BytesLike): Promise<void> {
    return this.#outLock.run(async () => {
      await this.#settle();
      for (const frame of this.#protocol.pushAudio(audio)) await this.#send(frame);
    });
  }

  /** Transcribe the audio sent since the last segment now (send it when the speaker pauses). */
  endSegment(): Promise<SegmentMark> {
    return this.#outLock.run(async () => {
      await this.#settle();
      const { frames, mark } = this.#protocol.cut();
      for (const frame of frames) await this.#send(frame);
      await this.#send(END_SEGMENT_FRAME);
      return mark;
    });
  }

  /** Set (or with `null`, clear) the terms for later segments. Waits for the server to confirm. */
  setTerminology(terminology: StreamTerminology | null, signal?: AbortSignal): Promise<TerminologySet> {
    return this.#terminologyLock.run(async () => {
      const protocol = this.#protocol;
      await this.#outLock.run(async () => {
        await this.#settle();
        await this.#send(protocol.beginTerminology(terminology));
      });
      await this.#waitUntil(() => !protocol.terminologyWaiting, this.#options.sessionStartTimeout, 'read', signal);
      const reply = protocol.terminologyReply;
      if (reply === null) throw new SessionEndedError('no reply to the terminology frame');
      if (reply instanceof Error) throw reply;
      return reply;
    });
  }

  /**
   * Finish: transcribe the remaining audio, and wait for the last transcripts,
   * `session.ended` and (when the server sends it) `session.saved`. The server
   * drains for up to 10 s; `timeoutMs` (default 20 s) bounds the wait.
   */
  async stop(options: { timeoutMs?: number | null | undefined; signal?: AbortSignal | undefined } = {}): Promise<SessionSummary> {
    const protocol = this.#protocol;
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_STOP_TIMEOUT : options.timeoutMs;
    if (!(protocol.closed || protocol.stopRequested || protocol.ended !== null || protocol.fatal !== null)) {
      await this.#outLock.run(async () => {
        const { frames, dropped } = protocol.beginStop();
        this.#warnTail(dropped);
        for (const frame of frames) await this.#send(frame);
        await this.#send(STOP_FRAME);
      });
    }
    try {
      await this.#waitUntil(() => protocol.closed, timeoutMs, 'stop_drain', options.signal);
    } catch (error) {
      this.#link?.abort(null);
      throw error;
    }
    if (protocol.fatal !== null) throw protocol.fatal;
    const summary = protocol.summary();
    if (summary === null) throw new SessionEndedError('the session closed without session.ended');
    return summary;
  }

  /** Close now, without `stop()`. Audio not yet transcribed is discarded. */
  async close(): Promise<void> {
    const protocol = this.#protocol;
    if (!protocol.closed && protocol.ended === null) {
      this.#options.logger.warn('closing a Speech to Text session without stop(); untranscribed audio is discarded');
    }
    await this.#link?.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Send audio from `source`, then `stop()`. Resolves with the summary. A whole
   * buffer is sent in 100 ms frames, as fast as the socket allows.
   */
  feedFrom(source: AudioSource, options: { signal?: AbortSignal | undefined } = {}): Promise<SessionSummary> {
    const run = async (): Promise<SessionSummary> => {
      for await (const chunk of audioChunks(source, this.sampleRate)) {
        if (options.signal?.aborted) throw abortReason(options.signal);
        await this.sendAudio(chunk);
      }
      return this.stop({ signal: options.signal });
    };
    // The same failure also ends event iteration; don't let an unawaited copy crash the process.
    return handled(run());
  }

  // --- Events -----------------------------------------------------------------------------

  [Symbol.asyncIterator](): AsyncIterator<SttEvent> {
    return this.#events();
  }

  async *#events(): AsyncGenerator<SttEvent, void, undefined> {
    const protocol = this.#protocol;
    this.#readers += 1;
    if (this.#readers > 1) this.#options.logger.warn('a Speech to Text session is being iterated from more than one place');
    try {
      for (;;) {
        const event = protocol.events.shift();
        if (event !== undefined) {
          yield event;
          continue;
        }
        if (protocol.closed) {
          if (protocol.fatal !== null) throw protocol.fatal; // after every buffered event (drain, then raise)
          return;
        }
        await this.#changed.wait();
      }
    } finally {
      this.#readers -= 1;
    }
  }

  /** Only the transcripts. */
  async *transcripts(): AsyncGenerator<Transcript, void, undefined> {
    for await (const event of this) if (event.type === 'transcript') yield event;
  }

  // --- Internals --------------------------------------------------------------------------

  #warnTail(dropped: number): void {
    if (dropped) this.#options.logger.warn(`dropped ${dropped} trailing byte at stop(): audio must be whole 16-bit samples`);
  }

  #startError(): EchoNovaError {
    return this.#protocol.fatal ?? new StreamClosedError('the Speech to Text session closed before it started');
  }

  /** After `session.ended`, wait for the close: it decides which error, if any, applies. */
  async #settle(): Promise<void> {
    const link = this.#link;
    if (this.#protocol.ended !== null && !this.#protocol.closed && link !== null) {
      await raceTimeout(link.done, this.#options.clock, this.#options.closeTimeout);
    }
  }

  async #waitUntil(predicate: () => boolean, timeout: number | null, kind: TimeoutKind, signal?: AbortSignal): Promise<void> {
    const { clock } = this.#options;
    const deadline = timeout === null ? null : clock.now() + timeout;
    const onAbort = (): void => this.#changed.notify();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (!predicate()) {
        if (signal?.aborted) throw abortReason(signal);
        const remaining = deadline === null ? null : deadline - clock.now();
        if (remaining !== null && remaining <= 0) {
          throw new APITimeoutError(`timed out after ${(timeout as number) / 1000} s (${kind})`, { kind, mayHaveExecuted: null });
        }
        await waitOrTimeout(this.#changed, clock, remaining);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #send(frame: string | Uint8Array): Promise<void> {
    const link = this.#link;
    if (link === null) throw new SessionEndedError('the session is not connected');
    try {
      await link.send(frame);
    } catch (error) {
      if (!(error instanceof LinkClosed)) throw error;
      await link.done;
      this.#protocol.checkSendable();
      throw new SessionEndedError('the session is closed');
    }
  }

  #onText(text: string): void {
    const event = decodeEvent(text);
    if (event['type'] === 'pong') {
      this.#link?.pong();
      return;
    }
    this.#protocol.receiveEvent(event, this.#options.clock.now());
    this.#changed.notify();
  }

  #onClosed(info: CloseInfo): void {
    this.#protocol.connectionClosed(info);
    this.#changed.notify();
  }

  toString(): string {
    return `SttSession(sessionId=${JSON.stringify(this.sessionId)}, state='${this.state}')`;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<BytesLike> {
  return typeof value === 'object' && value !== null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

function isReadableStream(value: unknown): value is ReadableStream<BytesLike> {
  return typeof value === 'object' && value !== null && typeof (value as ReadableStream).getReader === 'function';
}

function isBytes(value: unknown): value is BytesLike {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/** Chunks of an audio source. A whole buffer is split into 100 ms frames. */
export async function* audioChunks(source: AudioSource, sampleRate: number): AsyncGenerator<Uint8Array, void, undefined> {
  if (isBytes(source)) {
    yield* iterFrames(source, sampleRate);
  } else if (isAsyncIterable(source)) {
    for await (const chunk of source) yield asBytes(chunk);
  } else if (isReadableStream(source)) {
    // Some browsers' ReadableStream isn't async iterable yet.
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield asBytes(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else if (typeof (source as Iterable<BytesLike>)[Symbol.iterator] === 'function') {
    for (const chunk of source as Iterable<BytesLike>) yield asBytes(chunk);
  } else {
    throw new UsageError('the audio source must be bytes, an iterable or async iterable of bytes, or a ReadableStream');
  }
}
