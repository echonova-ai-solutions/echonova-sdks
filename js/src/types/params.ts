/**
 * Request parameters. Names are camelCase; the SDK sends each one under the
 * API's own name. Parameters you leave out are not sent, so the API's defaults apply.
 */

import type { HeaderValues } from '../core/http.js';
import type { Uploadable } from '../core/files.js';
import type { AgentChannel, Language } from './models.js';

/** Per-call overrides accepted by every API method (the last argument). */
export interface RequestOptions {
  /** Cancel the call. A POST cancelled after it was sent may still run. */
  signal?: AbortSignal | undefined;
  /** Milliseconds for one attempt. Defaults to a value per operation. */
  timeout?: number | undefined;
  /** Retries for failures that are safe to retry. */
  maxRetries?: number | undefined;
  /** Total milliseconds for the call, retries and rate-limit waits included. */
  deadline?: number | undefined;
  /** Extra headers for this call. A `null` value removes a header. */
  headers?: HeaderValues | undefined;
}

/**
 * Per-call options for the synchronous calls that make a job: `textToSpeech.generate`,
 * `speechToText.transcribe` and `soundCleaning.clean`.
 */
export interface SyncRequestOptions extends RequestOptions {
  /**
   * The `Idempotency-Key` to send. By default the SDK makes a new random key for
   * each call and sends it on every retry of that call. Pass your own to send the
   * same request again later, from any process: within 24 hours the API answers
   * with the first result and doesn't charge twice.
   */
  idempotencyKey?: string | undefined;
  /**
   * Milliseconds the SDK waits for a call that is still running: when the first request
   * with this key is still running (it sends it again every 5 s, then throws
   * `RequestInProgressError`), or when the job is still processing after 220 s (the API
   * answers `202`; the SDK polls the job, then throws `JobWaitTimeoutError` with its
   * `jobId`). One budget per call, from the first such answer, within any `deadline`.
   * Default 20 minutes, as for `jobs.wait()`.
   */
  waitTimeout?: number | undefined;
}

// --- Text to Speech -------------------------------------------------------------------------

export interface SpeechParams {
  text: string;
  voiceId: string;
  speed?: number | undefined;
  cfg?: number | undefined;
  /** 16, 32, 48, 64 or 128. */
  numSteps?: number | undefined;
  tashkeel?: boolean | undefined;
  normalize?: boolean | undefined;
}

export interface ListParams {
  /** How many jobs to skip. Default 0. */
  offset?: number | undefined;
  /** How many jobs per page: 1 to 100, default 20. */
  limit?: number | undefined;
}

// --- Speech to Text -------------------------------------------------------------------------

/**
 * One terminology entry with options, in the API's own field names. A plain
 * string is a keyword with no options. Terms are written exactly as typed.
 */
export interface Keyword {
  term: string;
  variants?: string[];
  blocked?: string[];
  context_words?: string[];
  needs_context?: boolean;
}

/** Terms the transcript should spell your way. Send the full list with every request. */
export interface Terminology {
  keywords: Array<string | Keyword>;
}

export interface TranscribeParams {
  /** The audio: a file path (Node.js, Bun, Deno), a `Blob`/`File`, bytes, a byte stream, or `toFile(...)`. */
  file: Uploadable;
  /**
   * `auto` (the API's default when left out) detects Arabic or English; `ar` for
   * Arabic and mixed Arabic/English; `en` only for wholly English speech.
   */
  language?: Language | undefined;
  numbersAsDigits?: boolean | undefined;
  identifySpeakers?: boolean | undefined;
  /** Your terms. The SDK sends them as the JSON string the API expects; a string is sent as is. */
  terminology?: Terminology | string | undefined;
}

export type ExportFormat = 'txt' | 'srt' | 'json';

export interface ExportParams<F extends ExportFormat = ExportFormat> {
  format: F;
  /** Language of the speaker labels: `en` (default) or `ar`. */
  lang?: 'en' | 'ar' | (string & {}) | undefined;
}

// --- Sound Cleaning -------------------------------------------------------------------------

export interface CleanParams {
  /** The audio: a file path (Node.js, Bun, Deno), a `Blob`/`File`, bytes, a byte stream, or `toFile(...)`. */
  file: Uploadable;
  cutoffFreq?: number | undefined;
  qFactor?: number | undefined;
  targetLufs?: number | undefined;
  truePeakDbfs?: number | undefined;
  compThreshDb?: number | undefined;
  compRatio?: number | undefined;
  compAttackMs?: number | undefined;
  compReleaseMs?: number | undefined;
  /** 16000, 24000, 32000 or 48000. */
  sampleRate?: number | undefined;
  /** 16 or 24. */
  bitDepth?: number | undefined;
}

// --- Widgets and agents ---------------------------------------------------------------------

/** The visitor a widget ticket is for. */
export interface WidgetUser {
  id?: string | undefined;
  name?: string | undefined;
}

export interface CreateTicketParams {
  user?: WidgetUser | undefined;
  channel?: AgentChannel | undefined;
  ttlSeconds?: number | undefined;
}

export interface StartSessionParams {
  /** `voice` for a room you speak in, `chat` for a text session. */
  channel?: AgentChannel | undefined;
}
