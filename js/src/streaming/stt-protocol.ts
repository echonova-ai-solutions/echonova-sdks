/**
 * Speech to Text stream protocol (sans-IO).
 *
 * `SttProtocol` tracks one session: frames to send, events received, and how
 * the session ended. `SegmentPlan` is the bookkeeping `transcribeStream` needs
 * on top: where to cut segments, which audio is not yet cut (and so can be
 * replayed after a reconnect), and which cut segments are still waiting for a
 * result.
 */

import {
  APIStatusError,
  InsufficientBalanceError,
  SessionEndedError,
  SpendingLimitError,
  StreamClosedError,
  UpstreamError,
  type EchoNovaError,
} from '../errors.js';
import { concatBytes, type BytesLike } from './audio.js';
import { encodeJson } from './link-rules.js';
import { BYTES_PER_SAMPLE, PcmFramer } from './pcm-framer.js';
import { CloseInfo, closeError, errorFromFrame } from './stream-errors.js';
import {
  unknownEvent,
  type RawEvent,
  type SegmentMark,
  type SessionEnded,
  type SessionSaved,
  type SessionSummary,
  type SttEvent,
  type TerminologySet,
  type StreamTerminology,
} from './types.js';

export type SttState = 'await_started' | 'open' | 'stopping' | 'ended' | 'closed' | 'failed';

/** The SDK expects no transcript for shorter segments. */
export const MIN_RESULT_SECONDS = 0.05;

const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const obj = (value: unknown): RawEvent | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RawEvent) : null;

export class SttProtocol {
  readonly sampleRate: number;
  readonly framer: PcmFramer;
  state: SttState = 'await_started';
  readonly events: SttEvent[] = [];
  started = false;
  startedAt: number | null = null;
  sessionId: string | null = null;
  jobId: string | null = null;
  language: string | null = null;
  serverSampleRate: number | null = null;
  /** Seconds from `session.started` until the server ends the session. */
  maxSessionSeconds: number | null = null;
  ended: SessionEnded | null = null;
  saved: SessionSaved | null = null;
  fatal: EchoNovaError | null = null;
  closed = false;
  closeInfo: CloseInfo | null = null;
  stopRequested = false;
  transcripts = 0;
  terminologyWaiting = false;
  terminologyReply: TerminologySet | EchoNovaError | null = null;
  #lastError: RawEvent | null = null;
  #segmentIndex = 0;
  #segmentStart = 0;

  constructor(sampleRate: number, options: { frameMs?: number | undefined } = {}) {
    this.sampleRate = sampleRate;
    this.framer = new PcmFramer(sampleRate, { frameMs: options.frameMs ?? 100 });
  }

  // --- Outbound ---------------------------------------------------------------------------

  checkSendable(): void {
    if (this.fatal !== null) throw this.fatal;
    if (this.closed || this.ended !== null) {
      const reason = this.ended !== null ? ` (${this.ended.reason})` : '';
      throw new SessionEndedError(`the Speech to Text session has ended${reason}`);
    }
    if (this.stopRequested) throw new SessionEndedError('stop() was called; this session takes no more audio');
  }

  /** Frames ready to send for this audio (about 100 ms each, even-length, at most 64 KiB). */
  pushAudio(data: BytesLike): Uint8Array[] {
    this.checkSendable();
    return this.framer.push(data);
  }

  /** End the current segment: the frames to flush first, and where the cut falls. */
  cut(): { frames: Uint8Array[]; mark: SegmentMark } {
    this.checkSendable();
    const frames = this.framer.flush();
    const segmentBytes = this.framer.bytesEmitted - this.#segmentStart;
    const mark: SegmentMark = Object.freeze({
      index: this.#segmentIndex,
      audioOffsetSeconds: this.framer.secondsEmitted,
      durationSeconds: segmentBytes / (this.sampleRate * BYTES_PER_SAMPLE),
      expectResult: segmentBytes >= this.minResultBytes,
    });
    this.#segmentStart = this.framer.bytesEmitted;
    this.#segmentIndex += 1;
    return { frames, mark };
  }

  get minResultBytes(): number {
    return Math.floor(this.sampleRate * MIN_RESULT_SECONDS) * BYTES_PER_SAMPLE;
  }

  /** The last frames before `stop`, and how many odd trailing bytes were dropped. */
  beginStop(): { frames: Uint8Array[]; dropped: number } {
    this.checkSendable();
    const result = this.framer.finish();
    this.stopRequested = true;
    if (this.state === 'open') this.state = 'stopping';
    return result;
  }

  beginTerminology(terminology: StreamTerminology | null): string {
    this.checkSendable();
    const text = encodeJson({ type: 'terminology', terminology: terminology ? { ...terminology } : null });
    this.terminologyWaiting = true;
    this.terminologyReply = null;
    return text;
  }

  // --- Inbound ----------------------------------------------------------------------------

  receiveEvent(event: RawEvent, now: number): void {
    switch (event['type']) {
      case 'session.started': {
        if (this.started) return;
        this.started = true;
        this.startedAt = now;
        this.sessionId = str(event['sessionId']);
        this.jobId = str(event['jobId']);
        this.language = str(event['language']);
        const rate = event['sampleRate'];
        this.serverSampleRate = typeof rate === 'number' && Number.isInteger(rate) ? rate : null;
        const limit = num(event['maxSessionSeconds'], -1);
        this.maxSessionSeconds = limit > 0 ? limit : null;
        if (this.state === 'await_started') this.state = this.stopRequested ? 'stopping' : 'open';
        return;
      }
      case 'transcript':
        this.events.push(
          Object.freeze({
            type: 'transcript',
            segmentId: str(event['segmentId']) ?? '',
            text: str(event['text']) ?? '',
            durationSeconds: num(event['durationSeconds']),
            creditsConsumed: num(event['creditsConsumed']),
            index: this.transcripts,
            terminology: obj(event['terminology']),
            language: str(event['language']),
            sessionId: this.sessionId,
            raw: event,
          }),
        );
        this.transcripts += 1;
        return;
      case 'terminology.set': {
        const reply: TerminologySet = Object.freeze({ type: 'terminology.set', active: Boolean(event['active']), raw: event });
        this.events.push(reply);
        if (this.terminologyWaiting) {
          this.terminologyWaiting = false;
          this.terminologyReply = reply;
        }
        return;
      }
      case 'session.ended': {
        const ended: SessionEnded = Object.freeze({
          type: 'session.ended',
          reason: str(event['reason']) || 'unknown',
          totalSeconds: num(event['totalSeconds']),
          creditsConsumed: num(event['creditsConsumed']),
          raw: event,
        });
        this.ended = ended;
        this.events.push(ended);
        this.state = 'ended';
        return;
      }
      case 'session.saved': {
        const jobId = str(event['jobId']);
        if (jobId) this.jobId = jobId;
        const saved: SessionSaved = Object.freeze({
          type: 'session.saved',
          jobId: jobId ?? this.jobId,
          status: str(event['status']) ?? 'unknown',
          sessionId: this.sessionId,
          raw: event,
        });
        this.saved = saved;
        this.events.push(saved);
        return;
      }
      case 'error': {
        const error = errorFromFrame(event, { sessionId: this.sessionId });
        this.#lastError = event;
        if (event['code'] === 'validation_failed' && this.terminologyWaiting) {
          this.terminologyWaiting = false;
          this.terminologyReply = error;
          return;
        }
        this.events.push(
          Object.freeze({ type: 'error', code: str(event['code']) ?? '', message: str(event['message']) ?? '', error, raw: event }),
        );
        return;
      }
      case 'pong':
        return;
      default:
        this.events.push(unknownEvent(event));
    }
  }

  connectionClosed(info: CloseInfo): void {
    this.closed = true;
    this.closeInfo = info;
    let error = closeError(info, {
      endedNormally: this.ended !== null,
      lastError: this.#lastError,
      sessionId: this.sessionId,
      mayHaveExecuted: null,
    });
    if (error === null && !this.started && !info.local) error = this.#startFailure(info);
    if (error !== null) {
      this.fatal = error;
      this.state = 'failed';
    } else {
      this.state = 'closed';
    }
    if (this.terminologyWaiting) {
      this.terminologyWaiting = false;
      this.terminologyReply = error ?? new SessionEndedError('the session closed before terminology was set');
    }
  }

  /** The session ended before `session.started`. */
  #startFailure(info: CloseInfo): EchoNovaError {
    const reason = this.ended?.reason ?? null;
    const last = this.#lastError ?? {};
    const message = str(last['message']);
    const code = str(last['code']);
    const classes: Readonly<Record<string, typeof APIStatusError>> = {
      upstream_error: UpstreamError,
      insufficient_balance: InsufficientBalanceError,
      spending_limit: SpendingLimitError,
    };
    const key = reason ?? code ?? '';
    const ErrorClass = Object.hasOwn(classes, key) ? classes[key] : undefined;
    if (ErrorClass !== undefined) {
      return new ErrorClass({
        errorMessage: message ?? `the session ended before it started (${reason})`,
        errorCode: code ?? reason,
        closeCode: info.code,
        transport: 'websocket',
      });
    }
    return new StreamClosedError(`the Speech to Text session ended before it started (${reason ?? info.code})`, {
      closeCode: info.code,
      reason: info.reason || null,
    });
  }

  summary(): SessionSummary | null {
    if (this.ended === null) return null;
    return Object.freeze({
      reason: this.ended.reason,
      totalSeconds: this.ended.totalSeconds,
      creditsConsumed: this.ended.creditsConsumed,
      sessionId: this.sessionId,
      jobId: this.jobId,
      savedStatus: this.saved?.status ?? null,
    });
  }
}

// --- transcribeStream bookkeeping ---------------------------------------------------------

export interface Piece {
  readonly data: Uint8Array;
  /** End the segment after this piece. */
  readonly cut: boolean;
}

/**
 * Cuts every `segmentSeconds` of audio and tracks what a reconnect must replay.
 *
 * Audio is kept sample-aligned: an odd trailing byte waits for the next chunk.
 * Offsets in the marks it returns count audio from the start of the stream,
 * across sessions.
 */
export class SegmentPlan {
  readonly sampleRate: number;
  readonly segmentBytes: number;
  /** Cut, waiting for a result. */
  readonly pending: SegmentMark[] = [];
  tailAnswered = false;
  #uncut: Uint8Array[] = []; // sent (or being sent) since the last cut
  #uncutBytes = 0;
  #carry: Uint8Array = new Uint8Array(0);
  #fill = 0; // planned bytes in the current segment
  #cutOffset = 0; // stream offset (bytes) of the last cut
  #cuts = 0;

  constructor(sampleRate: number, segmentSeconds: number) {
    if (!(segmentSeconds > 0)) throw new RangeError('segmentSeconds must be positive');
    this.sampleRate = sampleRate;
    this.segmentBytes = Math.max(BYTES_PER_SAMPLE, Math.floor(sampleRate * segmentSeconds) * BYTES_PER_SAMPLE);
  }

  get uncutBytes(): number {
    return this.#uncutBytes;
  }

  split(chunk: Uint8Array): Piece[] {
    let data = this.#carry.length > 0 ? concatBytes([this.#carry, chunk]) : chunk;
    if (data.length % 2) {
      this.#carry = data.slice(data.length - 1);
      data = data.subarray(0, data.length - 1);
    } else {
      this.#carry = new Uint8Array(0);
    }
    const pieces: Piece[] = [];
    let offset = 0;
    while (offset < data.length) {
      const room = this.segmentBytes - this.#fill;
      const piece = data.subarray(offset, offset + room);
      offset += piece.length;
      this.#fill += piece.length;
      const cut = this.#fill >= this.segmentBytes;
      if (cut) this.#fill = 0;
      pieces.push({ data: piece, cut });
    }
    return pieces;
  }

  delivered(data: Uint8Array): void {
    if (data.length === 0) return;
    this.#uncut.push(data.slice());
    this.#uncutBytes += data.length;
  }

  /** Record a cut (after the uncut audio was sent). Returns the mark in stream terms. */
  cut(sessionMark: SegmentMark): SegmentMark {
    const bytesPerSecond = this.sampleRate * BYTES_PER_SAMPLE;
    const end = this.#cutOffset + this.#uncutBytes;
    const mark: SegmentMark = Object.freeze({
      index: this.#cuts,
      audioOffsetSeconds: end / bytesPerSecond,
      durationSeconds: this.#uncutBytes / bytesPerSecond,
      expectResult: sessionMark.expectResult,
    });
    this.#cuts += 1;
    this.#cutOffset = end;
    this.#uncut = [];
    this.#uncutBytes = 0;
    this.#fill = 0;
    if (mark.expectResult) this.pending.push(mark);
    return mark;
  }

  /** A transcript (or a per-segment error) arrived: it answers the oldest pending cut. */
  result(): void {
    if (this.pending.length > 0) this.pending.shift();
    else this.tailAnswered = true; // a result for audio this plan never cut (the final segment)
  }

  newSession(): void {
    this.tailAnswered = false;
  }

  takeDropped(): SegmentMark[] {
    return this.pending.splice(0);
  }

  replay(): Uint8Array {
    return concatBytes(this.#uncut);
  }

  /** End of the source: how many odd trailing bytes were dropped (0 or 1). */
  finish(): number {
    const dropped = this.#carry.length;
    this.#carry = new Uint8Array(0);
    return dropped;
  }
}
