// The two parts you replace: who the end user is, and how much they may use.
// Pass your own versions to createProxy(settings, { authenticate, quota }).

import { timingSafeEqual } from 'node:crypto';

/**
 * Returns your user's id, or null to reject the request with 401.
 * Called for REST requests (an Express request) and for WebSocket upgrades (a plain Node
 * IncomingMessage): use only what both have, such as req.headers.
 * Stream tokens (?access_token= on WebSocket URLs) are checked by the proxy before this hook.
 * @typedef {(req: import('node:http').IncomingMessage) => Promise<string | null>} Authenticate
 */

/**
 * @typedef {object} Quota
 * @property {(userId: string) => Promise<number | null>} allowRequest
 *   null to allow the request, or the number of seconds to wait (sent as Retry-After).
 * @property {(userId: string) => Promise<boolean>} acquireStream
 *   Reserve a concurrent-stream slot. false rejects the stream with 429.
 * @property {(userId: string) => Promise<void>} releaseStream
 *   Give back a slot reserved by acquireStream (always called once the stream ends).
 */

/**
 * Parse a Cookie header.
 * @param {string | undefined} header
 * @returns {Map<string, string>}
 */
export function parseCookies(header) {
  const cookies = new Map();
  for (const pair of (header ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const name = pair.slice(0, at).trim();
    let value = pair.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name && !cookies.has(name)) {
      try {
        cookies.set(name, decodeURIComponent(value));
      } catch {
        cookies.set(name, value);
      }
    }
  }
  return cookies;
}

/**
 * DEMO ONLY - REPLACE THIS with your own authentication.
 *
 * Accepts one static token (PROXY_DEMO_TOKEN), sent either as `Authorization: Bearer <token>`
 * or as the session cookie, and treats everyone who has it as the same user. In a real app,
 * verify your own session cookie or access token here (look the session up, or check the
 * JWT's signature, expiry and audience) and return that user's id.
 *
 * @param {string} token
 * @param {string} [cookieName]
 * @returns {Authenticate}
 */
export function demoAuthenticate(token, cookieName = 'session') {
  const expected = Buffer.from(token, 'utf8');
  return async (req) => {
    const [scheme = '', ...rest] = (req.headers.authorization ?? '').split(' ');
    const candidate =
      scheme.toLowerCase() === 'bearer'
        ? rest.join(' ').trim()
        : (parseCookies(req.headers.cookie).get(cookieName) ?? '');
    const given = Buffer.from(candidate, 'utf8');
    if (candidate && given.length === expected.length && timingSafeEqual(given, expected)) return 'demo-user';
    return null;
  };
}

/**
 * Example quota: N requests a minute per user, and a cap on concurrent streams.
 *
 * Every REST request and every stream connection counts as a request. The concurrent-stream
 * caps apply per user and across all users: the EchoNova workspace allows 10 concurrent streams
 * in total (TTS and STT combined), so a proxy that lets more through only gets 429s from upstream.
 *
 * State lives in this process. With several proxy instances, keep these counters in a shared
 * store (Redis or your database) instead.
 *
 * @implements {Quota}
 */
export class InMemoryQuota {
  /**
   * @param {{ requestsPerMinute?: number, maxStreamsPerUser?: number, maxStreamsTotal?: number, clock?: () => number }} [options]
   *   clock returns milliseconds (monotonic).
   */
  constructor({
    requestsPerMinute = 60,
    maxStreamsPerUser = 2,
    maxStreamsTotal = 10,
    clock = () => performance.now(),
  } = {}) {
    this.requestsPerMinute = requestsPerMinute;
    this.maxStreamsPerUser = maxStreamsPerUser;
    this.maxStreamsTotal = maxStreamsTotal;
    this.clock = clock;
    /** @type {Map<string, number[]>} */
    this.requests = new Map();
    /** @type {Map<string, number>} */
    this.streams = new Map();
    this.totalStreams = 0;
  }

  /** @param {string} userId */
  async allowRequest(userId) {
    const now = this.clock();
    const window = (this.requests.get(userId) ?? []).filter((t) => t > now - 60_000);
    this.requests.set(userId, window);
    if (window.length >= this.requestsPerMinute) {
      return Math.max(1, Math.ceil((window[0] + 60_000 - now) / 1000));
    }
    window.push(now);
    this.forgetIdle(now);
    return null;
  }

  /** @param {string} userId */
  async acquireStream(userId) {
    const mine = this.streams.get(userId) ?? 0;
    if (mine >= this.maxStreamsPerUser || this.totalStreams >= this.maxStreamsTotal) return false;
    this.streams.set(userId, mine + 1);
    this.totalStreams += 1;
    return true;
  }

  /** @param {string} userId */
  async releaseStream(userId) {
    const mine = this.streams.get(userId) ?? 0;
    if (mine <= 0) return;
    this.totalStreams -= 1;
    if (mine > 1) this.streams.set(userId, mine - 1);
    else this.streams.delete(userId);
  }

  /** Keep memory bounded: drop users with no request in the last minute. @param {number} now */
  forgetIdle(now) {
    if (this.requests.size <= 10_000) return;
    for (const [user, window] of this.requests) {
      if (!window.length || window[window.length - 1] <= now - 60_000) this.requests.delete(user);
    }
  }
}
