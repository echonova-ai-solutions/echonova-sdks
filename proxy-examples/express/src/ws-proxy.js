// WebSocket pass-through for the two EchoNova streams.
//
// The app's upgrade is held until EchoNova has accepted (or refused) the proxy's own upgrade, so:
// - a refused upstream handshake is answered with the same HTTP status, JSON body and safe headers;
// - once both sides are open, text and binary frames are relayed in order, both ways. A side
//   whose peer can't keep up is paused (backpressure) instead of buffering without limit;
// - a close on either side is repeated on the other with the same code and reason. A connection
//   that drops without a close frame (1006) is dropped on the other side too. A close frame with
//   no code (1005) is repeated as 1000, as the FastAPI proxy does.

import { STATUS_CODES } from 'node:http';

import WebSocket, { WebSocketServer } from 'ws';

import {
  MESSAGES,
  STREAM_TOKEN_PARAM,
  TOO_MANY_STREAMS,
  errorBody,
  requestId,
  safeResponseHeaders,
  splitUrl,
  stripPrefix,
  userAgent,
} from './common.js';
import { upstreamWsUrl } from './config.js';
import { errorName, levelFor } from './log.js';
import { STREAM_ROUTES, isStreamRoute } from './routes.js';
import { verifyStreamToken } from './tokens.js';

const MAX_APP_FRAME = 1024 * 1024; // the API's own frame limit
const MAX_UPSTREAM_FRAME = 16 * 1024 * 1024;
const MAX_REJECTION_BODY = 64 * 1024;
const HIGH_WATER = 1024 * 1024; // pause the sending side when this much is waiting to be written
const PING_INTERVAL_MS = 20_000;

/**
 * @typedef {import('./app.js').ProxyContext} ProxyContext
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {import('node:stream').Duplex} Duplex
 */

/**
 * Refuse an upgrade with a plain HTTP response (the app sees the status and the body).
 * @param {Duplex} socket
 * @param {number} status
 * @param {string} rid
 * @param {Buffer} body
 * @param {Array<[string, string]>} headers
 */
function deny(socket, status, rid, body, headers) {
  if (socket.destroyed) return;
  const merged = new Map(headers);
  if (!merged.has('x-request-id')) merged.set('x-request-id', rid);
  merged.set('content-length', String(body.length));
  merged.set('connection', 'close');
  const head = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}`, ...[...merged].map(([k, v]) => `${k}: ${v}`)];
  socket.end(Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`, 'latin1'), body]));
}

/**
 * @param {Duplex} socket
 * @param {number} status
 * @param {string} rid
 * @param {string} [message]
 * @param {Array<[string, string]>} [headers]
 */
function denyError(socket, status, rid, message, headers = []) {
  const body = Buffer.from(errorBody(status, message ?? MESSAGES[status]));
  deny(socket, status, rid, body, [['content-type', 'application/json'], ['cache-control', 'no-store'], ...headers]);
}

/**
 * The checks the WebSocket server makes before it accepts an upgrade, made before EchoNova is called.
 * @param {IncomingMessage} req
 */
function isWebSocketUpgrade(req) {
  return (
    req.method === 'GET' &&
    req.headers.upgrade?.toLowerCase() === 'websocket' &&
    /^[+/0-9A-Za-z]{22}==$/.test(req.headers['sec-websocket-key'] ?? '') &&
    ['8', '13'].includes(req.headers['sec-websocket-version'] ?? '')
  );
}

/**
 * @param {ProxyContext} ctx
 */
export function createUpgradeHandler(ctx) {
  const { settings, log } = ctx;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_APP_FRAME });
  /** @type {Set<WebSocket>} */
  const upstreams = new Set();
  /** @type {WeakMap<IncomingMessage, string>} */
  const requestIds = new WeakMap();
  wss.on('headers', (headers, req) => {
    const rid = requestIds.get(req);
    if (rid) headers.push(`X-Request-Id: ${rid}`);
  });

  /**
   * Close every stream, as uvicorn does for the FastAPI proxy: 1012 (service restart) to the
   * app, which the relay repeats upstream. Connections that don't finish closing are dropped.
   */
  async function shutdown(graceMs = 1000) {
    const ended = [...wss.clients].map((app) => new Promise((resolve) => app.once('close', resolve)));
    for (const app of wss.clients) app.close(1012, 'server shutting down');
    const grace = new Promise((resolve) => setTimeout(resolve, graceMs).unref());
    await Promise.race([Promise.all(ended), grace]);
    for (const app of wss.clients) app.terminate();
    await new Promise((resolve) => setImmediate(resolve)); // let the relays repeat the close upstream
    for (const upstream of upstreams) upstream.terminate();
  }

  /**
   * @param {IncomingMessage} req
   * @param {Duplex} socket
   * @param {Buffer} head
   */
  async function handleUpgrade(req, socket, head) {
    socket.on('error', () => {}); // a reset before the upgrade completes is not a crash
    try {
      await upgrade(req, socket, head);
    } catch (err) {
      // Anything thrown (by a hook, say) becomes a plain 500: no stack traces, no request data.
      log('ws.error', { error: errorName(err) }, 'error');
      denyError(socket, 500, requestId(req.headers['x-request-id']), 'Internal server error');
    }
  }

  return { handleUpgrade, shutdown };

  /**
   * @param {IncomingMessage} req
   * @param {Duplex} socket
   * @param {Buffer} head
   */
  async function upgrade(req, socket, head) {
    const started = performance.now();
    const rid = requestId(req.headers['x-request-id']);
    /** @type {Record<string, unknown>} */
    const fields = { request_id: rid };
    /** @param {string} event @param {Record<string, unknown>} [extra] */
    const logEnd = (event, extra = {}) =>
      log(event, { ...fields, ...extra, ms: Math.round(performance.now() - started) }, levelFor(extra.status));

    if (!isWebSocketUpgrade(req)) {
      denyError(socket, 400, rid, 'Invalid WebSocket upgrade');
      return logEnd('ws.rejected', { status: 400 });
    }

    // The token never travels further than this: it is taken out of the URL first.
    const [rawPath, query] = splitUrl(req.url ?? '/');
    const params = new URLSearchParams(query);
    const token = params.getAll(STREAM_TOKEN_PARAM).at(-1);
    params.delete(STREAM_TOKEN_PARAM);

    const path = stripPrefix(rawPath, settings.prefix);
    const origin = req.headers.origin;
    if (path !== null && origin !== undefined && !settings.allowedOrigins.has(origin)) {
      denyError(socket, 403, rid); // see browserPolicy in app.js
      return log('origin.rejected', { type: 'websocket', request_id: rid });
    }
    if (path === null || !isStreamRoute(path)) {
      denyError(socket, 404, rid);
      return logEnd('ws.rejected', { status: 404 });
    }
    fields.route = path;

    const user =
      token !== undefined ? verifyStreamToken(token, settings.streamTokenSecret) : await ctx.authenticate(req);
    if (!user) {
      denyError(socket, 401, rid);
      return logEnd('ws.rejected', { status: 401 });
    }
    fields.user = user;
    const retryAfter = await ctx.quota.allowRequest(user);
    if (retryAfter !== null) {
      denyError(socket, 429, rid, undefined, [['retry-after', String(retryAfter)]]);
      return logEnd('ws.rejected', { status: 429 });
    }
    if (!(await ctx.quota.acquireStream(user))) {
      denyError(socket, 429, rid, TOO_MANY_STREAMS);
      return logEnd('ws.rejected', { status: 429, reason: 'streams' });
    }
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        ctx.quota.releaseStream(user).catch(() => {});
      }
    };

    if (socket.destroyed) {
      release(); // the app hung up during the checks above
      return logEnd('ws.rejected', { status: 499, outcome: 'client_closed' });
    }

    const allowed = STREAM_ROUTES[path];
    const forwarded = new URLSearchParams([...params].filter(([key]) => allowed.includes(key)));
    const url = upstreamWsUrl(settings) + path + (forwarded.size ? `?${forwarded}` : '');
    const upstream = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        'user-agent': userAgent(req.headers['user-agent']),
        'x-request-id': rid,
      },
      perMessageDeflate: false,
      handshakeTimeout: settings.connectTimeoutMs,
      maxPayload: MAX_UPSTREAM_FRAME,
      followRedirects: false,
    });
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    let settled = false; // the app's upgrade has been answered (accepted or refused)
    let connected = false; // both sides are open and the relay runs

    socket.once('close', () => {
      if (connected) return;
      upstream.terminate();
      release();
      if (!settled) {
        settled = true; // the app hung up while we were still talking to EchoNova
        logEnd('ws.rejected', { status: 499, outcome: 'client_closed' });
      }
    });

    upstream.on('unexpected-response', (request, response) => {
      // EchoNova refused: give the app the same answer, so the SDK maps it to the same error.
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      response.on('data', (/** @type {Buffer} */ chunk) => {
        if (size < MAX_REJECTION_BODY) chunks.push(chunk.subarray(0, MAX_REJECTION_BODY - size));
        size += chunk.length;
      });
      const finish = () => {
        if (settled) return;
        settled = true;
        const headers = safeResponseHeaders(Object.entries(response.headers));
        deny(socket, response.statusCode ?? 502, rid, Buffer.concat(chunks), headers);
        release();
        upstream.terminate();
        const upstreamRid = response.headers['x-request-id'];
        logEnd('ws.rejected', { status: response.statusCode, upstream_request_id: upstreamRid });
      };
      response.on('end', finish);
      response.on('error', finish);
      request.on('error', () => {});
    });

    upstream.on('error', (err) => {
      if (settled) return;
      settled = true;
      release();
      const name = errorName(err);
      // A timeout is 504; a network or TLS failure (nothing was sent) is 503; a broken handshake is 502.
      const network = /** @type {{ code?: unknown }} */ (err).code !== undefined;
      const status = /timed out/i.test(err.message) ? 504 : network ? 503 : 502;
      denyError(socket, status, rid);
      logEnd('ws.rejected', { status, upstream_error: name });
    });

    upstream.once('open', () => {
      if (settled) return;
      settled = true;
      if (socket.destroyed) {
        upstream.terminate();
        release();
        return logEnd('ws.rejected', { status: 499, outcome: 'client_closed' });
      }
      requestIds.set(req, rid);
      // Synchronous: the relay is listening before EchoNova's first message can be read.
      wss.handleUpgrade(req, socket, head, (app) => {
        connected = true;
        log('ws.open', fields);
        relay(app, upstream, (closedBy, code, counts) => {
          release();
          logEnd('ws.close', { closed_by: closedBy, code, ...counts });
        });
      });
    });
  }
}

/**
 * Relay until one side closes, then repeat the close on the other side.
 * @param {WebSocket} app
 * @param {WebSocket} upstream
 * @param {(closedBy: 'app' | 'upstream', code: number, counts: { frames_up: number, frames_down: number }) => void} onEnd
 */
function relay(app, upstream, onEnd) {
  const counts = { frames_up: 0, frames_down: 0 };
  let ended = false;

  /**
   * @param {WebSocket} from
   * @param {WebSocket} to
   * @param {'frames_up' | 'frames_down'} counter
   */
  const forward = (from, to, counter) => {
    from.on('message', (data, isBinary) => {
      if (to.readyState !== WebSocket.OPEN) return;
      to.send(/** @type {Buffer} */ (data), { binary: isBinary }, () => {
        if (from.isPaused && to.bufferedAmount < HIGH_WATER) from.resume();
      });
      counts[counter] += 1;
      if (to.bufferedAmount >= HIGH_WATER) from.pause();
    });
  };
  forward(app, upstream, 'frames_up');
  forward(upstream, app, 'frames_down');
  app.on('error', () => {});
  upstream.on('error', () => {});

  // Keep idle app connections honest: a peer that stops answering pings is dropped.
  let alive = true;
  app.on('pong', () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) return app.terminate();
    alive = false;
    app.ping();
  }, PING_INTERVAL_MS);

  upstream.on('close', (code, reason) => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    app.resume();
    if (code === 1006) app.terminate();
    else app.close(code === 1005 ? 1000 : code, reason);
    onEnd('upstream', code, counts);
  });
  app.on('close', (code, reason) => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    upstream.resume();
    try {
      upstream.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      upstream.close(1000); // a code the API can't receive: close normally instead
    }
    onEnd('app', code, counts);
  });
}
