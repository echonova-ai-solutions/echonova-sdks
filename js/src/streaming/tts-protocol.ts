/**
 * Text to Speech stream protocol (sans-IO).
 *
 * A pure state machine: the session feeds it user calls, inbound frames,
 * socket closes and clock ticks (milliseconds), and sends whatever
 * `nextOutbound()` returns.
 *
 * Correlation rules:
 * - The SDK generates every `requestId`.
 * - Binary frames carry no id. They belong to the synthesis whose `start` came
 *   last, and only while it is streaming; anything else is dropped and counted.
 * - `start` for a request ends every request sent before it (superseded).
 * - `done` and `cancelled` are matched by id; duplicates and late frames for
 *   finished requests are ignored.
 * - `cancel` is only sent while a request is in flight on the current socket,
 *   and the SDK never depends on a reply to it: a cancel that is not
 *   acknowledged within `cancelAckTimeout` is treated as done.
 *
 * Billing: a synthesis is charged per character when it starts; one that stops
 * after its audio started costs only the share of audio sent, at least 1 credit.
 * `done`, and `cancelled` or `error` when something was charged, carry the final
 * `creditsConsumed`. `charged` is true when the server reported a cost, false when
 * it reported none, and null when the SDK resolved the synthesis itself.
 *
 * `chargeState` is the SDK's conservative estimate: `yes` once `start` or audio
 * arrived (or the server reported a cost), `unknown` when a request was sent but
 * neither arrived, `no` when it was never sent, or was rejected or failed before
 * any audio. A request in the `unknown` state is never resent automatically, so
 * it can't be paid for twice. The one automatic resend is a synthesis that
 * failed with `upstream_error` before any audio (refunded), once.
 */

import { APIStatusError, APITimeoutError, SessionEndedError, StreamClosedError, UsageError, type EchoNovaError } from '../errors.js';
import { randomId } from './async-utils.js';
import { encodeJson } from './link-rules.js';
import { CloseInfo, FATAL_CLOSE_CODES, attachChargeState, closeError, errorFromFrame } from './stream-errors.js';
import {
  unknownEvent,
  type ChargeState,
  type RawEvent,
  type SynthesisMetrics,
  type SynthesisOptions,
  type SynthesisOutcome,
  type SynthesisResult,
  type SynthesisState,
  type UnknownStreamEvent,
} from './types.js';

const TERMINAL: ReadonlySet<SynthesisState> = new Set(['completed', 'cancelled', 'superseded', 'failed', 'lost']);

/** Option name -> wire field. Only options the caller set are sent: the server rejects unknown fields. */
const OPTION_FIELDS = {
  speed: 'speed',
  cfg: 'cfg',
  numSteps: 'numSteps',
  tashkeel: 'tashkeel',
  normalize: 'normalize',
} as const;
const KNOWN_OPTIONS = new Set<string>([...Object.keys(OPTION_FIELDS), 'voiceId', 'extraBody']);

export const MAX_RESENDS = 1;
const RECENT_LIMIT = 64;
const CANCEL_FRAME = '{"type":"cancel"}';

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** State of one synthesis request. Owned by `TtsProtocol`; read by `Synthesis`. */
export class SynthesisCore {
  state: SynthesisState = 'queued';
  readonly chunks: Uint8Array[] = [];
  audioBytes = 0;
  frames = 0;
  droppedFrames = 0;
  sampleRate: number | null = null;
  startEvent: RawEvent | null = null;
  /** The `done` or `cancelled` that ended it. */
  endEvent: RawEvent | null = null;
  readonly createdAt: number;
  sentAt: number | null = null;
  startedAt: number | null = null;
  firstAudioAt: number | null = null;
  finishedAt: number | null = null;
  /** `start` or audio arrived: the server is producing it. */
  started = false;
  /** Handed to the session; may be on the wire. */
  sending = false;
  everSent = false;
  cancelReason: SynthesisOutcome | null = null;
  cancelRequestedAt: number | null = null;
  cancelSent = false;
  cancelAcked = false;
  timedOut = false;
  readonly supersedes: SynthesisCore[] = [];
  error: EchoNovaError | null = null;
  charged: boolean | null = null;
  creditsConsumed: number | null = null;
  resends = 0;
  connGen = -1;
  sendSeq = -1;

  constructor(
    readonly requestId: string,
    readonly frame: Readonly<Record<string, unknown>>,
    readonly frameText: string,
    readonly origin: 'synthesize' | 'queue',
    now: number,
  ) {
    this.createdAt = now;
  }

  get terminal(): boolean {
    return TERMINAL.has(this.state);
  }

  get chargeState(): ChargeState {
    if (this.charged === true) return 'yes';
    if (this.charged === false) return 'no';
    if (this.started) return 'yes';
    return this.everSent ? 'unknown' : 'no';
  }

  get outcome(): SynthesisOutcome | null {
    const state = this.state;
    return state === 'completed' || state === 'cancelled' || state === 'superseded' ? state : null;
  }

  metrics(): SynthesisMetrics {
    const sinceSent = (at: number | null): number | null =>
      at !== null && this.sentAt !== null ? at - this.sentAt : null;
    return {
      ttfb: sinceSent(this.firstAudioAt),
      timeToStart: sinceSent(this.startedAt),
      total: sinceSent(this.finishedAt),
      audioBytes: this.audioBytes,
      frames: this.frames,
      droppedFrames: this.droppedFrames,
    };
  }

  result(): SynthesisResult {
    const outcome = this.outcome;
    if (outcome === null) throw new Error('synthesis has not finished'); // callers check first
    const end = this.endEvent ?? {};
    const characters = num(end['characters']);
    return Object.freeze({
      requestId: this.requestId,
      outcome,
      charged: this.charged,
      durationSeconds: num(end['durationSeconds']),
      characters: characters === null ? null : Math.trunc(characters),
      creditsConsumed: this.creditsConsumed,
      sampleRate: this.sampleRate,
      raw: this.endEvent,
    });
  }
}

export interface Outbound {
  readonly kind: 'synthesize' | 'cancel';
  readonly core: SynthesisCore;
}

export const outboundText = (item: Outbound): string => (item.kind === 'synthesize' ? item.core.frameText : CANCEL_FRAME);

export interface TtsProtocolOptions {
  voiceId: string;
  defaults?: SynthesisOptions | undefined;
  startTimeout?: number | undefined;
  cancelAckTimeout?: number | undefined;
  errorHold?: number | undefined;
  newRequestId?: (() => string) | undefined;
}

export class TtsProtocol {
  readonly voiceId: string;
  readonly defaults: SynthesisOptions;
  readonly startTimeout: number;
  readonly cancelAckTimeout: number;
  readonly errorHold: number;
  readonly #newRequestId: () => string;

  #pending: Outbound[] = []; // frames to send, in order
  #queue: SynthesisCore[] = []; // enqueue() FIFO: sent one at a time
  readonly #inFlight = new Map<string, SynthesisCore>(); // sent and not finished, in send order
  readonly #recent = new Map<string, SynthesisCore>();
  active: SynthesisCore | null = null;
  #sending: SynthesisCore | null = null; // handed to the session, not yet confirmed sent
  #lastClose: CloseInfo | null = null;
  connected = false;
  connGen = 0;
  #sendSeq = 0;
  fatal: EchoNovaError | null = null;
  closed = false;
  afterAbnormal = false;
  orphanFrames = 0;
  interrupts = 0;
  /** The sample rate of the latest `start` for a request this session tracks; `null` before the first. */
  sampleRate: number | null = null;
  readonly unknownEvents: UnknownStreamEvent[] = [];
  #heldError: { event: RawEvent; at: number } | null = null;

  constructor(options: TtsProtocolOptions) {
    this.voiceId = options.voiceId;
    this.defaults = withoutUndefined(options.defaults ?? {});
    this.startTimeout = options.startTimeout ?? 30_000;
    this.cancelAckTimeout = options.cancelAckTimeout ?? 5_000;
    this.errorHold = options.errorHold ?? 1_000;
    this.#newRequestId = options.newRequestId ?? randomId;
  }

  // --- User calls -------------------------------------------------------------------------

  checkUsable(): void {
    if (this.closed) throw new SessionEndedError('the Text to Speech session is closed');
    if (this.fatal !== null) {
      throw new SessionEndedError(`the Text to Speech session failed: ${this.fatal.message}`, { cause: this.fatal });
    }
  }

  newCore(text: string, options: SynthesisOptions, origin: 'synthesize' | 'queue', now: number): SynthesisCore {
    if (typeof text !== 'string') throw new UsageError('text must be a string');
    const unknown = Object.keys(options).filter((k) => !KNOWN_OPTIONS.has(k) && options[k as keyof SynthesisOptions] !== undefined);
    if (unknown.length > 0) throw new UsageError(`unknown synthesis option(s): ${unknown.sort().join(', ')}`);
    const merged: SynthesisOptions = { ...this.defaults, ...withoutUndefined(options) };
    const requestId = this.#newRequestId();
    const frame: Record<string, unknown> = {
      type: 'synthesize',
      requestId,
      text,
      voiceId: merged.voiceId || this.voiceId,
    };
    for (const [name, wire] of Object.entries(OPTION_FIELDS)) {
      const value = merged[name as keyof typeof OPTION_FIELDS];
      if (value !== undefined && value !== null) frame[wire] = value;
    }
    Object.assign(frame, merged.extraBody ?? {});
    return new SynthesisCore(requestId, frame, encodeJson(frame), origin, now);
  }

  /** Start a synthesis now. Anything not yet sent is dropped; the running one is superseded. */
  synthesize(text: string, options: SynthesisOptions, now: number): SynthesisCore {
    this.checkUsable();
    const core = this.newCore(text, options, 'synthesize', now);
    this.#dropUnsent(now, 'superseded');
    for (const other of this.#liveCores()) {
      if (other.state === 'sent' || other.state === 'streaming' || other.state === 'queued') {
        other.state = 'cancelling';
        other.cancelReason = 'superseded';
        core.supersedes.push(other);
      }
    }
    this.#pending.push({ kind: 'synthesize', core });
    return core;
  }

  /** Add to the client FIFO. It is sent after everything before it has finished. */
  enqueue(text: string, options: SynthesisOptions, now: number): SynthesisCore {
    this.checkUsable();
    const core = this.newCore(text, options, 'queue', now);
    this.#queue.push(core);
    return core;
  }

  cancel(core: SynthesisCore, now: number): void {
    if (core.terminal || core.state === 'cancelling') return;
    if (core.state === 'queued' && !core.sending) {
      this.#removeUnsent(core);
      this.#finish(core, 'cancelled', { charged: false, now });
      return;
    }
    core.state = 'cancelling';
    core.cancelReason = 'cancelled';
    core.cancelRequestedAt = now;
    this.#pending.push({ kind: 'cancel', core });
  }

  /** Cancel whatever is in flight. Does nothing (and sends nothing) when nothing is. */
  cancelActive(now: number): void {
    for (const core of this.#liveCores()) this.cancel(core, now);
  }

  /** Barge-in: cancel what is in flight and drop everything not yet sent. */
  interrupt(now: number): void {
    this.interrupts += 1;
    this.#dropUnsent(now, 'cancelled');
    this.cancelActive(now);
  }

  /** The user closed the session. In-flight requests end when the socket closes. */
  close(now: number): void {
    this.closed = true;
    this.#dropUnsent(now, 'cancelled');
  }

  // --- Outbound ---------------------------------------------------------------------------

  /** The next frame to send, if any. The session must call `sent()` or `requeue()` for it. */
  nextOutbound(now: number): Outbound | null {
    if (this.fatal !== null) return null;
    while (this.#pending.length > 0) {
      const item = this.#pending.shift() as Outbound;
      const core = item.core;
      if (item.kind === 'synthesize') {
        if ((core.state === 'queued' || core.state === 'cancelling') && !core.everSent) {
          if (core.state === 'cancelling') {
            this.#finish(core, 'cancelled', { charged: false, now }); // cancelled before it was ever sent
            continue;
          }
          core.sending = true;
          this.#sending = core;
          return item;
        }
        continue;
      }
      // cancel: only for a request in flight on this socket, and only once
      if (this.connected && core.connGen === this.connGen && !core.cancelSent && (core.state === 'cancelling' || core.timedOut)) {
        core.cancelSent = true;
        return item;
      }
    }
    if (this.#queue.length > 0 && !this.#anyRunning()) {
      const core = this.#queue.shift() as SynthesisCore;
      core.sending = true;
      this.#sending = core;
      return { kind: 'synthesize', core };
    }
    return null;
  }

  hasOutbound(): boolean {
    return this.#pending.length > 0 || (this.#queue.length > 0 && !this.#anyRunning());
  }

  sent(item: Outbound, now: number): void {
    const core = item.core;
    if (item.kind === 'cancel') return;
    core.sending = false;
    if (this.#sending === core) this.#sending = null;
    core.everSent = true;
    core.sentAt = now;
    if (!this.connected) {
      // the socket closed while this frame was being written
      const info = this.#lastClose ?? new CloseInfo(1006);
      const error = closeError(info, { mayHaveExecuted: null }) ?? new StreamClosedError('the stream closed');
      this.#finish(core, 'lost', { error: attachChargeState(error, 'unknown'), charged: null, now });
      return;
    }
    core.connGen = this.connGen;
    this.#sendSeq += 1;
    core.sendSeq = this.#sendSeq;
    if (core.state === 'queued') core.state = 'sent';
    this.#inFlight.set(core.requestId, core);
    for (const other of core.supersedes) {
      if (other.state === 'cancelling' && other.cancelRequestedAt === null) other.cancelRequestedAt = now;
    }
  }

  /** The frame could not be sent (the socket closed first). It goes out on the next socket. */
  requeue(item: Outbound, now: number): void {
    const core = item.core;
    if (item.kind === 'cancel') {
      core.cancelSent = false;
      return;
    }
    core.sending = false;
    if (this.#sending === core) this.#sending = null;
    if (core.state === 'cancelling' || this.closed) this.#finish(core, 'cancelled', { charged: false, now });
    else if (core.state === 'queued') this.#pending.unshift(item);
  }

  /** No connection could be opened to send this request. It was never sent. */
  sendFailed(item: Outbound, error: EchoNovaError, now: number): void {
    const core = item.core;
    core.sending = false;
    if (this.#sending === core) this.#sending = null;
    if (item.kind === 'cancel' || core.terminal) return;
    this.#finish(core, 'failed', { error: attachChargeState(error, 'no'), charged: false, now });
    if (error instanceof APIStatusError) {
      // the server refused the connection: the rest would fail too
      for (const other of this.#unsent()) {
        this.#removeUnsent(other);
        this.#finish(other, 'failed', { error, charged: false, now });
      }
    }
  }

  // --- Connection -------------------------------------------------------------------------

  connectionOpened(_now: number): void {
    this.connected = true;
    this.afterAbnormal = false;
  }

  connectionClosed(info: CloseInfo, now: number): void {
    const held = this.#heldError?.event ?? null;
    this.#heldError = null;
    this.#lastClose = info;
    this.connected = false;
    this.connGen += 1;
    this.active = null;
    this.afterAbnormal = info.abnormal;
    for (const core of [...this.#inFlight.values()]) {
      core.sending = false;
      if (core.state === 'cancelling' || (info.local && info.lostReason === null)) {
        this.#finish(core, core.cancelReason ?? 'cancelled', { charged: null, now });
        continue;
      }
      const error =
        closeError(info, { lastError: held, mayHaveExecuted: core.started ? true : null }) ??
        new StreamClosedError('the stream closed', { closeCode: info.code, reason: info.reason || null });
      attachChargeState(error, core.started ? 'yes' : 'unknown');
      this.#finish(core, FATAL_CLOSE_CODES.has(info.code) ? 'failed' : 'lost', { error, charged: null, now });
    }
    if (FATAL_CLOSE_CODES.has(info.code) && !info.local && info.lostReason === null) {
      this.fatal = closeError(info, { lastError: held });
      for (const core of this.#unsent()) {
        this.#removeUnsent(core);
        const error = closeError(info, { lastError: held });
        if (error !== null) attachChargeState(error, 'no');
        this.#finish(core, 'failed', { error, charged: false, now });
      }
    }
  }

  // --- Inbound ----------------------------------------------------------------------------

  receiveEvent(event: RawEvent, now: number): void {
    switch (event['type']) {
      case 'start':
        this.#onStart(event, now);
        break;
      case 'done':
        this.#onDone(event, now);
        break;
      case 'cancelled':
        this.#onCancelled(event, now);
        break;
      case 'error':
        this.#onError(event, now);
        break;
      case 'pong':
        break;
      default:
        this.unknownEvents.push(unknownEvent(event));
        if (this.unknownEvents.length > 32) this.unknownEvents.shift();
    }
  }

  receiveBinary(data: Uint8Array, now: number): void {
    const core = this.active;
    if (core !== null && core.state === 'streaming') {
      if (core.firstAudioAt === null) core.firstAudioAt = now;
      core.chunks.push(data);
      core.audioBytes += data.length;
      core.frames += 1;
      return;
    }
    if (core !== null) core.droppedFrames += 1;
    this.orphanFrames += 1;
  }

  #lookup(event: RawEvent): SynthesisCore | null {
    const rid = event['requestId'];
    return typeof rid === 'string' ? (this.#inFlight.get(rid) ?? null) : null;
  }

  #onStart(event: RawEvent, now: number): void {
    const core = this.#lookup(event);
    if (core === null) {
      this.active = null; // audio until the next start belongs to a request we no longer track
      return;
    }
    for (const other of [...this.#inFlight.values()]) {
      if (other === core) break;
      // ended by a newer start without its own cancelled: resolved here, so the cost is unknown
      const outcome = other.state === 'cancelling' && other.cancelReason ? other.cancelReason : 'superseded';
      this.#finish(other, outcome, { charged: null, now });
    }
    core.started = true;
    core.startedAt = now;
    core.startEvent = event;
    const rate = event['sampleRate'];
    if (typeof rate === 'number' && Number.isInteger(rate) && rate > 0) core.sampleRate = this.sampleRate = rate;
    if (core.state === 'sent') core.state = 'streaming';
    this.active = core;
  }

  #onDone(event: RawEvent, now: number): void {
    const core = this.#lookup(event);
    if (core === null) return;
    core.endEvent = event;
    core.creditsConsumed = num(event['creditsConsumed']);
    const outcome = core.state === 'cancelling' ? (core.cancelReason ?? 'cancelled') : 'completed';
    this.#finish(core, outcome, { charged: true, now });
  }

  #onCancelled(event: RawEvent, now: number): void {
    const core = this.#lookup(event);
    if (core === null) return;
    core.cancelAcked = true;
    core.endEvent = event;
    // creditsConsumed is the final cost; absent when it was cancelled before it was charged
    const credits = num(event['creditsConsumed']);
    core.creditsConsumed = credits;
    this.#finish(core, core.cancelReason ?? 'cancelled', { charged: credits !== null, now });
  }

  #onError(event: RawEvent, now: number): void {
    const code = event['code'];
    const rid = event['requestId'];
    if (code === 'invalid_message' || code === 'frame_too_large') {
      this.#heldError = { event, at: now }; // a policy close follows; it decides what fails
      return;
    }
    let core: SynthesisCore;
    if (typeof rid === 'string') {
      const found = this.#inFlight.get(rid);
      if (found === undefined) {
        if (!this.#recent.has(rid)) this.#heldError = { event, at: now };
        return;
      }
      core = found;
    } else {
      const candidates = [...this.#inFlight.values()];
      if (candidates.length !== 1) {
        this.#heldError = { event, at: now };
        return;
      }
      core = candidates[0] as SynthesisCore;
    }
    const error = errorFromFrame(event);
    if (code === 'upstream_error') {
      if (core.started) {
        // audio already flowed: it costs the share sent (at least 1 credit); no done follows
        core.creditsConsumed = num(event['creditsConsumed']);
        this.#finish(core, 'failed', { error: attachChargeState(error, 'yes'), charged: true, now });
      } else if (core.state === 'cancelling') {
        this.#finish(core, core.cancelReason ?? 'cancelled', { charged: false, now });
      } else if (core.resends < MAX_RESENDS) {
        // failed before any audio, and refunded: the one case the SDK resends
        core.resends += 1;
        this.#inFlight.delete(core.requestId);
        core.state = 'queued';
        core.sending = false;
        core.everSent = false;
        this.#pending.unshift({ kind: 'synthesize', core });
      } else {
        this.#finish(core, 'failed', { error: attachChargeState(error, 'no'), charged: false, now });
      }
      return;
    }
    this.#finish(core, 'failed', { error: attachChargeState(error, 'no'), charged: false, now });
    if (code === 'validation_failed') {
      // A rejected request leaves the running one going. The caller asked for it to stop,
      // so cancel it explicitly, unless a newer request is on its way (that one replaces it).
      const newerPending = this.#pending.some((item) => item.kind === 'synthesize');
      if (core.sendSeq === this.#sendSeq && !newerPending) {
        for (const other of core.supersedes) {
          if (other.state === 'cancelling' && !other.cancelSent && other.connGen === this.connGen) {
            other.cancelRequestedAt = now;
            this.#pending.push({ kind: 'cancel', core: other });
          }
        }
      }
    }
  }

  // --- Clock ------------------------------------------------------------------------------

  tick(now: number): void {
    for (const core of [...this.#inFlight.values()]) {
      if (core.state === 'sent' && core.sentAt !== null && now - core.sentAt >= this.startTimeout) {
        const error = new APITimeoutError(
          `no audio started within ${this.startTimeout / 1000} s; the request may have been charged`,
          { kind: 'read', mayHaveExecuted: null },
        );
        core.timedOut = true;
        this.#finish(core, 'failed', { error: attachChargeState(error, 'unknown'), charged: null, now });
        if (this.connected) this.#pending.push({ kind: 'cancel', core });
      } else if (
        core.state === 'cancelling' &&
        core.cancelRequestedAt !== null &&
        now - core.cancelRequestedAt >= this.cancelAckTimeout
      ) {
        this.#finish(core, core.cancelReason ?? 'cancelled', { charged: null, now });
      }
    }
    if (this.#heldError !== null && now - this.#heldError.at >= this.errorHold) this.#heldError = null;
  }

  nextDeadline(): number | null {
    const deadlines: number[] = [];
    for (const core of this.#inFlight.values()) {
      if (core.state === 'sent' && core.sentAt !== null) deadlines.push(core.sentAt + this.startTimeout);
      else if (core.state === 'cancelling' && core.cancelRequestedAt !== null) {
        deadlines.push(core.cancelRequestedAt + this.cancelAckTimeout);
      }
    }
    if (this.#heldError !== null) deadlines.push(this.#heldError.at + this.errorHold);
    return deadlines.length > 0 ? Math.min(...deadlines) : null;
  }

  // --- Introspection ----------------------------------------------------------------------

  /** Nothing in flight and nothing waiting to be sent. */
  get idle(): boolean {
    return (
      this.#inFlight.size === 0 &&
      this.#sending === null &&
      this.#queue.length === 0 &&
      !this.#pending.some((item) => item.kind === 'synthesize')
    );
  }

  inFlight(): SynthesisCore[] {
    return [...this.#inFlight.values()];
  }

  // --- Internals --------------------------------------------------------------------------

  #anyRunning(): boolean {
    for (const core of this.#inFlight.values()) if (core.state === 'sent' || core.state === 'streaming') return true;
    return false;
  }

  /** In flight, plus the one being written right now. */
  #liveCores(): SynthesisCore[] {
    const cores = [...this.#inFlight.values()];
    if (this.#sending !== null && !this.#sending.terminal) cores.push(this.#sending);
    return cores;
  }

  #unsent(): SynthesisCore[] {
    const pending = this.#pending.filter((i) => i.kind === 'synthesize' && i.core.state === 'queued').map((i) => i.core);
    return [...pending, ...this.#queue.filter((c) => c.state === 'queued')];
  }

  #removeUnsent(core: SynthesisCore): void {
    this.#queue = this.#queue.filter((c) => c !== core);
    this.#pending = this.#pending.filter((i) => !(i.kind === 'synthesize' && i.core === core));
  }

  #dropUnsent(now: number, outcome: SynthesisOutcome): void {
    for (const core of this.#unsent()) {
      if (core.sending) continue;
      this.#removeUnsent(core);
      this.#finish(core, outcome, { charged: false, now });
    }
  }

  #finish(
    core: SynthesisCore,
    state: SynthesisState,
    options: { charged: boolean | null; now: number; error?: EchoNovaError | null },
  ): void {
    if (core.terminal) return;
    core.state = state;
    core.charged = options.charged;
    core.error = options.error ?? null;
    core.finishedAt = options.now;
    core.sending = false;
    this.#inFlight.delete(core.requestId);
    if (this.active === core) this.active = null;
    this.#recent.set(core.requestId, core);
    while (this.#recent.size > RECENT_LIMIT) this.#recent.delete(this.#recent.keys().next().value as string);
  }
}

function withoutUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) if (field !== undefined && field !== null) out[key] = field;
  return out as T;
}

// --- Sentence splitting for speakStream ---------------------------------------------------

const SENTENCE_MARKS = new Set(['.', '!', '?', '؟', '،', '؛', '\n']);
export const MAX_SENTENCE_CHARS = 500;
const SPACE = /\s/u;
const SPEAKABLE = /[\p{L}\p{N}]/u;

/**
 * Split streamed text into sentences of at most 500 characters (UTF-16 units).
 *
 * A sentence ends at `. ! ? ؟ ، ؛` followed by whitespace, or at a newline.
 * Waiting for the whitespace keeps numbers like `3.5` whole. Pieces with no
 * letters or digits are skipped, because they produce no speech.
 */
export class SentenceSplitter {
  #buffer = '';

  constructor(readonly maxChars = MAX_SENTENCE_CHARS) {}

  push(delta: string): string[] {
    this.#buffer += delta;
    const out: string[] = [];
    let start = 0;
    const text = this.#buffer;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      if (!SENTENCE_MARKS.has(ch)) continue;
      if (ch === '\n' || (i + 1 < text.length && SPACE.test(text[i + 1] as string))) {
        out.push(...this.#emit(text.slice(start, i + 1)));
        start = i + 1;
      }
    }
    this.#buffer = text.slice(start);
    while (this.#buffer.length > this.maxChars) {
      const [piece, rest] = this.#cut(this.#buffer);
      this.#buffer = rest;
      out.push(...this.#emit(piece));
    }
    return out;
  }

  flush(): string[] {
    const rest = this.#buffer;
    this.#buffer = '';
    return this.#emit(rest);
  }

  #cut(text: string): [string, string] {
    const window = text.slice(0, this.maxChars + 1);
    let at = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
    if (at <= 0) {
      at = this.maxChars;
      const unit = text.charCodeAt(at - 1);
      if (unit >= 0xd800 && unit <= 0xdbff) at -= 1; // don't split a surrogate pair
    }
    return [text.slice(0, at), text.slice(at)];
  }

  #emit(piece: string): string[] {
    const out: string[] = [];
    let rest = piece.trim();
    while (rest.length > this.maxChars) {
      const [head, tail] = this.#cut(rest);
      out.push(head.trim());
      rest = tail.trim();
    }
    out.push(rest);
    return out.filter((p) => SPEAKABLE.test(p));
  }
}
