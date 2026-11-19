// Pieces shared by the REST and WebSocket relays.

import { createHmac, randomUUID } from 'node:crypto';

export const PROXY_USER_AGENT = 'echonova-proxy/0.1 (express)';

// Request headers copied from the app's request. Everything else is dropped, including
// Authorization, Cookie, hop-by-hop headers and X-Forwarded-*. The proxy sets its own
// Authorization (the API key) and X-Request-Id.
// Idempotency-Key makes a retried synthesis, transcription or cleaning return the first result
// instead of running (and charging) twice. It is forwarded scoped to the user (scopedIdempotencyKey).
export const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'idempotency-key'];

// What the API accepts as an Idempotency-Key: 1 to 200 printable ASCII characters, no spaces.
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

/**
 * The Idempotency-Key sent upstream for the app's key: hex HMAC-SHA256(secret, userId + "\0" + key).
 *
 * The API keeps one set of keys per workspace, and every user of the proxy shares the workspace.
 * Forwarded as-is, a key another user sent first would return that user's job. Scoped, the same
 * user always gets the same upstream key (so retries stay safe) and different users never share
 * one. The secret must be the same on every instance and across restarts, or a retry after a
 * restart runs (and charges) again: set PROXY_STREAM_TOKEN_SECRET.
 * A key the API would refuse is forwarded unchanged, so the app gets the API's own 400.
 * @param {string} key
 * @param {string} userId
 * @param {Buffer} secret
 */
export function scopedIdempotencyKey(key, userId, secret) {
  if (!IDEMPOTENCY_KEY.test(key)) return key;
  return createHmac('sha256', secret).update(`${userId}\0${key}`, 'utf8').digest('hex');
}

// Response headers copied from EchoNova's response. Everything else is dropped
// (Set-Cookie, Server, upstream CORS headers, ...).
const SAFE_RESPONSE_HEADERS = new Set(['content-type', 'content-disposition', 'retry-after', 'x-request-id']);
const SAFE_RESPONSE_PREFIXES = ['x-ratelimit-'];

export const EXPOSED_HEADERS =
  'Content-Disposition, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Request-Id';

export const STREAM_TOKEN_PARAM = 'access_token';

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The app's X-Request-Id when it is a plain token, otherwise a fresh one.
 * @param {string | string[] | undefined} incoming
 */
export function requestId(incoming) {
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * '/echonova/v1/x' -> '/v1/x'; null when the path is outside the prefix.
 * @param {string} rawPath
 * @param {string} prefix
 */
export function stripPrefix(rawPath, prefix) {
  if (!prefix) return rawPath;
  return rawPath.startsWith(`${prefix}/`) ? rawPath.slice(prefix.length) : null;
}

/**
 * Split a raw request target into path and query string (without '?').
 * @param {string} url
 * @returns {[string, string]}
 */
export function splitUrl(url) {
  const at = url.indexOf('?');
  return at < 0 ? [url, ''] : [url.slice(0, at), url.slice(at + 1)];
}

/** @param {string} name */
export function isSafeResponseHeader(name) {
  const lower = name.toLowerCase();
  return SAFE_RESPONSE_HEADERS.has(lower) || SAFE_RESPONSE_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * @param {Iterable<[string, string | string[] | undefined]>} headers
 * @returns {Array<[string, string]>}
 */
export function safeResponseHeaders(headers) {
  /** @type {Array<[string, string]>} */
  const out = [];
  for (const [name, value] of headers) {
    if (value === undefined || !isSafeResponseHeader(name)) continue;
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    if (!/[\r\n]/.test(text)) out.push([name.toLowerCase(), text]);
  }
  return out;
}

/** @param {string | string[] | undefined} incoming */
export function userAgent(incoming) {
  return typeof incoming === 'string' && incoming ? `${incoming} ${PROXY_USER_AGENT}` : PROXY_USER_AGENT;
}

/**
 * The EchoNova error envelope, so the SDKs map proxy errors like API errors.
 * @param {number} status
 * @param {string} message
 */
export function errorBody(status, message) {
  return JSON.stringify({ data: null, success: false, statusCode: status, errorMessage: message });
}

// Messages the SDKs already understand: 429 + Retry-After is a rate limit to wait out,
// 429 "Too many concurrent streams" is a concurrency limit, 503 "...temporarily unavailable"
// means nothing reached EchoNova, so retrying is safe.
/** @type {Record<number, string>} */
export const MESSAGES = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Origin not allowed',
  404: 'Route not found',
  405: 'Method not allowed',
  413: 'Request body too large',
  426: 'This route needs a WebSocket upgrade',
  429: 'Too many requests',
  502: 'Bad gateway: the EchoNova API connection failed',
  503: 'The EchoNova API is temporarily unavailable. Try again.',
  504: 'Gateway timeout: the EchoNova API did not answer in time',
};
export const TOO_MANY_STREAMS = 'Too many concurrent streams';
// The API doesn't redirect; the proxy never follows one (it could lead the key elsewhere).
export const UNEXPECTED_REDIRECT = 'Bad gateway: unexpected redirect from the EchoNova API';

/**
 * Did the upstream call fail before anything was sent (so a retry can't double-charge)?
 * @param {unknown} err
 */
export function failedToConnect(err) {
  const cause = /** @type {any} */ (err)?.cause ?? err;
  const causes = Array.isArray(cause?.errors) && cause.errors.length ? cause.errors : [cause];
  return causes.every(
    (/** @type {any} */ c) =>
      c?.syscall === 'connect' ||
      c?.syscall === 'getaddrinfo' ||
      c?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
      c?.code === 'ECONNREFUSED' ||
      c?.code === 'ENOTFOUND' ||
      c?.code === 'EAI_AGAIN',
  );
}

/**
 * Did the upstream call time out waiting for EchoNova?
 * @param {unknown} err
 */
export function timedOut(err) {
  const cause = /** @type {any} */ (err)?.cause ?? err;
  return ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(cause?.code);
}
