/**
 * One open stream socket: the handshake with retries, one reader that never
 * waits on the consumer, an ordered send queue, and keepalive.
 */

import { buildStatusError } from '../core/classifier.js';
import { EchoNovaError } from '../errors.js';
import { selectTransport } from '../runtime/ws-select.js';
import { HandshakeRejection, WsOpenFailure, type WsSocket } from '../runtime/ws-transport.js';
import { sleep } from './async-utils.js';
import { AttemptLimiter, HandshakeRetry, Liveness, MAX_INBOUND_BYTES, PING_FRAME, encodeJson } from './link-rules.js';
import { redactURL, streamURL, type ResolvedStreamOptions } from './options.js';
import { CloseInfo } from './stream-errors.js';

/** Internal: a send was attempted on a socket that is closed or closing. Nothing was sent. */
export class LinkClosed extends Error {
  override name = 'LinkClosed';

  constructor() {
    super('the stream socket is closed');
  }
}

/** Callbacks run on the reader and must not block. */
export interface LinkHandlers {
  onText(text: string): void;
  onBinary(data: Uint8Array): void;
  onClosed(info: CloseInfo): void;
}

const NOOP_HANDLERS: LinkHandlers = { onText() {}, onBinary() {}, onClosed() {} };

interface PendingSend {
  data: string | Uint8Array;
  onCommit: (() => void) | undefined;
  resolve(): void;
  reject(error: unknown): void;
}

export class Link {
  readonly openedAt: number;
  readonly handshakeRequestId: string | null;
  readonly liveness: Liveness;
  readonly done: Promise<CloseInfo>;
  closed = false;
  closeInfo: CloseInfo | null = null;

  readonly #socket: WsSocket;
  readonly #options: ResolvedStreamOptions;
  #handlers: LinkHandlers | null = null;
  #localClose = false;
  #sentClose: { code: number; reason: string } | null = null;
  #lostReason: string | null = null;
  #keeper: unknown = null;
  #queue: PendingSend[] = [];
  #writing = false;
  #resolveDone!: (info: CloseInfo) => void;

  constructor(socket: WsSocket, options: ResolvedStreamOptions) {
    this.#socket = socket;
    this.#options = options;
    const now = options.clock.now();
    this.openedAt = now;
    this.handshakeRequestId = socket.responseHeaders?.['x-request-id'] ?? null;
    this.liveness = new Liveness(now, {
      keepalive: options.keepalive,
      pongTimeout: options.pongTimeout,
      silenceTimeout: options.silenceTimeout,
    });
    this.done = new Promise<CloseInfo>((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  /** Start delivering events (buffered since the socket opened) and keepalive. */
  attach(handlers: LinkHandlers): void {
    if (this.#handlers) return;
    this.#handlers = handlers;
    this.#socket.start({
      text: (data) => this.#received(() => handlers.onText(data)),
      binary: (data) => this.#received(() => handlers.onBinary(data)),
      close: (code, reason) => this.#socketClosed(code, reason),
    });
    this.#scheduleKeeper();
  }

  age(now: number): number {
    return now - this.openedAt;
  }

  pong(): void {
    this.liveness.pong(this.#options.clock.now());
    this.#scheduleKeeper(); // the next ping is now due at a different time
  }

  /**
   * Queue a frame. `onCommit` runs when the frame is handed to the socket, which
   * is synchronous when nothing else is queued. Rejects with `LinkClosed` when the
   * frame could not be sent at all; once committed, resolves when it is written or
   * the socket closes.
   */
  send(data: string | Uint8Array, onCommit?: () => void): Promise<void> {
    if (this.closed || this.#localClose) return Promise.reject(new LinkClosed());
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ data, onCommit, resolve, reject });
      void this.#pump();
    });
  }

  sendJson(payload: Readonly<Record<string, unknown>>): Promise<void> {
    return this.send(encodeJson(payload));
  }

  async #pump(): Promise<void> {
    if (this.#writing) return;
    this.#writing = true;
    try {
      while (this.#queue.length > 0) {
        const item = this.#queue.shift() as PendingSend;
        if (this.closed || this.#localClose) {
          item.reject(new LinkClosed());
          continue;
        }
        const written = this.#socket.trySend(item.data);
        if (written === null) {
          item.reject(new LinkClosed());
          continue;
        }
        this.liveness.sent(this.#options.clock.now());
        try {
          item.onCommit?.();
        } catch (error) {
          this.#options.logger.error('stream send callback failed', error);
        }
        await written;
        item.resolve();
      }
    } finally {
      this.#writing = false;
    }
  }

  /** Close cleanly (the SDK's own close: not an error). Resolves once the socket has closed. */
  async close(code = 1000, reason = ''): Promise<void> {
    if (!this.#handlers) this.attach(NOOP_HANDLERS);
    if (!this.closed) {
      this.#localClose = true;
      this.#sentClose = { code, reason };
      this.#socket.close(code, reason);
      const { clock } = this.#options;
      const timer = clock.setTimeout(() => {
        if (!this.closed) this.#socket.terminate();
      }, this.#options.closeTimeout);
      await this.done;
      clock.clearTimeout(timer);
    }
    await this.done;
  }

  /** Drop the connection now, without a close handshake. */
  abort(lostReason: string | null): void {
    if (!this.#handlers) this.attach(NOOP_HANDLERS);
    if (lostReason !== null && this.#lostReason === null) this.#lostReason = lostReason;
    this.#socket.terminate();
  }

  #received(deliver: () => void): void {
    if (this.closed) return;
    this.liveness.received(this.#options.clock.now());
    try {
      deliver();
    } catch (error) {
      // A bug in a handler: don't leave the socket half-alive.
      this.#options.logger.error('stream reader failed', error);
      this.abort('internal error in the stream reader');
    }
  }

  #socketClosed(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.#keeper !== null) this.#options.clock.clearTimeout(this.#keeper);
    this.#keeper = null;
    for (const item of this.#queue.splice(0)) item.reject(new LinkClosed());
    // A drop the SDK caused because the connection stopped answering keeps its reason. A clean
    // close of our own that the server didn't answer in time still counts as that close.
    let info: CloseInfo;
    if (this.#lostReason !== null) info = new CloseInfo(1006, reason, this.#localClose, this.#lostReason);
    else if (this.#localClose && code === 1006 && this.#sentClose !== null) {
      info = new CloseInfo(this.#sentClose.code, this.#sentClose.reason, true, null);
    } else info = new CloseInfo(code, reason, this.#localClose, null);
    this.closeInfo = info;
    try {
      this.#handlers?.onClosed(info);
    } catch (error) {
      this.#options.logger.error('stream close handler failed', error);
    } finally {
      this.#resolveDone(info);
    }
  }

  #scheduleKeeper(): void {
    const { clock } = this.#options;
    if (this.#keeper !== null) clock.clearTimeout(this.#keeper);
    this.#keeper = null;
    if (this.closed || !this.#handlers) return;
    const deadline = this.liveness.nextDeadline();
    if (deadline === null) return;
    this.#keeper = clock.setTimeout(() => this.#keep(), Math.max(0, deadline - clock.now()) + 1);
  }

  #keep(): void {
    this.#keeper = null;
    if (this.closed) return;
    const now = this.#options.clock.now();
    const action = this.liveness.poll(now);
    if (action === 'ping') {
      this.liveness.pingSent(now);
      this.send(PING_FRAME).catch(() => {});
    } else if (action !== null) {
      const detail = this.liveness.describe(action);
      this.#options.logger.warn(`stream connection lost: ${detail}`);
      this.abort(detail);
      return;
    }
    this.#scheduleKeeper();
  }
}

export interface OpenLinkOptions {
  limiter: AttemptLimiter;
  /** Overrides `options.waitForSlot` for this session. */
  waitForSlot?: number | null | undefined;
  /** Reconnecting after an abnormal loss: "Too many concurrent streams" is retried for a while. */
  afterAbnormal?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

/** Open a socket, retrying the handshake as the retry table allows. The link starts detached. */
export async function openLink(
  options: ResolvedStreamOptions,
  path: string,
  query: Readonly<Record<string, string | number>>,
  open: OpenLinkOptions,
): Promise<Link> {
  const { clock, logger } = options;
  const retry = new HandshakeRetry(options.retryPolicy, {
    now: clock.now(),
    waitForSlot: open.waitForSlot !== undefined && open.waitForSlot !== null ? open.waitForSlot : options.waitForSlot,
    afterAbnormal: open.afterAbnormal ?? false,
    slotWaitAfterLoss: options.reconnectSlotWait,
  });
  const transport = selectTransport({ transport: options.transport, usesApiKey: options.usesApiKey });
  let first = true;
  let lastError: unknown = null;
  for (;;) {
    const wait = open.limiter.waitTime(clock.now());
    if (wait > 0) {
      if (!first && retry.mayWait(clock.now(), wait)) await sleep(clock, wait, open.signal);
      else throw lastError ?? open.limiter.error(); // after a slot wait, the refusal says more than the limit
    }
    first = false;
    open.limiter.record(clock.now());

    const headers = transport.sendsHeaders ? await upgradeHeaders(options) : {};
    const extra = options.query ? await options.query() : {};
    const url = streamURL(options.wsBaseURL, path, { ...query, ...stringsOnly(extra) });
    let delay: number;
    try {
      const socket = await transport.open({
        url,
        headers,
        openTimeout: options.openTimeout,
        maxPayload: MAX_INBOUND_BYTES,
        clock,
        signal: open.signal,
      });
      return new Link(socket, options);
    } catch (error) {
      if (error instanceof HandshakeRejection) {
        lastError = buildStatusError(error.status, error.headers, error.body, { method: 'WS', transport: 'websocket' });
        delay = retry.onStatus(error.status, error.headers, error.body, clock.now());
      } else if (error instanceof WsOpenFailure) {
        lastError = null;
        delay = retry.onNetwork(error.cause ?? error, url, error.timedOut);
      } else if (error instanceof EchoNovaError || open.signal?.aborted) {
        throw error;
      } else {
        delay = retry.onNetwork(error, url, false);
      }
    }
    logger.debug(`stream handshake to ${redactURL(url)} failed; retrying in ${Math.round(delay)} ms`);
    await sleep(clock, delay, open.signal);
  }
}

function stringsOnly(values: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

async function upgradeHeaders(options: ResolvedStreamOptions): Promise<Record<string, string>> {
  const headers = stringsOnly(await options.headers());
  if (options.userAgent) {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'user-agent') delete headers[key];
    headers['User-Agent'] = options.userAgent;
  }
  return headers;
}
