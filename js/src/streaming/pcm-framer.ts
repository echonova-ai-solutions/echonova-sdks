/**
 * Split raw PCM16LE audio into frames the Speech to Text stream accepts.
 *
 * Frames are about `frameMs` of audio, never larger than 65,536 bytes (larger
 * frames close the socket with 1008), and always an even number of bytes, so a
 * 16-bit sample is never split. An odd trailing byte is held until more audio
 * arrives. Input is copied, so callers can reuse their buffers.
 */

export const MAX_FRAME_BYTES = 65_536;
export const BYTES_PER_SAMPLE = 2;

export type AudioChunk = Uint8Array | ArrayBuffer | ArrayBufferView;

function asBytes(data: AudioChunk): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

export class PcmFramer {
  readonly sampleRate: number;
  /** Size of a full frame in bytes (even, at most 65,536). */
  readonly frameBytes: number;
  /** Total bytes returned as frames so far. */
  bytesEmitted = 0;

  // Holds less than one frame between calls; frames are copied straight from the input.
  readonly #pending: Uint8Array;
  #pendingLength = 0;

  constructor(sampleRate: number, options: { frameMs?: number | undefined } = {}) {
    const frameMs = options.frameMs ?? 100;
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new RangeError('sampleRate must be a positive whole number of Hz');
    }
    if (!Number.isInteger(frameMs) || frameMs <= 0) throw new RangeError('frameMs must be a positive whole number');
    let size = Math.floor((sampleRate * BYTES_PER_SAMPLE * frameMs) / 1000);
    size -= size % 2;
    this.frameBytes = Math.max(BYTES_PER_SAMPLE, Math.min(MAX_FRAME_BYTES, size));
    this.sampleRate = sampleRate;
    this.#pending = new Uint8Array(this.frameBytes);
  }

  /** Bytes held back until more audio arrives (always less than one frame). */
  get pendingBytes(): number {
    return this.#pendingLength;
  }

  /** Seconds of audio returned as frames so far. */
  get secondsEmitted(): number {
    return this.bytesEmitted / (this.sampleRate * BYTES_PER_SAMPLE);
  }

  /** Add audio; return the complete frames now ready to send. */
  push(data: AudioChunk): Uint8Array[] {
    const input = asBytes(data);
    const size = this.frameBytes;
    const frames: Uint8Array[] = [];
    let offset = 0;
    if (this.#pendingLength > 0) {
      const needed = size - this.#pendingLength;
      if (input.length < needed) {
        this.#pending.set(input, this.#pendingLength);
        this.#pendingLength += input.length;
        return frames;
      }
      const frame = new Uint8Array(size);
      frame.set(this.#pending.subarray(0, this.#pendingLength));
      frame.set(input.subarray(0, needed), this.#pendingLength);
      frames.push(frame);
      offset = needed;
      this.#pendingLength = 0;
    }
    while (input.length - offset >= size) {
      frames.push(input.slice(offset, offset + size));
      offset += size;
    }
    const rest = input.subarray(offset);
    this.#pending.set(rest, 0);
    this.#pendingLength = rest.length;
    this.bytesEmitted += frames.length * size;
    return frames;
  }

  /** Return all buffered whole samples (before `endSegment`). An odd byte stays buffered. */
  flush(): Uint8Array[] {
    const whole = this.#pendingLength - (this.#pendingLength % 2);
    if (whole === 0) return [];
    const frame = this.#pending.slice(0, whole);
    this.#pending.copyWithin(0, whole, this.#pendingLength);
    this.#pendingLength -= whole;
    this.bytesEmitted += whole;
    return [frame];
  }

  /** Flush at `stop`. Returns the last frames and how many odd bytes were dropped (0 or 1). */
  finish(): { frames: Uint8Array[]; dropped: number } {
    const frames = this.flush();
    const dropped = this.#pendingLength;
    this.#pendingLength = 0;
    return { frames, dropped };
  }
}
