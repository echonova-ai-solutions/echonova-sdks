/**
 * Verify and parse EchoNova webhook requests.
 *
 * ```ts
 * import { verifyWebhook } from 'echonova';
 *
 * const event = await verifyWebhook(rawBody, request.headers, process.env.ECHONOVA_WEBHOOK_SECRET!);
 * ```
 *
 * Pass the raw request body exactly as received. Parsing the JSON and
 * serialising it again changes the bytes, and the signature check then fails.
 *
 * Uses Web Crypto (`crypto.subtle`), so it runs on Node, Bun, Deno, edge
 * runtimes and browsers. It is therefore async.
 */

import { header, type HeadersLike } from './core/envelope.js';
import { numberKey, parseFloatStrict, roundHalfEven, strip } from './core/text.js';
import { WebhookVerificationError } from './errors.js';

export const DEFAULT_TOLERANCE_SECONDS = 300;
export const EVENT_HEADER = 'X-Webhook-Event';
export const TIMESTAMP_HEADER = 'X-Webhook-Timestamp';
export const SIGNATURE_HEADER = 'X-Webhook-Signature';

type Raw = Readonly<Record<string, unknown>>;

/** An async Text to Speech or Speech to Text job finished. Check `service`. */
export interface JobCompleted {
  readonly type: 'job.completed';
  readonly event: 'job.completed';
  readonly jobId: string;
  readonly apiKeyId: string | null;
  /** `"tts"` or `"stt"`. */
  readonly service: 'tts' | 'stt' | (string & {});
  readonly durationSeconds: number | null;
  /** TTS: the text that was synthesized. */
  readonly text: string | null;
  /** TTS: a signed link that expires. Get the job again for a fresh one. */
  readonly audioUrl: string | null;
  /** STT: the transcript. */
  readonly transcription: string | null;
  /** STT: the terminology result, when terminology was sent. */
  readonly terminology: Raw | null;
  /** The `X-Webhook-Timestamp` value (Unix seconds). */
  readonly timestamp: number;
  readonly raw: Raw;
  /** Stable id for deduplicating deliveries of the same event. */
  readonly dedupeKey: string;
}

/** An async job failed. */
export interface JobFailed {
  readonly type: 'job.failed';
  readonly event: 'job.failed';
  readonly jobId: string;
  readonly apiKeyId: string | null;
  readonly service: 'tts' | 'stt' | (string & {});
  readonly error: string | null;
  readonly timestamp: number;
  readonly raw: Raw;
  readonly dedupeKey: string;
}

/** The key is close to its Credit Limit for this billing cycle. */
export interface SpendingWarning {
  readonly type: 'spending.warning';
  readonly event: 'spending.warning';
  readonly apiKeyId: string;
  readonly apiKeyName: string | null;
  readonly creditsUsed: number | null;
  readonly creditLimit: number | null;
  readonly percentageUsed: number | null;
  readonly timestamp: number;
  readonly raw: Raw;
  readonly dedupeKey: string;
}

/** The key reached its Credit Limit; paid calls with it now fail until the limit changes. */
export interface SpendingExhausted {
  readonly type: 'spending.exhausted';
  readonly event: 'spending.exhausted';
  readonly apiKeyId: string;
  readonly apiKeyName: string | null;
  readonly creditsUsed: number | null;
  readonly creditLimit: number | null;
  readonly timestamp: number;
  readonly raw: Raw;
  readonly dedupeKey: string;
}

/** An event this SDK version doesn't know yet. The signature was valid. */
export interface UnknownEvent {
  readonly type: 'unknown';
  /** The `X-Webhook-Event` value. */
  readonly event: string;
  readonly timestamp: number;
  readonly raw: unknown;
  readonly dedupeKey: null;
}

/** Narrow with `event.type`. */
export type WebhookEvent = JobCompleted | JobFailed | SpendingWarning | SpendingExhausted | UnknownEvent;

export type WebhookPayload = string | Uint8Array | ArrayBuffer;

export interface VerifyWebhookOptions {
  /** Maximum age (and clock skew) of the timestamp, in seconds. Default 300. */
  toleranceSeconds?: number | undefined;
  /** The current time, as a `Date` or Unix seconds. Defaults to now. */
  now?: Date | number | undefined;
}

const encoder = new TextEncoder();

function toBytes(payload: WebhookPayload): Uint8Array {
  if (typeof payload === 'string') return encoder.encode(payload);
  if (payload instanceof Uint8Array) return payload;
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  if (Object.prototype.toString.call(payload) === '[object ArrayBuffer]') return new Uint8Array(payload);
  throw new TypeError('payload must be the raw request body: a string, Uint8Array or ArrayBuffer');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function subtleCrypto(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new TypeError('verifyWebhook needs Web Crypto (globalThis.crypto.subtle)');
  return subtle;
}

/** Check one secret. `crypto.subtle.verify` compares the MAC in constant time. */
async function signatureMatches(
  secret: string,
  message: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer> | null,
): Promise<boolean> {
  const subtle = subtleCrypto();
  const key = await subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  if (signature === null) return false;
  return subtle.verify('HMAC', key, signature, message);
}

/**
 * Check a webhook's signature and timestamp, then parse it.
 *
 * `secret` may be a list, so two secrets can be valid at once (for example
 * while moving to a new webhook endpoint). Rejects with
 * `WebhookVerificationError` whose `reason` is `"headers"`, `"timestamp"`,
 * `"signature"` or `"payload"`.
 */
export async function verifyWebhook(
  payload: WebhookPayload,
  headers: HeadersLike,
  secret: string | readonly string[],
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent> {
  const body = toBytes(payload);
  const secrets: readonly unknown[] = typeof secret === 'string' ? [secret] : Array.isArray(secret) ? secret : [];
  if (secrets.length === 0 || !secrets.every((s) => typeof s === 'string' && s.length > 0)) {
    throw new TypeError('secret must be a non-empty string or a list of them');
  }
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  const eventName = header(headers, EVENT_HEADER);
  const timestampHeader = header(headers, TIMESTAMP_HEADER);
  const signatureHeader = header(headers, SIGNATURE_HEADER);
  if (!eventName || !timestampHeader || !signatureHeader) {
    throw new WebhookVerificationError(
      `missing ${EVENT_HEADER}, ${TIMESTAMP_HEADER} or ${SIGNATURE_HEADER} header`,
      { reason: 'headers' },
    );
  }

  const timestampText = strip(timestampHeader);
  if (!/^[0-9]+$/.test(timestampText)) {
    throw new WebhookVerificationError('webhook timestamp is not a number', { reason: 'timestamp' });
  }
  const timestamp = Number(timestampText);
  const now =
    options.now === undefined ? Date.now() / 1000 : options.now instanceof Date ? options.now.getTime() / 1000 : options.now;
  if (!(Math.abs(now - timestamp) <= tolerance)) {
    throw new WebhookVerificationError('webhook timestamp is outside the allowed tolerance', { reason: 'timestamp' });
  }

  const prefix = encoder.encode(`${timestampText}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  const received = hexToBytes(strip(signatureHeader).toLowerCase());
  // Check every secret (no early exit), like a constant-time comparison would.
  const results = await Promise.all(secrets.map((s) => signatureMatches(s as string, message, received)));
  if (!results.includes(true)) {
    throw new WebhookVerificationError('webhook signature does not match', { reason: 'signature' });
  }

  let data: unknown;
  try {
    let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    data = JSON.parse(text);
  } catch {
    throw new WebhookVerificationError('webhook body is not JSON', { reason: 'payload' });
  }
  return parseEvent(strip(eventName), data, timestamp);
}

function parseEvent(name: string, data: unknown, timestamp: number): WebhookEvent {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return Object.freeze({ type: 'unknown', event: name, timestamp, raw: data, dedupeKey: null });
  }
  const raw = data as Raw;
  switch (name) {
    case 'job.completed': {
      const jobId = requiredStr(raw, 'jobId');
      const terminology = raw['terminology'];
      return Object.freeze({
        type: 'job.completed',
        event: 'job.completed',
        jobId,
        apiKeyId: str(raw['apiKeyId']),
        service: requiredStr(raw, 'service'),
        durationSeconds: num(raw['durationSeconds']),
        text: str(raw['text']),
        audioUrl: str(raw['audioUrl']),
        transcription: str(raw['transcription']),
        terminology:
          typeof terminology === 'object' && terminology !== null && !Array.isArray(terminology)
            ? (terminology as Raw)
            : null,
        timestamp,
        raw,
        dedupeKey: `job.completed:${jobId}`,
      });
    }
    case 'job.failed': {
      const jobId = requiredStr(raw, 'jobId');
      return Object.freeze({
        type: 'job.failed',
        event: 'job.failed',
        jobId,
        apiKeyId: str(raw['apiKeyId']),
        service: requiredStr(raw, 'service'),
        error: str(raw['error']),
        timestamp,
        raw,
        dedupeKey: `job.failed:${jobId}`,
      });
    }
    case 'spending.warning': {
      const apiKeyId = requiredStr(raw, 'apiKeyId');
      const creditsUsed = num(raw['creditsUsed']);
      const creditLimit = num(raw['creditLimit']);
      const percentage = num(raw['percentageUsed']);
      return Object.freeze({
        type: 'spending.warning',
        event: 'spending.warning',
        apiKeyId,
        apiKeyName: str(raw['apiKeyName']),
        creditsUsed,
        creditLimit,
        percentageUsed: percentage !== null && Number.isFinite(percentage) ? roundHalfEven(percentage) : null,
        timestamp,
        raw,
        dedupeKey: `spending.warning:${apiKeyId}:${numberKey(creditsUsed)}:${numberKey(creditLimit)}`,
      });
    }
    case 'spending.exhausted': {
      const apiKeyId = requiredStr(raw, 'apiKeyId');
      const creditsUsed = num(raw['creditsUsed']);
      const creditLimit = num(raw['creditLimit']);
      return Object.freeze({
        type: 'spending.exhausted',
        event: 'spending.exhausted',
        apiKeyId,
        apiKeyName: str(raw['apiKeyName']),
        creditsUsed,
        creditLimit,
        timestamp,
        raw,
        dedupeKey: `spending.exhausted:${apiKeyId}:${numberKey(creditsUsed)}:${numberKey(creditLimit)}`,
      });
    }
    default:
      return Object.freeze({ type: 'unknown', event: name, timestamp, raw, dedupeKey: null });
  }
}

function requiredStr(data: Raw, key: string): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new WebhookVerificationError(`webhook payload is missing ${key}`, { reason: 'payload' });
  }
  return value;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseFloatStrict(value);
  return null;
}
