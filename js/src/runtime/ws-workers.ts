/**
 * WebSocket transport for Cloudflare Workers (workerd): a `fetch()` upgrade.
 *
 * A Worker opens a client WebSocket with `fetch(url, { headers: { Upgrade: 'websocket' } })`.
 * Unlike a browser, that sends headers (the API key in `Authorization`) and shows why a
 * handshake was refused: a 401, 402, 429... arrives as an ordinary response with its
 * status, headers and body, classified like a REST error. An accepted upgrade is a `101`
 * whose `webSocket` the Worker accepts. Loaded only on Workers (see `ws-select.ts`).
 */

import { NativeSocket, type NativeWebSocket } from './ws-native.js';
import { abortReason, HandshakeRejection, WsOpenFailure, type WsOpenRequest, type WsSocket } from './ws-transport.js';

/** The parts of a workerd `Response` used here. */
export interface UpgradeResponse {
  readonly status: number;
  readonly headers: { forEach(callback: (value: string, key: string) => void): void };
  readonly body: ReadableStream<Uint8Array> | null;
  readonly webSocket?: (NativeWebSocket & { accept(): void }) | null;
}

export type UpgradeFetch = (url: string, init: RequestInit) => Promise<UpgradeResponse>;

const MAX_ERROR_BODY = 64 * 1024;

/** At most `MAX_ERROR_BODY` bytes of a refused handshake's body. */
async function readBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  const out = new Uint8Array(MAX_ERROR_BODY);
  let size = 0;
  const reader = body?.getReader();
  try {
    while (reader && size < MAX_ERROR_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, MAX_ERROR_BODY - size);
      out.set(part, size);
      size += part.length;
    }
  } catch {
    // keep what arrived
  }
  reader?.cancel().catch(() => {});
  return out.slice(0, size);
}

/** Open a stream socket with a `fetch()` upgrade. `fetch` is the global one unless given. */
export async function openFetchUpgrade(
  request: WsOpenRequest,
  fetch: UpgradeFetch = globalThis.fetch as unknown as UpgradeFetch,
): Promise<WsSocket> {
  const { clock, signal } = request;
  if (signal?.aborted) throw abortReason(signal);
  const controller = new AbortController();
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.openTimeout);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const failed = (error: unknown): unknown => {
    if (signal?.aborted) return abortReason(signal);
    if (timedOut) return new WsOpenFailure('the opening handshake timed out', { timedOut: true, cause: error });
    return new WsOpenFailure(error instanceof Error ? error.message : String(error), { cause: error });
  };
  try {
    let response: UpgradeResponse;
    try {
      // fetch() takes http(s) URLs only; the Upgrade header makes it a WebSocket handshake.
      response = await fetch(request.url.replace(/^ws/, 'http'), {
        headers: { ...request.headers, Upgrade: 'websocket' },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      throw failed(error);
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const ws = response.webSocket;
    if (response.status !== 101 || !ws) {
      const body = await readBody(response.body);
      if (signal?.aborted || timedOut) throw failed(null);
      throw new HandshakeRejection(response.status, headers, body);
    }
    ws.accept();
    try {
      ws.binaryType = 'arraybuffer'; // saves a Blob conversion per frame; older compatibility dates lack it
    } catch {
      // Blobs are converted
    }
    const socket = new NativeSocket(ws, clock, request.maxPayload, headers);
    if (signal?.aborted) {
      socket.terminate();
      throw abortReason(signal);
    }
    return socket;
  } finally {
    clock.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
