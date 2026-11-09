// Audio uploads: content type resolution, sniffing, replay across retries, and no buffering.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EchoNova } from '../src/client.js';
import { EXTENSION_TYPES, sniffContentType, toFile } from '../src/core/files.js';
import * as errors from '../src/errors.js';
import { nodeFs } from '../src/runtime/node.js';
import { caught, fail, JOB_ID, makeClient, MP3, ok, partsOf, refused, TEST_KEY, WAV } from './rest-support.js';

const dir = mkdtempSync(join(tmpdir(), 'echonova-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function writeTemp(name: string, content: Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const accepted = () => ok({ jobId: JOB_ID, status: 'pending' });

async function uploadedFile(file: Parameters<EchoNova['speechToText']['jobs']['create']>[0]['file']) {
  const { client, requests } = makeClient(accepted);
  await client.speechToText.jobs.create({ file, language: 'en' });
  return { request: requests[0]!, ...(await partsOf(requests[0]!)) };
}

const ascii = (text: string) => new TextEncoder().encode(text);

describe('content type', () => {
  it.each(Object.entries(EXTENSION_TYPES))('%s is sent as %s', async (ext, type) => {
    const { file } = await uploadedFile(writeTemp(`a${ext}`, new Uint8Array([1, 2, 3])));
    expect(file?.type).toBe(type);
    expect(file?.name).toBe(`a${ext}`);
    expect((await uploadedFile(toFile(new Uint8Array([1]), `B${ext.toUpperCase()}`))).file?.type).toBe(type);
  });

  it('a .wav is audio/wav, not the audio/x-wav some platforms report', async () => {
    const file = new File([WAV], 'call.wav', { type: 'audio/x-wav' });
    expect((await uploadedFile(file)).file?.type).toBe('audio/wav');
  });

  it.each([
    [WAV, 'audio/wav'],
    [ascii('fLaC\0\0\0\0'), 'audio/flac'],
    [ascii('OggS\0\0\0\0'), 'audio/ogg'],
    [MP3, 'audio/mpeg'],
    [new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg'],
    [new Uint8Array([0xff, 0xf1, 0x50, 0x80]), 'audio/aac'],
    [ascii('#!AMR\n'), 'audio/amr'],
    [new Uint8Array([0, 0, 0, 0x20, ...ascii('ftypM4A ')]), 'audio/mp4'],
    [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]), 'audio/webm'],
    [ascii('hello world'), null],
    [new Uint8Array(), null],
  ])('sniffs %o as %s', (head, type) => {
    expect(sniffContentType(head)).toBe(type);
  });

  it('names bytes after the sniffed type', async () => {
    const { file } = await uploadedFile(MP3);
    expect(file?.name).toBe('audio.mp3');
    expect(file?.type).toBe('audio/mpeg');
    expect((await uploadedFile(WAV.buffer.slice(0) as ArrayBuffer)).file?.type).toBe('audio/wav');
  });

  it('falls back to sniffing for an unknown extension or a plain Blob', async () => {
    expect((await uploadedFile(writeTemp('recording.bin', WAV))).file?.type).toBe('audio/wav');
    expect((await uploadedFile(new Blob([MP3]))).file?.type).toBe('audio/mpeg');
    expect((await uploadedFile(new Blob([MP3], { type: 'application/octet-stream' }))).file?.type).toBe('audio/mpeg');
    expect((await uploadedFile(new Blob([new Uint8Array(4)], { type: 'audio/ogg' }))).file?.type).toBe('audio/ogg');
  });

  it('an explicit type wins', async () => {
    const { file } = await uploadedFile(toFile(WAV, 'clip.mp3', { type: 'audio/webm' }));
    expect(file?.type).toBe('audio/webm');
    expect(file?.name).toBe('clip.mp3');
  });

  it.each(['application/octet-stream', 'binary/octet-stream', ''])('refuses the generic type %j before sending', async (type) => {
    const { client, requests } = makeClient(accepted);
    const error = await caught(client.speechToText.jobs.create({ file: toFile(WAV, 'a.wav', { type }), language: 'en' }));
    expect(error).toBeInstanceOf(errors.UsageError);
    expect(requests).toHaveLength(0);
  });

  it('an unrecognisable file is a UsageError, and nothing is sent', async () => {
    const { client, requests } = makeClient(accepted);
    const error = await caught(client.soundCleaning.clean({ file: writeTemp('notes.txt', ascii('just some text')) }));
    expect(error).toBeInstanceOf(errors.UsageError);
    expect(error.message).toContain('notes.txt');
    expect(requests).toHaveLength(0);
  });

  it('a missing path, text input or unknown value is a UsageError', async () => {
    const { client } = makeClient(accepted);
    await expect(client.speechToText.transcribe({ file: join(dir, 'missing.wav'), language: 'en' })).rejects.toThrow(/no such file/);
    await expect(client.speechToText.transcribe({ file: 42 as never, language: 'en' })).rejects.toThrow(errors.UsageError);
    expect(() => toFile('call.wav' as never)).toThrow(errors.UsageError);
  });

  it('a stream that yields text fails with a UsageError, not a connection error', async () => {
    const { client } = makeClient(async (request) => {
      await partsOf(request); // the server reads the body, which breaks
      return accepted();
    });
    const text = Readable.from(['RIFF....WAVE text chunks']);
    const error = await caught(client.speechToText.transcribe({ file: toFile(text, 'a.wav'), language: 'en' }));
    expect(error).toBeInstanceOf(errors.UsageError);
    expect(error.message).toMatch(/binary/);
  });
});

describe('re-readable bodies', () => {
  it('a path is streamed from disk with fs.openAsBlob, reopened for every attempt, and never buffered', async () => {
    const fs = process.getBuiltinModule('node:fs');
    const openAsBlob = vi.spyOn(fs, 'openAsBlob');
    const path = writeTemp('meeting.wav', WAV);
    const { client, requests } = makeClient((request) => (requests.length === 1 ? refused() : accepted()));
    await client.speechToText.jobs.create({ file: path, language: 'en' });
    expect(requests).toHaveLength(2);
    expect(openAsBlob).toHaveBeenCalledTimes(2);
    expect(openAsBlob).toHaveBeenCalledWith(path, { type: 'audio/wav' });
    for (const request of requests) {
      expect(request.init.redirect).toBe('error'); // fetch would otherwise keep the body for a redirect
      expect(request.init.body).toBeInstanceOf(FormData);
      const { file } = await partsOf(request);
      expect(new Uint8Array(await file!.arrayBuffer())).toEqual(WAV);
    }
  });

  it('without fs.openAsBlob, a path is streamed through a multipart body', async () => {
    const fs = process.getBuiltinModule('node:fs');
    vi.spyOn(fs, 'openAsBlob' as never, 'get').mockReturnValue(undefined as never);
    const path = writeTemp('fallback.flac', ascii('fLaC-audio-bytes'));
    const { request, file } = await uploadedFile(path);
    expect(request.init.body).toBeInstanceOf(ReadableStream);
    expect(request.init.duplex).toBe('half');
    expect(file?.type).toBe('audio/flac');
    expect(new TextDecoder().decode(await file!.arrayBuffer())).toBe('fLaC-audio-bytes');
  });

  it('a Blob and bytes are reused on a retry', async () => {
    for (const input of [new Blob([WAV], { type: 'audio/wav' }), WAV]) {
      const { client, requests } = makeClient((request) => (requests.length === 1 ? fail(503, 'Audio processing is temporarily unavailable.') : accepted()));
      await client.speechToText.transcribe({ file: input, language: 'en' });
      expect(requests).toHaveLength(2);
      expect(new Uint8Array(await (await partsOf(requests[1]!)).file!.arrayBuffer())).toEqual(WAV);
    }
  });
});

describe('streams', () => {
  const streamOf = (...chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

  it('a ReadableStream is piped through a streamed multipart body', async () => {
    const { request, fields, file } = await uploadedFile(streamOf(WAV.subarray(0, 5), WAV.subarray(5)));
    expect(request.init.body).toBeInstanceOf(ReadableStream);
    expect(request.init.duplex).toBe('half');
    expect(request.init.redirect).toBe('error');
    expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=echonova-[0-9a-f]{24}$/);
    expect(fields).toEqual({ language: 'en' });
    expect(file?.name).toBe('audio.wav');
    expect(file?.type).toBe('audio/wav');
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(WAV);
  });

  it('a Node stream or async iterable works too, with a name from toFile()', async () => {
    const { file } = await uploadedFile(toFile(Readable.from([Buffer.from(MP3)]), 'speech "final".mp3'));
    expect(file?.name).toBe('speech "final".mp3'); // sent as speech %22final%22.mp3
    expect(file?.type).toBe('audio/mpeg');
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(MP3);
  });

  it('is sent again only while none of it has been read', async () => {
    const { client, requests } = makeClient((request) => (requests.length === 1 ? refused() : accepted()));
    await client.speechToText.jobs.create({ file: streamOf(WAV), language: 'en' }); // the refused attempt read nothing
    expect(requests).toHaveLength(2);
    expect(new Uint8Array(await (await partsOf(requests[1]!)).file!.arrayBuffer())).toEqual(WAV);
  });

  it('is never sent again once it has been read', async () => {
    const { client, requests } = makeClient(async (request) => {
      await partsOf(request); // the server read the whole upload
      return fail(503, 'Audio processing is temporarily unavailable. Please try again.');
    });
    const error = (await caught(client.speechToText.jobs.create({ file: streamOf(WAV), language: 'en' }))) as errors.APIStatusError;
    expect(error).toBeInstanceOf(errors.ServiceUnavailableError);
    expect(error.retryDisabledReason).toBe('body_not_replayable');
    expect(requests).toHaveLength(1);
  });
});

describe('on the wire (a local HTTP server)', () => {
  const received: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }> = [];
  let baseURL = '';
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url?.startsWith('/moved')) {
        res.writeHead(307, { Location: `${baseURL}/v1/speech-to-text` }).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': 'local-1' });
      res.end(JSON.stringify({ data: { jobId: JOB_ID, status: 'pending' }, success: true, statusCode: 200, errorMessage: null }));
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    baseURL = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const parse = async (entry: (typeof received)[number]) =>
    new Response(new Uint8Array(entry.body), { headers: { 'content-type': entry.headers['content-type']! } }).formData();

  it('sends a path and a stream as multipart with the audio type and the fields first', async () => {
    received.length = 0;
    const big = new Uint8Array(3 * 1024 * 1024);
    big.set(WAV);
    const client = new EchoNova({ apiKey: TEST_KEY, baseURL });
    const terms = { keywords: ['KYC', { term: 'Emirates NBD', variants: ['امريتس ان بي دي'] }] };
    await client.speechToText.jobs.create({ file: writeTemp('big.wav', big), language: 'ar', terminology: terms });
    await client.speechToText.transcribe({ file: Readable.from([Buffer.from(big)]), language: 'en', identifySpeakers: true });
    expect(received.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /v1/speech-to-text', 'POST /v1/speech-to-text/sync']);
    const [first, second] = await Promise.all(received.map(parse));
    expect([...first!.keys()]).toEqual(['language', 'terminology', 'file']);
    expect(JSON.parse(String(first!.get('terminology')))).toEqual(terms);
    const firstFile = first!.get('file') as File;
    expect([firstFile.name, firstFile.type, firstFile.size]).toEqual(['big.wav', 'audio/wav', big.length]);
    expect([...second!.keys()]).toEqual(['language', 'identify_speakers', 'file']);
    const secondFile = second!.get('file') as File;
    expect([secondFile.type, secondFile.size]).toEqual(['audio/wav', big.length]);
    expect(Buffer.from(await secondFile.arrayBuffer()).equals(Buffer.from(big))).toBe(true);
    expect(received[0]!.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
  });

  it('a stream that breaks while fetch sends it is reported as the SDK error that broke it', async () => {
    const client = new EchoNova({ apiKey: TEST_KEY, baseURL });
    const text = Readable.from(['RIFF....WAVE as text']);
    const error = await caught(client.soundCleaning.clean({ file: toFile(text, 'a.wav') }));
    expect(error).toBeInstanceOf(errors.UsageError);
  });

  it('refuses to follow a redirect with an upload', async () => {
    received.length = 0;
    const client = new EchoNova({ apiKey: TEST_KEY, baseURL: `${baseURL}/moved` });
    const error = (await caught(client.speechToText.jobs.create({ file: WAV, language: 'en' }))) as errors.ProtocolError;
    expect(error).toBeInstanceOf(errors.ProtocolError);
    expect(error.message).toContain('redirect');
    expect(error.mayHaveExecuted).toBeNull();
    expect(received).toHaveLength(1);
  });
});

describe('runtimes without a file system', () => {
  it('a file path needs Node.js, Bun or Deno', async () => {
    const real = globalThis.process;
    vi.stubGlobal('process', { env: {} });
    try {
      await expect(nodeFs('uploading from a file path')).rejects.toThrow(errors.UnsupportedEnvironmentError);
    } finally {
      vi.stubGlobal('process', real);
    }
  });
});
