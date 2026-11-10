/**
 * The interface behind the streaming sessions' WebSocket transports.
 *
 * - Node, Bun and Deno: the `ws` package, loaded only when a stream is opened.
 *   It exposes a refused handshake's status, headers and body, so the SDK can
 *   raise the same errors as REST (401, 402, 403, 429, 503...).
 * - Cloudflare Workers: a `fetch()` upgrade, loaded only there. It sends headers
 *   and exposes a refused handshake's status, headers and body too.
 * - Browsers: the native `WebSocket`, in proxy mode only (no API key). It can't
 *   send headers, so the app authenticates with cookies or `query`, and a refused
 *   handshake can't be told apart from a network failure.
 * - Anywhere else: `UnsupportedEnvironmentError`.
 */

import type { Clock } from '../streaming/options.js';

export interface WsOpenRequest {
  readonly url: string;
  /** Sent on the upgrade request, when the transport can send headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** Milliseconds. */
  readonly openTimeout: number;
  /** Largest inbound message accepted, in bytes. */
  readonly maxPayload: number;
  readonly clock: Clock;
  readonly signal?: AbortSignal | undefined;
}

/** Events from an open socket. The transport buffers them until `start()` is called. */
export interface WsHandlers {
  text(data: string): void;
  binary(data: Uint8Array): void;
  /** Called once. `code` 1006 means the connection dropped without a close frame. */
  close(code: number, reason: string): void;
}

export interface WsSocket {
  /** Headers of the `101` response, when the transport can see them. */
  readonly responseHeaders: Readonly<Record<string, string>> | null;
  start(handlers: WsHandlers): void;
  /**
   * Hand a frame to the socket. Returns `null` if the socket is no longer open
   * (nothing was sent), otherwise a promise that settles once the frame has been
   * written, or the socket closed. It never rejects.
   */
  trySend(data: string | Uint8Array): Promise<void> | null;
  /** Start a clean close. */
  close(code: number, reason: string): void;
  /** Drop the connection now, without a close handshake. `close` follows with 1006. */
  terminate(): void;
}

export interface WsTransport {
  readonly name: string;
  /** Whether `headers` reach the server. Browsers can't set headers on a WebSocket. */
  readonly sendsHeaders: boolean;
  /**
   * Open a socket. Rejects with `HandshakeRejection` when the server answered the
   * upgrade with an HTTP error, `WsOpenFailure` for network failures and timeouts,
   * or an SDK error the caller should raise as is.
   */
  open(request: WsOpenRequest): Promise<WsSocket>;
}

/** The server refused the upgrade with an HTTP status. Classified like a REST error. */
export class HandshakeRejection extends Error {
  override name = 'HandshakeRejection';

  constructor(
    readonly status: number,
    readonly headers: Readonly<Record<string, string>>,
    readonly body: Uint8Array,
  ) {
    super(`the stream handshake was refused with ${status}`);
  }
}

/** No response to the upgrade: DNS, TCP or TLS failure, a reset, or the open timeout. */
export class WsOpenFailure extends Error {
  override name = 'WsOpenFailure';
  readonly timedOut: boolean;

  constructor(message: string, options: { timedOut?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.timedOut = options.timedOut ?? false;
  }
}

/** Lower-case header names; join repeated values with ", ". */
export function flattenHeaders(headers: Readonly<Record<string, string | readonly string[] | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = typeof value === 'string' ? value : value.join(', ');
  }
  return out;
}

/** The reason an `AbortSignal` was aborted, as something to throw. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}
