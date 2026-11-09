// Short-lived stream tokens for browser WebSockets.
//
// Browsers can't set an Authorization header on a WebSocket. A web app that doesn't rely on
// cookies first calls POST {prefix}/stream-token with its normal credentials, then opens
// wss://.../v1/...stream?access_token=<token> within the token's lifetime (60 s by default).
// The proxy removes access_token from the URL before forwarding or logging it.
//
// Format: base64url(user id) "." expiry (Unix seconds) "." base64url(HMAC-SHA256 of the first two).
// The FastAPI proxy uses the same format, so either proxy accepts the other's tokens when they
// share PROXY_STREAM_TOKEN_SECRET.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * @param {Buffer} secret
 * @param {string} payload
 */
function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload, 'ascii').digest('base64url');
}

/**
 * @param {string} userId
 * @param {Buffer} secret
 * @param {number} ttl seconds
 * @param {number} [now] Unix seconds
 */
export function mintStreamToken(userId, secret, ttl, now = Date.now() / 1000) {
  const payload = `${Buffer.from(userId, 'utf8').toString('base64url')}.${Math.floor(now) + ttl}`;
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * The user id, or null when the token is forged, malformed or expired.
 * @param {string} token
 * @param {Buffer} secret
 * @param {number} [now] Unix seconds
 * @returns {string | null}
 */
export function verifyStreamToken(token, secret, now = Date.now() / 1000) {
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[1]) || token.length > 512) return null;
  const expected = Buffer.from(sign(secret, `${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(parts[1]) <= now) return null;
  const user = Buffer.from(parts[0], 'base64url').toString('utf8');
  return user || null;
}
