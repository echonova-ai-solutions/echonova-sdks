/**
 * A socket over the standard WebSocket API, shared by the browser and Cloudflare
 * Workers transports. It imports nothing at run time but `ws-transport.ts`, so the
 * Workers transport, a chunk of its own, pulls in nothing else.
 */

import type { Clock } from '../streaming/options.js';
import type { WsHandlers, WsSocket } from './ws-transport.js';

interface MessageEventLike {
  data: unknown;
}

interface CloseEventLike {
  code: number;
  reason: string;
}

/**
 * The standard WebSocket API, as browsers and Cloudflare Workers have it. Only
 * `addEventListener` is used: a Worker's sockets have no `onmessage` properties,
 * nor `bufferedAmount`.
 */
export interface NativeWebSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  binaryType?: string;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  addEventListener(type: 'close', listener: (event: CloseEventLike) => void): void;
  addEventListener(type: 'open' | 'error', listener: (event: unknown) => void): void;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;
/** Above this many buffered bytes, `send` waits for the browser to drain its buffer. */
const HIGH_WATER = 256 * 1024;
const DRAIN_POLL_MS = 10;

async function toBytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}

/** Bytes in a message (UTF-16 code units for text, which never overstates its UTF-8 size). */
function sizeOf(data: unknown): number {
  if (typeof data === 'string') return data.length;
  const sized = data as { byteLength?: number; size?: number } | null;
  return sized?.byteLength ?? sized?.size ?? 0;
}

/** A socket over the standard WebSocket API (browsers and Cloudflare Workers). */
export class NativeSocket implements WsSocket {
  readonly responseHeaders: Readonly<Record<string, string>> | null;
  readonly #ws: NativeWebSocket;
  readonly #clock: Clock;
  #handlers: WsHandlers | null = null;
  #queued: Array<(handlers: WsHandlers) => void> = [];
  #closed = false;
  // Messages are delivered in order even if one needs an async conversion (a Blob).
  #order: Promise<void> = Promise.resolve();

  /** Called once, when the socket closes (before `start()` too). */
  onClosed: (() => void) | null = null;

  constructor(ws: NativeWebSocket, clock: Clock, maxPayload: number, responseHeaders: Readonly<Record<string, string>> | null = null) {
    this.#ws = ws;
    this.#clock = clock;
    this.responseHeaders = responseHeaders;
    ws.addEventListener('message', (event) => {
      const data = event.data;
      if (this.#closed) return;
      if (sizeOf(data) > maxPayload) {
        // As `ws` does on Node.js: refuse the message and close with 1009 (a browser may only
        // send 1000 itself, but the session sees 1009 either way).
        this.#closedWith(1009, 'message too big');
        this.close(1009, 'message too big');
        return;
      }
      if (typeof data === 'string') {
        this.#enqueue(() => (h) => h.text(data));
        return;
      }
      const converted = toBytes(data);
      this.#enqueue(async () => {
        const bytes = await converted;
        return bytes ? (h) => h.binary(bytes) : null;
      });
    });
    ws.addEventListener('close', (event) => this.#closedWith(event.code, event.reason));
  }

  #enqueue(make: () => ((handlers: WsHandlers) => void) | null | Promise<((handlers: WsHandlers) => void) | null>): void {
    this.#order = this.#order
      .then(async () => {
        const event = await make();
        if (event) this.#deliver(event);
      })
      .catch(() => {}); // a failing handler must not stop later events
  }

  #closedWith(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#enqueue(() => (h) => h.close(code, reason));
    this.onClosed?.();
  }

  #deliver(event: (handlers: WsHandlers) => void): void {
    if (this.#handlers) event(this.#handlers);
    else this.#queued.push(event);
  }

  get closed(): boolean {
    return this.#closed;
  }

  start(handlers: WsHandlers): void {
    if (this.#handlers) throw new Error('socket already started');
    this.#handlers = handlers;
    const queued = this.#queued;
    this.#queued = [];
    for (const event of queued) event(handlers);
  }

  trySend(data: string | Uint8Array): Promise<void> | null {
    if (this.#closed || this.#ws.readyState !== OPEN) return null;
    try {
      this.#ws.send(data);
    } catch {
      return Promise.resolve();
    }
    return this.#drained();
  }

  /** Whether the socket has room for more (a Worker's socket has no `bufferedAmount`: always). */
  #roomy(): boolean {
    return (this.#ws.bufferedAmount ?? 0) <= HIGH_WATER || this.#closed || this.#ws.readyState !== OPEN;
  }

  #drained(): Promise<void> {
    if (this.#roomy()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.#roomy()) resolve();
        else this.#clock.setTimeout(check, DRAIN_POLL_MS);
      };
      this.#clock.setTimeout(check, DRAIN_POLL_MS);
    });
  }

  close(code: number, reason: string): void {
    try {
      this.#ws.close(code, reason);
    } catch {
      this.terminate();
    }
  }

  terminate(): void {
    // The standard API can't drop a socket without the close handshake: start it, and report
    // the connection as gone now rather than waiting for a server that may not answer.
    try {
      this.#ws.close(1000);
    } catch {
      // already closing
    }
    this.#closedWith(1006, '');
  }
}
