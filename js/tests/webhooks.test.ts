import { createHmac } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { WebhookVerificationError } from '../src/errors.js';
import { verifyWebhook, type JobCompleted, type UnknownEvent, type WebhookEvent } from '../src/webhooks.js';
import { loadSpec } from './helpers.js';

interface Vector {
  name: string;
  secrets: string[];
  now: number;
  tolerance_seconds: number;
  headers: Record<string, string>;
  body: string;
  expect: 'valid' | 'invalid';
  expect_type?: string;
  reason?: string;
}

const VECTORS = loadSpec<{ vectors: Vector[] }>('fixtures/webhooks/vectors.json').vectors;
const vector = (name: string): Vector => {
  const found = VECTORS.find((v) => v.name === name);
  if (!found) throw new Error(`no vector ${name}`);
  return found;
};

const TYPE_NAMES: Record<WebhookEvent['type'], string> = {
  'job.completed': 'JobCompleted',
  'job.failed': 'JobFailed',
  'spending.warning': 'SpendingWarning',
  'spending.exhausted': 'SpendingExhausted',
  unknown: 'UnknownEvent',
};

async function rejection(promise: Promise<unknown>): Promise<WebhookVerificationError> {
  const error = await promise.then(
    () => {
      throw new Error('expected verification to fail');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WebhookVerificationError);
  return error as WebhookVerificationError;
}

const SECRET = 'whsec_TEST0000000000000000000000000000000000000000';
function signed(body: string, event: string, timestamp = 1762300800): Record<string, string> {
  const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  return { 'X-Webhook-Event': event, 'X-Webhook-Timestamp': String(timestamp), 'X-Webhook-Signature': signature };
}

describe('shared webhook vectors', () => {
  it.each(VECTORS.map((v) => [v.name, v] as const))('%s', async (_name, v) => {
    const body = new TextEncoder().encode(v.body);
    const options = { toleranceSeconds: v.tolerance_seconds, now: v.now };
    if (v.expect === 'valid') {
      const event = await verifyWebhook(body, v.headers, v.secrets, options);
      expect(TYPE_NAMES[event.type]).toBe(v.expect_type);
    } else {
      const error = await rejection(verifyWebhook(body, v.headers, v.secrets, options));
      expect(error.reason).toBe(v.reason);
    }
  });
});

describe('verifyWebhook', () => {
  it('parses fields and the dedupe key', async () => {
    const v = vector('tts job.completed');
    const event = await verifyWebhook(v.body, v.headers, v.secrets[0]!, { now: v.now });
    expect(event.type).toBe('job.completed');
    if (event.type !== 'job.completed') return;
    expectTypeOf(event).toEqualTypeOf<JobCompleted>();
    expect(event.service).toBe('tts');
    expect(event.text).toBe('مرحبا بكم في إيكونوفا');
    expect(event.durationSeconds).toBe(3.4);
    expect(event.dedupeKey).toBe('job.completed:000000000000000000000001');
    expect(String(event.raw['audioUrl']).startsWith('https://')).toBe(true);
    expect(event.timestamp).toBe(1762300800);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('parses STT terminology', async () => {
    const v = vector('stt job.completed with terminology');
    const event = await verifyWebhook(v.body, v.headers, v.secrets, { now: v.now });
    if (event.type !== 'job.completed') throw new Error('wrong type');
    expect(event.service).toBe('stt');
    expect(event.transcription).toBe('hello from the KYC team');
    expect(event.terminology).not.toBeNull();
    expect(event.audioUrl).toBeNull();
  });

  it('builds the spending dedupe key', async () => {
    const v = vector('spending.warning');
    const event = await verifyWebhook(v.body, v.headers, v.secrets, { now: v.now });
    if (event.type !== 'spending.warning') throw new Error('wrong type');
    expect(event.percentageUsed).toBe(80);
    expect(event.apiKeyName).toBe('production');
    expect(event.dedupeKey).toBe('spending.warning:000000000000000000000a01:8000:10000');
  });

  it('builds the exhausted dedupe key', async () => {
    const v = vector('spending.exhausted');
    const event = await verifyWebhook(v.body, v.headers, v.secrets, { now: v.now });
    expect(event.dedupeKey).toBe('spending.exhausted:000000000000000000000a01:10000:10000');
  });

  it('has no dedupe key for unknown events', async () => {
    const v = vector('unknown event name parses');
    const event = await verifyWebhook(v.body, v.headers, v.secrets, { now: v.now });
    expect(event).toMatchObject({ type: 'unknown', event: 'job.archived', dedupeKey: null });
    if (event.type === 'unknown') expectTypeOf(event).toEqualTypeOf<UnknownEvent>();
  });

  it('reads headers case-insensitively and accepts string bodies', async () => {
    const v = vector('job.failed');
    const lowered = Object.fromEntries(Object.entries(v.headers).map(([k, val]) => [k.toLowerCase(), val]));
    const event = await verifyWebhook(v.body, lowered, v.secrets, { now: v.now });
    if (event.type !== 'job.failed') throw new Error('wrong type');
    expect(event.error).toBe('Transcription failed. Try again.');
    expect(event.dedupeKey).toBe('job.failed:000000000000000000000003');
  });

  it('accepts Headers, ArrayBuffer, Buffer and a Date for now', async () => {
    const v = vector('job.failed');
    const bytes = new TextEncoder().encode(v.body);
    const now = new Date(v.now * 1000);
    await expect(verifyWebhook(bytes.buffer as ArrayBuffer, new Headers(v.headers), v.secrets, { now })).resolves.toMatchObject({
      type: 'job.failed',
    });
    await expect(verifyWebhook(Buffer.from(v.body), v.headers, v.secrets, { now })).resolves.toMatchObject({
      type: 'job.failed',
    });
  });

  it('rejects non-ASCII digits in the timestamp', async () => {
    const v = vector('job.failed');
    const headers = { ...v.headers, 'X-Webhook-Timestamp': '١٧٦٢٣٠٠٨٠٠' };
    expect((await rejection(verifyWebhook(v.body, headers, v.secrets, { now: v.now }))).reason).toBe('timestamp');
  });

  it('rejects an empty header as missing', async () => {
    const v = vector('job.failed');
    const headers = { ...v.headers, 'X-Webhook-Signature': '' };
    expect((await rejection(verifyWebhook(v.body, headers, v.secrets, { now: v.now }))).reason).toBe('headers');
  });

  it('uses the current time by default', async () => {
    const v = vector('job.failed'); // signed in 2025: stale now
    expect((await rejection(verifyWebhook(v.body, v.headers, v.secrets))).reason).toBe('timestamp');
  });

  it.each([[''], [[]], [['']], [[5]]] as const)('treats an empty secret as a programming error (%j)', async (secret) => {
    const v = vector('job.failed');
    await expect(verifyWebhook(v.body, v.headers, secret as never, { now: v.now })).rejects.toThrow(TypeError);
    await expect(verifyWebhook(v.body, v.headers, secret as never, { now: v.now })).rejects.toThrow(/secret/);
  });

  it('rejects a signed body that is not JSON', async () => {
    const body = 'not json';
    const error = await rejection(verifyWebhook(body, signed(body, 'job.failed'), SECRET, { now: 1762300800 }));
    expect(error.reason).toBe('payload');
  });

  it('rejects a known event missing a required field', async () => {
    const body = '{"service":"tts"}';
    const error = await rejection(verifyWebhook(body, signed(body, 'job.completed'), SECRET, { now: 1762300800 }));
    expect(error.reason).toBe('payload');
    expect(error.message).toMatch(/jobId/);
  });

  it('parses a non-object payload as an unknown event', async () => {
    const body = '[1,2]';
    const event = await verifyWebhook(body, signed(body, 'job.completed'), SECRET, { now: 1762300800 });
    expect(event).toMatchObject({ type: 'unknown', event: 'job.completed', raw: [1, 2] });
  });

  it('rounds percentageUsed half to even and reads numeric strings', async () => {
    const body = '{"apiKeyId":"k1","creditsUsed":"8050.5","creditLimit":10000,"percentageUsed":80.5}';
    const event = await verifyWebhook(body, signed(body, 'spending.warning'), SECRET, { now: 1762300800 });
    if (event.type !== 'spending.warning') throw new Error('wrong type');
    expect(event.percentageUsed).toBe(80);
    expect(event.creditsUsed).toBe(8050.5);
    expect(event.dedupeKey).toBe('spending.warning:k1:8050.5:10000');
  });
});
