# Authentication

An EchoNova API key (`ek_…`) authenticates your requests and spends your workspace's credits. This guide covers where to keep it, how to replace it, and how web and mobile apps use EchoNova without ever holding it.

## How the SDKs use your key

- **Where it comes from.** Every SDK reads `ECHONOVA_API_KEY` from the environment unless you pass the key yourself (`api_key=` in Python, `apiKey` in TypeScript and Dart). Surrounding whitespace is removed.
- **Where it goes.** The SDK sends `Authorization: Bearer <key>` on every REST call and every stream connection, and only to the configured base URL. Signed download links point at a storage host, so `download()` fetches them without the key.
- **Where it never goes.** The key is never logged and never copied into an error. A client prints it as `ek_…c21d`. Python, and TypeScript with logging on, also warn when a key doesn't start with `ek_`.

A key belongs to one workspace, and the API checks on every request that it exists, is enabled, and may call the service you are calling. See [Authentication](https://echonova.ai/docs/developers/authentication) in the API docs for each check and its error.

## Keep keys on your server

> Never send an API key to a user's device, and never commit one to source control.
> — [Security best practices](https://echonova.ai/docs/developers/best-practices-security)

Read the key from an environment variable or a secrets manager when your server starts. The environment variable needs no code: `EchoNova()` reads it. A secrets manager that mounts secrets as files (Docker and Kubernetes secrets, for example) needs one line:

**Python**

```python
from pathlib import Path

from echonova import EchoNova

api_key = Path("/run/secrets/echonova_api_key").read_text()
client = EchoNova(api_key=api_key)  # the trailing newline is removed
```

**TypeScript**

```ts
import { readFile } from 'node:fs/promises';
import EchoNova from '@echonova/ai';

const apiKey = await readFile('/run/secrets/echonova_api_key', 'utf8');
const client = new EchoNova({ apiKey }); // the trailing newline is removed
```

**Dart**

```dart
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

final apiKey = await File('/run/secrets/echonova_api_key').readAsString();
final client = EchoNova(apiKey: apiKey); // the trailing newline is removed
```

If your secrets manager is an API instead, fetch the secret with its client library at start-up and pass it the same way.

The API docs also recommend:

- **One key per system** that calls the API, named after that system, so you can see its usage and revoke it alone.
- **Only the services it needs.** A key restricted to Speech to Text gets `403` (`PermissionDeniedError`) from Text to Speech.
- **A Credit Limit on every unattended key**, a little above its normal monthly use. Subscribe a [webhook](webhooks.md) to `spending.warning` and `spending.exhausted` to hear about it before calls start failing with `SpendingLimitError`.

## Rotate keys

The secret can't be recovered or changed, so rotating a key means replacing it. The [Security best practices](https://echonova.ai/docs/developers/best-practices-security) page describes the steps:

1. **Create** a new key with the same services and Credit Limit. Copy its secret: it is shown once.
2. **Deploy** the new secret to your server's configuration, and restart or reload so it is used. An SDK client reads its key when it is created, so clients created before the change keep the old key until they are replaced.
3. **Verify** that a request with the new key succeeds, and that the old key's **Last Used** date stops changing in the portal.
4. **Delete** the old key. Requests with it get `401` (`AuthenticationError`) from then on, and deleting can't be undone.

Rotate on a schedule you can keep, and at once when a person who knew a secret leaves. If you suspect a leak but aren't sure, disable the key first with the switch on its row (that is reversible), then decide about deleting it.

## Never in browsers or mobile apps

Anything you ship to a user's device can be extracted from it: a web page's source, a mobile app bundle, a desktop binary. Whoever extracts the key can spend your credits from anywhere until you delete it. Browsers also can't set the `Authorization` header on a WebSocket, so a browser can't open the streams with a key at all.

The SDKs guard against the common mistakes:

- **TypeScript:** creating a client with an API key in a browser, a browser worker or a React Native app throws `UnsupportedEnvironmentError`. Streaming from a browser with a key is refused too.
- **Dart:** `EchoNova(apiKey: ...)` throws `UnsupportedEnvironmentException` on the web. On Android, iOS and desktop the SDK can't tell an app from a server, so the rule is yours to keep: Flutter apps use `EchoNova.proxy`, never `EchoNova(apiKey: ...)`.
- Both checks can be turned off with `dangerouslyAllowBrowser: true`, for internal tools whose users may see the key. The name is meant to stand out in code review.

Web and mobile apps use proxy mode instead.

## Proxy mode for web and mobile apps

In proxy mode, your app talks to **your backend**, with **your app's own credentials**. Your backend checks the user, adds the EchoNova key and forwards the request:

```text
app (your user's session)  ──►  your proxy  ──►  api.echonova.ai (your API key)
                                 checks the user
                                 applies a quota
                                 adds the key
```

The SDK in the app behaves exactly as it does against the API: the same methods, errors, retries and streaming. Only the base URL and the credentials change.

### Point the SDK at your proxy

Set the base URL to where your proxy is mounted, and an `auth` hook that returns your app's headers:

**Python**

```python
import os

from echonova import EchoNova


def app_credentials() -> dict[str, str]:
    # Your app's own credentials for your backend: never an EchoNova key.
    return {"Authorization": f"Bearer {os.environ['MYAPP_ACCESS_TOKEN']}"}


client = EchoNova(base_url="https://api.example.com/echonova", auth=app_credentials)
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

// Your app's own sign-in: the signed-in user's access token for your backend.
async function accessToken(): Promise<string> {
  return sessionStorage.getItem('access_token') ?? '';
}

const client = new EchoNova({
  baseURL: 'https://api.example.com/echonova',
  auth: async () => ({ Authorization: `Bearer ${await accessToken()}` }),
});
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

// Your app's own sign-in: the signed-in user's access token for your backend.
Future<String> accessToken() async => 'token from your sign-in flow';

final client = EchoNova.proxy(
  baseUrl: Uri.parse('https://api.example.com/echonova'),
  auth: () async => {'Authorization': 'Bearer ${await accessToken()}'},
);
```

- **API paths are appended to the base URL.** With the URL above, `text_to_speech.jobs.create()` sends `POST https://api.example.com/echonova/v1/text-to-speech`. Don't end the base URL with `/v1` (Python and TypeScript warn about it).
- **`auth` runs before every attempt** and every stream connection (in browsers, only for REST calls: a WebSocket there can't carry its headers), so it can return a freshly refreshed token. In Python, `AsyncEchoNova` accepts an async `auth` function. In TypeScript, the hook receives the request's `method` and `url`.
- **An error your `auth` or stream query function throws reaches you unchanged**, not as an EchoNova error, and the attempt it was preparing isn't sent. It is your code's error, so you can tell it from the API's.
- **With `auth` set, `ECHONOVA_API_KEY` is not read** (Python and TypeScript), so a key in the environment can never reach your proxy by accident. That includes a copy made with `with_options()` / `withOptions()` that adds `auth`: a key the original read from the environment is dropped. A key you passed yourself is kept. `EchoNova.proxy` in Dart never reads it.
- **Errors from your proxy look like EchoNova errors** when the proxy answers in the API's error shape, as the reference proxies do: a `401` from your proxy raises `AuthenticationError`, a `429` with `Retry-After` raises `RateLimitError`, and so on.

### Cookies instead of a token (browsers)

A web app that authenticates with a session cookie doesn't need to add headers. Return no headers from `auth`, and make requests carry cookies when the proxy is on another origin:

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova({
  baseURL: 'https://api.example.com/echonova',
  auth: () => ({}), // the session cookie authenticates; there is no API key here
  fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
});
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';
import 'package:http/browser_client.dart';

final client = EchoNova.proxy(
  baseUrl: Uri.parse('https://api.example.com/echonova'),
  auth: () => {}, // the session cookie authenticates
  httpClient: BrowserClient()..withCredentials = true,
);
```

`auth` is still required: a client with neither an API key nor `auth` refuses to start, because it would have no credentials at all.

### Streams through the proxy

The SDKs derive the stream URLs from the base URL (`wss://api.example.com/echonova/v1/text-to-speech/stream`), so streaming goes through your proxy too.

- **Server-side, mobile and desktop apps** send the `auth` headers on the WebSocket upgrade, as on REST calls. Nothing else is needed.
- **Browsers can't add headers to a WebSocket.** Authenticate streams with a **cookie** (the browser sends it with the upgrade when the proxy is on your site), or with a **short-lived token in the URL**. The reference proxies issue such tokens: `POST <prefix>/stream-token`, with the app's normal credentials, returns `{"token": "…", "expiresIn": 60}`, and the stream is opened with `?access_token=<token>`. The proxy removes the token from the URL before it forwards or logs anything.

The SDKs call the query function before every connection attempt, so each attempt gets a fresh token:

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const proxy = 'https://api.example.com/echonova';

// Your app's own sign-in: the signed-in user's access token for your backend.
async function accessToken(): Promise<string> {
  return sessionStorage.getItem('access_token') ?? '';
}

// A short-lived token for one stream connection, from the proxy's stream-token route.
async function streamToken(): Promise<string> {
  const response = await fetch(`${proxy}/stream-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  if (!response.ok) throw new Error(`stream token request failed: HTTP ${response.status}`);
  const { token } = (await response.json()) as { token: string; expiresIn: number };
  return token;
}

const client = new EchoNova({
  baseURL: proxy,
  auth: async () => ({ Authorization: `Bearer ${await accessToken()}` }),
  stream: { query: async () => ({ access_token: await streamToken() }) },
});
```

**Dart**

```dart
import 'dart:convert';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:http/http.dart' as http;

final proxy = Uri.parse('https://api.example.com/echonova');

// Your app's own sign-in: the signed-in user's access token for your backend.
Future<String> accessToken() async => 'token from your sign-in flow';

// A short-lived token for one stream connection, from the proxy's stream-token route.
Future<String> streamToken() async {
  final response = await http.post(
    proxy.replace(path: '${proxy.path}/stream-token'),
    headers: {'Authorization': 'Bearer ${await accessToken()}'},
  );
  if (response.statusCode != 200) {
    throw StateError('stream token request failed: HTTP ${response.statusCode}');
  }
  final body = jsonDecode(response.body) as Map<String, Object?>;
  return body['token']! as String;
}

final client = EchoNova.proxy(
  baseUrl: proxy,
  auth: () async => {'Authorization': 'Bearer ${await accessToken()}'},
  streamQuery: () async => {'access_token': await streamToken()}, // only browsers need it
);
```

The Python SDK doesn't run in browsers, so its streams always send the `auth` headers.

### The reference proxies

[`proxy-examples/`](../../proxy-examples/README.md) has two reference proxies, in FastAPI (Python) and Express (Node). They behave the same way, don't depend on any SDK, and are tested in CI. Use one as it is, or as a blueprint for your own framework. They:

- **forward only an allow-list of routes.** The Text to Speech, Speech to Text and Sound Cleaning REST routes, each with its own method, and the two streams. Anything else gets `404`. A proxy that forwarded any path would let every signed-in user do anything your key can do, so it is never an open proxy. Delete the routes your app doesn't use.
- **keep widget tickets and agent sessions server-side.** Those routes are left out on purpose. Starting an agent session spends workspace credits and returns a room token for one user, and a widget ticket admits one visitor. Your backend decides which of your users may have one, then calls the API directly with the SDK and hands the result to that user only. See [Agents and widgets](agents-and-widgets.md).
- **authenticate each user and apply a quota.** Both are hooks you replace: the demo `authenticate` hook accepts one static token and must not reach production.
- **keep each user's jobs to that user.** Every user's calls reach the API with the same key, so the proxies record which user created each job and answer `404` when anyone else reads, exports or deletes it. The job list routes are left out for the same reason, and an `Idempotency-Key` is scoped to the user before it is forwarded. The demo job store keeps records in memory: replace it with your database.
- **add the key upstream and never return it.** The key comes only from the proxy's environment. The app's own `Authorization` and `Cookie` headers are dropped before forwarding, and only a short list of safe response headers comes back, including `Retry-After`, `X-RateLimit-*` and `X-Request-Id`.
- **stream everything and relay WebSockets faithfully.** Uploads are never held in memory, and a rejected stream handshake or a stream's close code reaches the app unchanged, so the SDK raises the same errors as it would without a proxy.

Before you deploy one, work through the [security checklist](../../proxy-examples/README.md#security-checklist). Webhooks don't go through the proxy: receive and [verify](webhooks.md) them on your server.

## See also

- [Configuration](configuration.md): base URL, default headers and custom HTTP clients.
- [Troubleshooting](troubleshooting.md): what 401, 402, 403 and 429 mean.
- [Security best practices](https://echonova.ai/docs/developers/best-practices-security) in the API docs.
