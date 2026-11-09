import { describe, expect, it } from 'vitest';
import { parseRateLimit, RateLimitTracker } from '../src/core/ratelimit.js';

class FakeClock {
  now = 1000;
  readonly read = (): number => this.now;
}

describe('parseRateLimit', () => {
  it('reads the three headers', () => {
    const info = parseRateLimit({ 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '7', 'X-RateLimit-Reset': '42' });
    expect(info).toEqual({ limit: 100, remaining: 7, resetSeconds: 42 });
    expect(parseRateLimit({})).toBeNull();
  });

  it('keeps partial and malformed values as null', () => {
    expect(parseRateLimit(new Headers({ 'x-ratelimit-remaining': ' 0 ', 'x-ratelimit-limit': '7.5' }))).toEqual({
      limit: null,
      remaining: 0,
      resetSeconds: null,
    });
  });
});

describe('RateLimitTracker', () => {
  it('preflight waits for the window when nothing remains', () => {
    const clock = new FakeClock();
    const tracker = new RateLimitTracker({ clock: clock.read });
    tracker.observe('tts.jobs.get', { 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '20' });
    expect(tracker.waitTime('tts.jobs.get')).toBe(20);
    expect(tracker.waitTime('tts.jobs.get', { preflight: false })).toBe(0);
    expect(tracker.waitTime('tts.jobs.list')).toBe(0); // other endpoints have their own bucket
    clock.now += 21;
    expect(tracker.waitTime('tts.jobs.get')).toBe(0);
  });

  it('does not wait while requests remain', () => {
    const tracker = new RateLimitTracker({ clock: new FakeClock().read });
    tracker.observe('a', { 'X-RateLimit-Remaining': '3', 'X-RateLimit-Reset': '20' });
    expect(tracker.waitTime('a')).toBe(0);
  });

  it('a throttle block applies even without preflight', () => {
    const clock = new FakeClock();
    const tracker = new RateLimitTracker({ clock: clock.read });
    tracker.block('stt.transcribe', 60);
    clock.now += 15;
    expect(tracker.waitTime('stt.transcribe', { preflight: false })).toBe(45);
    tracker.block('stt.transcribe', 10); // a shorter block never shortens the current one
    expect(tracker.waitTime('stt.transcribe')).toBe(45);
  });

  it('ignores responses without rate-limit headers and keeps a snapshot', () => {
    const tracker = new RateLimitTracker({ clock: new FakeClock().read });
    expect(tracker.observe('a', {})).toBeNull();
    expect(tracker.last('a')).toBeNull();
    tracker.observe('b', { 'X-RateLimit-Limit': '100', 'X-RateLimit-Remaining': '99', 'X-RateLimit-Reset': '60' });
    expect(tracker.last('b')).toEqual({ limit: 100, remaining: 99, resetSeconds: 60 });
    expect(tracker.snapshot()).toEqual({ b: { limit: 100, remaining: 99, resetSeconds: 60 } });
  });

  it('never lets a malformed reset produce NaN', () => {
    const tracker = new RateLimitTracker({ clock: new FakeClock().read });
    tracker.observe('a', { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': 'nan' });
    expect(tracker.waitTime('a')).toBe(0);
  });
});
