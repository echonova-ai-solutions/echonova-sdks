// Test helpers for the REST layer: a fake clock, a recording mock fetch, envelopes,
// multipart parsing and examples synthesised from the vendored openapi.json.
import { EchoNova, type ClientOptions, type InternalClientOptions } from '../src/client.js';
import type { Runtime } from '../src/core/runtime.js';
import { loadSpec, TEST_KEY } from './helpers.js';

export { TEST_KEY };
export const JOB_ID = '6a1b2c3d4e5f60718293a4b5';
export const SIGNED_URL = 'https://storage.example.com/tts/out.wav?sv=2024&sig=REDACTED-secret-signature';
export const WAV = new Uint8Array([...new TextEncoder().encode('RIFF$\0\0\0WAVEfmt '), ...new Uint8Array(32)]);
export const MP3 = new Uint8Array([...new TextEncoder().encode('ID3'), 4, 0, 0, 0, 0, 0, 0, ...new Uint8Array(32)]);

/** A monotonic clock that only moves when the SDK sleeps. */
export class FakeTime {
  monotonic = 1000;
  sleeps: number[] = [];
  readonly start = new Date('2026-11-09T12:00:00.000Z');
  random = 0.5;

  runtime(): Partial<Runtime> {
    return {
      clock: () => this.monotonic,
      now: () => new Date(this.start.getTime() + (this.monotonic - 1000) * 1000),
      sleep: async (ms: number, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        this.sleeps.push(ms);
        this.monotonic += ms / 1000;
        await Promise.resolve();
      },
      random: () => this.random,
    };
  }
}

/** A clock whose sleeps wait until the test moves time forward with `advance()`. */
export class SteppedTime extends FakeTime {
  readonly #waiters: Array<{ at: number; resolve: () => void }> = [];

  override runtime(): Partial<Runtime> {
    return {
      ...super.runtime(),
      sleep: (ms: number) => {
        this.sleeps.push(ms);
        return new Promise<void>((resolve) => this.#waiters.push({ at: this.monotonic + ms / 1000, resolve }));
      },
    };
  }

  async advance(seconds: number): Promise<void> {
    this.monotonic += seconds;
    for (const waiter of this.#waiters.splice(0)) {
      if (waiter.at <= this.monotonic) waiter.resolve();
      else this.#waiters.push(waiter);
    }
    await settle();
  }
}

/** Let pending promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

export interface Captured {
  url: URL;
  method: string;
  headers: Headers;
  init: RequestInit & { duplex?: string };
}

export type Reply = Response | Error | Promise<Response>;
export type Handler = (request: Captured) => Reply;

export function envelopeBody(data: unknown): string {
  return JSON.stringify({ data, success: true, statusCode: 200, errorMessage: null });
}

export function ok(data: unknown, headers: Record<string, string> = {}, requestId = 'req-1'): Response {
  return new Response(envelopeBody(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId, ...headers },
  });
}

export function fail(status: number, message: string | null, headers: Record<string, string> = {}): Response {
  const body = JSON.stringify({ data: null, success: false, statusCode: status, errorMessage: message });
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-err', ...headers } });
}

/** A fetch failure where the request was sent but no answer came (connection reset). */
export function reset(): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
}

export function refused(): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}

export function makeClient(handler: Handler, options: ClientOptions & { time?: FakeTime } = {}) {
  const requests: Captured[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const captured: Captured = { url: new URL(url), method: String(init.method), headers: new Headers(init.headers), init };
    requests.push(captured);
    const reply = await handler(captured);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const { time = new FakeTime(), ...rest } = options;
  const internal: InternalClientOptions = { apiKey: TEST_KEY, fetch, ...rest, _runtime: time.runtime() };
  const client = new EchoNova(internal);
  return { client, requests, time };
}

/** The multipart fields of a captured upload: FormData as sent, or a streamed body parsed back. */
export async function formOf(request: Captured): Promise<FormData> {
  const body = request.init.body;
  if (body instanceof FormData) return body;
  const type = request.headers.get('content-type') ?? '';
  return new Response(body as BodyInit, { headers: { 'content-type': type } }).formData();
}

/** Text fields and the file part of a multipart upload. */
export async function partsOf(request: Captured) {
  const form = await formOf(request);
  const fields: Record<string, string> = {};
  let file: File | null = null;
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') fields[name] = value;
    else if (name === 'file') file = value;
  }
  return { fields, file, names: [...form.keys()] };
}

export async function caught(promise: PromiseLike<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

// --- Examples synthesised from openapi.json ----------------------------------------------------

type Schema = Record<string, any>;
const openapi = loadSpec<{ paths: Record<string, Record<string, any>>; components: { schemas: Record<string, Schema> } }>(
  'openapi.json',
);
export const OPENAPI = openapi;

export function resolve(schema: Schema): Schema {
  let current = schema;
  while (current && '$ref' in current) current = openapi.components.schemas[String(current['$ref']).split('/').pop()!]!;
  return current;
}

/** The properties of an object schema, following refs and allOf. */
export function schemaProperties(schema: Schema): Record<string, Schema> {
  const resolved = resolve(schema);
  const props: Record<string, Schema> = {};
  for (const part of resolved['allOf'] ?? []) Object.assign(props, schemaProperties(part));
  Object.assign(props, resolved['properties'] ?? {});
  return props;
}

/** An example value for a schema: its `example` when given, otherwise built from its parts. */
export function exampleFor(schema: Schema): any {
  const resolved = resolve(schema);
  if (resolved['allOf']) {
    const merged: Record<string, unknown> = {};
    for (const part of resolved['allOf']) {
      const value = exampleFor(part);
      if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(merged, value);
      else return value;
    }
    if (resolved['properties']) Object.assign(merged, exampleFor({ type: 'object', properties: resolved['properties'] }));
    return merged;
  }
  if (resolved['properties'] || resolved['type'] === 'object') {
    if (!resolved['properties'] && 'example' in resolved) return resolved['example'];
    return Object.fromEntries(Object.entries(resolved['properties'] ?? {}).map(([name, prop]) => [name, exampleFor(prop as Schema)]));
  }
  if (resolved['type'] === 'array') return [exampleFor(resolved['items'] ?? {})];
  if ('example' in resolved && resolved['example'] !== null) return resolved['example'];
  if (resolved['enum']) return resolved['enum'][0];
  return ({ string: 'text', number: 1.5, integer: 1, boolean: true } as Record<string, unknown>)[resolved['type'] ?? ''];
}

/** The `data` schema of an operation's 200 JSON response. */
export function dataSchema(path: string, method: string): Schema {
  const response = openapi.paths[path]![method.toLowerCase()]!['responses']['200']['content']['application/json']['schema'];
  return schemaProperties(response)['data']!;
}
