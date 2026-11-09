# EchoNova proxy: Express

A reference backend proxy that lets your apps use EchoNova while the API key stays on your server. Start with [the overview](../README.md): it explains what the proxy does, how to point the SDKs at it and what to check before you deploy.

Node 22+, with Express 5, ws, and Node's built-in `fetch` (with an undici `Agent` for the timeouts). Plain JavaScript with JSDoc types, checked by `tsc`.

## Run it

```bash
cd proxy-examples/express
npm ci
export ECHONOVA_API_KEY=ek_...                          # your key, from a secret store
export PROXY_DEMO_TOKEN=change-me                       # demo auth only: replace the hook
export PROXY_ALLOWED_ORIGINS=http://localhost:3000      # your web app, if any
npm start                                               # http://127.0.0.1:8080/echonova
```

Try it:

```bash
curl http://127.0.0.1:8080/healthz
curl -H "Authorization: Bearer change-me" http://127.0.0.1:8080/echonova/v1/text-to-speech/voices
```

All settings are environment variables; see [Configuration](../README.md#configuration-both-proxies). Run it behind a TLS-terminating load balancer or reverse proxy.

## Plug in your authentication and quota

```js
import { InMemoryQuota, createProxy, settingsFromEnv } from './src/index.js';

const proxy = createProxy(settingsFromEnv(), {
  // Return your user's id, or null for 401. req is an Express request on REST calls and a
  // plain Node IncomingMessage on WebSocket upgrades: use req.headers.
  authenticate: async (req) => {
    const session = await mySessions.fromCookieHeader(req.headers.cookie); // or verify a JWT
    return session?.userId ?? null;
  },
  quota: new InMemoryQuota({ requestsPerMinute: 30, maxStreamsPerUser: 1 }),
});
await proxy.listen(8080, '0.0.0.0');
```

- `authenticate` runs for every REST call and every WebSocket upgrade. On upgrades, a valid `?access_token=` stream token is accepted before your hook is called.
- `quota` is any object with `allowRequest(userId)`, `acquireStream(userId)` and `releaseStream(userId)` (see `src/hooks.js`). `InMemoryQuota` keeps its counters in one process: with several instances, implement the same three methods on Redis or your database.
- With your own hook, `PROXY_DEMO_TOKEN` isn't needed. Without either, `createProxy` throws.

To add the proxy to an existing Express server instead of `proxy.listen`, add `proxy.app` after your own routes (it answers `404` for anything it doesn't relay) and hand it the WebSocket upgrades under the prefix:

```js
app.use(proxy.app);
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/echonova/')) proxy.handleUpgrade(req, socket, head);
});
```

Call `await proxy.close()` when the server stops: it closes open streams (`1012` to both sides) and the upstream connection pool.

## Files

| File | What it holds |
|---|---|
| `src/routes.js` | The allow-list. Delete the routes you don't use. |
| `src/hooks.js` | The demo `authenticate` hook (**replace it**) and `InMemoryQuota`. |
| `src/http-proxy.js` | REST relay: checks, key injection, streaming in both directions. |
| `src/ws-proxy.js` | WebSocket relay: handshake mirroring, frames, backpressure, close codes. |
| `src/app.js` | `createProxy`, CORS and the cross-site origin check, `/healthz`, `/stream-token`. |
| `src/tokens.js` | Short-lived stream tokens (same format as the FastAPI proxy). |
| `src/config.js` | Settings and their checks. |
| `src/log.js` | JSON logs. |
| `src/server.js` | `npm start`. |

## Notes

- Node's `fetch` gives up waiting for response headers after 300 s by default. The proxy passes its own undici `Agent` (connect 10 s, read 600 s), because synchronous EchoNova calls on long audio can take several minutes.
- Uploads are sent with `redirect: 'error'`. With any other redirect mode, `fetch` keeps a copy of the request body for a possible redirect, which holds the whole upload in memory. The upload test measures this.
- The server's `requestTimeout` is raised to 15 minutes, so a 150 MiB upload from a slow connection isn't cut off.
- Outbound calls don't use `HTTPS_PROXY`. If your servers reach the internet through an egress proxy, pass a matching dispatcher (undici's `ProxyAgent`) and a WebSocket `agent`.

## Test

```bash
npm run typecheck && npm run format:check && npm test
```

The tests (`node:test`) run the proxy and a fake EchoNova API (HTTP and WebSocket) as real servers on `127.0.0.1`. They cover the allow-list (checked against `spec/openapi.json` and `spec/asyncapi.json`), key injection, header filtering, user auth, quotas, a 150 MiB upload (chunked, with peak memory checked), a 64 MiB download, WebSocket relaying in both directions with backpressure, close codes, refused handshakes, CORS, shutdown, and logs without secrets.
