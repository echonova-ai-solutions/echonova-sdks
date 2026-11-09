// Proxy settings, read from environment variables.

import { randomBytes } from 'node:crypto';

export const DEFAULT_UPSTREAM = 'https://api.echonova.ai';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The proxy is misconfigured and refuses to start. */
export class ConfigError extends Error {
  name = 'ConfigError';
}

/**
 * @typedef {object} Settings
 * @property {string} apiKey The EchoNova API key. Only ever sent to upstreamUrl; never logged, never returned.
 * @property {string} upstreamUrl Where EchoNova lives. HTTPS only, except for local test servers.
 * @property {string} prefix Path the proxy is mounted under. Apps use baseURL = "https://your.host" + prefix.
 * @property {Set<string>} allowedOrigins Web origins allowed to call the proxy from a browser.
 * @property {string | null} demoToken Demo end-user auth only: the static token the demo hook accepts. Replace the hook.
 * @property {string} sessionCookie Cookie the demo hook reads the session from.
 * @property {Buffer} streamTokenSecret Signs the short-lived stream tokens used as ?access_token= on WebSocket URLs.
 * @property {number} streamTokenTtl Stream token lifetime, in seconds.
 * @property {number} requestsPerMinute Demo quota, per user.
 * @property {number} maxStreamsPerUser Demo quota, per user.
 * @property {number} maxStreamsTotal Demo quota, all users. The EchoNova workspace allows 10 concurrent streams in total.
 * @property {number} maxUploadBytes Upload cap. The API takes files up to 150 MiB; this leaves room for multipart overhead.
 * @property {number} connectTimeoutMs Upstream connect timeout.
 * @property {number} readTimeoutMs Upstream read timeout. Long synchronous calls (STT, Sound Cleaning) can take minutes.
 */

/**
 * Build and check settings. Unset fields get their defaults.
 * @param {Partial<Settings> & { apiKey: string }} values
 * @returns {Settings}
 */
export function makeSettings(values) {
  const apiKey = (values.apiKey ?? '').trim();
  if (!apiKey) throw new ConfigError('ECHONOVA_API_KEY is not set');
  return {
    upstreamUrl: DEFAULT_UPSTREAM,
    prefix: '/echonova',
    allowedOrigins: new Set(),
    demoToken: null,
    sessionCookie: 'session',
    streamTokenSecret: randomBytes(32),
    streamTokenTtl: 60,
    requestsPerMinute: 60,
    maxStreamsPerUser: 2,
    maxStreamsTotal: 10,
    maxUploadBytes: 160 * 1024 * 1024,
    connectTimeoutMs: 10_000,
    readTimeoutMs: 600_000,
    ...values,
    apiKey,
    ...checked(values),
  };
}

/**
 * @param {Partial<Settings>} values
 */
function checked(values) {
  /** @type {{ upstreamUrl?: string, prefix?: string }} */
  const out = {};
  if (values.upstreamUrl !== undefined) out.upstreamUrl = checkUpstream(values.upstreamUrl);
  if (values.prefix !== undefined) out.prefix = checkPrefix(values.prefix);
  return out;
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {Settings}
 */
export function settingsFromEnv(env = process.env) {
  const secret = env.PROXY_STREAM_TOKEN_SECRET ?? '';
  const origins = (env.PROXY_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return makeSettings({
    apiKey: env.ECHONOVA_API_KEY ?? '',
    upstreamUrl: env.ECHONOVA_UPSTREAM_URL ?? DEFAULT_UPSTREAM,
    prefix: env.PROXY_PREFIX ?? '/echonova',
    allowedOrigins: new Set(origins),
    demoToken: env.PROXY_DEMO_TOKEN || null,
    sessionCookie: env.PROXY_SESSION_COOKIE ?? 'session',
    streamTokenSecret: secret ? Buffer.from(secret, 'utf8') : randomBytes(32),
    requestsPerMinute: int(env, 'PROXY_REQUESTS_PER_MINUTE', 60),
    maxStreamsPerUser: int(env, 'PROXY_MAX_STREAMS_PER_USER', 2),
    maxStreamsTotal: int(env, 'PROXY_MAX_STREAMS_TOTAL', 10),
    maxUploadBytes: int(env, 'PROXY_MAX_UPLOAD_BYTES', 160 * 1024 * 1024),
  });
}

/**
 * @param {Settings} settings
 * @returns {string}
 */
export function upstreamWsUrl(settings) {
  return settings.upstreamUrl.replace(/^http/, 'ws');
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {number} fallback
 */
function int(env, name, fallback) {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative integer`);
  return Number(raw);
}

/** @param {string} url */
function checkUpstream(url) {
  const trimmed = url.trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError('ECHONOVA_UPSTREAM_URL must be an absolute https:// URL');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new ConfigError('ECHONOVA_UPSTREAM_URL must be an absolute https:// URL');
  }
  if (parsed.protocol === 'http:' && !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new ConfigError('ECHONOVA_UPSTREAM_URL must use https:// (the API key would travel in clear text)');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new ConfigError('ECHONOVA_UPSTREAM_URL must be the host only, without a path (routes include /v1)');
  }
  return trimmed;
}

/** @param {string} prefix */
function checkPrefix(prefix) {
  const trimmed = prefix.trim().replace(/\/+$/, '');
  if (trimmed && (!trimmed.startsWith('/') || trimmed.includes('?') || trimmed.includes('//'))) {
    throw new ConfigError('PROXY_PREFIX must look like /echonova');
  }
  return trimmed;
}
