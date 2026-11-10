// A local stand-in for the EchoNova API, for the runtime smoke test (smoke-runtime.mjs).
//
// Runs under Node.js on 127.0.0.1 and answers the few calls the smoke test makes, with the
// message shapes of spec/openapi.json and spec/asyncapi.json. It is not a model of the
// real service. Credentials pick the scenario:
//
//   Bearer ek_REDACTED_smoke_ok      accepted
//   Bearer ek_REDACTED_smoke_broke   stream handshakes are refused with 402 (REST is accepted)
//   anything else                    401
//
// The `scenario` query parameter on a stream URL scripts the edge cases:
//
//   hang                   never answer the upgrade (an open timeout)
//   busy:<token>           the first upgrade with this token gets a 503 with Retry-After: 0
//   drop                   Text to Speech: drop the connection after `start` and one audio frame
//   close4008              Text to Speech: close with 4008 max_duration after the first `done`
//   badutf8                Text to Speech: send a text frame that is not valid UTF-8
//   oversize               Text to Speech: send a text message over the SDK's 16 MiB limit
//   balance                Speech to Text: run out of credit after the first transcript (close 4002)
//   unreachable            Speech to Text: the speech service is down: error, session.ended, close 1011 at once
//
//   node scripts/smoke-runtime-server.mjs   # prints {"url": "http://127.0.0.1:<port>"}, runs until killed

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { BROKE_KEY, DOWNLOAD_BYTES, OK_KEY } from './smoke-runtime-checks.mjs';

const TTS_SAMPLE_RATE = 24_000;
const TTS_FRAMES = 3;
const TTS_FRAME_BYTES = 4_800; // 100 ms at 24 kHz

const VOICES = [
  { id: '66e5ef3a9c1d2b4f8a7e6c01', name: 'smoke_ar', displayName: 'Smoke Arabic', language: 'ar', gender: 'Male', previewUrl: null },
  { id: '66e5ef3a9c1d2b4f8a7e6c02', name: 'smoke_en', displayName: 'Smoke English', language: 'en', gender: 'Female', previewUrl: null },
];

const requestId = () => `req-${randomUUID()}`;
const hexId = () => randomUUID().replace(/-/g, '').slice(0, 24);

function envelope(statusCode, data, errorMessage = null) {
  const body = { data, statusCode, success: errorMessage === null, errorMessage };
  if (errorMessage !== null) {
    body.docs = `https://echonova.ai/docs/developers/${statusCode === 401 ? 'authentication' : 'errors'}`;
  }
  return JSON.stringify(body);
}

const ERRORS = {
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Insufficient subscription balance',
  404: 'Cannot GET this path',
  503: 'Service temporarily unavailable',
};

function credentials(req) {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  return match ? match[1] : null;
}

function sendJson(res, status, body, id = requestId()) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': id, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** Split a multipart/form-data body into its parts: { name, filename, type, data }. */
function parseMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts = [];
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) return null;
    const part = body.subarray(start + 2, next - 2); // drop the CRLF after the delimiter and before the next
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString('utf8');
    const disposition = /content-disposition:([^\r\n]*)/i.exec(head)?.[1] ?? '';
    parts.push({
      name: /\bname="([^"]*)"/.exec(disposition)?.[1] ?? null,
      filename: /\bfilename="([^"]*)"/.exec(disposition)?.[1] ?? null,
      type: /content-type:\s*([^\r\n]*)/i.exec(head)?.[1]?.trim() ?? null,
      data: part.subarray(split + 4),
    });
    at = next;
  }
  return parts;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function handleHttp(req, res, log) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  log.push({ kind: 'http', method: req.method, path: url.pathname, userAgent: req.headers['user-agent'] ?? null });
  if (req.method === 'GET' && url.pathname === '/files/smoke.bin') {
    // A signed download link: no API key is expected (or wanted) here.
    const bad = req.headers.authorization !== undefined;
    res.writeHead(bad ? 400 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bad ? 0 : DOWNLOAD_BYTES.length });
    res.end(bad ? undefined : DOWNLOAD_BYTES);
    return;
  }
  const key = credentials(req);
  if (key !== OK_KEY && key !== BROKE_KEY) {
    await readBody(req);
    sendJson(res, 401, envelope(401, null, ERRORS[401]));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/text-to-speech/voices') {
    res.setHeader('X-Smoke-User-Agent', req.headers['user-agent'] ?? '');
    sendJson(res, 200, envelope(200, { items: VOICES, total: VOICES.length }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/speech-to-text/sync') {
    const parts = parseMultipart(await readBody(req), req.headers['content-type']);
    const file = parts?.find((p) => p.name === 'file' && p.filename !== null);
    const language = parts?.find((p) => p.name === 'language')?.data.toString('utf8');
    if (!file || (language !== 'ar' && language !== 'en')) {
      sendJson(res, 400, envelope(400, null, file ? 'language must be one of ar, en' : 'file is required'));
      return;
    }
    // The transcript describes what arrived, so the smoke test can check the upload.
    const received = {
      filename: file.filename,
      type: file.type,
      bytes: file.data.length,
      sha256: createHash('sha256').update(file.data).digest('hex'),
      chunked: req.headers['transfer-encoding'] === 'chunked',
    };
    sendJson(
      res,
      200,
      envelope(200, {
        jobId: hexId(),
        status: 'completed',
        transcription: JSON.stringify(received),
        durationSeconds: 1,
        language,
        numbersAsDigits: true,
        identifySpeakers: false,
        segments: [],
        speakers: [],
        creditsConsumed: 4,
      }),
    );
    return;
  }
  await readBody(req);
  sendJson(res, 404, envelope(404, null, ERRORS[404]));
}

const REASONS = { 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 503: 'Service Unavailable' };

function refuse(socket, status, message, extra = []) {
  const body = envelope(status, null, message);
  socket.end(
    [
      `HTTP/1.1 ${status} ${REASONS[status]}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      `X-Request-Id: ${requestId()}`,
      ...extra,
      'Connection: close',
      '',
      body,
    ].join('\r\n'),
  );
}

function sendEvent(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function ttsStream(ws, scenario) {
  let running = null;
  let completed = 0;
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      sendEvent(ws, { type: 'error', code: 'invalid_message', message: 'Text to Speech takes JSON messages only' });
      ws.close(1008, 'invalid_message');
      return;
    }
    let frame;
    try {
      frame = JSON.parse(data.toString('utf8'));
    } catch {
      sendEvent(ws, { type: 'error', code: 'invalid_message', message: 'not JSON' });
      ws.close(1008, 'invalid_message');
      return;
    }
    if (frame.type === 'ping') sendEvent(ws, { type: 'pong' });
    else if (frame.type === 'cancel') {
      if (running) {
        running.cancelled = true;
        sendEvent(ws, { type: 'cancelled', requestId: running.requestId, creditsConsumed: 1 });
        running = null;
      }
    } else if (frame.type === 'synthesize') {
      const text = typeof frame.text === 'string' ? frame.text.trim() : '';
      if (!text || text.length > 500 || typeof frame.voiceId !== 'string') {
        sendEvent(ws, { type: 'error', code: 'validation_failed', message: 'text and voiceId are required', requestId: frame.requestId });
        return;
      }
      if (running) {
        running.cancelled = true;
        sendEvent(ws, { type: 'cancelled', requestId: running.requestId, creditsConsumed: 1 });
      }
      const job = { requestId: frame.requestId ?? randomUUID(), cancelled: false };
      running = job;
      sendEvent(ws, { type: 'start', requestId: job.requestId, sampleRate: TTS_SAMPLE_RATE, encoding: 'pcm_s16le', channels: 1 });
      if (scenario === 'badutf8') return ws.send(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { binary: false });
      if (scenario === 'oversize') return ws.send(`"${'x'.repeat(16 * 1024 * 1024)}"`);
      for (let i = 0; i < TTS_FRAMES && !job.cancelled; i++) {
        ws.send(new Uint8Array(TTS_FRAME_BYTES).fill(i + 1), { binary: true });
        if (scenario === 'drop') return ws.terminate();
      }
      if (!job.cancelled) {
        const durationSeconds = (TTS_FRAMES * TTS_FRAME_BYTES) / (TTS_SAMPLE_RATE * 2);
        sendEvent(ws, { type: 'done', requestId: job.requestId, durationSeconds, characters: text.length, creditsConsumed: text.length });
        running = null;
        completed += 1;
        if (scenario === 'close4008' && completed === 1) ws.close(4008, 'max_duration');
      }
    } else {
      sendEvent(ws, { type: 'error', code: 'invalid_message', message: `unknown type ${frame.type}` });
      ws.close(1008, 'invalid_message');
    }
  });
}

function sttStream(ws, sampleRate, language, scenario) {
  const session = { sessionId: randomUUID(), jobId: hexId(), segment: 0, segments: 0, totalSeconds: 0, credits: 0, ended: false };
  const cut = () => {
    if (session.segment === 0) return;
    const seconds = session.segment / (sampleRate * 2);
    const credits = Math.round(((seconds * 200) / 60) * 1000) / 1000;
    session.segment = 0;
    session.segments += 1;
    session.totalSeconds += seconds;
    session.credits += credits;
    sendEvent(ws, {
      type: 'transcript',
      segmentId: hexId(),
      text: `smoke segment ${session.segments}`,
      language,
      durationSeconds: seconds,
      creditsConsumed: credits,
      isFinal: true,
    });
    if (scenario === 'balance') {
      session.ended = true;
      sendEvent(ws, { type: 'error', code: 'insufficient_balance', message: 'Insufficient subscription balance' });
      sendEvent(ws, { type: 'session.ended', reason: 'insufficient_balance', totalSeconds: session.totalSeconds, creditsConsumed: session.credits });
      sendEvent(ws, { type: 'session.saved', jobId: session.jobId, status: 'saved' });
      ws.close(4002, 'insufficient_balance');
    }
  };
  if (scenario === 'unreachable') {
    // Sent in one burst with the 101, before the client has sent anything.
    sendEvent(ws, { type: 'error', code: 'upstream_error', message: 'speech service unavailable' });
    sendEvent(ws, { type: 'session.ended', reason: 'upstream_error', totalSeconds: 0, creditsConsumed: 0 });
    ws.close(1011, 'upstream_error');
    return;
  }
  sendEvent(ws, { type: 'session.started', sessionId: session.sessionId, language, sampleRate, maxSessionSeconds: 1500, jobId: session.jobId });
  ws.on('message', (data, isBinary) => {
    if (session.ended) return;
    if (isBinary) {
      if (data.length > 65_536 || data.length % 2 !== 0) {
        sendEvent(ws, { type: 'error', code: 'frame_too_large', message: 'binary frames must be at most 64 KiB of whole samples' });
        ws.close(1009, 'frame_too_large');
        return;
      }
      session.segment += data.length;
      return;
    }
    const frame = JSON.parse(data.toString('utf8'));
    if (frame.type === 'ping') sendEvent(ws, { type: 'pong' });
    else if (frame.type === 'end_segment') cut();
    else if (frame.type === 'terminology') sendEvent(ws, { type: 'terminology.set', active: frame.terminology !== null });
    else if (frame.type === 'stop') {
      cut();
      session.ended = true;
      const round = (n) => Math.round(n * 1000) / 1000;
      sendEvent(ws, { type: 'session.ended', reason: 'stopped', totalSeconds: round(session.totalSeconds), creditsConsumed: round(session.credits) });
      sendEvent(ws, { type: 'session.saved', jobId: session.jobId, status: session.segments > 0 ? 'saved' : 'empty' });
      ws.close(1000, 'stopped');
    } else {
      sendEvent(ws, { type: 'error', code: 'invalid_message', message: `unknown type ${frame.type}` });
      ws.close(1008, 'invalid_message');
    }
  });
}

const busyTokens = new Set();

function handleUpgrade(wss, req, socket, head, log) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const key = credentials(req);
  const scenario = url.searchParams.get('scenario') ?? '';
  log.push({ kind: 'ws', path: url.pathname, userAgent: req.headers['user-agent'] ?? null });
  if (key !== OK_KEY && key !== BROKE_KEY) return refuse(socket, 401, ERRORS[401]);
  if (key === BROKE_KEY) return refuse(socket, 402, ERRORS[402]);
  if (scenario === 'hang') return; // the socket stays open, unanswered, until the client gives up
  if (scenario.startsWith('busy:') && !busyTokens.has(scenario)) {
    busyTokens.add(scenario);
    return refuse(socket, 503, ERRORS[503], ['Retry-After: 0']);
  }
  if (url.pathname === '/v1/speech-to-text/stream') {
    const sampleRate = Number(url.searchParams.get('sample_rate'));
    const language = url.searchParams.get('language');
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
      return refuse(socket, 400, 'sample_rate must be an integer from 8000 to 48000');
    }
    if (language !== 'ar' && language !== 'en') return refuse(socket, 400, 'language must be one of ar, en');
    if ((url.searchParams.get('encoding') ?? 'pcm_s16le') !== 'pcm_s16le') return refuse(socket, 400, 'encoding must be pcm_s16le');
    wss.handleUpgrade(req, socket, head, (ws) => sttStream(ws, sampleRate, language, scenario));
  } else if (url.pathname === '/v1/text-to-speech/stream') {
    wss.handleUpgrade(req, socket, head, (ws) => ttsStream(ws, scenario));
  } else {
    refuse(socket, 400, `no stream at ${url.pathname}`);
  }
}

/** Start the mock on 127.0.0.1. Resolves to `{ url, log, close() }`. */
export async function startMockServer({ port = 0 } = {}) {
  const log = [];
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 20 });
  const server = createServer((req, res) => {
    handleHttp(req, res, log).catch((error) => {
      res.destroy(error);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => handleUpgrade(wss, req, socket, head, log));
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    log,
    close: () =>
      new Promise((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        for (const socket of sockets) socket.destroy();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockServer({ port: Number(process.env.PORT ?? 0) });
  process.stdout.write(`${JSON.stringify({ url: mock.url })}\n`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
