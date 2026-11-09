import { describe, expect, it } from 'vitest';
import { Audio, iterFrames, parseWav, pcmToWav, wavHeader } from '../../src/streaming/audio.js';
import { pcm } from './stream-helpers.js';

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));

describe('audio helpers', () => {
  it('writes a 44-byte PCM16 mono WAV header', () => {
    const header = wavHeader(16_000, { dataLength: 32_000 });
    const v = view(header);
    expect(header.length).toBe(44);
    expect([ascii(header, 0), ascii(header, 8), ascii(header, 12), ascii(header, 36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(v.getUint32(4, true)).toBe(32_036);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000); // byte rate
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(32_000);
  });

  it('writes unknown sizes for a streaming header', () => {
    const v = view(wavHeader(24_000));
    expect(v.getUint32(4, true)).toBe(0xffffffff);
    expect(v.getUint32(40, true)).toBe(0xffffffff);
  });

  it('rejects bad header arguments', () => {
    expect(() => wavHeader(0)).toThrow(RangeError);
    expect(() => wavHeader(16_000, { dataLength: -1 })).toThrow(RangeError);
    expect(() => wavHeader(16_000, { dataLength: 0xffffffff })).toThrow(RangeError);
  });

  it('round-trips through pcmToWav and parseWav', () => {
    const data = pcm(0.25, 22_050);
    const audio = new Audio(data, 22_050);
    expect(audio.duration).toBeCloseTo(0.25, 3);
    expect(audio.channels).toBe(1);
    const wav = audio.toWav();
    expect(wav).toEqual(pcmToWav(data, 22_050));
    expect(wav.length).toBe(44 + data.length);
    const parsed = parseWav(wav);
    expect(parsed.sampleRate).toBe(22_050);
    expect(parsed.pcm).toEqual(data);
    expect(String(audio)).toBe(`Audio(sampleRate=22050, duration=0.250s, bytes=${data.length})`);
    expect(new Audio(new Uint8Array(10), 0).duration).toBe(0);
  });

  it('reads a streamed WAV (unknown size) to the end, whole samples only', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const parsed = parseWav(new Uint8Array([...wavHeader(8_000), ...data]));
    expect([...parsed.pcm]).toEqual([1, 2, 3, 4]);
  });

  it('refuses anything but mono 16-bit PCM', () => {
    const stereo = wavHeader(16_000, { channels: 2, dataLength: 0 });
    expect(() => parseWav(stereo)).toThrow(/2 channels/);
    const eightBit = wavHeader(16_000, { bitsPerSample: 8, dataLength: 0 });
    expect(() => parseWav(eightBit)).toThrow(/8-bit/);
    const float = wavHeader(16_000, { dataLength: 0 });
    view(float).setUint16(20, 3, true);
    expect(() => parseWav(float)).toThrow(/format 3/);
    expect(() => parseWav(new TextEncoder().encode('not a wav file at all'))).toThrow(/not a WAV file/);
  });

  it('splits PCM into 100 ms frames', () => {
    const frames = [...iterFrames(pcm(0.35), 16_000)];
    expect(frames.map((f) => f.length)).toEqual([3_200, 3_200, 3_200, 1_600]);
    expect([...iterFrames(new Uint8Array(0), 16_000)]).toEqual([]);
    expect(() => [...iterFrames(new Uint8Array(4), 0)]).toThrow(RangeError);
  });
});
