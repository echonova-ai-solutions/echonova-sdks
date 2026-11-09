/**
 * Public data types for the Text to Speech and Speech to Text streams.
 *
 * Events are plain, frozen objects with a `type` discriminant, so a `switch`
 * on `event.type` narrows them. Durations of audio are in seconds (like the
 * API's `durationSeconds`); latencies and timeouts are in milliseconds.
 */

import type { APIStatusError } from '../errors.js';

// `Symbol.asyncDispose` (explicit resource management) is in TypeScript's `esnext.disposable`
// lib, which this package doesn't require. Declared the same way as `@types/node` does, so it
// merges with either.
declare global {
  interface SymbolConstructor {
    readonly asyncDispose: unique symbol;
  }
}

/** A JSON object received from the server, exactly as sent. */
export type RawEvent = Readonly<Record<string, unknown>>;

// --- Text to Speech -------------------------------------------------------------------------

/**
 * Where a synthesis is:
 * - `queued`: not sent yet (waiting in the client queue or for a connection);
 * - `sent`: sent, no `start` yet;
 * - `streaming`: `start` arrived and audio is flowing;
 * - `cancelling`: a cancel (or a newer synthesis) was requested; waiting for the server to stop;
 * - `completed`, `cancelled`, `superseded`, `failed`, `lost` (the connection dropped while it was in flight).
 */
export type SynthesisState =
  | 'queued'
  | 'sent'
  | 'streaming'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'superseded'
  | 'failed'
  | 'lost';

/** How a synthesis ended without an error. Cancellations the caller asked for are outcomes, not errors. */
export type SynthesisOutcome = 'completed' | 'cancelled' | 'superseded';

/**
 * The SDK's conservative estimate of whether a synthesis was charged:
 * `yes` once `start` or audio arrived (or the server reported a cost), `unknown`
 * when it was sent but neither arrived (it may have started, so it may have been
 * charged), `no` when it was never sent, or was rejected or failed before any audio.
 * A synthesis in the `unknown` state is never resent automatically.
 */
export type ChargeState = 'yes' | 'no' | 'unknown';

/** Timings for one synthesis. Times are in milliseconds from sending the request, `null` until known. */
export interface SynthesisMetrics {
  /** Time to the first audio frame. */
  readonly ttfb: number | null;
  /** Time to `start`. */
  readonly timeToStart: number | null;
  /** Time to the final state. */
  readonly total: number | null;
  readonly audioBytes: number;
  readonly frames: number;
  /** Frames that arrived after a cancel was requested, and were discarded. */
  readonly droppedFrames: number;
}

/**
 * How a synthesis ended.
 *
 * `charged` is `true` when the server reported a cost (`creditsConsumed` on
 * `done`, `cancelled` or `error`), `false` when it reported none (a `cancelled`
 * without `creditsConsumed`: cancelled before it was charged), and `null` when the
 * SDK resolved the synthesis itself (a cancel the server never confirmed, a newer
 * `start` without `cancelled`, or the session closing).
 */
export interface SynthesisResult {
  readonly requestId: string;
  readonly outcome: SynthesisOutcome;
  readonly charged: boolean | null;
  /** Seconds of audio sent (from `done`). */
  readonly durationSeconds: number | null;
  /** Characters charged (from `done`). */
  readonly characters: number | null;
  /** Credits this synthesis finally cost, when the server reported it. */
  readonly creditsConsumed: number | null;
  /** Sample rate of the audio, from `start`. */
  readonly sampleRate: number | null;
  /** The `done` or `cancelled` event that ended it. */
  readonly raw: RawEvent | null;
}

/** Options for one synthesis. Only the options that are set are sent: the server rejects unknown fields. */
export interface SynthesisOptions {
  /** Overrides the session's voice for this synthesis. */
  voiceId?: string | undefined;
  /** 0.5 to 2. */
  speed?: number | undefined;
  /** 1 to 5. */
  cfg?: number | undefined;
  /** 16, 32, 48, 64 or 128. */
  numSteps?: number | undefined;
  tashkeel?: boolean | undefined;
  normalize?: boolean | undefined;
  /** Extra fields for the `synthesize` frame, for options newer than this SDK. */
  extraBody?: Readonly<Record<string, unknown>> | undefined;
}

// --- Speech to Text -------------------------------------------------------------------------

/** Where `endSegment()` cut the audio. Seconds count the audio sent in this session (or stream). */
export interface SegmentMark {
  readonly index: number;
  /** End of the segment. */
  readonly audioOffsetSeconds: number;
  readonly durationSeconds: number;
  /** `false` for an empty or very short (< 50 ms) segment, which gets no transcript. */
  readonly expectResult: boolean;
}

/** `saved`: the session is a Speech to Text job; `empty`: nothing was transcribed; `failed`: it could not be kept. */
export type SessionSavedStatus = 'saved' | 'empty' | 'failed' | (string & {});

/** Totals from `session.ended`, and what `session.saved` reported (when it arrived). */
export interface SessionSummary {
  readonly reason: string;
  readonly totalSeconds: number;
  readonly creditsConsumed: number;
  readonly sessionId: string | null;
  /** The job this session is saved as (`GET /v1/speech-to-text/jobs/{jobId}` once saved). */
  readonly jobId: string | null;
  /** From `session.saved`, or `null` when the server closed without sending it. */
  readonly savedStatus: SessionSavedStatus | null;
}

/**
 * The final transcript of one segment. `text` is passed through unchanged: it
 * can be empty or carry surrounding whitespace. `index` counts transcripts in
 * arrival order, from 0.
 */
export interface Transcript {
  readonly type: 'transcript';
  readonly segmentId: string;
  readonly text: string;
  readonly durationSeconds: number;
  readonly creditsConsumed: number;
  readonly index: number;
  /** The segment corrected to your terms, while terms are set. */
  readonly terminology: RawEvent | null;
  readonly language: string | null;
  readonly sessionId: string | null;
  readonly raw: RawEvent;
}

/** The server accepted a terminology frame. `active` is `false` when the terms were cleared. */
export interface TerminologySet {
  readonly type: 'terminology.set';
  readonly active: boolean;
  readonly raw: RawEvent;
}

/** A non-fatal error on the stream, such as one segment failing. The session continues. */
export interface StreamErrorEvent {
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
  readonly error: APIStatusError;
  readonly raw: RawEvent;
}

/** The server ended the session. */
export interface SessionEnded {
  readonly type: 'session.ended';
  readonly reason: string;
  readonly totalSeconds: number;
  readonly creditsConsumed: number;
  readonly raw: RawEvent;
}

/** Sent after `session.ended`, usually: whether the session was kept as a Speech to Text job. */
export interface SessionSaved {
  readonly type: 'session.saved';
  readonly jobId: string | null;
  readonly status: SessionSavedStatus;
  readonly sessionId: string | null;
  readonly raw: RawEvent;
}

/** An event type this SDK version doesn't know. Kept so nothing is silently lost. */
export interface UnknownStreamEvent {
  readonly type: 'unknown';
  /** The event's own `type`, when it had one. */
  readonly eventType: string | null;
  readonly raw: RawEvent;
}

/**
 * `transcribeStream` opened a new session. `reason` is `rollover` for a planned
 * handover before the session's time limit, or why the previous connection ended
 * (`connection_lost`, `server_restarting`, `upstream_error`, `session_expired`,
 * `max_duration` or `idle_timeout`).
 */
export interface Reconnected {
  readonly type: 'reconnected';
  readonly reason: string;
  readonly sessionId: string | null;
  /** Reconnects in a row without a transcript in between (0 for a rollover). */
  readonly attempt: number;
}

/** Segments that were cut but got no result before the connection dropped. Not transcribed, not charged. */
export interface AudioDropped {
  readonly type: 'audio.dropped';
  readonly segmentMarks: readonly SegmentMark[];
  readonly seconds: number;
}

export type SttEvent = Transcript | TerminologySet | StreamErrorEvent | SessionEnded | SessionSaved | UnknownStreamEvent;

export type TranscribeEvent =
  | Transcript
  | StreamErrorEvent
  | SessionSaved
  | Reconnected
  | AudioDropped
  | UnknownStreamEvent;

/**
 * Terms for a Speech to Text stream: `{ keywords: [...], options?: {...} }`. Each
 * keyword is a term string or `{term, variants, blocked, context_words, needs_context}`.
 * The REST `Terminology` type is accepted as is.
 */
export interface StreamTerminology {
  readonly keywords: readonly unknown[];
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

export function unknownEvent(raw: RawEvent): UnknownStreamEvent {
  const kind = raw['type'];
  return Object.freeze({ type: 'unknown', eventType: typeof kind === 'string' ? kind : null, raw });
}
