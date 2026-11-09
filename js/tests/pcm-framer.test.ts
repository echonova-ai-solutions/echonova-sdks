import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, PcmFramer } from '../src/streaming/pcm-framer.js';

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

describe('PcmFramer', () => {
  it.each([
    [16_000, 100, 3_200],
    [8_000, 100, 1_600],
    [48_000, 100, 9_600],
    [48_000, 1_000, MAX_FRAME_BYTES],
    [8_001, 100, 1_600],
    [8_000, 1, 16],
  ])('frame size at %i Hz, %i ms is %i bytes', (sampleRate, frameMs, expected) => {
    expect(new PcmFramer(sampleRate, { frameMs }).frameBytes).toBe(expected);
  });

  it('frames are lossless, even and bounded', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(8_000, 16_000, 22_050, 44_100, 48_000),
        fc.array(fc.uint8Array({ maxLength: 20_000 }), { maxLength: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (sampleRate, chunks, segmentAfter) => {
          const framer = new PcmFramer(sampleRate);
          const sent: Uint8Array[] = [];
          chunks.forEach((chunk, index) => {
            sent.push(...framer.push(chunk));
            if (index === segmentAfter) sent.push(...framer.flush()); // endSegment
          });
          const { frames, dropped } = framer.finish();
          sent.push(...frames);
          const data = concat(chunks);
          for (const frame of sent) {
            expect(frame.length % 2).toBe(0);
            expect(frame.length).toBeGreaterThan(0);
            expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
          }
          expect(concat(sent)).toEqual(data.subarray(0, data.length - dropped));
          expect(dropped).toBe(data.length % 2);
          expect(framer.bytesEmitted).toBe(data.length - dropped);
          expect(framer.pendingBytes).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('carries an odd byte across endSegment', () => {
    const framer = new PcmFramer(16_000);
    framer.push(new Uint8Array([1, 2, 3]));
    expect(framer.flush()).toEqual([new Uint8Array([1, 2])]);
    expect(framer.pendingBytes).toBe(1);
    expect(framer.push(new Uint8Array([4]))).toEqual([]);
    expect(framer.flush()).toEqual([new Uint8Array([3, 4])]);
    expect(framer.flush()).toEqual([]);
  });

  it('copies its input', () => {
    const framer = new PcmFramer(8_000, { frameMs: 1 }); // 16-byte frames
    const buffer = new Uint8Array(10).fill(0x61);
    framer.push(buffer);
    buffer.fill(0x62);
    const big = new Uint8Array(32).fill(0x63);
    const frames = framer.push(big);
    big.fill(0x64);
    expect(frames).toEqual([
      new Uint8Array([...new Uint8Array(10).fill(0x61), ...new Uint8Array(6).fill(0x63)]),
      new Uint8Array(16).fill(0x63),
    ]);
    expect(framer.pendingBytes).toBe(10);
  });

  it('accepts ArrayBuffer and other views', () => {
    const framer = new PcmFramer(8_000, { frameMs: 1 });
    expect(framer.push(new ArrayBuffer(16))).toHaveLength(1);
    expect(framer.push(new Int16Array(8))).toHaveLength(1);
    expect(framer.secondsEmitted).toBeCloseTo(32 / 16_000);
  });

  it('rejects invalid arguments', () => {
    expect(() => new PcmFramer(0)).toThrow(/sampleRate/);
    expect(() => new PcmFramer(16_000.5)).toThrow(/sampleRate/);
    expect(() => new PcmFramer(16_000, { frameMs: 0 })).toThrow(/frameMs/);
  });
});
