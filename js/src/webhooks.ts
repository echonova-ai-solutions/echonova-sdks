/**
 * Verify and parse EchoNova webhook requests (Standard Webhooks v1).
 *
 * ```ts
 * import { verifyWebhook } from '@echonova/ai';
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
import { parseFloatStrict, roundHalfEven, strip } from './core/text.js';
import { WebhookVerificationError } from './errors.js';

export const DEFAULT_TOLERANCE_SECONDS = 300;
export const EVENT_HEADER = 'X-Webhook-Event';
export const ID_HEADER = 'webhook-id';
export const TIMESTAMP_HEADER = 'webhook-timestamp';
export const SIGNATURE_HEADER = 'webhook-signature';

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
  /** The `webhook-timestamp` value (Unix seconds). */
  readonly timestamp: number;
  readonly raw: Raw;
  /** The delivery's `webhook-id`. It stays the same when a delivery is retried. */
  readonly webhookId: string;
  /** The key to deduplicate deliveries with: the `webhookId`. */
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
  readonly webhookId: string;
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
  readonly webhookId: string;
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
  readonly webhookId: string;
  readonly dedupeKey: string;
}

/** An event this SDK version doesn't know yet. The signature was valid. */
export interface UnknownEvent {
  readonly type: 'unknown';
  /** The `X-Webhook-Event` value. */
  readonly event: string;
  readonly timestamp: number;
  readonly raw: unknown;
  readonly webhookId: string;
  readonly dedupeKey: string;
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

const MAX_TIMESTAMP_LENGTH = 15;
const SECRET_PREFIX = 'whsec_';

const encoder = new TextEncoder();

function toBytes(payload: WebhookPayload): Uint8Array {
  if (typeof payload === 'string') return encoder.encode(payload);
  if (payload instanceof Uint8Array) return payload;
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  if (Object.prototype.toString.call(payload) === '[object ArrayBuffer]') return new Uint8Array(payload);
  throw new TypeError('payload must be the raw request body: a string, Uint8Array or ArrayBuffer');
}

/** Decode base64 in either alphabet, padding optional; null if it isn't base64. */
function base64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  const unpadded = text.replace(/-/g, '+').replace(/_/g, '/').replace(/={1,2}$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(unpadded) || unpadded.length % 4 === 1) return null;
  const binary = atob(unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The HMAC key: the base64 after `whsec_`, decoded. */
function signingKey(secret: string): Uint8Array<ArrayBuffer> {
  const text = strip(secret);
  const key = base64ToBytes(text.startsWith(SECRET_PREFIX) ? text.slice(SECRET_PREFIX.length) : text);
  if (key === null || key.length === 0) {
    throw new TypeError('secret is not a webhook signing secret: expected whsec_ followed by base64');
  }
  return key;
}

function subtleCrypto(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new TypeError('verifyWebhook needs Web Crypto (globalThis.crypto.subtle)');
  return subtle;
}

/** Check one key against every signature. `crypto.subtle.verify` compares the MAC in constant time. */
async function signatureMatches(
  key: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
  signatures: readonly Uint8Array<ArrayBuffer>[],
): Promise<boolean> {
  const subtle = subtleCrypto();
  const hmacKey = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const results = await Promise.all(signatures.map((signature) => subtle.verify('HMAC', hmacKey, signature, message)));
  return results.includes(true);
}

/**
 * Check a webhook's signature and timestamp, then parse it.
 *
 * `secret` is the webhook's signing secret (`whsec_…`) as shown in the portal.
 * It may be a list, so more than one secret can be valid at once. During a
 * rotation in the portal the gateway signs with both the new and the previous
 * secret, so passing only the new one works. Rejects with
 * `WebhookVerificationError` whose `reason` is `"headers"`, `"timestamp"`,
 * `"signature"` or `"payload"`, and throws `TypeError` for a secret that isn't valid.
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
  const keys = secrets.map((s) => signingKey(s as string));
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  const eventName = header(headers, EVENT_HEADER);
  const idHeader = header(headers, ID_HEADER);
  const timestampHeader = header(headers, TIMESTAMP_HEADER);
  const signatureHeader = header(headers, SIGNATURE_HEADER);
  if (!eventName || !idHeader || !timestampHeader || !signatureHeader) {
    throw new WebhookVerificationError(
      `missing ${EVENT_HEADER}, ${ID_HEADER}, ${TIMESTAMP_HEADER} or ${SIGNATURE_HEADER} header`,
      { reason: 'headers' },
    );
  }

  const timestampText = strip(timestampHeader);
  // Unix seconds fit in 15 digits for millions of years; refuse anything longer
  // before parsing, so a huge header can't cost anything before the signature check.
  if (timestampText.length > MAX_TIMESTAMP_LENGTH || !/^[0-9]+$/.test(timestampText)) {
    throw new WebhookVerificationError('webhook timestamp is not a number', { reason: 'timestamp' });
  }
  const timestamp = Number(timestampText);
  const now =
    options.now === undefined ? Date.now() / 1000 : options.now instanceof Date ? options.now.getTime() / 1000 : options.now;
  if (!(Math.abs(now - timestamp) <= tolerance)) {
    throw new WebhookVerificationError('webhook timestamp is outside the allowed tolerance', { reason: 'timestamp' });
  }

  const webhookId = strip(idHeader);
  const prefix = encoder.encode(`${webhookId}.${timestampText}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  // One `v1,<base64>` per secret the gateway signed with, space-separated; other versions are ignored.
  const signatures = signatureHeader
    .split(/\s+/)
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => base64ToBytes(entry.slice(3)))
    .filter((bytes): bytes is Uint8Array<ArrayBuffer> => bytes !== null && bytes.length === 32);
  // Check every key (no early exit), like a constant-time comparison would.
  const results = await Promise.all(keys.map((key) => signatureMatches(key, message, signatures)));
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
  return parseEvent(strip(eventName), data, timestamp, webhookId);
}

function parseEvent(name: string, data: unknown, timestamp: number, webhookId: string): WebhookEvent {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return Object.freeze({ type: 'unknown', event: name, timestamp, raw: data, webhookId, dedupeKey: webhookId });
  }
  const raw = data as Raw;
  switch (name) {
    case 'job.completed': {
      const jobId = requiredStr(raw, 'jobId');
      const service = requiredStr(raw, 'service');
      // A completed job carries its result. Without it the body is not a
      // completion (for example a job.failed body sent under this event name).
      if (service === 'tts') requiredStr(raw, 'audioUrl');
      else if (service === 'stt') requiredStr(raw, 'transcription');
      const terminology = raw['terminology'];
      return Object.freeze({
        type: 'job.completed',
        event: 'job.completed',
        jobId,
        apiKeyId: str(raw['apiKeyId']),
        service,
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
        webhookId,
        dedupeKey: webhookId,
      });
    }
    case 'job.failed': {
      // A failed job has no result. With one, the body may be a job.completed sent under this event name.
      refuseKeys(raw, ['audioUrl', 'transcription']);
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
        webhookId,
        dedupeKey: webhookId,
      });
    }
    case 'spending.warning': {
      // A spending event carries its credits. Without them, the body may be a job event sent under this name.
      const creditsUsed = requiredNum(raw, 'creditsUsed');
      const creditLimit = requiredNum(raw, 'creditLimit');
      const apiKeyId = requiredStr(raw, 'apiKeyId');
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
        webhookId,
        dedupeKey: webhookId,
      });
    }
    case 'spending.exhausted': {
      const creditsUsed = requiredNum(raw, 'creditsUsed');
      const creditLimit = requiredNum(raw, 'creditLimit');
      const apiKeyId = requiredStr(raw, 'apiKeyId');
      return Object.freeze({
        type: 'spending.exhausted',
        event: 'spending.exhausted',
        apiKeyId,
        apiKeyName: str(raw['apiKeyName']),
        creditsUsed,
        creditLimit,
        timestamp,
        raw,
        webhookId,
        dedupeKey: webhookId,
      });
    }
    default:
      return Object.freeze({ type: 'unknown', event: name, timestamp, raw, webhookId, dedupeKey: webhookId });
  }
}

function requiredStr(data: Raw, key: string): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new WebhookVerificationError(`webhook payload is missing ${key}`, { reason: 'payload' });
  }
  return value;
}

function requiredNum(data: Raw, key: string): number {
  const value = num(data[key]);
  if (value === null || !Number.isFinite(value)) {
    throw new WebhookVerificationError(`webhook payload is missing ${key}`, { reason: 'payload' });
  }
  return value;
}

/** Refuses a body that carries any of these keys as a non-empty string (null or empty is allowed). */
function refuseKeys(data: Raw, keys: readonly string[]): void {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) {
      throw new WebhookVerificationError(`webhook payload has an unexpected ${key}`, { reason: 'payload' });
    }
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseFloatStrict(value);
  return null;
}
