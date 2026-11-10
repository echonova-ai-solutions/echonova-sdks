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
import { redactURL } from '../streaming/options.js';
import { NativeSocket, type NativeWebSocket } from './ws-native.js';
import { abortReason, WsOpenFailure, type WsOpenRequest, type WsSocket, type WsTransport } from './ws-transport.js';

type BrowserWebSocketConstructor = new (url: string) => NativeWebSocket;

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
      let ws: NativeWebSocket;
      try {
        ws = new WebSocketCtor(request.url);
      } catch (error) {
        reject(new WsOpenFailure(error instanceof Error ? error.message : String(error), { cause: error }));
        return;
      }
      ws.binaryType = 'arraybuffer';
      const socket = new NativeSocket(ws, clock, request.maxPayload);
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

      ws.addEventListener('error', () => {}); // a close event always follows
      // Before `open`, a close means the handshake failed. After it, the close reaches the session.
      socket.onClosed = () => fail(failedHandshake(request.url));
      ws.addEventListener('open', () => {
        if (settled) return;
        finish();
        socket.onClosed = null;
        resolve(socket);
      });
    });
  },
};
