// Every operation in spec/mapping.json is reachable under its TypeScript name, accepts every
// documented parameter, and sends the documented request: method, path, query, headers, JSON or
// multipart. Operations the mapping marks `excluded` are not part of this SDK yet.
import { describe, expect, it } from 'vitest';
import { OPS, attemptTimeout } from '../src/core/operations.js';
import type { Language } from '../src/types/models.js';
import { loadSpec } from './helpers.js';
import { dataSchema, exampleFor, JOB_ID, makeClient, ok, partsOf, WAV, type Captured } from './rest-support.js';

interface MappedParam {
  api: string;
  in: 'path' | 'query' | 'json' | 'form' | 'header';
  required: boolean;
  ts: string;
}
interface MappedOperation {
  method: string;
  path: string;
  sdk: { ts: string };
  params: MappedParam[];
  idempotency_key: boolean;
  excluded?: string;
}
const mapping = Object.fromEntries(
  Object.entries(loadSpec<{ operations: Record<string, MappedOperation> }>('mapping.json').operations).filter(([, o]) => !o.excluded),
);

const TERMS = { keywords: ['KYC', { term: 'Emirates NBD', variants: ['امريتس ان بي دي'] }] };

/** A value for every parameter, by its API name. */
const VALUES: Record<string, unknown> = {
  text: 'مرحبا',
  voiceId: 'v1',
  speed: 1.1,
  cfg: 3,
  numSteps: 32,
  tashkeel: true,
  normalize: false,
  offset: 40,
  limit: 20,
  jobId: JOB_ID,
  file: WAV,
  language: 'ar',
  numbers_as_digits: false,
  identify_speakers: true,
  terminology: TERMS,
  format: 'srt',
  lang: 'ar',
  cutoffFreq: 80,
  qFactor: 0.707,
  targetLufs: -16,
  truePeakDbfs: -1,
  compThreshDb: -20,
  compRatio: 3,
  compAttackMs: 5,
  compReleaseMs: 50,
  sampleRate: 48000,
  bitDepth: 24,
  publicId: 'wdg_123',
  user: { id: 'u1', name: 'Visitor' },
  channel: 'chat',
  ttlSeconds: 300,
  agentId: 'agent-1',
  sessionId: 'session/1',
  'Idempotency-Key': 'key-0f8b5c',
};

/** How a value travels in a multipart field. */
function formValue(value: unknown): string {
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function respond(operation: MappedOperation) {
  return (request: Captured): Response => {
    if (request.url.pathname.endsWith('/export')) return new Response('1\n00:00:00,000 --> 00:00:01,000\nhi\n', { status: 200 });
    const schemaPath = operation.path;
    return ok(exampleFor(dataSchema(schemaPath, operation.method)));
  };
}

/**
 * Call `client.<ts path>` with path parameters first, then one object with every other parameter,
 * then the request options, which carry the header parameters (`idempotencyKey`).
 */
async function invoke(client: any, operation: MappedOperation) {
  const names = operation.sdk.ts.split('.');
  let target = client;
  for (const name of names.slice(0, -1)) target = target[name];
  const method = target[names.at(-1)!];
  expect(typeof method, operation.sdk.ts).toBe('function');
  const args: unknown[] = operation.params.filter((p) => p.in === 'path').map((p) => VALUES[p.api]);
  const rest = operation.params.filter((p) => p.in !== 'path' && p.in !== 'header');
  const headers = operation.params.filter((p) => p.in === 'header');
  if (rest.length > 0) args.push(Object.fromEntries(rest.map((p) => [p.ts, VALUES[p.api]])));
  if (headers.length > 0) args.push(Object.fromEntries(headers.map((p) => [p.ts, VALUES[p.api]])));
  return method.apply(target, args);
}

describe.each(Object.entries(mapping))('%s', (operationId, operation) => {
  it(`is ${operation.sdk.ts}() and sends ${operation.method} ${operation.path}`, async () => {
    const { client, requests } = makeClient(respond(operation));
    await invoke(client, operation);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;

    expect(request.method).toBe(operation.method);
    let path = operation.path;
    for (const p of operation.params.filter((q) => q.in === 'path')) {
      path = path.replace(`{${p.api}}`, encodeURIComponent(String(VALUES[p.api])));
    }
    expect(request.url.pathname).toBe(path);
    expect(request.url.origin).toBe('https://api.echonova.ai');

    const query = Object.fromEntries(request.url.searchParams);
    const expectedQuery = Object.fromEntries(
      operation.params.filter((p) => p.in === 'query').map((p) => [p.api, String(VALUES[p.api])]),
    );
    expect(query).toEqual(expectedQuery);
    for (const p of operation.params.filter((q) => q.in === 'header')) {
      expect(request.headers.get(p.api), p.api).toBe(VALUES[p.api]);
    }
    expect(request.headers.has('idempotency-key')).toBe(operation.idempotency_key);

    const json = operation.params.filter((p) => p.in === 'json');
    const form = operation.params.filter((p) => p.in === 'form');
    if (json.length > 0) {
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(String(request.init.body))).toEqual(Object.fromEntries(json.map((p) => [p.api, VALUES[p.api]])));
    } else if (form.length > 0) {
      expect(request.init.redirect).toBe('error');
      const { fields, file, names } = await partsOf(request);
      expect(fields).toEqual(
        Object.fromEntries(form.filter((p) => p.api !== 'file').map((p) => [p.api, formValue(VALUES[p.api])])),
      );
      expect(names.at(-1)).toBe('file'); // fields first, so the server reads them before the audio
      expect(file?.name).toBe('audio.wav');
      expect(file?.type).toBe('audio/wav');
      expect(new Uint8Array(await file!.arrayBuffer())).toEqual(WAV);
    } else {
      expect(request.init.body).toBeUndefined();
    }
    expect(operationId).toMatch(/^V1/);
  });
});

describe('the operation table', () => {
  it('names every mapped operation and nothing else', () => {
    const fromMapping = Object.values(mapping).map((o) => `${o.method} ${o.path} ${o.sdk.ts}`).sort();
    const fromTable = Object.values(OPS).map((o) => `${o.method} ${o.path} ${o.name}`).sort();
    expect(fromTable).toEqual(fromMapping);
  });

  it('marks the operations that accept an Idempotency-Key', () => {
    const fromMapping = Object.values(mapping).filter((o) => o.idempotency_key).map((o) => o.sdk.ts).sort();
    const fromTable = Object.values(OPS).filter((o) => 'idempotencyKey' in o && o.idempotencyKey).map((o) => o.name).sort();
    expect(fromTable).toEqual(fromMapping);
    expect(fromTable).toEqual(['soundCleaning.clean', 'speechToText.transcribe', 'textToSpeech.generate']);
  });

  it('sends only the parameters that are set', async () => {
    const { client, requests } = makeClient((request) =>
      request.method === 'GET'
        ? ok({ items: [], total: 0 })
        : ok({ jobId: JOB_ID, status: 'completed', id: JOB_ID, ticket: 't', token: 'x' }),
    );
    await client.textToSpeech.generate({ text: 'hi', voiceId: 'v1', speed: undefined });
    await client.speechToText.transcribe({ file: WAV });
    await client.soundCleaning.clean({ file: WAV, targetLufs: undefined });
    await client.widgets.createTicket('wdg_1');
    await client.agents.sessions.start('a1');
    await client.textToSpeech.jobs.list();
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ text: 'hi', voiceId: 'v1' });
    expect((await partsOf(requests[1]!)).fields).toEqual({}); // no language: the API's default (auto) applies
    expect((await partsOf(requests[2]!)).fields).toEqual({});
    expect(JSON.parse(String(requests[3]!.init.body))).toEqual({});
    expect(JSON.parse(String(requests[4]!.init.body))).toEqual({});
    expect(requests[5]!.url.search).toBe('');
  });

  it('language is optional: left out, no field is sent and the API detects it (auto)', async () => {
    const { client, requests } = makeClient(() =>
      ok({ jobId: JOB_ID, status: 'completed', transcription: 'hi', language: 'auto', segments: [], speakers: [] }),
    );
    const result = await client.speechToText.transcribe({ file: WAV });
    await client.speechToText.jobs.create({ file: WAV, numbersAsDigits: false });
    await client.speechToText.transcribe({ file: WAV, language: 'auto' });
    await client.speechToText.jobs.create({ file: WAV, language: 'auto' });
    const fields = await Promise.all(requests.map(async (r) => (await partsOf(r)).fields));
    expect(fields).toEqual([{}, { numbers_as_digits: 'false' }, { language: 'auto' }, { language: 'auto' }]);
    const language: Language = result.language!; // results may report 'auto'
    expect(language).toBe('auto');
  });

  it('sends terminology given as a string unchanged', async () => {
    const { client, requests } = makeClient(() => ok({ jobId: JOB_ID, status: 'pending' }));
    await client.speechToText.jobs.create({ file: WAV, language: 'en', terminology: '{"keywords":[]}' });
    expect((await partsOf(requests[0]!)).fields['terminology']).toBe('{"keywords":[]}');
  });

  it('accepts a job object wherever a job ID is expected', async () => {
    const { client, requests } = makeClient(() => ok({ id: JOB_ID, status: 'completed' }));
    await client.textToSpeech.jobs.get({ jobId: JOB_ID });
    await client.speechToText.jobs.get({ id: JOB_ID });
    expect(requests.map((r) => r.url.pathname)).toEqual([
      `/v1/text-to-speech/jobs/${JOB_ID}`,
      `/v1/speech-to-text/jobs/${JOB_ID}`,
    ]);
    await expect(client.textToSpeech.jobs.get('  ')).rejects.toThrow(/job ID/);
    await expect(client.agents.sessions.get('', 's1')).rejects.toThrow(/agentId/);
  });

  it.each([
    [OPS.ttsJobsGet, null, 50_000],
    [OPS.sttJobsExport, null, 80_000],
    [OPS.ttsJobsCreate, null, 50_000],
    [OPS.ttsGenerate, null, 260_000], // 240 s to answer: above the 220 s after which the API answers 202
    [OPS.sttJobsCreate, 1000, 190_000],
    [OPS.sttTranscribe, 1000, 670_000],
    [OPS.clean, 100 * 1024 * 1024, 810_000],
    [OPS.clean, null, 910_000],
    [OPS.agentSessionsStart, null, 50_000],
  ] as const)('derives the attempt deadline for %o', (operation, bytes, expected) => {
    expect(attemptTimeout(operation, bytes)).toBe(expected);
  });
});
