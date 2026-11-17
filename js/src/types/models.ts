/**
 * Response models for the REST API.
 *
 * They mirror the API's JSON field for field, so the API reference applies as
 * written. The SDK adds `requestId` to every result. Fields the API leaves out
 * are `undefined`; fields it documents as nullable may also be `null`, so test
 * them with `== null`. Fields this SDK version doesn't know yet are kept on the
 * object as received.
 *
 * Enums are open: besides the values listed, treat any other `status` as
 * "not finished", and any other value as unknown.
 */

/** pending, processing, completed or failed. Any other value means the job is not finished. */
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | (string & {});
/** `auto` detects Arabic or English; `ar` is Arabic and mixed Arabic/English; `en` is wholly English speech. */
export type Language = 'auto' | 'ar' | 'en' | (string & {});

/** Added by the SDK to every result. */
export interface APIResult {
  /** The `X-Request-Id` of the response this came from. Quote it when contacting support. */
  requestId: string | null;
}

// --- Shared ---------------------------------------------------------------------------------

/** An async job was accepted. Poll it with `jobs.wait()` or wait for its webhook. */
export interface JobInitiated extends APIResult {
  jobId: string;
  status: JobStatus;
}

/**
 * The `202` answer of a synchronous call whose job was still processing after 220 s.
 * The SDK doesn't return it: it waits for the job and returns the call's usual result.
 */
export interface SyncProcessing {
  jobId: string;
  status: JobStatus;
  /** The job's `get` route, e.g. `/v1/text-to-speech/jobs/{jobId}`. */
  resultUrl: string;
}

export interface DeleteResult extends APIResult {
  deleted: boolean;
  /** True when a retried delete found the job gone, because an earlier attempt had removed it. */
  alreadyDeleted: boolean;
}

// --- Text to Speech -------------------------------------------------------------------------

/** The result of `textToSpeech.generate()`. `audioUrl` is a signed WAV link that expires: download it soon. */
export interface TtsResult extends APIResult {
  jobId: string;
  status: JobStatus;
  audioUrl: string;
  durationSeconds?: number | null;
  creditsConsumed: number;
}

export interface Voice {
  id: string;
  name: string;
  displayName?: string;
  language: string;
  gender?: string;
  previewUrl?: string | null;
}

/** Every voice you can use. Iterate it directly, or read `items`. */
export interface VoiceList extends APIResult, Iterable<Voice> {
  items: Voice[];
  total?: number;
}

/** Only on jobs saved from a Text to Speech stream: where the job came from. */
export interface TtsJobStream {
  /** The stream session. Every synthesis on one socket shares it. */
  sessionId: string;
  /** The synthesis's `requestId`: the one you sent, or the one the server made. */
  requestId: string;
  /** True when the synthesis stopped early; the audio holds only what was sent. */
  cancelled?: boolean;
  /** True when the audio could not be saved. The text is kept and `audioUrl` stays null. */
  audioDropped?: boolean;
}

/** A Text to Speech job. `audioUrl` is signed again on every get and expires, so don't store it. */
export interface TtsJob extends APIResult {
  id: string;
  status: JobStatus;
  text: string;
  voiceId: string;
  audioUrl?: string | null;
  durationSeconds?: number | null;
  creditsConsumed: number;
  error?: string | null;
  stream?: TtsJobStream;
  /** ISO 8601 date-time. */
  createdAt: string;
}

// --- Speech to Text -------------------------------------------------------------------------

export interface SttSegment {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
}

export interface SttSpeaker {
  id: string;
  talkTime: number;
}

export interface TerminologyEdit {
  start: number;
  end: number;
  original: string;
  replacement: string;
  stage: string;
  score: number;
}

export interface TerminologyNearMiss {
  start: number;
  end: number;
  original: string;
  candidate: string;
  score: number;
}

export interface TerminologyWarning {
  code: string;
  detail: string;
}

/** How your terminology changed the transcript. */
export interface TerminologyResult {
  /** The transcript before corrections. */
  raw: string;
  corrected: string;
  edits: TerminologyEdit[];
  nearMisses: TerminologyNearMiss[];
  warnings: TerminologyWarning[];
  mapperStatus: string;
  mapperVersion: string;
}

/** The result of `speechToText.transcribe()`. */
export interface SttResult extends APIResult {
  jobId: string;
  status: JobStatus;
  transcription: string;
  durationSeconds?: number | null;
  language: Language | null;
  numbersAsDigits: boolean;
  identifySpeakers: boolean;
  segments: SttSegment[];
  speakers: SttSpeaker[];
  terminology?: TerminologyResult;
  creditsConsumed: number;
}

/** Only on jobs saved from a Speech to Text stream: the session they came from. */
export interface SttJobStream {
  sessionId: string;
}

/** A Speech to Text job. `transcription` is missing until it completes. */
export interface SttJob extends APIResult {
  id: string;
  status: JobStatus;
  transcription?: string | null;
  durationSeconds?: number | null;
  language: Language | null;
  numbersAsDigits: boolean;
  identifySpeakers: boolean;
  segments: SttSegment[];
  speakers: SttSpeaker[];
  terminology?: TerminologyResult;
  /** Only on jobs from a Speech to Text stream. */
  stream?: SttJobStream;
  /** Only on jobs from a Speech to Text stream: a signed link to the recording. It expires. */
  audioUrl?: string;
  creditsConsumed: number;
  error?: string | null;
  /** ISO 8601 date-time. */
  createdAt: string;
}

export interface TranscriptExportSpeaker {
  id?: string;
  label?: string;
  talkTime?: number;
}

export interface TranscriptExportSegment {
  start?: number;
  end?: number;
  speaker?: string | null;
  speakerLabel?: string;
  text?: string;
}

/** `speechToText.jobs.export(job, { format: 'json' })`: text, speakers and timed segments. */
export interface TranscriptExport extends APIResult {
  id?: string;
  fileName?: string;
  durationSeconds?: number | null;
  language?: Language | null;
  text?: string;
  speakers?: TranscriptExportSpeaker[];
  segments?: TranscriptExportSegment[];
}

// --- Sound Cleaning -------------------------------------------------------------------------

/** The cleaning options recorded on the job. */
export interface CleanJobOptions {
  cutoffFreq?: number;
  qFactor?: number;
  targetLufs?: number;
  truePeakDbfs?: number;
  compThreshDb?: number;
  compRatio?: number;
  compAttackMs?: number;
  compReleaseMs?: number;
}

export interface CleanMetrics {
  sampleRate?: number;
  bitDepth?: number;
  integratedLufs?: number;
  truePeakDbfs?: number;
}

/** A Sound Cleaning job. `outputUrl` is a signed link to the cleaned WAV; it expires. */
export interface CleanJob extends APIResult {
  id: string;
  status: JobStatus;
  fileName: string;
  outputUrl?: string;
  durationSeconds?: number | null;
  creditsConsumed: number;
  options?: CleanJobOptions;
  metrics?: CleanMetrics;
  error?: string;
  /** ISO 8601 date-time. */
  createdAt: string;
}

// --- Widgets --------------------------------------------------------------------------------

/** A short-lived ticket that lets one visitor open a private widget. Hand it only to that visitor. */
export interface WidgetTicket extends APIResult {
  ticket: string;
  /** ISO 8601 date-time. */
  expiresAt: string;
}

// --- Agents ---------------------------------------------------------------------------------

export type AgentChannel = 'voice' | 'chat' | (string & {});
/** active while open; ended after you end it or it finishes; failed or out_of_credits when it stopped early. */
export type AgentSessionStatus = 'active' | 'ended' | 'failed' | 'out_of_credits' | (string & {});

/** A live voice or chat session with an agent. */
export interface AgentSession extends APIResult {
  /** The session ID; also the conversation ID once it ends. */
  id: string;
  agentId: string;
  channel: AgentChannel;
  status: AgentSessionStatus;
  /** ISO 8601 date-time. */
  startedAt: string;
  /** ISO 8601 date-time; null while the session is open. */
  endedAt: string | null;
}

/**
 * A session `agents.sessions.start()` just opened.
 *
 * `token` is a secret. The API sends it once, here, and never again: hand it
 * only to the client that joins the room, and never log it. The SDK never logs
 * it or copies it into an error.
 */
export interface StartedAgentSession extends AgentSession {
  /** The room token. Secret: give it only to the client that joins. */
  token: string;
  /** The room address the client connects to with `token`. */
  wsUrl: string;
  /** A chat session's first agent message; null for voice. */
  greeting: string | null;
}
