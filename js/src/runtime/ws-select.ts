/**
 * Choose the WebSocket transport for this runtime (see `ws-transport.ts`).
 */

import { UnsupportedEnvironmentError } from '../errors.js';
import { isBrowserLike, runtimeInfo, type RuntimeInfo } from './detect.js';
import { browserTransport } from './ws-browser.js';
import { nodeTransport } from './ws-node.js';
import type { WsTransport } from './ws-transport.js';

/**
 * Cloudflare Workers: a `fetch()` upgrade, which sends headers and shows a refused
 * handshake's status and body (`ws-workers.ts`). Loaded only on Workers.
 */
export const workersTransport: WsTransport = {
  name: 'workers',
  sendsHeaders: true,
  open: async (request) => (await import('./ws-workers.js')).openFetchUpgrade(request),
};

export interface TransportChoice {
  transport?: WsTransport | null | undefined;
  usesApiKey?: boolean | undefined;
}

export interface Environment {
  browser: boolean;
  runtime: RuntimeInfo['name'];
}

export function detectEnvironment(): Environment {
  return { browser: isBrowserLike(), runtime: runtimeInfo().name };
}

/** The transport for this runtime, or `UnsupportedEnvironmentError`. */
export function selectTransport(choice: TransportChoice = {}, env: Environment = detectEnvironment()): WsTransport {
  if (choice.transport) return choice.transport;
  if (env.browser) {
    if (choice.usesApiKey) {
      throw new UnsupportedEnvironmentError(
        'Streaming with an API key is not possible in a browser: a browser WebSocket cannot send the ' +
          'Authorization header, and the key would be exposed to everyone using the app. Point the client at ' +
          'your backend (proxy mode) and authenticate the stream with cookies or a short-lived token in `query`.',
      );
    }
    return browserTransport;
  }
  if (env.runtime === 'node' || env.runtime === 'bun' || env.runtime === 'deno') return nodeTransport;
  if (env.runtime === 'workerd') return workersTransport;
  throw new UnsupportedEnvironmentError(
    `Streaming is not supported in this runtime (${env.runtime}): it needs Node.js, Bun, Deno, Cloudflare ` +
      'Workers or a browser (proxy mode). Use the REST endpoints here, or pass a custom `transport`.',
  );
}
