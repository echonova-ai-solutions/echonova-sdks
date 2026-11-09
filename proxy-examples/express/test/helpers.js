// Test harness: a fake EchoNova API (HTTP + WebSocket) and the proxy, both real servers on
// 127.0.0.1. Nothing here talks to the real API.

import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import WebSocket, { WebSocketServer } from 'ws';

import { createLogger, createProxy, makeSettings } from '../src/index.js';

export const API_KEY = 'ek_REDACTED_proxy_test_key_0001'; // made up; must never reach the app side
export const USER_TOKEN = 'user-token-1';
export const ORIGIN = 'https://app.example.com';
export const UPSTREAM_RID = 'upstream-rid-1';
export const MiB = 1024 * 1024;

/**
 * @typedef {object} Recorded
 * @property {string} method
 * @property {string} path
 * @property {string} query
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {string[]} rawHeaders
 * @property {number} bodyBytes
 * @property {string} bodySha256
 * @property {number} chunks
 */

/** @returns {{ promise: Promise<void>, resolve: () => void }} */
function deferred() {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
}

/** @param {http.IncomingMessage} req @returns {Recorded} */
function record(req) {
  const [path, query = ''] = (req.url ?? '/').split('?');
  return {
    method: req.method ?? 'GET',
    path,
    query,
    headers: req.headers,
    rawHeaders: req.rawHeaders,
    bodyBytes: 0,
    bodySha256: '',
    chunks: 0,
  };
}

export class FakeUpstream {
  /** @type {Recorded[]} */ requests = [];
  /** @type {Recorded[]} */ wsHandshakes = [];
  /** @type {Array<[number, string]>} */ wsCloses = [];
  wsClosed = deferred();
  firstChunk = deferred();
  burstSent = 0;
  /** @type {((req: http.IncomingMessage, res: http.ServerResponse, recorded: Recorded) => Promise<void> | void) | null} */
  respond = null;
  /** @type {[number, unknown, Record<string, string>] | null} status, JSON body, extra headers */
  wsReject = null;

  async start() {
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    this.server = http.createServer((req, res) => this.http(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    await new Promise((r) => this.server?.listen(0, '127.0.0.1', () => r(undefined)));
    const address = /** @type {net.AddressInfo} */ (this.server.address());
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async stop() {
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.server?.closeAllConnections();
    await new Promise((r) => this.server?.close(() => r(undefined)));
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async http(req, res) {
    const recorded = record(req);
    this.requests.push(recorded);
    const digest = createHash('sha256');
    try {
      for await (const chunk of req) {
        recorded.chunks += 1;
        recorded.bodyBytes += chunk.length;
        digest.update(chunk);
        this.firstChunk.resolve();
      }
    } catch {
      return; // the proxy gave up on the upload
    }
    recorded.bodySha256 = digest.digest('hex');
    if (this.respond) return this.respond(req, res, recorded);
    const body = JSON.stringify({
      data: { method: recorded.method, path: recorded.path, bytes: recorded.bodyBytes },
      success: true,
      statusCode: 200,
      errorMessage: null,
    });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': UPSTREAM_RID,
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '99',
      'x-ratelimit-reset': '60',
      'set-cookie': 'upstream_session=abc; HttpOnly',
      server: 'fake-upstream',
      'x-powered-by': 'fake',
      'access-control-allow-origin': '*',
      'x-internal-trace': 'node-7',
    });
    res.end(body);
  }

  /** @param {http.IncomingMessage} req @param {import('node:stream').Duplex} socket @param {Buffer} head */
  upgrade(req, socket, head) {
    const recorded = record(req);
    this.wsHandshakes.push(recorded);
    if (this.wsReject) {
      const [status, json, extra] = this.wsReject;
      const body = Buffer.from(JSON.stringify(json));
      const lines = [
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}`,
        'content-type: application/json; charset=utf-8',
        `x-request-id: ${UPSTREAM_RID}`,
        'x-internal-trace: node-7',
        ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
        `content-length: ${body.length}`,
        'connection: close',
      ];
      socket.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), body]));
      return;
    }
    this.wss?.handleUpgrade(req, socket, head, (ws) => this.session(ws, recorded));
  }

  /** @param {WebSocket} ws @param {Recorded} recorded */
  session(ws, recorded) {
    if (recorded.path.endsWith('/speech-to-text/stream')) ws.send(JSON.stringify({ type: 'session.started' }));
    ws.on('close', (code, reason) => {
      this.wsCloses.push([code, reason.toString()]);
      this.wsClosed.resolve();
    });
    ws.on('message', async (data, isBinary) => {
      if (isBinary) return ws.send(data, { binary: true });
      const text = data.toString();
      const command = text.startsWith('{') ? JSON.parse(text) : {};
      if (command.type === 'close') {
        ws.send(JSON.stringify({ type: 'error', code: 'bye' }));
        return ws.close(command.code, command.reason ?? '');
      }
      if (command.type === 'drop') return ws.terminate(); // no close frame: the proxy sees 1006
      if (command.type === 'pause') {
        ws.pause(); // stop reading for a while
        return setTimeout(() => ws.resume(), command.seconds * 1000);
      }
      if (command.type === 'burst') {
        for (let i = 0; i < command.count; i += 1) {
          const frame = Buffer.alloc(4 * command.size);
          for (let j = 0; j < command.size; j += 1) frame.writeUInt32BE(i, j * 4);
          await new Promise((r) => ws.send(frame, { binary: true }, r)); // resolves once written out
          this.burstSent += 1;
        }
        return ws.send(JSON.stringify({ type: 'done' }));
      }
      ws.send(text);
    });
  }
}

/** A port nothing listens on. */
export async function closedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  await new Promise((r) => server.close(() => r(undefined)));
  return port;
}

/**
 * Start a fake upstream and a proxy in front of it.
 * @param {Record<string, unknown>} [overrides] settings
 * @param {{ authenticate?: import('../src/hooks.js').Authenticate, quota?: import('../src/hooks.js').Quota }} [hooks]
 */
export async function startProxy(overrides = {}, hooks = {}) {
  const fake = await new FakeUpstream().start();
  /** @type {string[]} */
  const logs = [];
  const settings = makeSettings({
    apiKey: API_KEY,
    upstreamUrl: /** @type {string} */ (fake.url),
    prefix: '/echonova',
    allowedOrigins: new Set([ORIGIN]),
    demoToken: USER_TOKEN,
    streamTokenSecret: Buffer.from('test-secret'),
    requestsPerMinute: 1000,
    ...overrides,
  });
  const proxy = createProxy(settings, { ...hooks, logger: createLogger((line) => logs.push(line)) });
  const server = await proxy.listen(0);
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${port}`;
  return {
    fake,
    logs,
    origin,
    base: `${origin}/echonova`,
    /** @param {string} path */
    wsUrl: (path) => `ws://127.0.0.1:${port}/echonova${path}`,
    async close() {
      await proxy.close();
      await fake.stop(); // drops any stream still open, so the proxy's side ends too
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}

/** Auth header for the demo user. */
export const AUTH = { authorization: `Bearer ${USER_TOKEN}` };

/**
 * Collects a WebSocket's messages so tests can await them one by one.
 * @param {WebSocket} ws
 */
export function inbox(ws) {
  const existing = inboxes.get(ws);
  if (existing) return existing;
  /** @type {Array<{ data: Buffer, isBinary: boolean }>} */
  const queue = [];
  /** @type {Array<(m: { data: Buffer, isBinary: boolean }) => void>} */
  const waiting = [];
  ws.on('message', (data, isBinary) => {
    const message = { data: /** @type {Buffer} */ (data), isBinary };
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const box = {
    /** @param {number} [timeoutMs] @returns {Promise<{ data: Buffer, isBinary: boolean }>} */
    next(timeoutMs = 5000) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no message in time')), timeoutMs);
        waiting.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    },
  };
  inboxes.set(ws, box);
  return box;
}

/** Response headers of each test WebSocket's accepted upgrade. */
export const upgradeHeaders = new WeakMap();

/** @type {WeakMap<WebSocket, { next: (timeoutMs?: number) => Promise<{ data: Buffer, isBinary: boolean }> }>} */
const inboxes = new WeakMap();

/**
 * Open a WebSocket; resolves when open, rejects with { status, headers, body } when refused.
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<WebSocket>}
 */
export function openWs(url, headers = AUTH) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    inbox(ws); // listen from the start: the first message can arrive before the caller resumes
    ws.once('upgrade', (res) => {
      upgradeHeaders.set(ws, res.headers);
    });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        reject(
          Object.assign(new Error(`refused: ${res.statusCode}`), {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        ws.terminate();
      });
    });
    ws.once('error', reject);
  });
}

/**
 * Resolves with the close code and reason the app saw.
 * @param {WebSocket} ws
 * @returns {Promise<[number, string]>}
 */
export function closed(ws) {
  if (ws.readyState === WebSocket.CLOSED) throw new Error('already closed');
  return new Promise((resolve) => ws.once('close', (code, reason) => resolve([code, reason.toString()])));
}

/**
 * Close and wait until the closing handshake is done (the proxy has released the stream).
 * @param {WebSocket} ws
 * @param {number} [code]
 * @param {string} [reason]
 */
export async function closeWs(ws, code, reason) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const end = closed(ws);
  ws.close(code, reason);
  await end;
}
