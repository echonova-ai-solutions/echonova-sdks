/**
 * A scripted stand-in for the EchoNova stream endpoints, for tests.
 *
 * It plays the message flows of both streams on localhost, plus edge-case
 * scenarios the SDK must tolerate (silent closes, unanswered cancels, errors
 * mid-stream), whether or not a given server ever produces them. It is not a
 * model of the real service. Every knob is a plain property; set it before the
 * client connects.
 *
 * Text to Speech scripting uses markers inside the synthesis text:
 * `[slow]` many frames with pauses, `[nostart]` never answers, `[upstream_pre]`
 * fails before audio the first time that text is seen, `[upstream_pre_always]`
 * always does, `[upstream_mid]` fails after one frame, `[drop]` kills the
 * connection after one frame, `[close:CODE]` closes with CODE right away,
 * `[bad_utf8]` sends a text frame that is not valid UTF-8.
 *
 * Billing, as published: a synthesis is charged when it starts; one that stops
 * after its audio started costs the share of audio sent, at least 1 credit.
 * `cancelled` and `error` carry `creditsConsumed` only when something was charged.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

const TTS_FIELDS = new Set(['type', 'requestId', 'text', 'voiceId', 'speed', 'cfg', 'numSteps', 'tashkeel', 'normalize']);
const MAX_FRAME = 65_536;

export interface Rejection {
  status: number;
  message: string;
  retryAfter?: string;
  jsonBody?: boolean;
}

export interface Attempt {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  rejected: number | null;
}

export class TtsScript {
  sampleRate = 22_050;
  frames = 3;
  frameBytes = 960;
  frameInterval = 0;
  startDelay = 0;
  idleTimeout: number | null = null;
  maxDuration: number | null = null;
  answerPings = true;
}

export interface SttAction {
  /** abort (1006), restart (1001), upstream (error + session.ended + 1011), abort_on_cut. */
  kind: 'abort' | 'restart' | 'upstream' | 'abort_on_cut';
  /** Bytes of audio before it happens; for abort_on_cut, the 1-based segment number whose end_segment triggers it. */
  after: number;
}

export class SttScript {
  maxSessionSeconds = 1500;
  startedDelay = 0;
  enforceMaxDuration: number | null = null;
  idleTimeout: number | null = null;
  upstreamUnreachable = false;
  autoCutSeconds = 15;
  /** 1-based segment numbers that fail. */
  segmentErrors = new Set<number>();
  failAfterSegments: [number, 'insufficient_balance' | 'spending_limit' | 'upstream_error'] | null = null;
  /** Consumed, one per connection. */
  actions: SttAction[] = [];
  answerPings = true;
  drainDelay = 0;
  /** What `session.saved` reports; `auto` = saved when something was transcribed, else empty; `null` = not sent. */
  savedStatus: 'auto' | 'saved' | 'empty' | 'failed' | null = 'auto';
}

export interface TtsConnRecord {
  received: Array<Record<string, unknown> | Uint8Array>;
  charged: string[];
  closeCode: number | null;
}

export interface SttConnRecord {
  query: Record<string, string>;
  audio: Uint8Array[];
  received: Array<Record<string, unknown>>;
  sessionId: string;
  jobId: string;
  closeCode: number | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const toBytes = (data: RawData): Uint8Array =>
  Array.isArray(data) ? concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);

const decoder = new TextDecoder();
const textOf = (data: RawData): string => decoder.decode(toBytes(data));

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function close(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
}

export class MockServer {
  readonly rejections: Rejection[] = [];
  readonly attempts: Attempt[] = [];
  tts = new TtsScript();
  stt = new SttScript();
  readonly ttsConns: TtsConnRecord[] = [];
  readonly sttConns: SttConnRecord[] = [];
  readonly seenTexts = new Set<string>();
  readonly live = new Set<WebSocket>();
  port = 0;
  #http: Server | null = null;
  #wss: WebSocketServer | null = null;
  readonly #sockets = new Set<Socket>();

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get httpURL(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });
    const http = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    http.on('connection', (socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    http.on('upgrade', (req, socket, head) => this.#upgrade(wss, req, socket as Socket, head));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    this.port = (http.address() as AddressInfo).port;
    this.#http = http;
    this.#wss = wss;
    return this;
  }

  async stop(): Promise<void> {
    for (const ws of this.live) ws.terminate();
    for (const socket of this.#sockets) socket.destroy();
    this.#wss?.close();
    await new Promise<void>((resolve) => (this.#http ? this.#http.close(() => resolve()) : resolve()));
  }

  abortAll(): void {
    for (const ws of this.live) ws.terminate();
  }

  #upgrade(wss: WebSocketServer, req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const headers: Record<string, string> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i] as string] = req.rawHeaders[i + 1] as string;
    const rejection = this.rejections.shift();
    this.attempts.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      rejected: rejection ? rejection.status : null,
    });
    if (rejection) {
      const json = rejection.jsonBody ?? true;
      const body = json
        ? JSON.stringify({ data: null, success: false, statusCode: rejection.status, errorMessage: rejection.message })
        : rejection.message;
      const lines = [
        `HTTP/1.1 ${rejection.status} Error`,
        `Content-Type: ${json ? 'application/json' : 'text/html'}`,
        `Content-Length: ${Buffer.byteLength(body)}`,
        `X-Request-Id: req-${randomUUID().slice(0, 8)}`,
        'Connection: close',
      ];
      if (rejection.retryAfter !== undefined) lines.push(`Retry-After: ${rejection.retryAfter}`);
      socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      this.live.add(ws);
      ws.on('close', () => this.live.delete(ws));
      if (url.pathname.endsWith('/text-to-speech/stream')) new TtsConn(this, ws).run();
      else if (url.pathname.endsWith('/speech-to-text/stream')) new SttConn(this, ws, url).run();
      else close(ws, 1008, 'unknown path');
    });
  }
}

/** A restartable one-shot timer. */
class Timer {
  #handle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly delay: number | null,
    readonly callback: () => void,
  ) {
    this.reset();
  }

  reset(): void {
    this.cancel();
    if (this.delay !== null) this.#handle = setTimeout(this.callback, this.delay);
  }

  cancel(): void {
    if (this.#handle !== null) clearTimeout(this.#handle);
    this.#handle = null;
  }
}

class TtsConn {
  readonly record: TtsConnRecord = { received: [], charged: [], closeCode: null };
  running: { rid: string; cancel: () => void; credits: () => number | null } | null = null;

  constructor(
    readonly server: MockServer,
    readonly ws: WebSocket,
  ) {
    server.ttsConns.push(this.record);
  }

  get script(): TtsScript {
    return this.server.tts;
  }

  run(): void {
    const { ws } = this;
    const idle = new Timer(this.script.idleTimeout, () => this.#close(4008, 'idle_timeout'));
    const limit = new Timer(this.script.maxDuration, () => this.#close(4008, 'max_duration'));
    ws.on('message', (data, isBinary) => {
      idle.reset(); // scenario: the idle timer counts frames from the client
      if (isBinary) {
        this.record.received.push(toBytes(data));
        send(ws, { type: 'error', code: 'frame_too_large', message: 'binary frame' });
        this.#close(1008, 'frame_too_large');
        return;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(textOf(data)) as Record<string, unknown>;
        if (typeof frame !== 'object' || frame === null || typeof frame['type'] !== 'string') throw new Error('bad');
      } catch {
        send(ws, { type: 'error', code: 'invalid_message', message: 'bad frame' });
        this.#close(1008, 'invalid_message');
        return;
      }
      this.record.received.push(frame);
      const kind = frame['type'];
      if (kind === 'ping') {
        if (this.script.answerPings) send(ws, { type: 'pong' });
      } else if (kind === 'cancel') {
        this.#cancelRunning();
      } else if (kind === 'synthesize') {
        this.#synthesize(frame);
      } else {
        send(ws, { type: 'error', code: 'invalid_message', message: 'unknown type' });
        this.#close(1008, 'invalid_message');
      }
    });
    ws.on('close', (code) => {
      idle.cancel();
      limit.cancel();
      this.running?.cancel();
      this.record.closeCode = code;
    });
  }

  #close(code: number, reason: string): void {
    this.running?.cancel();
    this.running = null;
    close(this.ws, code, reason);
  }

  #cancelRunning(): void {
    const running = this.running;
    if (running === null) return; // scenario: a cancel with nothing running gets no reply
    this.running = null;
    running.cancel();
    const credits = running.credits();
    send(this.ws, { type: 'cancelled', requestId: running.rid, ...(credits === null ? {} : { creditsConsumed: credits }) });
  }

  #synthesize(frame: Record<string, unknown>): void {
    const rid = typeof frame['requestId'] === 'string' ? frame['requestId'] : randomUUID();
    const text = frame['text'];
    const problems = Object.keys(frame).filter((k) => !TTS_FIELDS.has(k)).sort();
    if (typeof text !== 'string' || text.trim().length < 1 || text.trim().length > 500) {
      problems.push('text must be 1 to 500 characters');
    }
    if (typeof frame['voiceId'] !== 'string') problems.push('voiceId is required');
    if (problems.length > 0) {
      // scenario: a rejected request leaves the running one going
      send(this.ws, { type: 'error', code: 'validation_failed', message: problems.join(', '), requestId: rid });
      return;
    }
    this.#cancelRunning();
    if (frame['voiceId'] === 'missing') {
      send(this.ws, { type: 'error', code: 'voice_not_found', message: 'Voice not found', requestId: rid });
      return;
    }
    const body = text as string;
    const closeMatch = /\[close:(\d+)\]/.exec(body);
    if (closeMatch) {
      this.#close(Number(closeMatch[1]), 'scripted');
      return;
    }
    void this.#stream(rid, body);
  }

  async #stream(rid: string, text: string): Promise<void> {
    const { script, ws } = this;
    const firstTime = !this.server.seenTexts.has(text);
    this.server.seenTexts.add(text);
    let cancelled = false;
    let started = false;
    let framesSent = 0;
    const slow = text.includes('[slow]');
    const frames = slow ? 40 : script.frames;
    const characters = text.trim().length;
    const share = (): number => Math.max(1, Math.round((characters * framesSent) / frames));
    this.running = {
      rid,
      cancel: () => {
        cancelled = true;
      },
      credits: () => (started ? share() : null),
    };
    const finished = (): void => {
      if (this.running?.rid === rid) this.running = null;
    };

    if (text.includes('[nostart]')) return; // never answers
    if ((text.includes('[upstream_pre]') && firstTime) || text.includes('[upstream_pre_always]')) {
      send(ws, { type: 'error', code: 'upstream_error', message: 'could not synthesize this text', requestId: rid });
      finished();
      return;
    }
    if (script.startDelay) await sleep(script.startDelay);
    if (cancelled || ws.readyState !== ws.OPEN) return;
    started = true;
    this.record.charged.push(rid);
    send(ws, { type: 'start', requestId: rid, sampleRate: script.sampleRate, encoding: 'pcm_s16le', channels: 1 });
    if (text.includes('[bad_utf8]')) {
      ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false });
      return;
    }
    for (let i = 0; i < frames; i++) {
      if (cancelled || ws.readyState !== ws.OPEN) return;
      ws.send(new Uint8Array(script.frameBytes).fill(i % 256), { binary: true });
      framesSent += 1;
      if (i === 0 && text.includes('[upstream_mid]')) {
        send(ws, {
          type: 'error',
          code: 'upstream_error',
          message: 'stopped during this synthesis',
          requestId: rid,
          creditsConsumed: share(),
        });
        finished();
        return;
      }
      if (i === 0 && text.includes('[drop]')) {
        ws.terminate();
        return;
      }
      const interval = slow ? 50 : script.frameInterval;
      if (interval) await sleep(interval);
    }
    if (cancelled || ws.readyState !== ws.OPEN) return;
    const seconds = (frames * script.frameBytes) / (script.sampleRate * 2);
    send(ws, { type: 'done', requestId: rid, durationSeconds: seconds, characters, creditsConsumed: characters });
    finished();
  }
}

class SttConn {
  readonly record: SttConnRecord;
  readonly action: SttAction | null;
  #pendingAction: SttAction | null;
  segment: Uint8Array[] = [];
  segmentBytes = 0;
  audioBytes = 0;
  segments = 0;
  cuts = 0;
  totalSeconds = 0;
  credits = 0;
  terminologyActive = false;
  done = false;
  readonly sampleRate: number;

  constructor(
    readonly server: MockServer,
    readonly ws: WebSocket,
    url: URL,
  ) {
    this.record = {
      query: Object.fromEntries(url.searchParams),
      audio: [],
      received: [],
      sessionId: randomUUID(),
      jobId: randomUUID().replace(/-/g, '').slice(0, 24),
      closeCode: null,
    };
    server.sttConns.push(this.record);
    this.action = server.stt.actions.shift() ?? null;
    this.#pendingAction = this.action;
    this.sampleRate = Number(this.record.query['sample_rate'] ?? '16000');
  }

  get script(): SttScript {
    return this.server.stt;
  }

  run(): void {
    const { ws } = this;
    if (this.script.upstreamUnreachable) {
      send(ws, { type: 'error', code: 'upstream_error', message: 'speech service unavailable' });
      this.#end('upstream_error', 1011);
      return;
    }
    const idle = new Timer(this.script.idleTimeout, () => {
      this.#cut();
      this.#end('idle_timeout', 4008);
    });
    const limit = new Timer(this.script.enforceMaxDuration, () => {
      this.segment = []; // scenario: the open segment gets no transcript
      this.segmentBytes = 0;
      this.#end('max_duration', 4008);
    });
    const started = setTimeout(() => {
      send(ws, {
        type: 'session.started',
        sessionId: this.record.sessionId,
        language: this.record.query['language'] ?? 'ar',
        sampleRate: this.sampleRate,
        maxSessionSeconds: this.script.maxSessionSeconds,
        jobId: this.record.jobId,
      });
    }, this.script.startedDelay);
    let chain = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      chain = chain.then(() => this.#message(data, isBinary, idle));
    });
    ws.on('close', (code) => {
      clearTimeout(started);
      idle.cancel();
      limit.cancel();
      this.record.closeCode = code;
    });
  }

  async #message(data: RawData, isBinary: boolean, idle: Timer): Promise<void> {
    idle.reset();
    if (this.done) return;
    if (isBinary) {
      this.#audio(toBytes(data));
      return;
    }
    const frame = JSON.parse(textOf(data)) as Record<string, unknown>;
    this.record.received.push(frame);
    switch (frame['type']) {
      case 'ping':
        if (this.script.answerPings) send(this.ws, { type: 'pong' });
        return;
      case 'end_segment': {
        const action = this.#pendingAction;
        if (action?.kind === 'abort_on_cut' && this.cuts + 1 >= action.after) {
          this.done = true;
          this.ws.terminate(); // cut, but no result ever comes
          return;
        }
        this.cuts += 1;
        this.#cut();
        return;
      }
      case 'terminology':
        this.#terminology(frame['terminology']);
        return;
      case 'stop':
        if (this.script.drainDelay) await sleep(this.script.drainDelay);
        this.#cut();
        this.#end('stopped', 1000);
        return;
      default:
        send(this.ws, { type: 'error', code: 'invalid_message', message: 'unknown type' });
        close(this.ws, 1008, 'invalid_message');
    }
  }

  #audio(data: Uint8Array): void {
    if (data.length > MAX_FRAME) {
      send(this.ws, { type: 'error', code: 'frame_too_large', message: 'frame too large' });
      close(this.ws, 1008, 'frame_too_large');
      return;
    }
    this.record.audio.push(data);
    this.audioBytes += data.length;
    this.segment.push(data);
    this.segmentBytes += data.length;
    const action = this.#pendingAction;
    if (action !== null && action.kind !== 'abort_on_cut' && this.audioBytes >= action.after) {
      this.#pendingAction = null;
      if (action.kind === 'abort') {
        this.done = true;
        this.ws.terminate();
        return;
      }
      if (action.kind === 'restart') {
        this.done = true;
        close(this.ws, 1001, 'server_restarting');
        return;
      }
      send(this.ws, { type: 'error', code: 'upstream_error', message: 'upstream failed' });
      this.#end('upstream_error', 1011);
      return;
    }
    if (this.segmentBytes >= this.script.autoCutSeconds * this.sampleRate * 2) this.#cut();
  }

  #cut(): void {
    const bytes = this.segmentBytes;
    this.segment = [];
    this.segmentBytes = 0;
    if (bytes < 0.05 * this.sampleRate * 2) return; // scenario: too short for a transcript
    this.segments += 1;
    const seconds = bytes / (this.sampleRate * 2);
    if (this.script.segmentErrors.has(this.segments)) {
      send(this.ws, { type: 'error', code: 'upstream_error', message: 'segment failed' });
    } else {
      const credits = Math.round(((seconds * 200) / 60) * 1000) / 1000;
      this.totalSeconds += seconds;
      this.credits += credits;
      send(this.ws, {
        type: 'transcript',
        segmentId: randomUUID().replace(/-/g, '').slice(0, 24),
        text: `segment ${this.segments}`,
        language: this.record.query['language'] ?? 'ar',
        durationSeconds: seconds,
        creditsConsumed: credits,
        isFinal: true,
        ...(this.terminologyActive
          ? { terminology: { raw: 'x', corrected: 'x', edits: [], nearMisses: [], warnings: [], mapperStatus: 'applied', mapperVersion: '1' } }
          : {}),
      });
    }
    const fail = this.script.failAfterSegments;
    if (fail !== null && this.segments >= fail[0]) {
      const code = { insufficient_balance: 4002, spending_limit: 4029, upstream_error: 1011 }[fail[1]];
      send(this.ws, { type: 'error', code: fail[1], message: fail[1].replace(/_/g, ' ') });
      this.#end(fail[1], code);
    }
  }

  #terminology(value: unknown): void {
    if (value !== null && !(typeof value === 'object' && Array.isArray((value as Record<string, unknown>)['keywords']))) {
      send(this.ws, { type: 'error', code: 'validation_failed', message: 'keywords must be a list' });
      return;
    }
    this.terminologyActive = value !== null;
    send(this.ws, { type: 'terminology.set', active: this.terminologyActive });
  }

  #end(reason: string, code: number): void {
    if (this.done) return;
    this.done = true;
    send(this.ws, {
      type: 'session.ended',
      reason,
      totalSeconds: Math.round(this.totalSeconds * 1000) / 1000,
      creditsConsumed: Math.round(this.credits * 1000) / 1000,
    });
    const saved = this.script.savedStatus;
    if (saved !== null) {
      const status = saved === 'auto' ? (this.segments > 0 ? 'saved' : 'empty') : saved;
      send(this.ws, { type: 'session.saved', jobId: this.record.jobId, status });
    }
    close(this.ws, code, reason);
  }
}
