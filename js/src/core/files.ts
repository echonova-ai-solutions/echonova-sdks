/**
 * Audio upload inputs: name, content type and replay across retries.
 *
 * The content type comes from an explicit value (`toFile(..., { type })`), then
 * the SDK's own extension map, then a `Blob`'s own type, then the file's first
 * bytes. The SDK always sends a specific `audio/*` type and never
 * `application/octet-stream`, which the API rejects.
 *
 * Each attempt gets a fresh body: paths are reopened, `Blob`s and bytes are
 * reused, and a stream can be sent again only while none of it has been read.
 * Nothing is buffered: paths stream from disk and streams are piped through.
 */

import { UsageError } from '../errors.js';
import type { RequestBody, UploadBody } from './http.js';
import { nodeFs, nodePath, type FileHandleLike } from '../runtime/node.js';

/** Raw audio content: bytes, a `Blob`/`File`, or a stream of bytes (sent once, never buffered). */
export type FileContent =
  | Blob
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

const FILE_BRAND = Symbol.for('echonova.file');

/** Audio content with a file name and, optionally, its content type. Made by `toFile()`. */
export interface FileUpload {
  readonly [FILE_BRAND]: true;
  readonly content: FileContent;
  readonly name: string | undefined;
  readonly type: string | undefined;
}

/**
 * An audio file to upload: a file path (Node.js, Bun and Deno), a `Blob` or
 * `File`, bytes (`Uint8Array`, `Buffer`, `ArrayBuffer`), a byte stream, or `toFile(...)`.
 */
export type Uploadable = string | FileContent | FileUpload;

/**
 * Name audio content and, optionally, set its type: `toFile(bytes, 'call.mp3')`
 * or `toFile(stream, 'call.ogg', { type: 'audio/ogg' })`. Without a type, the
 * SDK reads it from the file name or the first bytes.
 */
export function toFile(content: FileContent, filename?: string, options: { type?: string } = {}): FileUpload {
  if (content == null || typeof content !== 'object') {
    throw new UsageError('toFile() takes bytes, a Blob or a stream; pass a file path to the method directly');
  }
  return { [FILE_BRAND]: true, content, name: filename || undefined, type: options.type };
}

export const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.amr': 'audio/amr',
};
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const SNIFF_BYTES = 16;
const CHUNK_BYTES = 64 * 1024;

const ascii = (bytes: Uint8Array, start: number, end: number): string => String.fromCharCode(...bytes.subarray(start, end));

/** Recognise common audio containers from their first bytes. */
export function sniffContentType(head: Uint8Array): string | null {
  const four = ascii(head, 0, 4);
  if (four === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return 'audio/wav';
  if (four === 'fLaC') return 'audio/flac';
  if (four === 'OggS') return 'audio/ogg';
  if (ascii(head, 0, 3) === 'ID3') return 'audio/mpeg';
  if (ascii(head, 0, 6) === '#!AMR\n') return 'audio/amr';
  if (ascii(head, 4, 8) === 'ftyp') return 'audio/mp4';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'audio/webm';
  if (head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) {
    return ((head[1] ?? 0) >> 1) & 0x03 ? 'audio/mpeg' : 'audio/aac'; // ADTS AAC has layer 0; MPEG audio doesn't
  }
  return null;
}

const extensionOf = (name: string | undefined): string => {
  const match = name ? /\.[^./\\]+$/.exec(name) : null;
  return match ? match[0].toLowerCase() : '';
};
const isGeneric = (type: string | undefined): boolean => GENERIC_TYPES.has((type ?? '').split(';')[0]!.trim().toLowerCase());

function resolveType(explicit: string | undefined, name: string | undefined, blobType: string | undefined, head: Uint8Array | null): string {
  if (explicit !== undefined) {
    if (isGeneric(explicit)) {
      throw new UsageError(`content type ${JSON.stringify(explicit)} is too generic: the API needs the audio type, such as 'audio/mpeg'`);
    }
    return explicit;
  }
  const found =
    EXTENSION_TYPES[extensionOf(name)] ?? (isGeneric(blobType) ? undefined : blobType) ?? (head ? sniffContentType(head) : null);
  if (found) return found;
  throw new UsageError(
    `can't tell the audio format of ${name ? JSON.stringify(name) : 'the file'}. Use a known extension ` +
      `(${Object.keys(EXTENSION_TYPES).join(', ')}) or set it with toFile(content, name, { type }).`,
  );
}

function defaultName(type: string): string {
  const bare = type.split(';')[0]!.trim().toLowerCase();
  const ext = Object.keys(EXTENSION_TYPES).find((key) => EXTENSION_TYPES[key] === bare);
  return `audio${ext ?? ''}`;
}

function needsSniff(explicit: string | undefined, name: string | undefined, blobType?: string): boolean {
  return explicit === undefined && !EXTENSION_TYPES[extensionOf(name)] && isGeneric(blobType);
}

function toUint8(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new UsageError('an upload stream must yield bytes (Uint8Array or Buffer), not text; read it in binary mode');
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}

async function* readStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* readFile(handle: FileHandleLike): AsyncGenerator<Uint8Array> {
  try {
    for (;;) {
      const buffer = new Uint8Array(CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

const quote = (value: string): string => value.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** A multipart body streamed from `source`, for uploads `FormData` can't hold without buffering. */
function multipartStream(
  fields: ReadonlyArray<readonly [string, string]>,
  name: string,
  type: string,
  source: AsyncIterator<Uint8Array>,
): { body: ReadableStream<Uint8Array>; contentType: string } {
  const random = crypto.getRandomValues(new Uint8Array(12));
  const boundary = `echonova-${Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const encoder = new TextEncoder();
  let head = '';
  for (const [key, value] of fields) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${quote(key)}"\r\n\r\n${value}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quote(name)}"\r\nContent-Type: ${type}\r\n\r\n`;
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(head));
        return;
      }
      const { value, done } = await source.next();
      if (!done) {
        controller.enqueue(toUint8(value));
        return;
      }
      controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
      controller.close();
    },
    async cancel(reason) {
      await source.return?.(reason);
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function formBody(fields: ReadonlyArray<readonly [string, string]>, blob: Blob, name: string): FormData {
  const form = new FormData();
  for (const [key, value] of fields) form.append(key, value);
  form.append('file', blob, name);
  return form;
}

/** An upload ready to be opened for each attempt. */
export interface PreparedUpload extends UploadBody {
  readonly name: string;
  readonly type: string;
  /** Bytes, or null for a stream of unknown length. */
  readonly size: number | null;
}

type Fields = ReadonlyArray<readonly [string, string]>;

/** Normalise an upload and attach the multipart fields that go with it. Only the fields given are sent. */
export async function prepareUpload(file: Uploadable, fields: Fields): Promise<PreparedUpload> {
  if (typeof file === 'string') return preparePath(file, fields);
  let content: unknown = file;
  let name: string | undefined;
  let explicit: string | undefined;
  if (typeof file === 'object' && file !== null && (file as FileUpload)[FILE_BRAND] === true) {
    ({ content, name, type: explicit } = file as FileUpload);
  }

  if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
    const bytes = toUint8(content);
    const type = resolveType(explicit, name, undefined, bytes.subarray(0, SNIFF_BYTES));
    return blobUpload(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), name ?? defaultName(type), type, fields);
  }
  if (isBlob(content)) {
    name ??= (content as Partial<File>).name || undefined;
    const head = needsSniff(explicit, name, content.type)
      ? new Uint8Array(await content.slice(0, SNIFF_BYTES).arrayBuffer())
      : null;
    const type = resolveType(explicit, name, content.type, head);
    const blob = content.type === type ? content : content.slice(0, content.size, type);
    return blobUpload(blob, name ?? defaultName(type), type, fields);
  }
  if (isReadableStream(content) || (typeof content === 'object' && content !== null && Symbol.asyncIterator in content)) {
    const source = isReadableStream(content) ? readStream(content) : (content as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    return streamUpload(source, name, explicit, fields);
  }
  throw new UsageError(
    'file must be a file path, a Blob or File, bytes (Uint8Array, Buffer, ArrayBuffer), a stream of bytes, or toFile(...)',
  );
}

function blobUpload(blob: Blob, name: string, type: string, fields: Fields): PreparedUpload {
  return {
    name,
    type,
    size: blob.size,
    replayable: () => true,
    open: async () => ({ body: formBody(fields, blob, name) }),
  };
}

async function preparePath(path: string, fields: Fields): Promise<PreparedUpload> {
  const why = 'uploading from a file path';
  const fs = await nodeFs(why);
  const name = (await nodePath(why)).basename(path);
  const stats = await fs.promises.stat(path).catch(() => null);
  if (!stats?.isFile()) throw new UsageError(`no such file: ${path}`);
  let head: Uint8Array | null = null;
  if (needsSniff(undefined, name)) {
    const handle = await fs.promises.open(path, 'r');
    try {
      head = new Uint8Array(SNIFF_BYTES);
      head = head.subarray(0, (await handle.read(head, 0, SNIFF_BYTES, 0)).bytesRead);
    } finally {
      await handle.close();
    }
  }
  const type = resolveType(undefined, name, undefined, head);
  const openAsBlob = fs.openAsBlob;
  return {
    name,
    type,
    size: stats.size,
    replayable: () => true,
    // The file is reopened for every attempt and streamed from disk, never read into memory.
    open: async (): Promise<{ body: RequestBody; contentType?: string }> => {
      if (openAsBlob) return { body: formBody(fields, await openAsBlob(path, { type }), name) };
      const source = readFile(await fs.promises.open(path, 'r'));
      return multipartStream(fields, name, type, source);
    },
  };
}

async function streamUpload(
  source: AsyncIterator<Uint8Array>,
  name: string | undefined,
  explicit: string | undefined,
  fields: Fields,
): Promise<PreparedUpload> {
  // Read just enough to recognise the format, then put it back in front.
  const head: Uint8Array[] = [];
  let headBytes = 0;
  let ended = false;
  if (needsSniff(explicit, name)) {
    while (headBytes < SNIFF_BYTES) {
      const next = await source.next();
      if (next.done) {
        ended = true;
        break;
      }
      const chunk = toUint8(next.value);
      head.push(chunk);
      headBytes += chunk.length;
    }
  }
  const joined = new Uint8Array(headBytes);
  let at = 0;
  for (const chunk of head) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  const type = resolveType(explicit, name, undefined, headBytes ? joined.subarray(0, SNIFF_BYTES) : null);
  const fileName = name ?? defaultName(type);
  let consumed = false;
  /** One attempt's view: the sniffed head again, then the rest of the stream (which can be read only once). */
  const attempt = (): AsyncIterator<Uint8Array> => {
    let index = 0;
    return {
      next: async () => {
        if (index < head.length) return { value: head[index++]!, done: false };
        if (ended) return { value: undefined, done: true };
        consumed = true;
        const next = await source.next();
        if (next.done) ended = true;
        return next;
      },
      // Stop reading the caller's stream only once it can't be replayed anyway.
      return: async (value?: unknown) =>
        consumed && source.return ? source.return(value) : { value: undefined, done: true as const },
    };
  };
  return {
    name: fileName,
    type,
    size: null,
    // Sent again only while no byte beyond the sniffed head has been read.
    replayable: () => !consumed,
    open: async () => multipartStream(fields, fileName, type, attempt()),
  };
}
