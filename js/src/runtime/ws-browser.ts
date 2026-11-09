/**
 * WebSocket transport for browsers, using the native `WebSocket`. Proxy mode only.
 *
 * A browser can't set headers on a WebSocket, so the stream is authenticated by
 * the app's cookies or by `query` (for example a short-lived `access_token`
 * from your backend). A browser also hides why a handshake failed: a refused
 * upgrade (401, 402, 429...) looks exactly like a network failure, so it is
 * reported as `APIConnectionError` and not retried.
 */

import { APIConnectionError, UnsupportedEnvironmentError } from '../errors.js';
import type { Clock } from '../streaming/options.js';
import { redactURL } from '../streaming/options.js';
import { abortReason, WsOpenFailure, type WsHandlers, type WsOpenRequest, type WsSocket, type WsTransport } from './ws-transport.js';

interface MessageEventLike {
  data: unknown;
}

interface CloseEventLike {
  code: number;
  reason: string;
}

interface BrowserWebSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: MessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: CloseEventLike) => void) | null;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

type BrowserWebSocketConstructor = new (url: string) => BrowserWebSocket;

const OPEN = 1;
/** Above this many buffered bytes, `send` waits for the browser to drain its buffer. */
const HIGH_WATER = 256 * 1024;
const DRAIN_POLL_MS = 10;

const decoder = new TextDecoder();

async function toBytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}

class BrowserSocket implements WsSocket {
  readonly responseHeaders = null;
  readonly #ws: BrowserWebSocket;
  readonly #clock: Clock;
  #handlers: WsHandlers | null = null;
  #queued: Array<(handlers: WsHandlers) => void> = [];
  #closed = false;
  // Messages are delivered in order even if one needs an async conversion (a Blob).
  #order: Promise<void> = Promise.resolve();

  /** Called once, when the socket closes (before `start()` too). */
  onClosed: (() => void) | null = null;

  constructor(ws: BrowserWebSocket, clock: Clock) {
    this.#ws = ws;
    this.#clock = clock;
    ws.onmessage = (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        this.#enqueue(() => (h) => h.text(data));
        return;
      }
      const converted = toBytes(data);
      this.#enqueue(async () => {
        const bytes = await converted;
        return bytes ? (h) => h.binary(bytes) : null;
      });
    };
    ws.onclose = (event) => this.#closedWith(event.code, event.reason);
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

  #drained(): Promise<void> {
    if (this.#ws.bufferedAmount <= HIGH_WATER || this.#closed) return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.#ws.bufferedAmount <= HIGH_WATER || this.#closed || this.#ws.readyState !== OPEN) resolve();
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
    // A browser can't drop a socket without the close handshake: start it, and report the
    // connection as gone now rather than waiting for a server that may not answer.
    try {
      this.#ws.close(1000);
    } catch {
      // already closing
    }
    this.#closedWith(1006, '');
  }
}

function failedHandshake(url: string): APIConnectionError {
  return new APIConnectionError(
    `could not open the stream at ${redactURL(url)}. Browsers don't say why a WebSocket handshake failed: ` +
      'your backend may have refused the credentials (check the cookies or the `query` token), the account may ' +
      'be out of credits or at a limit, or the network failed. Check your backend logs for the status.',
    { mayHaveExecuted: false, retryDisabledReason: 'handshake_status_unavailable' },
  );
}

export const browserTransport: WsTransport = {
  name: 'browser',
  sendsHeaders: false,

  open(request: WsOpenRequest): Promise<WsSocket> {
    const WebSocketCtor = (globalThis as { WebSocket?: BrowserWebSocketConstructor }).WebSocket;
    if (typeof WebSocketCtor !== 'function') {
      return Promise.reject(new UnsupportedEnvironmentError('this browser has no WebSocket support'));
    }
    const { clock, signal } = request;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<WsSocket>((resolve, reject) => {
      let ws: BrowserWebSocket;
      try {
        ws = new WebSocketCtor(request.url);
      } catch (error) {
        reject(new WsOpenFailure(error instanceof Error ? error.message : String(error), { cause: error }));
        return;
      }
      ws.binaryType = 'arraybuffer';
      const socket = new BrowserSocket(ws, clock);
      let settled = false;

      const timer = clock.setTimeout(
        () => fail(new WsOpenFailure('the opening handshake timed out', { timedOut: true })),
        request.openTimeout,
      );
      const onAbort = (): void => fail(abortReason(signal as AbortSignal));
      signal?.addEventListener('abort', onAbort, { once: true });

      function finish(): void {
        settled = true;
        clock.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }

      function fail(error: unknown): void {
        if (settled) return;
        finish();
        socket.terminate();
        reject(error);
      }

      ws.onerror = () => {}; // a close event always follows
      // Before `open`, a close means the handshake failed. After it, the close reaches the session.
      socket.onClosed = () => fail(failedHandshake(request.url));
      ws.onopen = () => {
        if (settled) return;
        finish();
        socket.onClosed = null;
        resolve(socket);
      };
    });
  },
};
