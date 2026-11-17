// Response models against openapi.json: every documented field is in the TypeScript interface
// (checked by the compiler and here), optional exactly when the spec says so, and every
// operation parses an example synthesised from its schema.
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import * as errors from '../src/errors.js';
import type * as M from '../src/types/models.js';
import { loadSpec } from './helpers.js';
import { dataSchema, exampleFor, JOB_ID, makeClient, OPENAPI, ok, resolve, schemaProperties, WAV } from './rest-support.js';

// --- Compile-time field lists ------------------------------------------------------------------

// `requestId` is added by the SDK to results; on a nested model (`TtsJobStream`) it is an API field.
type SdkOnly<T> = (T extends { requestId: infer R } ? (null extends R ? 'requestId' : never) : never) | 'alreadyDeleted' | typeof Symbol.iterator;
type Fields<T> = Exclude<keyof T, SdkOnly<T>>;
type RequiredFields<T> = Exclude<{ [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T], SdkOnly<T>>;

/** Every field of `T`, and nothing else: the compiler rejects a missing or unknown name. */
const fields =
  <T>() =>
  <const A extends readonly Fields<T>[]>(names: A & ([Fields<T>] extends [A[number]] ? unknown : 'missing a field')) =>
    names as readonly string[];
/** Exactly the non-optional fields of `T`. */
const required =
  <T>() =>
  <const A extends readonly RequiredFields<T>[]>(
    names: A & ([RequiredFields<T>] extends [A[number]] ? unknown : 'missing a required field'),
  ) =>
    names as readonly string[];

interface ModelCase {
  schema: string;
  fields: readonly string[];
  required: readonly string[];
}

const MODELS: Record<string, ModelCase> = {
  SyncProcessing: {
    schema: 'V1SyncProcessingResponseDto',
    fields: fields<M.SyncProcessing>()(['jobId', 'status', 'resultUrl']),
    required: required<M.SyncProcessing>()(['jobId', 'status', 'resultUrl']),
  },
  JobInitiated: {
    schema: 'V1JobInitiatedResponseDto',
    fields: fields<M.JobInitiated>()(['jobId', 'status']),
    required: required<M.JobInitiated>()(['jobId', 'status']),
  },
  TtsResult: {
    schema: 'V1TtsSyncResponseDto',
    fields: fields<M.TtsResult>()(['jobId', 'status', 'audioUrl', 'durationSeconds', 'creditsConsumed']),
    required: required<M.TtsResult>()(['jobId', 'status', 'audioUrl', 'creditsConsumed']),
  },
  Voice: {
    schema: 'V1VoiceResponseDto',
    fields: fields<M.Voice>()(['id', 'name', 'displayName', 'language', 'gender', 'previewUrl']),
    required: required<M.Voice>()(['id', 'name', 'language']),
  },
  TtsJobStream: {
    schema: 'V1TtsJobStreamDto',
    fields: fields<M.TtsJobStream>()(['sessionId', 'requestId', 'cancelled', 'audioDropped']),
    required: required<M.TtsJobStream>()(['sessionId', 'requestId']),
  },
  TtsJob: {
    schema: 'V1TtsJobResponseDto',
    fields: fields<M.TtsJob>()([
      'id', 'status', 'text', 'voiceId', 'audioUrl', 'durationSeconds', 'creditsConsumed', 'error', 'stream', 'createdAt',
    ]),
    required: required<M.TtsJob>()(['id', 'status', 'text', 'voiceId', 'creditsConsumed', 'createdAt']),
  },
  DeleteResult: {
    schema: 'V1DeleteJobResponseDto',
    fields: fields<M.DeleteResult>()(['deleted']),
    required: required<M.DeleteResult>()(['deleted']),
  },
  SttSegment: {
    schema: 'V1SttSegmentDto',
    fields: fields<M.SttSegment>()(['start', 'end', 'text', 'speaker']),
    required: required<M.SttSegment>()(['start', 'end', 'text', 'speaker']),
  },
  SttSpeaker: {
    schema: 'V1SttSpeakerDto',
    fields: fields<M.SttSpeaker>()(['id', 'talkTime']),
    required: required<M.SttSpeaker>()(['id', 'talkTime']),
  },
  TerminologyEdit: {
    schema: 'SttTerminologyEditDto',
    fields: fields<M.TerminologyEdit>()(['start', 'end', 'original', 'replacement', 'stage', 'score']),
    required: required<M.TerminologyEdit>()(['start', 'end', 'original', 'replacement', 'stage', 'score']),
  },
  TerminologyNearMiss: {
    schema: 'SttTerminologyNearMissDto',
    fields: fields<M.TerminologyNearMiss>()(['start', 'end', 'original', 'candidate', 'score']),
    required: required<M.TerminologyNearMiss>()(['start', 'end', 'original', 'candidate', 'score']),
  },
  TerminologyWarning: {
    schema: 'SttTerminologyWarningDto',
    fields: fields<M.TerminologyWarning>()(['code', 'detail']),
    required: required<M.TerminologyWarning>()(['code', 'detail']),
  },
  TerminologyResult: {
    schema: 'SttTerminologyResultDto',
    fields: fields<M.TerminologyResult>()(['raw', 'corrected', 'edits', 'nearMisses', 'warnings', 'mapperStatus', 'mapperVersion']),
    required: required<M.TerminologyResult>()(['raw', 'corrected', 'edits', 'nearMisses', 'warnings', 'mapperStatus', 'mapperVersion']),
  },
  SttResult: {
    schema: 'V1SttSyncResponseDto',
    fields: fields<M.SttResult>()([
      'jobId', 'status', 'transcription', 'durationSeconds', 'language', 'numbersAsDigits', 'identifySpeakers',
      'segments', 'speakers', 'terminology', 'creditsConsumed',
    ]),
    required: required<M.SttResult>()([
      'jobId', 'status', 'transcription', 'language', 'numbersAsDigits', 'identifySpeakers', 'segments', 'speakers', 'creditsConsumed',
    ]),
  },
  SttJobStream: {
    schema: 'V1SttJobStreamDto',
    fields: fields<M.SttJobStream>()(['sessionId']),
    required: required<M.SttJobStream>()(['sessionId']),
  },
  SttJob: {
    schema: 'V1SttJobResponseDto',
    fields: fields<M.SttJob>()([
      'id', 'status', 'transcription', 'durationSeconds', 'language', 'numbersAsDigits', 'identifySpeakers', 'segments',
      'speakers', 'terminology', 'stream', 'audioUrl', 'creditsConsumed', 'error', 'createdAt',
    ]),
    required: required<M.SttJob>()([
      'id', 'status', 'language', 'numbersAsDigits', 'identifySpeakers', 'segments', 'speakers', 'creditsConsumed', 'createdAt',
    ]),
  },
  CleanJobOptions: {
    schema: 'CleanOptionsResponseDto',
    fields: fields<M.CleanJobOptions>()([
      'cutoffFreq', 'qFactor', 'targetLufs', 'truePeakDbfs', 'compThreshDb', 'compRatio', 'compAttackMs', 'compReleaseMs',
    ]),
    required: required<M.CleanJobOptions>()([]),
  },
  CleanMetrics: {
    schema: 'CleanMetricsResponseDto',
    fields: fields<M.CleanMetrics>()(['sampleRate', 'bitDepth', 'integratedLufs', 'truePeakDbfs']),
    required: required<M.CleanMetrics>()([]),
  },
  CleanJob: {
    schema: 'V1CleanJobResponseDto',
    fields: fields<M.CleanJob>()([
      'id', 'status', 'fileName', 'outputUrl', 'durationSeconds', 'creditsConsumed', 'options', 'metrics', 'error', 'createdAt',
    ]),
    required: required<M.CleanJob>()(['id', 'status', 'fileName', 'creditsConsumed', 'createdAt']),
  },
  WidgetTicket: {
    schema: 'WidgetTicketResponseDto',
    fields: fields<M.WidgetTicket>()(['ticket', 'expiresAt']),
    required: required<M.WidgetTicket>()(['ticket', 'expiresAt']),
  },
  AgentSession: {
    schema: 'V1AgentSessionResponseDto',
    fields: fields<M.AgentSession>()(['id', 'agentId', 'channel', 'status', 'startedAt', 'endedAt']),
    required: required<M.AgentSession>()(['id', 'agentId', 'channel', 'status', 'startedAt', 'endedAt']),
  },
  StartedAgentSession: {
    schema: 'V1StartedSessionResponseDto',
    fields: fields<M.StartedAgentSession>()(['id', 'agentId', 'channel', 'status', 'startedAt', 'endedAt', 'token', 'wsUrl', 'greeting']),
    required: required<M.StartedAgentSession>()([
      'id', 'agentId', 'channel', 'status', 'startedAt', 'endedAt', 'token', 'wsUrl', 'greeting',
    ]),
  },
};

const LIST_FIELDS = fields<M.VoiceList>()(['items', 'total']);

/** Schemas only the operations spec/mapping.json leaves out (`excluded`, e.g. agent management) use. */
function excludedOnlySchemas(): Set<string> {
  const operations = loadSpec<{ operations: Record<string, { method: string; path: string; excluded?: string }> }>('mapping.json');
  const excluded = new Set(Object.values(operations.operations).filter((o) => o.excluded).map((o) => `${o.method} ${o.path}`));
  const reach = (value: unknown, into: Set<string>): void => {
    if (Array.isArray(value)) {
      for (const item of value) reach(item, into);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        const name = key === '$ref' && typeof item === 'string' ? item.split('/').pop()! : null;
        if (name === null) {
          reach(item, into);
        } else if (!into.has(name)) {
          into.add(name);
          reach(OPENAPI.components.schemas[name], into);
        }
      }
    }
  };
  const used = new Set<string>();
  const onlyExcluded = new Set<string>();
  for (const [path, item] of Object.entries(OPENAPI.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      reach(operation, excluded.has(`${method.toUpperCase()} ${path}`) ? onlyExcluded : used);
    }
  }
  return new Set([...onlyExcluded].filter((name) => !used.has(name)));
}

describe('every response schema has a matching interface', () => {
  it.each(Object.entries(MODELS))('%s', (_name, model) => {
    const schema = OPENAPI.components.schemas[model.schema]!;
    expect([...model.fields].sort()).toEqual(Object.keys(schemaProperties(schema)).sort());
    expect([...model.required].sort()).toEqual([...(schema['required'] ?? [])].sort());
  });

  it('covers every schema in the spec except requests, envelopes, errors and excluded operations', () => {
    const covered = new Set([...Object.values(MODELS).map((m) => m.schema), ...excludedOnlySchemas()]);
    const requests = /^(V1GenerateSpeech|V1GenerateSpeechSync|MintWidgetTicket|MintWidgetTicketUser|V1StartSession)Dto$/;
    const missing = Object.keys(OPENAPI.components.schemas).filter(
      (name) => !covered.has(name) && !requests.test(name) && !/^(GlobalResponseSwagger|V1ErrorResponse)Dto$/.test(name),
    );
    expect(missing).toEqual([]);
  });

  it('lists have items and total', () => {
    for (const path of ['/v1/text-to-speech/voices', '/v1/text-to-speech/jobs', '/v1/speech-to-text/jobs', '/v1/sound-cleaning/jobs']) {
      expect(Object.keys(schemaProperties(dataSchema(path, 'GET'))).sort()).toEqual([...LIST_FIELDS].sort());
    }
  });
});

// --- Every operation parses its synthesised example --------------------------------------------

const CALLS: Array<[string, string, (client: any) => PromiseLike<any>]> = [
  ['/v1/text-to-speech', 'POST', (c) => c.textToSpeech.jobs.create({ text: 'hi', voiceId: 'v' })],
  ['/v1/text-to-speech/sync', 'POST', (c) => c.textToSpeech.generate({ text: 'hi', voiceId: 'v' })],
  ['/v1/text-to-speech/jobs/{jobId}', 'GET', (c) => c.textToSpeech.jobs.get(JOB_ID)],
  ['/v1/text-to-speech/jobs/{jobId}', 'DELETE', (c) => c.textToSpeech.jobs.delete(JOB_ID)],
  ['/v1/speech-to-text', 'POST', (c) => c.speechToText.jobs.create({ file: WAV, language: 'en' })],
  ['/v1/speech-to-text/sync', 'POST', (c) => c.speechToText.transcribe({ file: WAV, language: 'en' })],
  ['/v1/speech-to-text/jobs/{jobId}', 'GET', (c) => c.speechToText.jobs.get(JOB_ID)],
  ['/v1/speech-to-text/jobs/{jobId}', 'DELETE', (c) => c.speechToText.jobs.delete(JOB_ID)],
  ['/v1/sound-cleaning', 'POST', (c) => c.soundCleaning.clean({ file: WAV })],
  ['/v1/sound-cleaning/jobs/{jobId}', 'GET', (c) => c.soundCleaning.jobs.get(JOB_ID)],
  ['/v1/sound-cleaning/jobs/{jobId}', 'DELETE', (c) => c.soundCleaning.jobs.delete(JOB_ID)],
  ['/v1/widgets/{publicId}/tickets', 'POST', (c) => c.widgets.createTicket('wdg_1')],
  ['/v1/agents/{agentId}/sessions', 'POST', (c) => c.agents.sessions.start('a1')],
  ['/v1/agents/{agentId}/sessions/{sessionId}', 'GET', (c) => c.agents.sessions.get('a1', 's1')],
  ['/v1/agents/{agentId}/sessions/{sessionId}/end', 'POST', (c) => c.agents.sessions.end('a1', 's1')],
];

describe('every operation parses the example synthesised from its schema', () => {
  it.each(CALLS)('%s %s', async (path, method, call) => {
    const example = exampleFor(dataSchema(path, method));
    const { client } = makeClient(() => ok(example, {}, 'req-9'));
    const result = await call(client);
    const extra = method === 'DELETE' ? { alreadyDeleted: false } : {};
    expect({ ...result }).toEqual({ ...example, ...extra, requestId: 'req-9' });
  });

  it.each([
    ['/v1/text-to-speech/jobs', (c: any) => c.textToSpeech.jobs.list()],
    ['/v1/speech-to-text/jobs', (c: any) => c.speechToText.jobs.list()],
    ['/v1/sound-cleaning/jobs', (c: any) => c.soundCleaning.jobs.list()],
  ])('lists %s', async (path, call) => {
    const example = exampleFor(dataSchema(path, 'GET'));
    const { client } = makeClient(() => ok(example, {}, 'req-9'));
    const page = await call(client);
    expect(page.total).toBe(example.total);
    expect(page.items).toEqual(example.items.map((item: object) => ({ ...item, requestId: 'req-9' })));
    expect(page.requestId).toBe('req-9');
  });

  it('voices', async () => {
    const example = exampleFor(dataSchema('/v1/text-to-speech/voices', 'GET'));
    const { client } = makeClient(() => ok(example, {}, 'req-9'));
    const voices = await client.textToSpeech.voices.list();
    expect(voices.items).toEqual(example.items);
    expect(voices.total).toBe(example.total);
    expect(voices.requestId).toBe('req-9');
    expect([...voices]).toEqual(example.items);
    expect(JSON.parse(JSON.stringify(voices))).toEqual({ ...example, requestId: 'req-9' });
  });

  it('the JSON transcript export matches the documented example', async () => {
    const content = OPENAPI.paths['/v1/speech-to-text/jobs/{jobId}/export']!['get']['responses']['200']['content'];
    const example = content['application/json']['example'];
    const { client } = makeClient(() => new Response(JSON.stringify(example), { headers: { 'X-Request-Id': 'r' } }));
    const exported = await client.speechToText.jobs.export(JOB_ID, { format: 'json' });
    expect({ ...exported }).toEqual({ ...example, requestId: 'r' });
    expect(exported.speakers?.[0]?.label).toBe('Speaker 1');
    expect(exported.segments?.[1]?.speakerLabel).toBe('Speaker 2');
    const exportFields = fields<M.TranscriptExport>()(['id', 'fileName', 'durationSeconds', 'language', 'text', 'speakers', 'segments']);
    expect(Object.keys(example).sort()).toEqual([...exportFields].sort());
    expect(Object.keys(example.speakers[0]).sort()).toEqual([...fields<M.TranscriptExportSpeaker>()(['id', 'label', 'talkTime'])].sort());
    expect(Object.keys(example.segments[0]).sort()).toEqual(
      [...fields<M.TranscriptExportSegment>()(['start', 'end', 'speaker', 'speakerLabel', 'text'])].sort(),
    );
  });

  it('values from the examples survive unchanged', async () => {
    const job = exampleFor(resolve({ $ref: '#/components/schemas/V1TtsJobResponseDto' }));
    const { client } = makeClient(() => ok(job));
    const parsed = await client.textToSpeech.jobs.get(JOB_ID);
    expect(parsed.createdAt).toBe(job.createdAt);
    expect(parsed.stream).toEqual(job.stream);
    expect(Number.isInteger(parsed.creditsConsumed)).toBe(true);
  });
});

describe('lenient parsing', () => {
  it('keeps unknown fields and leaves missing ones undefined', async () => {
    const { client } = makeClient(() => ok({ id: 'j1', status: 'processing', newField: { x: 1 } }));
    const job = await client.speechToText.jobs.get('j1');
    expect(job.transcription).toBeUndefined();
    expect(job.segments).toBeUndefined();
    expect((job as unknown as Record<string, unknown>)['newField']).toEqual({ x: 1 });
  });

  it('accepts unknown status values', async () => {
    const { client } = makeClient(() => ok({ id: 'j', status: 'queued' }));
    expect((await client.textToSpeech.jobs.get('j')).status).toBe('queued');
  });

  it.each([
    ['TtsJob', (c: any) => c.textToSpeech.jobs.get('j'), { status: 'completed' }, 'id'],
    ['SttJob', (c: any) => c.speechToText.jobs.get('j'), { id: 'j' }, 'status'],
    ['CleanJob', (c: any) => c.soundCleaning.jobs.get('j'), { status: 'completed' }, 'id'],
    ['JobInitiated', (c: any) => c.textToSpeech.jobs.create({ text: 't', voiceId: 'v' }), { status: 'pending' }, 'jobId'],
    ['StartedAgentSession', (c: any) => c.agents.sessions.start('a'), { id: 's', status: 'active' }, 'token'],
  ])('a %s without the fields the SDK needs is a protocol error', async (_name, call, data, field) => {
    const { client, requests } = makeClient(() => ok(data));
    const error = await call(client).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(errors.ProtocolError);
    expect(error.message).toContain(`missing '${field}'`);
    expect(requests.length).toBe(requests[0]!.method === 'GET' ? 2 : 1); // a GET is retried once; a POST that ran never
  });

  it('a list result that is not a list is a protocol error', async () => {
    const { client } = makeClient(() => ok(['not', 'a', 'page']));
    await expect(client.textToSpeech.jobs.list()).rejects.toBeInstanceOf(errors.ProtocolError);
  });

  it('never copies an agent session token into an error or a log', async () => {
    const logs: string[] = [];
    const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: (m: string) => void logs.push(m) };
    const body = { status: 'active', token: 'eyJ-SECRET-ROOM-TOKEN', wsUrl: 'wss://rooms.example.com' };
    const { client } = makeClient(() => ok(body), { logLevel: 'debug', logger });
    const error = await client.agents.sessions.start('a1').then(
      () => null,
      (e: unknown) => e as errors.ProtocolError,
    );
    expect(error).toBeInstanceOf(errors.ProtocolError);
    expect(error!.mayHaveExecuted).toBe(true);
    expect(error!.rawBody).toBeNull();
    for (const text of [String(error), inspect(error, { depth: 5 }), JSON.stringify(error), logs.join('\n')]) {
      expect(text).not.toContain('SECRET-ROOM-TOKEN');
    }
  });

  it('shows a started session token as [secret] in inspect, but keeps it in JSON', async () => {
    const body = exampleFor(resolve({ $ref: '#/components/schemas/V1StartedSessionResponseDto' }));
    const { client } = makeClient(() => ok({ ...body, token: 'eyJ-SECRET-ROOM-TOKEN' }));
    const session = await client.agents.sessions.start('a1', { channel: 'voice' });
    expect(session.token).toBe('eyJ-SECRET-ROOM-TOKEN');
    expect(inspect(session)).not.toContain('SECRET');
    expect(inspect(session)).toContain('[secret]');
    expect(JSON.parse(JSON.stringify(session)).token).toBe('eyJ-SECRET-ROOM-TOKEN');
  });
});
