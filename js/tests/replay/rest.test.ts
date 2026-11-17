// Replays every recorded REST call in spec/fixtures/rest/ through the SDK method for its
// operation (spec/mapping.json, matched by method and templated path), with `fetch` answering
// exactly what the live API answered. Each test checks the result or error against
// spec/fixtures/expected.json, and the request the SDK sent against the recorded one.
import { describe, expect, it } from 'vitest';
import type { APIPromise } from '../../src/core/api-promise.js';
import { EXTENSION_TYPES, toFile, type FileUpload } from '../../src/core/files.js';
import { Page } from '../../src/core/pagination.js';
import { ERROR_CLASSES, UsageError, type ErrorClassName } from '../../src/errors.js';
import { loadSpec } from '../helpers.js';
import { caught, makeClient, partsOf, TEST_KEY, type Captured } from '../rest-support.js';
import { EXPECTED, fixtureNames, itCoversEveryFixture, readFixture, type RestExpectation } from './fixtures.js';

interface RecordedFile {
  field: string;
  filename: string;
  content_type: string;
  bytes: number;
}

interface RestFixture {
  name: string;
  note?: string;
  request: {
    method: string;
    path: string;
    query?: Record<string, string | number | boolean>;
    json?: Record<string, unknown>;
    /** Multipart text fields, as sent. */
    form?: Record<string, string>;
    /** The multipart file part: its content is stored as a byte count only. */
    file?: RecordedFile;
    /** A raw (non-JSON, non-multipart) body: byte count and content type only. */
    content?: { bytes: number; content_type: string | null };
    authorization: 'test key' | 'none' | 'other key';
  };
  response: {
    status: number;
    headers: Record<string, string>;
    json?: unknown;
    text?: string;
    bytes?: number;
  };
}

interface MappedParam {
  api: string;
  in: 'path' | 'query' | 'json' | 'form';
  required: boolean;
  ts: string;
}

interface MappedOperation {
  method: string;
  path: string;
  sdk: { ts: string };
  params: MappedParam[];
}

const OPERATIONS = Object.values(loadSpec<{ operations: Record<string, MappedOperation> }>('mapping.json').operations);

/**
 * Recordings that deliberately send what the SDK's REST API can't. The SDK has no `extraBody`
 * for REST, sends only JSON to JSON endpoints, and refuses a generic upload type, so for these
 * the part it can't send is left out: the rest of the request is still checked, and the
 * recorded response is replayed in full (only the response handling is tested for that part).
 * The test fails if the SDK can't send something a recording not listed here sent.
 *
 * Other recordings send values the TypeScript types rule out or the API rejects: `format: 'vtt'`,
 * `limit: 101`, `targetLufs: 0`, 501 characters of text, the job ID `not-an-id`, terminology
 * `{"keywords": 5}`. The SDK leaves validation to the API, so these go out exactly as recorded and
 * their requests are checked like any other. stt/sync_missing_language sends no `language`, as the
 * SDK does when it is left out (it was recorded when the API still required one).
 *
 * The SDK adds an `Idempotency-Key` to the calls that accept one (ADR 0014); the recordings, made
 * before the API took one, have none. Headers other than Authorization aren't compared.
 */
const CANNOT_SEND: Readonly<Record<string, string>> = {
  'tts/sync_unknown_field': 'the unknown JSON field `foo`: REST methods send documented parameters only',
  'tts/sync_not_json': 'a 5-byte text/plain body: the SDK always sends JSON (here {"text":"hello",...})',
  'clean/clean_unknown_field': 'the unknown form field `foo`: REST methods send documented parameters only',
  'stt/sync_octet_stream_mp3':
    'an application/octet-stream file part: the SDK refuses a generic type with UsageError, so the replay sends the mp3 as audio/mpeg',
};

/** Stand-ins for required parameters when the recording sent a non-JSON body instead (tts/sync_not_json). */
const PLACEHOLDERS: Readonly<Record<string, string>> = { text: 'hello', voiceId: '000000000000000000000001' };

const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The one operation whose method and templated path match the recorded request, with its path parameters. */
function operationFor(method: string, path: string): { operation: MappedOperation; pathParams: Record<string, string> } {
  const matches: Array<{ operation: MappedOperation; pathParams: Record<string, string> }> = [];
  for (const operation of OPERATIONS) {
    if (operation.method !== method) continue;
    const source = operation.path
      .split(/(\{\w+\})/)
      .map((part) => (/^\{\w+\}$/.test(part) ? `(?<${part.slice(1, -1)}>[^/]+)` : escapeRegExp(part)))
      .join('');
    const match = new RegExp(`^${source}$`).exec(path);
    if (!match) continue;
    const pathParams = Object.fromEntries(Object.entries(match.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    matches.push({ operation, pathParams });
  }
  expect(
    matches.map((m) => m.operation.sdk.ts),
    `operations matching ${method} ${path}`,
  ).toHaveLength(1);
  return matches[0]!;
}

/** A multipart field's value as the SDK takes it: the SDK turns it back into the same string. */
function formValue(value: string): unknown {
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value; // text, and terminology as a JSON string (the SDK sends a string unchanged)
}

const extensionOf = (name: string): string => /\.[^.]+$/.exec(name)?.[0].toLowerCase() ?? '';

interface Call {
  args: unknown[];
  /** What the SDK can't send as recorded (empty when it sends the whole request). */
  unsent: string[];
  unsentFields: Set<string>;
  /** The file part's content type the SDK sends. */
  fileType: string | null;
}

/** Arguments for the SDK method: path parameters, then one object with the rest, then request options. */
function buildCall(fixture: RestFixture, operation: MappedOperation, pathParams: Record<string, string>): Call {
  const { request } = fixture;
  const params: Record<string, unknown> = {};
  const unsent: string[] = [];
  const unsentFields = new Set<string>();
  const take = (where: 'query' | 'json' | 'form', values: Record<string, unknown> | undefined, convert = (v: unknown) => v) => {
    for (const [api, value] of Object.entries(values ?? {})) {
      const param = operation.params.find((p) => p.in === where && p.api === api);
      if (param) {
        params[param.ts] = convert(value);
      } else {
        unsent.push(`${where} field ${api}`);
        unsentFields.add(api);
      }
    }
  };
  take('query', request.query);
  take('json', request.json);
  take('form', request.form, (v) => formValue(String(v)));

  if (request.content) {
    unsent.push(`a ${request.content.content_type ?? 'raw'} body`);
    for (const p of operation.params) {
      if (p.required && p.in === 'json' && !(p.ts in params)) params[p.ts] = PLACEHOLDERS[p.api];
    }
  }

  let fileType: string | null = null;
  if (request.file) {
    const file = request.file;
    const param = operation.params.find((p) => p.in === 'form' && p.api === file.field);
    expect(param, `${operation.sdk.ts} has no file parameter ${file.field}`).toBeDefined();
    // Zero-filled content of the recorded size: the SDK takes the type from the name or an explicit type, not these bytes.
    const content = new Uint8Array(file.bytes);
    const fromName = EXTENSION_TYPES[extensionOf(file.filename)] ?? null;
    let upload: FileUpload;
    if (fromName === file.content_type) {
      upload = toFile(content, file.filename); // the SDK picks the recorded type from the name, as for any user
      fileType = fromName;
    } else if (GENERIC_TYPES.has(file.content_type)) {
      unsent.push(`content type ${file.content_type}`);
      upload = toFile(content, file.filename);
      fileType = fromName;
    } else {
      upload = toFile(content, file.filename, { type: file.content_type }); // explicit type: the escape hatch
      fileType = file.content_type;
    }
    params[param!.ts] = upload;
  }

  const args: unknown[] = operation.params.filter((p) => p.in === 'path').map((p) => pathParams[p.api]);
  if (operation.params.some((p) => p.in !== 'path')) args.push(params);
  expect(['test key', 'none'], 'recorded authorization').toContain(request.authorization);
  // No key at all: the documented per-call way to drop a header.
  args.push(request.authorization === 'none' ? { headers: { Authorization: null } } : {});
  return { args, unsent, unsentFields, fileType };
}

function methodFor(client: unknown, path: string): (...args: unknown[]) => APIPromise<unknown> {
  const names = path.split('.');
  let target = client as Record<string, unknown>;
  for (const name of names.slice(0, -1)) target = target[name] as Record<string, unknown>;
  const method = target[names.at(-1)!];
  expect(typeof method, path).toBe('function');
  return (method as (...args: unknown[]) => APIPromise<unknown>).bind(target);
}

function recordedResponse(response: RestFixture['response']): Response {
  const body =
    response.json !== undefined
      ? JSON.stringify(response.json)
      : response.text !== undefined
        ? response.text
        : new Uint8Array(response.bytes ?? 0);
  return new Response(body, { status: response.status, headers: response.headers });
}

const omit = <T>(values: Record<string, T>, keys: Set<string>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).filter(([k]) => !keys.has(k)).map(([k, v]) => [k, String(v)]));

/** The result holds the recorded data, field for field, plus only what the SDK adds (`requestId`). */
function checkResult(fixture: RestFixture, operation: MappedOperation, data: any, requestId: string): void {
  const { request, response } = fixture;
  if (operation.sdk.ts.endsWith('.export')) {
    if (response.text !== undefined) {
      expect(data).toBe(response.text); // txt and srt come back as the recorded text
    } else {
      const { requestId: rid, ...exported } = data;
      expect(rid).toBe(requestId);
      expect(exported).toStrictEqual(response.json);
    }
    return;
  }
  const recorded = (response.json as { data: any }).data;
  if (data instanceof Page) {
    const items = data.items.map(({ requestId: rid, ...item }: any) => {
      expect(rid).toBe(requestId);
      return item;
    });
    expect(items).toStrictEqual(recorded.items);
    expect(data.total).toBe(recorded.total ?? null);
    expect(data.requestId).toBe(requestId);
    expect(data.offset).toBe(Number(request.query?.['offset'] ?? 0));
    expect(data.limit).toBe(request.query?.['limit'] === undefined ? null : Number(request.query['limit']));
    return;
  }
  const { requestId: rid, alreadyDeleted, ...fields } = data;
  expect(rid).toBe(requestId);
  expect(alreadyDeleted).toBe(operation.method === 'DELETE' ? false : undefined);
  expect(fields).toStrictEqual(recorded);
}

function checkError(fixture: RestFixture, expected: RestExpectation, error: any, requestId: string): void {
  const name = expected.error as ErrorClassName;
  expect(ERROR_CLASSES[name], `unknown error class ${name}`).toBeDefined();
  expect(error).toBeInstanceOf(ERROR_CLASSES[name]);
  expect(error.name).toBe(name); // that class exactly, not a subclass
  expect(error.statusCode).toBe(fixture.response.status);
  expect(error.errorMessage).toBe((fixture.response.json as { errorMessage: string | null }).errorMessage);
  expect(error.requestId).toBe(requestId);
}

/** The request the SDK sent matches the recording, except for what it can't send. */
async function checkRequest(sent: Captured, fixture: RestFixture, call: Call): Promise<void> {
  const { request } = fixture;
  expect(sent.method).toBe(request.method);
  expect(sent.url.origin).toBe('https://api.echonova.ai');
  expect(sent.url.pathname).toBe(request.path);
  expect(Object.fromEntries(sent.url.searchParams)).toStrictEqual(omit(request.query ?? {}, call.unsentFields));
  expect(sent.headers.get('authorization')).toBe(request.authorization === 'none' ? null : `Bearer ${TEST_KEY}`);
  if (request.json !== undefined || request.content !== undefined) {
    expect(sent.headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(sent.init.body)) as Record<string, unknown>;
    if (request.json !== undefined) {
      const recorded = Object.fromEntries(Object.entries(request.json).filter(([k]) => !call.unsentFields.has(k)));
      expect(body).toStrictEqual(recorded);
    }
  } else if (request.file !== undefined) {
    const { fields, file, names } = await partsOf(sent);
    expect(fields).toStrictEqual(omit(request.form ?? {}, call.unsentFields));
    expect(names.at(-1)).toBe(request.file.field);
    expect(file?.name).toBe(request.file.filename);
    expect(file?.type).toBe(call.fileType);
    expect(file?.size).toBe(request.file.bytes);
  } else {
    expect(sent.init.body).toBeUndefined();
  }
}

const label = (name: string): string => {
  const expected = EXPECTED.rest[name];
  return expected?.ok ? 'ok' : (expected?.error ?? 'NO EXPECTATION');
};

describe('REST replay of the recorded fixtures', () => {
  itCoversEveryFixture('rest');

  it.each(fixtureNames('rest').map((name) => [name, label(name)] as const))('%s -> %s', async (name) => {
    const fixture = JSON.parse(readFixture('rest', name)) as RestFixture;
    const expected = EXPECTED.rest[name];
    expect(expected, `no entry in expected.json for ${name}`).toBeDefined();
    expect(Boolean(expected!.ok) !== Boolean(expected!.error), 'exactly one of ok / error').toBe(true);
    expect(fixture.name).toBe(name);

    const { operation, pathParams } = operationFor(fixture.request.method, fixture.request.path);
    const call = buildCall(fixture, operation, pathParams);
    if (name in CANNOT_SEND) expect(call.unsent, `${name}: ${CANNOT_SEND[name]}`).not.toEqual([]);
    else expect(call.unsent, `${name} sends what the SDK can't: list it in CANNOT_SEND`).toEqual([]);

    const requestId = fixture.response.headers['x-request-id'];
    expect(requestId, 'recorded X-Request-Id').toBeTruthy();
    const { client, requests } = makeClient(() => recordedResponse(fixture.response));
    const promise = methodFor(client, operation.sdk.ts)(...call.args);

    if (expected!.ok) {
      const { data, requestId: responseRequestId } = await promise.withResponse();
      expect(responseRequestId).toBe(requestId);
      checkResult(fixture, operation, data, requestId!);
    } else {
      checkError(fixture, expected!, await caught(promise), requestId!);
    }
    expect(requests).toHaveLength(1); // answered once: nothing here is retried
    await checkRequest(requests[0]!, fixture, call);
  });

  it('refuses the generic upload type stt/sync_octet_stream_mp3 sent, before sending anything', async () => {
    const fixture = JSON.parse(readFixture('rest', 'stt/sync_octet_stream_mp3')) as RestFixture;
    const file = fixture.request.file!;
    const { client, requests } = makeClient(() => recordedResponse(fixture.response));
    const upload = toFile(new Uint8Array(file.bytes), file.filename, { type: file.content_type });
    await expect(client.speechToText.transcribe({ file: upload, language: 'ar' })).rejects.toThrow(UsageError);
    expect(requests).toHaveLength(0);
  });
});
