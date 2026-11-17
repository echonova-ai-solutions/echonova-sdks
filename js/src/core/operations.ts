/**
 * Every REST operation the SDK calls, with its default timeouts.
 *
 * `name` is the SDK method as in `spec/mapping.json`. It also names the
 * operation's rate-limit bucket: the API counts requests per key per endpoint.
 *
 * `write` and `read` are the per-phase timeouts (seconds) shared by every
 * EchoNova SDK. `fetch` only has a total deadline per attempt, so this SDK
 * derives one from them: connect + upload + read (`attemptTimeout`).
 */

export interface Operation {
  readonly name: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly write: number;
  readonly read: number;
  /** The request carries an audio upload. */
  readonly upload?: boolean;
  /** The response body holds a secret (a ticket or token): never copy it into an error. */
  readonly sensitive?: boolean;
  /** The operation accepts an `Idempotency-Key` (ADR 0014): every call sends one. */
  readonly idempotencyKey?: boolean;
}

const op = (
  name: string,
  method: Operation['method'],
  path: string,
  write = 10,
  read = 30,
  flags: { upload?: boolean; sensitive?: boolean; idempotencyKey?: boolean } = {},
): Operation => ({ name, method, path, write, read, ...flags });

const TTS = '/v1/text-to-speech';
const STT = '/v1/speech-to-text';
const CLEAN = '/v1/sound-cleaning';
const AGENT_SESSIONS = '/v1/agents/{agentId}/sessions';
const upload = { upload: true };
const sensitive = { sensitive: true };
const idempotencyKey = { idempotencyKey: true };

export const OPS = {
  // 240 s to answer: above the 220 s after which the API answers 202 Processing (ADR 0014).
  ttsGenerate: op('textToSpeech.generate', 'POST', `${TTS}/sync`, 10, 240, idempotencyKey),
  ttsJobsCreate: op('textToSpeech.jobs.create', 'POST', TTS),
  ttsVoicesList: op('textToSpeech.voices.list', 'GET', `${TTS}/voices`),
  ttsJobsList: op('textToSpeech.jobs.list', 'GET', `${TTS}/jobs`),
  ttsJobsGet: op('textToSpeech.jobs.get', 'GET', `${TTS}/jobs/{jobId}`),
  ttsJobsDelete: op('textToSpeech.jobs.delete', 'DELETE', `${TTS}/jobs/{jobId}`),

  sttTranscribe: op('speechToText.transcribe', 'POST', `${STT}/sync`, 60, 600, { ...upload, ...idempotencyKey }),
  sttJobsCreate: op('speechToText.jobs.create', 'POST', STT, 60, 120, upload),
  sttJobsList: op('speechToText.jobs.list', 'GET', `${STT}/jobs`),
  sttJobsGet: op('speechToText.jobs.get', 'GET', `${STT}/jobs/{jobId}`),
  sttJobsDelete: op('speechToText.jobs.delete', 'DELETE', `${STT}/jobs/{jobId}`),
  sttJobsExport: op('speechToText.jobs.export', 'GET', `${STT}/jobs/{jobId}/export`, 10, 60),

  clean: op('soundCleaning.clean', 'POST', CLEAN, 60, 600, { ...upload, ...idempotencyKey }),
  cleanJobsList: op('soundCleaning.jobs.list', 'GET', `${CLEAN}/jobs`),
  cleanJobsGet: op('soundCleaning.jobs.get', 'GET', `${CLEAN}/jobs/{jobId}`),
  cleanJobsDelete: op('soundCleaning.jobs.delete', 'DELETE', `${CLEAN}/jobs/{jobId}`),

  widgetsCreateTicket: op('widgets.createTicket', 'POST', '/v1/widgets/{publicId}/tickets', 10, 30, sensitive),

  agentSessionsStart: op('agents.sessions.start', 'POST', AGENT_SESSIONS, 10, 30, sensitive),
  agentSessionsGet: op('agents.sessions.get', 'GET', `${AGENT_SESSIONS}/{sessionId}`),
  agentSessionsEnd: op('agents.sessions.end', 'POST', `${AGENT_SESSIONS}/{sessionId}/end`),
} as const satisfies Record<string, Operation>;

export const CONNECT_TIMEOUT_SECONDS = 10;
/** The slowest upload the SDK plans for: about 4.2 Mbit/s, which sends 150 MiB in 300 s. */
export const MIN_UPLOAD_BYTES_PER_SECOND = 512 * 1024;
/** The server stops waiting for an upload body after this long. */
export const MAX_UPLOAD_SECONDS = 300;

/**
 * The default deadline for one attempt, in milliseconds: connect, then the
 * upload (scaled by its size, between `write` and 300 s), then the read.
 * An upload of unknown size (a stream) gets the full 300 s.
 */
export function attemptTimeout(operation: Operation, uploadBytes?: number | null): number {
  let upload = operation.write;
  if (operation.upload) {
    const needed = uploadBytes == null ? MAX_UPLOAD_SECONDS : uploadBytes / MIN_UPLOAD_BYTES_PER_SECOND;
    upload = Math.min(MAX_UPLOAD_SECONDS, Math.max(operation.write, Math.ceil(needed)));
  }
  return (CONNECT_TIMEOUT_SECONDS + upload + operation.read) * 1000;
}

/** Fill `{name}` placeholders, percent-encoding each value. */
export function buildPath(path: string, params: Readonly<Record<string, string>> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new TypeError(`missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}
