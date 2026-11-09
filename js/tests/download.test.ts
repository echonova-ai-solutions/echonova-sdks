// Signed-link downloads: no credentials, streamed to disk or returned, expired links explained.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as errors from '../src/errors.js';
import { caught, fail, JOB_ID, makeClient, ok, SIGNED_URL, TEST_KEY, type Captured, type Handler } from './rest-support.js';

const AUDIO = new Uint8Array(200_000).fill(1);
AUDIO.set(new TextEncoder().encode('RIFF'));
const root = mkdtempSync(join(tmpdir(), 'echonova-download-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = (): string => {
  const dir = join(root, `d${(n += 1)}`);
  mkdirSync(dir);
  return dir;
};

/** The API answers job GETs; storage answers with `storage` replies in turn, then the audio. */
function routes(...storage: Array<Response | Error>): Handler {
  return (request: Captured) => {
    if (request.url.hostname === 'api.echonova.ai') {
      return ok({ id: JOB_ID, status: 'completed', audioUrl: SIGNED_URL, outputUrl: SIGNED_URL });
    }
    return storage.shift() ?? new Response(AUDIO, { status: 200 });
  };
}

const storageRequests = (requests: Captured[]) => requests.filter((r) => r.url.hostname === 'storage.example.com');

describe('client.download()', () => {
  it('sends no API key, default headers or auth hook headers to storage', async () => {
    const { client, requests } = makeClient(routes(), {
      defaultHeaders: { 'X-Team': 'a' },
      auth: () => ({ 'X-App': 'secret' }),
    });
    const data = await client.download(SIGNED_URL);
    expect(data).toEqual(AUDIO);
    const request = requests[0]!;
    expect(request.url.href).toBe(SIGNED_URL);
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('x-team')).toBe(false);
    expect(request.headers.has('x-app')).toBe(false);
    expect(request.headers.get('user-agent')).toMatch(/^echonova-js\//);
    expect(request.init.redirect).toBe('follow');
  });

  it('streams to a file and renames it into place', async () => {
    const dir = freshDir();
    const target = join(dir, 'speech.wav');
    const { client } = makeClient(routes());
    expect(await client.download(SIGNED_URL, { to: target })).toBe(target);
    expect(new Uint8Array(readFileSync(target))).toEqual(AUDIO);
    expect(readdirSync(dir)).toEqual(['speech.wav']); // no temporary file left
  });

  it('into a directory, keeps the link file name', async () => {
    const dir = freshDir();
    const { client } = makeClient(routes());
    expect(await client.download(SIGNED_URL, { to: dir })).toBe(join(dir, 'out.wav'));
  });

  it('an expired link is explained, hides the signature and leaves no file', async () => {
    const dir = freshDir();
    const { client, requests } = makeClient(routes(new Response('<Error><Code>AuthenticationFailed</Code></Error>', { status: 403 })));
    const error = (await caught(client.download(SIGNED_URL, { to: join(dir, 'x.wav') }))) as errors.DownloadExpiredError;
    expect(error).toBeInstanceOf(errors.DownloadExpiredError);
    expect(error.url).toBe('https://storage.example.com/tts/out.wav');
    expect(String(error)).not.toContain('sig=');
    expect(readdirSync(dir)).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('retries transient storage errors', async () => {
    const { client, requests } = makeClient(routes(new Response('busy', { status: 503 }), new Response(null, { status: 500 })));
    expect(await client.download(SIGNED_URL)).toEqual(AUDIO);
    expect(requests).toHaveLength(3);
  });

  it('does not retry a missing file, and keeps no storage body', async () => {
    const body = `<Error>BlobNotFound ${SIGNED_URL}</Error>`;
    const { client, requests } = makeClient(routes(new Response(body, { status: 404 })));
    const error = (await caught(client.download(SIGNED_URL))) as errors.NotFoundError;
    expect(error).toBeInstanceOf(errors.NotFoundError);
    expect(error.rawBody).toBeNull();
    expect(String(error)).not.toContain('sig');
    expect(requests).toHaveLength(1);
  });

  it('restarts the file after a reset mid-download', async () => {
    const dir = freshDir();
    const target = join(dir, 'a.wav');
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }));
      },
    });
    const { client, requests } = makeClient(routes(new Response(broken, { status: 200 })));
    await client.download(SIGNED_URL, { to: target });
    expect(new Uint8Array(readFileSync(target))).toEqual(AUDIO);
    expect(requests).toHaveLength(2);
  });

  it('gives up when no data arrives for the timeout', async () => {
    const stalled = () =>
      new Response(new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array([1])) }), { status: 200 });
    const { client, requests } = makeClient(routes(stalled(), stalled()), { maxRetries: 1 });
    const error = (await caught(client.download(SIGNED_URL, { timeout: 20 }))) as errors.APITimeoutError;
    expect(error).toBeInstanceOf(errors.APITimeoutError);
    expect(error.kind).toBe('read');
    expect(error.message).not.toContain('sig=');
    expect(requests).toHaveLength(2);
  });

  it('logs the link without its query string', async () => {
    const logs: string[] = [];
    const logger = { error: () => {}, warn: () => {}, info: (m: string) => void logs.push(m), debug: (m: string) => void logs.push(m) };
    const { client } = makeClient(routes(new Response(null, { status: 500 })), { logLevel: 'debug', logger });
    await client.download(SIGNED_URL);
    const text = logs.join('\n');
    expect(text).toContain('storage.example.com/tts/out.wav');
    expect(text).not.toContain('sig=');
    expect(text).not.toContain('REDACTED-secret');
  });

  it.each([null, undefined, '', 'ftp://example.com/a.wav', 'not a url'])('refuses %j', async (url) => {
    const { client, requests } = makeClient(routes());
    expect(await caught(client.download(url as string))).toBeInstanceOf(errors.UsageError);
    expect(requests).toHaveLength(0);
  });
});

describe('jobs.download()', () => {
  it('gets the job for a fresh link first', async () => {
    const dir = freshDir();
    const { client, requests } = makeClient(routes());
    const path = await client.textToSpeech.jobs.download(JOB_ID, { to: join(dir, 'job.wav') });
    expect(existsSync(path)).toBe(true);
    expect(requests.map((r) => `${r.method} ${r.url.hostname}${r.url.pathname}`)).toEqual([
      `GET api.echonova.ai/v1/text-to-speech/jobs/${JOB_ID}`,
      'GET storage.example.com/tts/out.wav',
    ]);
    expect(requests[0]!.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(storageRequests(requests)[0]!.headers.has('authorization')).toBe(false);
    expect(await client.soundCleaning.jobs.download({ id: JOB_ID })).toEqual(AUDIO);
  });

  it('explains an unfinished or failed job', async () => {
    const unfinished = makeClient(() => ok({ id: JOB_ID, status: 'processing' })).client;
    expect(await caught(unfinished.textToSpeech.jobs.download(JOB_ID))).toBeInstanceOf(errors.UsageError);
    expect(await caught(unfinished.soundCleaning.jobs.download(JOB_ID))).toBeInstanceOf(errors.UsageError);
    const failed = makeClient(() => ok({ id: JOB_ID, status: 'failed', error: 'bad audio' })).client;
    const error = (await caught(failed.textToSpeech.jobs.download(JOB_ID))) as errors.JobFailedError;
    expect(error).toBeInstanceOf(errors.JobFailedError);
    expect(error.message).toContain('bad audio');
  });

  it('a 404 from the API is not a storage error', async () => {
    const { client } = makeClient(() => fail(404, 'TTS Job not found'));
    expect(await caught(client.textToSpeech.jobs.download(JOB_ID))).toBeInstanceOf(errors.JobNotFoundError);
  });
});
