/**
 * Helpers for the raw audio the streams use: 16-bit little-endian mono PCM.
 *
 * Nothing here resamples or converts formats: audio must already be mono PCM16
 * at the sample rate you connect with. No runtime-specific APIs: write the bytes
 * with `fs.writeFile`, or wrap them in a `Blob` in a browser.
 */

export const BYTES_PER_SAMPLE = 2;
/** RIFF/data size for a WAV stream whose length isn't known yet. */
export const UNKNOWN_SIZE = 0xffffffff;
const HEADER_SIZE = 44;
const PCM_FORMAT = 1;
const EXTENSIBLE_FORMAT = 0xfffe;

export type BytesLike = Uint8Array | ArrayBuffer | ArrayBufferView;

export function asBytes(data: BytesLike): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** PCM16LE mono audio and its sample rate. */
export class Audio {
  readonly pcm: Uint8Array;
  readonly sampleRate: number;

  constructor(pcm: BytesLike, sampleRate: number) {
    this.pcm = asBytes(pcm);
    this.sampleRate = sampleRate;
  }

  get channels(): 1 {
    return 1;
  }

  /** Length in seconds. */
  get duration(): number {
    if (this.sampleRate <= 0) return 0;
    return this.pcm.length / (this.sampleRate * BYTES_PER_SAMPLE);
  }

  /** The audio as a complete WAV file. */
  toWav(): Uint8Array {
    return pcmToWav(this.pcm, this.sampleRate);
  }

  toString(): string {
    return `Audio(sampleRate=${this.sampleRate}, duration=${this.duration.toFixed(3)}s, bytes=${this.pcm.length})`;
  }
}

export interface WavHeaderOptions {
  channels?: number | undefined;
  bitsPerSample?: number | undefined;
  /**
   * Bytes of audio that follow. Leave it out for audio still being streamed: the
   * header then carries 0xFFFFFFFF sizes, which most players accept.
   */
  dataLength?: number | null | undefined;
}

/** A 44-byte WAV header. Without `dataLength` it is a streaming header (unknown length). */
export function wavHeader(sampleRate: number, options: WavHeaderOptions = {}): Uint8Array {
  const channels = options.channels ?? 1;
  const bits = options.bitsPerSample ?? 16;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be a positive number of Hz');
  const blockAlign = (channels * bits) / 8;
  let riffSize: number;
  let dataSize: number;
  const dataLength = options.dataLength ?? null;
  if (dataLength === null) {
    riffSize = dataSize = UNKNOWN_SIZE;
  } else {
    if (!Number.isInteger(dataLength) || dataLength < 0 || dataLength + HEADER_SIZE - 8 > UNKNOWN_SIZE - 1) {
      throw new RangeError("dataLength doesn't fit in a WAV header");
    }
    dataSize = dataLength;
    riffSize = dataLength + HEADER_SIZE - 8;
  }
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, riffSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  return header;
}

/** PCM16LE mono audio as a complete WAV file. */
export function pcmToWav(pcm: BytesLike, sampleRate: number): Uint8Array {
  const data = asBytes(pcm);
  return concatBytes([wavHeader(sampleRate, { dataLength: data.length }), data]);
}

/**
 * Read a mono 16-bit PCM WAV file. Throws `RangeError` for anything else (other
 * encodings, stereo, other bit depths). The data is not copied.
 */
export function parseWav(file: BytesLike): Audio {
  const bytes = asBytes(file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new RangeError('not a WAV file (missing RIFF/WAVE header)');
  let offset = 12;
  let format: { tag: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + size > bytes.length) throw new RangeError('not a valid WAV file: short fmt chunk');
      let formatTag = view.getUint16(body, true);
      if (formatTag === EXTENSIBLE_FORMAT && size >= 26) formatTag = view.getUint16(body + 24, true);
      format = {
        tag: formatTag,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (format === null) throw new RangeError('not a valid WAV file: data before fmt');
      if (format.tag !== PCM_FORMAT) {
        throw new RangeError(`unsupported WAV encoding (format ${format.tag}); only uncompressed PCM is supported`);
      }
      if (format.channels !== 1) throw new RangeError(`the WAV file has ${format.channels} channels; streams need mono audio`);
      if (format.bits !== 16) throw new RangeError(`the WAV file is ${format.bits}-bit; streams need 16-bit PCM`);
      const end = size === UNKNOWN_SIZE ? bytes.length : Math.min(bytes.length, body + size);
      const length = end - body - ((end - body) % 2);
      return new Audio(bytes.subarray(body, body + length), format.sampleRate);
    }
    offset = body + size + (size % 2);
  }
  throw new RangeError('not a valid WAV file: no data chunk');
}

/** Split PCM16 mono audio into frames of `frameMs` (the last one may be shorter). Views, not copies. */
export function* iterFrames(pcm: BytesLike, sampleRate: number, frameMs = 100): Generator<Uint8Array, void, undefined> {
  if (!(sampleRate > 0) || !(frameMs > 0)) throw new RangeError('sampleRate and frameMs must be positive');
  const data = asBytes(pcm);
  let size = Math.max(BYTES_PER_SAMPLE, Math.floor((sampleRate * BYTES_PER_SAMPLE * frameMs) / 1000));
  size -= size % 2;
  for (let start = 0; start < data.length; start += size) yield data.subarray(start, start + size);
}
