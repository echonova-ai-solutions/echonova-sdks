/**
 * Plays a recorded stream transcript (spec/fixtures/ws/*.jsonl) to the SDK as its WebSocket.
 *
 * It is a `WsTransport` (the streaming option every session accepts), so the whole session stack
 * runs: link, protocol and session. The recording is followed step by step. A server event is
 * delivered once everything the recorded client sent before it has arrived; a client frame must
 * match the recorded one. Recorded requestIds (r1, r2, ...) are mapped to the SDK's own IDs as its
 * synthesize frames arrive, and server frames are rewritten with them. Audio is recorded as byte
 * counts: the replay sends zero-filled frames of those sizes, and takes the SDK's audio by total
 * bytes (the SDK frames audio its own way). Nothing touches the network.
 */

import { isDeepStrictEqual } from 'node:util';
import { UsageError } from '../../src/errors.js';
import { HandshakeRejection, type WsHandlers, type WsOpenRequest, type WsSocket, type WsTransport } from '../../src/runtime/ws-transport.js';
import { MAX_FRAME_BYTES } from '../../src/streaming/index.js';
import { TEST_KEY } from '../helpers.js';

/** One line of a recording. `data` is the frame (json), `{bytes}` (binary), `{code, reason}` (close), ... */
export interface WsLine {
  t: number;
  dir: 'in' | 'out' | 'note';
  kind: string;
  data: any;
}

export interface Step extends WsLine {
  /** The line number in the recording (steps may be reordered). */
  line: number;
  /** Why the SDK doesn't send this recorded client frame: the replay moves past it. */
  skip?: string;
  /** The driver still makes the SDK call for a skipped frame, which must then send nothing. */
  perform?: boolean;
}

export interface ReplayPlan {
  stream: 'tts' | 'stt';
  steps: Step[];
  /** Frames the SDK sends that the recorded client did not. The replay requires each one. */
  extras: Array<Record<string, unknown>>;
  /** Where the replay departs from the recording, and why. */
  adaptations: string[];
}

/** Query parameters the SDK always sends on the Speech to Text stream (`encoding` defaults to pcm_s16le). */
const SDK_QUERY = new Set(['sample_rate', 'language', 'encoding']);
const BASE = 'wss://api.echonova.ai';

export function describeStep(step: Step | undefined): string {
  if (step === undefined) return 'the end of the recording';
  const what = step.kind === 'json' ? `${step.kind} ${String(step.data?.type)}` : step.kind;
  return `${step.dir} ${what} (line ${step.line + 1})`;
}

const isJson = (step: Step | undefined, dir: 'in' | 'out', type: string): boolean =>
  step?.dir === dir && step.kind === 'json' && step.data?.type === type;

/**
 * Turn a recording into replay steps. What the SDK can't send, or deliberately doesn't, is marked
 * `skip`; frames it sends beyond the recording are listed in `extras`. Each rule follows the SDK's
 * documented behaviour, and the notes in spec/fixtures/expected.json.
 */
export function planReplay(name: string, text: string): ReplayPlan {
  const stream = name.startsWith('tts/') ? 'tts' : name.startsWith('stt/') ? 'stt' : null;
  if (stream === null) throw new Error(`${name}: not a tts/ or stt/ recording`);
  const steps: Step[] = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => ({ ...(JSON.parse(line) as WsLine), line: index }));
  const extras: Array<Record<string, unknown>> = [];
  const adaptations: string[] = [];

  if (stream === 'stt') {
    // connect() resolves only once the server has started the session, so the SDK can't send
    // anything before session.started (stt/audio_before_started, stt/ping).
    const open = steps.findIndex((s) => s.dir === 'in' && s.kind === 'open');
    const started = steps.findIndex((s) => isJson(s, 'in', 'session.started'));
    if (open !== -1 && started > open && steps.slice(open + 1, started).some((s) => s.dir === 'out')) {
      const [step] = steps.splice(started, 1);
      steps.splice(open + 1, 0, step!);
      adaptations.push(`${describeStep(step)} delivered right after the handshake: connect() waits for it`);
    }
  }

  // Text to Speech requests in flight, as the SDK will see them.
  let inFlight: string[] = [];
  let latest: string | null = null;
  const cancelled = new Set<string>();
  const supersedes = new Map<string, string[]>();
  for (const step of steps) {
    if (step.dir === 'note') {
      step.skip = 'a note from the recorder';
    } else if (step.dir === 'out') {
      const type = step.kind === 'json' ? step.data?.type : null;
      if (step.kind === 'text') {
        step.skip = 'the SDK sends only JSON objects';
      } else if (step.kind === 'binary' && stream === 'tts') {
        step.skip = 'the SDK never sends binary frames on the Text to Speech stream';
      } else if (step.kind === 'binary' && step.data.bytes > MAX_FRAME_BYTES) {
        step.skip = `the SDK sends audio in frames of at most ${MAX_FRAME_BYTES} bytes`;
      } else if (step.kind === 'abort') {
        step.skip = 'the recorder dropped the connection here: the replay drops it with the recorded 1006 close';
      } else if (stream === 'tts' && type === 'synthesize') {
        const rid = String(step.data.requestId);
        supersedes.set(rid, [...inFlight]);
        inFlight.push(rid);
        latest = rid;
      } else if (stream === 'tts' && type === 'cancel') {
        if (inFlight.length === 0) {
          step.skip = 'the SDK sends no cancel when nothing is in flight';
          step.perform = true;
        }
        for (const rid of inFlight) cancelled.add(rid);
      }
      if (step.skip !== undefined) adaptations.push(`${describeStep(step)}: ${step.skip}`);
    } else if (step.kind === 'close') {
      inFlight = [];
    } else if (stream === 'tts' && step.kind === 'json' && typeof step.data?.requestId === 'string') {
      const rid: string = step.data.requestId;
      const type = step.data.type;
      if (type === 'start') {
        inFlight = inFlight.slice(Math.max(0, inFlight.indexOf(rid))); // a start ends the requests sent before it
      } else if (type === 'done' || type === 'cancelled' || type === 'error') {
        inFlight = inFlight.filter((r) => r !== rid);
        // A newer request was rejected while the one it replaced still runs. The caller asked for
        // that one to stop, so the SDK cancels it (expected.json, tts/invalid_while_running).
        if (type === 'error' && step.data.code === 'validation_failed' && rid === latest) {
          for (const older of supersedes.get(rid) ?? []) {
            if (!inFlight.includes(older) || cancelled.has(older)) continue;
            extras.push({ type: 'cancel' });
            cancelled.add(older);
            adaptations.push(`after ${describeStep(step)} the SDK cancels ${older}, which the recorded client did not`);
          }
        }
      }
    }
  }
  return { stream, steps, extras, adaptations };
}

class ReplaySocket implements WsSocket {
  readonly responseHeaders = null; // the recording keeps no 101 headers
  handlers: WsHandlers | null = null;
  open = true;
  closing = false;

  constructor(readonly transport: ReplayTransport) {}

  start(handlers: WsHandlers): void {
    this.handlers = handlers;
    this.transport.pump();
  }

  trySend(data: string | Uint8Array): Promise<void> | null {
    if (!this.open || this.closing) return null;
    this.transport.receive(data);
    return Promise.resolve();
  }

  close(code: number, reason: string): void {
    if (!this.open || this.closing) return;
    this.closing = true;
    this.transport.receiveClose(code, reason);
  }

  terminate(): void {
    if (this.open) this.transport.terminated();
  }
}

export class ReplayTransport implements WsTransport {
  readonly name = 'replay';
  readonly sendsHeaders = true;
  /** Every way the SDK departed from the recording. A passing replay has none. */
  readonly problems: string[] = [];
  readonly opens: WsOpenRequest[] = [];
  /** Every frame the SDK sent: JSON frames parsed, binary frames as their size. */
  readonly sent: Array<Record<string, unknown> | number> = [];
  /** The `plan.extras` frames the SDK sent. */
  readonly extrasSent: Array<Record<string, unknown>> = [];
  /** Recorded requestId -> the SDK's. */
  readonly ids = new Map<string, string>();
  /** The next step: everything before it has been delivered or received. */
  pos = 0;
  #socket: ReplaySocket | null = null;
  #binaryUsed = 0;
  #scheduled = false;
  readonly #extras: Array<Record<string, unknown>>;
  readonly #waiters: Array<{ index: number; resolve: () => void }> = [];

  constructor(readonly plan: ReplayPlan) {
    this.#extras = [...plan.extras];
  }

  get steps(): Step[] {
    return this.plan.steps;
  }

  /** Resolves once every step before `index` has been played. Fails after `timeoutMs` of real time. */
  reached(index: number, timeoutMs = 3_000): Promise<void> {
    if (this.pos >= index) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const problems = this.problems.length > 0 ? this.problems.join('; ') : 'none';
        reject(new Error(`replay stuck at ${describeStep(this.steps[this.pos])}, waiting for step ${index}; problems: ${problems}`));
      }, timeoutMs);
      this.#waiters.push({
        index,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  /** Resolves once the whole recording has been played. */
  finished(): Promise<void> {
    return this.reached(this.steps.length);
  }

  async open(request: WsOpenRequest): Promise<WsSocket> {
    this.opens.push(request);
    const connect = this.steps[this.pos];
    if (this.opens.length > 1 || connect?.kind !== 'connect') {
      this.#problem(`unexpected connection attempt ${this.opens.length} at ${describeStep(connect)}`);
      throw new UsageError('replay: the recording has no further connection');
    }
    this.#checkConnect(request, connect.data);
    const answer = this.steps[this.pos + 1];
    this.pos += 2;
    this.#notify();
    if (answer?.kind === 'handshake_rejected') {
      const { status, headers, body } = answer.data;
      const text = body === null || body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
      const lower = Object.fromEntries(Object.entries(headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      throw new HandshakeRejection(status, lower, new TextEncoder().encode(text));
    }
    if (answer?.kind !== 'open') {
      this.#problem(`the recording answers the handshake with ${describeStep(answer)}`);
      throw new UsageError('replay: no handshake answer recorded');
    }
    this.#socket = new ReplaySocket(this);
    return this.#socket;
  }

  #checkConnect(request: WsOpenRequest, recorded: { path: string; authorization: string }): void {
    const url = new URL(request.url);
    const expected = new URL(recorded.path, BASE);
    if (url.pathname !== expected.pathname) this.#problem(`connected to ${url.pathname}, recorded ${expected.pathname}`);
    for (const [key, value] of expected.searchParams) {
      if (url.searchParams.get(key) !== value) this.#problem(`query ${key}=${url.searchParams.get(key)}, recorded ${value}`);
    }
    for (const key of url.searchParams.keys()) {
      if (!expected.searchParams.has(key) && !SDK_QUERY.has(key)) this.#problem(`query ${key} was not recorded`);
    }
    const auth = Object.entries(request.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? null;
    const wanted = recorded.authorization === 'set' ? `Bearer ${TEST_KEY}` : null;
    if (auth !== wanted) this.#problem(`Authorization ${auth === null ? 'missing' : 'sent'}, recorded ${recorded.authorization}`);
  }

  // --- Server side: deliver the recording ----------------------------------------------------

  /** Deliver the next server event, one per macrotask like frames off a socket. */
  pump(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      this.#step();
    });
  }

  #step(): void {
    const socket = this.#socket;
    if (socket?.handlers == null) return;
    this.#skipUnsent();
    const step = this.steps[this.pos];
    if (step?.dir !== 'in') return; // the end, or waiting for the client
    this.pos += 1;
    if (!socket.open) {
      this.#problem(`${describeStep(step)} comes after the socket closed`);
    } else {
      this.#deliver(socket, step);
    }
    this.#notify();
    this.pump();
  }

  #deliver(socket: ReplaySocket, step: Step): void {
    const handlers = socket.handlers!;
    switch (step.kind) {
      case 'json':
        handlers.text(JSON.stringify(this.#withSdkIds(step.data)));
        return;
      case 'text':
        handlers.text(String(step.data.text));
        return;
      case 'binary':
        handlers.binary(new Uint8Array(step.data.bytes));
        return;
      case 'close':
        socket.open = false;
        handlers.close(step.data.code, step.data.reason ?? '');
        return;
      default:
        this.#problem(`can't replay ${describeStep(step)}`);
    }
  }

  #withSdkIds(frame: Record<string, unknown>): Record<string, unknown> {
    const rid = frame['requestId'];
    if (typeof rid !== 'string') return frame;
    const sdkId = this.ids.get(rid);
    if (sdkId === undefined) {
      this.#problem(`a server frame for ${rid}, which the SDK never sent`);
      return frame;
    }
    return { ...frame, requestId: sdkId };
  }

  /** Move past client frames the SDK doesn't send. */
  #skipUnsent(): void {
    while (this.steps[this.pos]?.skip !== undefined) this.pos += 1;
    this.#notify();
  }

  // --- Client side: check what the SDK sends -------------------------------------------------

  receive(data: string | Uint8Array): void {
    this.#skipUnsent();
    if (typeof data === 'string') {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data) as Record<string, unknown>;
      } catch {
        this.#problem(`the SDK sent a text frame that is not JSON: ${data.slice(0, 80)}`);
        return;
      }
      this.sent.push(frame);
      this.#receiveJson(frame);
    } else {
      this.sent.push(data.length);
      this.#receiveBinary(data.length);
    }
    this.#notify();
    this.pump();
  }

  #receiveJson(frame: Record<string, unknown>): void {
    const step = this.steps[this.pos];
    if (step?.dir === 'out' && step.kind === 'json' && this.#matches(step.data, frame)) {
      this.pos += 1;
      return;
    }
    const extra = this.#extras.findIndex((e) => isDeepStrictEqual(e, frame));
    if (extra !== -1) {
      this.extrasSent.push(...this.#extras.splice(extra, 1));
      return;
    }
    this.#problem(`the SDK sent ${JSON.stringify(frame)} where the recording has ${describeStep(step)}`);
  }

  /** The SDK's frame equals the recorded one, with the recorded requestId standing for the SDK's. */
  #matches(recorded: Record<string, unknown>, frame: Record<string, unknown>): boolean {
    const rid = recorded['requestId'];
    if (typeof rid !== 'string') return isDeepStrictEqual(recorded, frame);
    const sdkId = frame['requestId'];
    if (typeof sdkId !== 'string') return false;
    const known = this.ids.get(rid);
    if (known !== undefined ? known !== sdkId : [...this.ids.values()].includes(sdkId)) return false;
    if (!isDeepStrictEqual({ ...recorded, requestId: sdkId }, frame)) return false;
    this.ids.set(rid, sdkId);
    return true;
  }

  #receiveBinary(bytes: number): void {
    let left = bytes;
    while (left > 0) {
      this.#skipUnsent();
      const step = this.steps[this.pos];
      if (step?.dir !== 'out' || step.kind !== 'binary') {
        this.#problem(`the SDK sent ${left} bytes of audio where the recording has ${describeStep(step)}`);
        return;
      }
      const used = Math.min(step.data.bytes - this.#binaryUsed, left);
      this.#binaryUsed += used;
      left -= used;
      if (this.#binaryUsed === step.data.bytes) {
        this.pos += 1;
        this.#binaryUsed = 0;
      }
    }
  }

  receiveClose(code: number, reason: string): void {
    this.#skipUnsent();
    const step = this.steps[this.pos];
    if (step?.dir === 'out' && step.kind === 'close') {
      if (step.data.code !== code) this.#problem(`the SDK closed with ${code}, recorded ${step.data.code}`);
      this.pos += 1;
      this.#notify();
      this.pump(); // the recorded server close follows
      return;
    }
    this.#problem(`the SDK closed the socket (${code}) where the recording has ${describeStep(step)}`);
    setImmediate(() => this.#closeNow(code, reason)); // answer anyway, so nothing hangs
  }

  terminated(): void {
    this.#problem(`the SDK dropped the connection at ${describeStep(this.steps[this.pos])}`);
    this.#closeNow(1006, '');
  }

  #closeNow(code: number, reason: string): void {
    const socket = this.#socket;
    if (!socket?.open) return;
    socket.open = false;
    socket.handlers?.close(code, reason);
  }

  #problem(message: string): void {
    this.problems.push(message);
  }

  #notify(): void {
    for (const waiter of [...this.#waiters]) {
      if (this.pos < waiter.index) continue;
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  }
}
