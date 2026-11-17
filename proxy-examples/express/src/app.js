// The proxy application: createProxy(settings, { authenticate, quota }).

import http from 'node:http';

import express from 'express';
import { Agent } from 'undici';

import { EXPOSED_HEADERS, requestId, splitUrl, stripPrefix } from './common.js';
import { ConfigError } from './config.js';
import { InMemoryQuota, demoAuthenticate } from './hooks.js';
import { handleHttp, sendError } from './http-proxy.js';
import { createLogger, errorName } from './log.js';
import { mintStreamToken } from './tokens.js';
import { createUpgradeHandler } from './ws-proxy.js';

/**
 * @typedef {import('./config.js').Settings} Settings
 * @typedef {import('./hooks.js').Authenticate} Authenticate
 * @typedef {import('./hooks.js').Quota} Quota
 * @typedef {import('./log.js').Logger} Logger
 *
 * @typedef {object} ProxyContext
 * @property {Settings} settings
 * @property {Authenticate} authenticate
 * @property {Quota} quota
 * @property {Logger} log
 * @property {Agent} dispatcher HTTP connection pool for upstream calls (with the proxy's timeouts)
 */

/**
 * @param {Settings} settings
 * @param {{ authenticate?: Authenticate, quota?: Quota, logger?: Logger }} [hooks]
 */
export function createProxy(settings, hooks = {}) {
  let authenticate = hooks.authenticate;
  if (!authenticate) {
    if (!settings.demoToken) {
      throw new ConfigError('set PROXY_DEMO_TOKEN for the demo auth hook, or pass your own authenticate (hooks.js)');
    }
    authenticate = demoAuthenticate(settings.demoToken, settings.sessionCookie);
  }
  /** @type {ProxyContext} */
  const ctx = {
    settings,
    authenticate,
    quota: hooks.quota ?? new InMemoryQuota(settings),
    log: hooks.logger ?? createLogger(),
    // The pool behind fetch (http-proxy.js), with timeouts suited to the API: long synchronous
    // calls (STT, Sound Cleaning) can take minutes, and undici's default gives up after 300 s.
    // HTTP/1.1 only, as before undici 8 (which would otherwise negotiate HTTP/2 over TLS): one
    // connection per request in flight, so a large upload doesn't share a connection with others.
    dispatcher: new Agent({
      connect: { timeout: settings.connectTimeoutMs },
      headersTimeout: settings.readTimeoutMs,
      bodyTimeout: settings.readTimeoutMs,
      allowH2: false,
    }),
  };

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('query parser', false);
  app.use(browserPolicy(settings, ctx.log));

  app.get('/healthz', (_req, res) => {
    res.set('cache-control', 'no-store').json({ status: 'ok' });
  });

  // A short-lived token for ?access_token= on a WebSocket URL (for browsers without cookies).
  app.post(`${settings.prefix}/stream-token`, async (req, res) => {
    const rid = requestId(req.headers['x-request-id']);
    const user = await ctx.authenticate(req);
    if (!user) {
      ctx.log('stream_token', { status: 401, request_id: rid });
      return sendError(res, 401, rid);
    }
    const retryAfter = await ctx.quota.allowRequest(user);
    if (retryAfter !== null) {
      ctx.log('stream_token', { status: 429, user, request_id: rid });
      return sendError(res, 429, rid, undefined, { 'retry-after': String(retryAfter) });
    }
    const token = mintStreamToken(user, settings.streamTokenSecret, settings.streamTokenTtl);
    ctx.log('stream_token', { status: 200, user, request_id: rid });
    res.set({ 'cache-control': 'no-store', 'x-request-id': rid }).json({ token, expiresIn: settings.streamTokenTtl });
  });

  app.use((req, res) => handleHttp(req, res, ctx));
  // Anything thrown (by a hook, say) becomes a plain 500: no stack traces, no request data.
  app.use(
    /** @type {import('express').ErrorRequestHandler} */
    (err, req, res, _next) => {
      const rid = requestId(req.headers['x-request-id']);
      ctx.log('http.error', { request_id: rid, error: errorName(err) }, 'error');
      if (res.headersSent) return res.destroy();
      sendError(res, 500, rid, 'Internal server error');
    },
  );

  const { handleUpgrade, shutdown } = createUpgradeHandler(ctx);

  /**
   * Start an HTTP server for the proxy (REST and WebSocket upgrades).
   * @param {number} port
   * @param {string} [host]
   * @returns {Promise<http.Server>}
   */
  const listen = (port, host = '127.0.0.1') => {
    const server = http.createServer(
      {
        requestTimeout: 15 * 60_000, // a 150 MiB upload from a slow phone can take a while
        headersTimeout: 60_000,
      },
      app,
    );
    server.on('upgrade', (req, socket, head) => {
      handleUpgrade(req, socket, head).catch(() => socket.destroy());
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        ctx.log('proxy.start', { upstream: settings.upstreamUrl, prefix: settings.prefix || '/' });
        resolve(server);
      });
    });
  };

  /** Close open streams and the upstream connection pool (call when the server stops). */
  const close = async () => {
    await shutdown();
    await ctx.dispatcher.close();
  };

  return { app, handleUpgrade, listen, close };
}

/**
 * Browser rules for everything under the prefix.
 *
 * - CORS for the origins you list, with credentials, so web apps can use cookies.
 * - Requests that carry an Origin you didn't list are refused (403). CORS alone doesn't stop
 *   another site from *sending* a form post with your users' cookies; this check does. Apps
 *   that aren't browsers (mobile, server-side SDKs) send no Origin and are unaffected.
 *   WebSocket upgrades get the same check in ws-proxy.js.
 *
 * @param {Settings} settings
 * @param {Logger} log
 * @returns {import('express').RequestHandler}
 */
function browserPolicy(settings, log) {
  return (req, res, next) => {
    const [rawPath] = splitUrl(req.originalUrl);
    const origin = req.headers.origin;
    if (stripPrefix(rawPath, settings.prefix) === null || origin === undefined) return next();
    if (!settings.allowedOrigins.has(origin)) {
      const rid = requestId(req.headers['x-request-id']);
      log('origin.rejected', { type: 'http', request_id: rid });
      return sendError(res, 403, rid);
    }
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE');
      res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Idempotency-Key, X-Request-Id');
      res.setHeader('access-control-max-age', '600');
      return res.status(204).end();
    }
    res.setHeader('access-control-expose-headers', EXPOSED_HEADERS);
    next();
  };
}
