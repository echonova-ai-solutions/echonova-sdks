/**
 * WebSocket transport for Node.js, Bun and Deno, using the `ws` package.
 *
 * `ws` is imported only when the first stream opens, so REST-only use never
 * loads it. It exposes a refused handshake's status, headers and body through
 * its `unexpected-response` event, which the SDK classifies like a REST error.
 */

import { UnsupportedEnvironmentError } from '../errors.js';
import {
  abortReason,
  flattenHeaders,
  HandshakeRejection,
  WsOpenFailure,
  type WsHandlers,
  type WsOpenRequest,
  type WsSocket,
  type WsTransport,
} from './ws-transport.js';

// The small part of the `ws` API used here. Its own types aren't imported, so the
// SDK's type declarations don't depend on `@types/ws` or `@types/node`.
interface IncomingLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  on(event: 'end' | 'error', listener: (error?: unknown) => void): void;
  resume?(): void;
}

interface ClientRequestLike {
  destroy(): void;
}

interface WsLike {
  readonly readyState: number;
  binaryType: string;
  on(event: 'open', listener: () => void): void;
  on(event: 'upgrade', listener: (response: IncomingLike) => void): void;
  on(event: 'unexpected-response', listener: (request: ClientRequestLike, response: IncomingLike) => void): void;
  on(event: 'message', listener: (data: ArrayBuffer | Uint8Array | Uint8Array[], isBinary: boolean) => void): void;
  on(event: 'close', listener: (code: number, reason: Uint8Array) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  send(data: string | Uint8Array, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

type WsConstructor = new (
  url: string,
  options: {
    headers: Record<string, string>;
    handshakeTimeout: number;
    maxPayload: number;
    perMessageDeflate: boolean;
    followRedirects: boolean;
  },
) => WsLike;

const OPEN = 1;
const MAX_ERROR_BODY = 64 * 1024;

let loading: Promise<WsConstructor> | null = null;

function loadWs(): Promise<WsConstructor> {
  // `as string` keeps TypeScript from loading `ws`'s Node-only types; bundlers still see the literal.
  loading ??= import('ws' as string).then(
    (module: { default?: unknown; WebSocket?: unknown }) => {
      const ctor = (module.WebSocket ?? module.default) as WsConstructor | undefined;
      if (typeof ctor !== 'function') throw new TypeError('the ws module has no WebSocket export');
      return ctor;
    },
    (error: unknown) => {
      loading = null;
      throw new UnsupportedEnvironmentError(
        'Streaming needs the `ws` package, which could not be loaded. Install it next to echonova (`npm install ws`).',
        { cause: error },
      );
    },
  );
  return loading;
}

const decoder = new TextDecoder();

function toBytes(data: ArrayBuffer | Uint8Array | Uint8Array[]): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const out = new Uint8Array(data.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of data) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  return new Uint8Array(data); // a copy: its own buffer, offset 0, safe for Int16Array views
}

/** The close code `ws` sends for a protocol error it detected in what the server sent. */
export function protocolCloseCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  for (const symbol of Object.getOwnPropertySymbols(error)) {
    if (symbol.description === 'status-code') {
      const value = (error as Record<symbol, unknown>)[symbol];
      if (typeof value === 'number') return value;
    }
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !code.startsWith('WS_ERR_')) return null;
  if (code === 'WS_ERR_INVALID_UTF8') return 1007;
  if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' || code === 'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH') return 1009;
  return 1002;
}

class NodeSocket implements WsSocket {
  readonly responseHeaders: Readonly<Record<string, string>> | null;
  readonly #ws: WsLike;
  #handlers: WsHandlers | null = null;
  #queued: Array<(handlers: WsHandlers) => void> = [];
  #protocolCode: number | null = null;
  #closed = false;

  constructor(ws: WsLike, responseHeaders: Record<string, string> | null) {
    this.#ws = ws;
    this.responseHeaders = responseHeaders;
    ws.on('message', (data, isBinary) => {
      const bytes = toBytes(data);
      if (isBinary) this.#deliver((h) => h.binary(bytes));
      else {
        const text = decoder.decode(bytes);
        this.#deliver((h) => h.text(text));
      }
    });
    ws.on('close', (code, reason) => {
      if (this.#closed) return;
      this.#closed = true;
      // `ws` closes with 1002/1007/1009 itself when the server breaks the protocol, but then
      // usually reports 1006 because it stops reading before the server's close frame.
      const effective = this.#protocolCode ?? code;
      const text = decoder.decode(reason);
      this.#deliver((h) => h.close(effective, text));
    });
  }

  recordError(error: unknown): void {
    this.#protocolCode ??= protocolCloseCode(error);
  }

  #deliver(event: (handlers: WsHandlers) => void): void {
    if (this.#handlers) event(this.#handlers);
    else this.#queued.push(event);
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
    return new Promise((resolve) => {
      try {
        this.#ws.send(data, () => resolve());
      } catch {
        resolve(); // the close event follows
      }
    });
  }

  close(code: number, reason: string): void {
    try {
      this.#ws.close(code, reason);
    } catch {
      this.#ws.terminate();
    }
  }

  terminate(): void {
    this.#ws.terminate();
  }
}

export const nodeTransport: WsTransport = {
  name: 'ws',
  sendsHeaders: true,

  async open(request: WsOpenRequest): Promise<WsSocket> {
    const WebSocket = await loadWs();
    const { clock, signal } = request;
    if (signal?.aborted) throw abortReason(signal);
    return new Promise<WsSocket>((resolve, reject) => {
      let settled = false;
      let socket: NodeSocket | null = null;
      let upgradeHeaders: Record<string, string> | null = null;
      let ws: WsLike;
      try {
        ws = new WebSocket(request.url, {
          headers: { ...request.headers },
          handshakeTimeout: request.openTimeout,
          maxPayload: request.maxPayload,
          perMessageDeflate: false,
          followRedirects: false,
        });
      } catch (error) {
        reject(new WsOpenFailure(error instanceof Error ? error.message : String(error), { cause: error }));
        return;
      }
      ws.binaryType = 'arraybuffer';

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
        try {
          ws.terminate();
        } catch {
          // already gone
        }
        reject(error);
      }

      ws.on('upgrade', (response) => {
        upgradeHeaders = flattenHeaders(response.headers);
      });
      ws.on('unexpected-response', (req, response) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        response.on('data', (chunk: Uint8Array) => {
          if (size < MAX_ERROR_BODY) {
            chunks.push(chunk);
            size += chunk.length;
          }
        });
        response.on('end', () => {
          const body = toBytes(chunks).slice(0, MAX_ERROR_BODY);
          req.destroy();
          fail(new HandshakeRejection(response.statusCode ?? 0, flattenHeaders(response.headers), body));
        });
        response.on('error', (error) => {
          req.destroy();
          fail(new WsOpenFailure('the handshake response could not be read', { cause: error }));
        });
      });
      ws.on('open', () => {
        if (settled) {
          ws.terminate();
          return;
        }
        finish();
        socket = new NodeSocket(ws, upgradeHeaders);
        resolve(socket);
      });
      ws.on('error', (error) => {
        if (socket) {
          socket.recordError(error);
          return;
        }
        const timedOut = /timed out/i.test(error.message);
        fail(new WsOpenFailure(error.message, { timedOut, cause: error }));
      });
    });
  },
};
