# Configuration

The defaults suit most programs: create one client, reuse it, close it at the end. This guide covers what you can change, and where.

## Where options go

- **On the client**, for every call it makes: `EchoNova(timeout=..., max_retries=...)`.
- **On one call**, overriding the client: `timeout`, `max_retries`, `deadline` and extra headers.
- **On a scoped copy**, for a group of calls: `with_options()` / `withOptions()` returns a client that shares the original's connections and rate-limit state.

| Option | Python | TypeScript | Dart |
| --- | --- | --- | --- |
| API key | `api_key` | `apiKey` | `apiKey` (`EchoNova()` only) |
| Base URL | `base_url` | `baseURL` | `baseUrl` |
| Proxy credentials | `auth` | `auth` | `auth` (`EchoNova.proxy` only) |
| Time limit per attempt | `timeout` (seconds, or `Timeout`) | `timeout` (milliseconds) | `timeout` (`Duration`) |
| Retries | `max_retries` (default 2) | `maxRetries` (default 2) | `maxRetries` (default 2) |
| Total time per call | `deadline` (seconds) | `deadline` (milliseconds) | `deadline` (`Duration`) |
| Wait for the rate-limit window | `rate_limit_preflight` (default on) | `rateLimitPreflight` (default on) | `rateLimitPreflight` (default on) |
| Headers on every request | `default_headers` | `defaultHeaders` | `defaultHeaders` |
| HTTP client | `http_client`, `download_http_client` | `fetch` | `httpClient`, `downloadHttpClient` |
| Hooks | `on_request`, `on_response` | `onRequest`, `onResponse` | wrap `httpClient` |
| Logging | the `echonova` logger | `logLevel`, `logger` | none for REST |
| Browser guard override | none | `dangerouslyAllowBrowser` | `dangerouslyAllowBrowser` |
| Stream settings | `stream_keepalive` (seconds), arguments of `connect()` | `stream` (`query`, `keepalive`, `waitForSlot`, `openTimeout`) | `streamKeepalive` (`Duration`), `streamQuery`, arguments of `connect()` |

Per call, Python methods take `timeout`, `max_retries`, `deadline` and `extra_headers` as keyword arguments; TypeScript methods take a last argument with `timeout`, `maxRetries`, `deadline`, `headers` and `signal`; Dart methods take `options: RequestOptions(...)`.

Environment variables:

| Variable | Used for | SDKs |
| --- | --- | --- |
| `ECHONOVA_API_KEY` | The API key, when you don't pass one. Not read when `auth` is set. | all |
| `ECHONOVA_BASE_URL` | The base URL, when you don't pass one. | all |
| `ECHONOVA_LOG` | Turn on logging: `debug`, `info`, `warning` or `error`. | Python, TypeScript |

## Timeouts

Each operation has its own default time limit, generous where the server may be working for a while: listing jobs gets seconds, while a synchronous transcription of a long file gets minutes. The defaults are listed in each SDK's README ([Python](../../python/README.md#configuration), [TypeScript](../../js/README.md#configuration), [Dart](../../dart/README.md#configuration)). They are long on purpose: the SDK should not be the component that gives up on a paid call that is still running.

What a timeout means depends on the SDK's HTTP layer:

- **Python** has a limit per phase: `Timeout(connect=, read=, write=, pool=)`. `read` and `write` limit each wait for bytes, not the whole call. A plain number sets all four.
- **TypeScript** and **Dart** have one limit per attempt, covering connecting, sending the body and waiting for the answer. For uploads, the default grows with the file's size.

**Python**

```python
from echonova import EchoNova, Timeout

client = EchoNova(timeout=Timeout(connect=5, read=60))  # unset phases keep each operation's default

voices = client.text_to_speech.voices.list(timeout=10, max_retries=0)  # one call
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova({ timeout: 60_000 }); // milliseconds, per attempt

const controller = new AbortController();
const voices = await client.textToSpeech.voices.list({ timeout: 10_000, maxRetries: 0, signal: controller.signal });
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova(timeout: const Duration(seconds: 60)); // per attempt

final voices = await client.textToSpeech.voices.list(
  options: const RequestOptions(timeout: Duration(seconds: 10), maxRetries: 0),
);
client.close();
```

A timeout raises `APITimeoutError` (`APITimeoutException` in Dart), whose `kind` says which limit expired. **Be careful with short timeouts on calls that do paid work** (`generate`, `transcribe`, `clean`, `jobs.create`): once the request has been sent, a timeout means it may still run and be charged. The SDK then raises with `may_have_executed` set and does not send it again (see [Errors](errors.md#recovering-from-a-post-that-may-have-run)). For long audio, prefer an async job and `wait()`, which polls with short calls (see [Jobs](jobs.md)).

## Retries

The SDK retries failures that are safe to retry: a connection that failed before anything was sent, a rate limit with `Retry-After`, a service the API reports as temporarily unavailable, and for `GET` and `DELETE`, most server errors and lost responses. It never resends a `POST` that may already have run. [Errors](errors.md#what-the-sdk-retries) has the full list and the reasons.

- `max_retries` / `maxRetries` (default 2) caps the retries per call. Retries after a `429` count toward it. `0` turns retries off.
- The delay before retry *n* is `min(8, 0.5 × 2^(n−1))` seconds, multiplied by a random factor between 0.5 and 1.
- After a `429` with `Retry-After`, the SDK waits that long plus up to a second. If `Retry-After` is longer than 60 seconds, or past the call's `deadline`, it raises `RateLimitError` at once instead of waiting.

## Deadline

`timeout` limits one attempt; `deadline` limits the whole call: every attempt, every retry delay and every rate-limit wait. It is off by default.

**Python**

```python
from echonova import EchoNova

client = EchoNova(deadline=30)  # seconds, for every call

voices = client.text_to_speech.voices.list(deadline=5)  # or for one call
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova({ deadline: 30_000 }); // milliseconds, for every call

const voices = await client.textToSpeech.voices.list({ deadline: 5_000 }); // or for one call
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova(deadline: const Duration(seconds: 30)); // for every call

final voices = await client.textToSpeech.voices.list(
  options: const RequestOptions(deadline: Duration(seconds: 5)), // or for one call
);
client.close();
```

When the deadline passes during an attempt, the SDK raises `APITimeoutError` with `kind` `total`. When a rate-limit wait would end after the deadline, it raises `RateLimitError` without sending. `jobs.wait()` has its own `timeout` instead (see [Jobs](jobs.md)).

## Rate-limit preflight

The API limits each key per endpoint, and reports the count in `X-RateLimit-*` headers (see [Rate limits](https://echonova.ai/docs/developers/rate-limits)). Each client tracks those headers per operation. When the last response said no requests remain and the window hasn't reset, the next call **waits for the reset** instead of sending a request that would be refused. Turn this off with `rate_limit_preflight=False` / `rateLimitPreflight: false` if you prefer to get the `429`.

Independently of preflight, after a `429` with `Retry-After` the client holds every call to that endpoint until the wait is over, so concurrent callers don't each discover the limit.

The state is per client. Use one client per process, and give each system its own key, so one busy system doesn't throttle another.

## Default headers

Headers you add are sent with every API request (never with downloads). They are useful for your own proxy or gateway, such as an app version or a tenant ID.

**Python**

```python
from echonova import EchoNova

client = EchoNova(default_headers={"X-App-Version": "4.2.0"})
voices = client.text_to_speech.voices.list(extra_headers={"X-Trace-Id": "checkout-7f3a"})
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova({ defaultHeaders: { 'X-App-Version': '4.2.0' } });
const voices = await client.textToSpeech.voices.list({ headers: { 'X-Trace-Id': 'checkout-7f3a' } });
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova(defaultHeaders: {'X-App-Version': '4.2.0'});
final voices = await client.textToSpeech.voices.list(
  options: const RequestOptions(headers: {'X-Trace-Id': 'checkout-7f3a'}),
);
client.close();
```

In TypeScript, a `null` value removes a header. In Dart, per-call headers can't replace the credentials. The reference proxies forward only an allow-list of request headers, so add custom ones to your proxy's list if it should pass them on.

## Custom HTTP client or fetch

Bring your own HTTP client for HTTP proxies, custom certificate authorities, mutual TLS, connection limits or instrumentation.

Downloads of signed links use a **separate** client in Python and Dart, because they go to a storage host and must never carry credentials. Configure that one too when your network needs it, and don't give it default auth headers.

**Python**

```python
import ssl

import httpx

from echonova import EchoNova

tls = ssl.create_default_context(cafile="/etc/ssl/certs/corporate-ca.pem")
proxy = "http://proxy.internal.example.com:3128"

with (
    httpx.Client(proxy=proxy, verify=tls, limits=httpx.Limits(max_connections=20)) as http_client,
    httpx.Client(proxy=proxy, verify=tls, follow_redirects=True) as download_client,
):
    client = EchoNova(http_client=http_client, download_http_client=download_client)
    print(client.text_to_speech.voices.list().total)
    client.close()  # leaves the clients you passed open: the with block closes them
```

Use `httpx.AsyncClient` with `AsyncEchoNova`.

**TypeScript**

The `fetch` option replaces `globalThis.fetch` for API calls and downloads alike. This one logs each request's method, path and status (never its query string: a download link's query string is its signature):

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova({
  fetch: async (url, init) => {
    const started = performance.now();
    const response = await fetch(url, init);
    const elapsed = Math.round(performance.now() - started);
    console.log(`${init.method ?? 'GET'} ${new URL(url).pathname} -> ${response.status} in ${elapsed} ms`);
    return response;
  },
});
```

**Dart**

Pass any `package:http` client. `close()` leaves a client you passed open, so close it yourself. This one adds a header and prints each request:

```dart
import 'dart:io';

import 'package:echonova/echonova.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

class TracingClient extends http.BaseClient {
  TracingClient(this._inner);

  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    request.headers['X-App-Version'] = '4.2.0';
    final response = await _inner.send(request);
    print('${request.method} ${request.url.path} -> ${response.statusCode}'); // never log the headers
    return response;
  }

  @override
  void close() => _inner.close();
}

Future<void> main() async {
  final httpClient = TracingClient(
    IOClient(HttpClient()..connectionTimeout = const Duration(seconds: 10)),
  );
  final client = EchoNova(httpClient: httpClient);
  try {
    print((await client.textToSpeech.voices.list()).length);
  } finally {
    client.close();
    httpClient.close();
  }
}
```

Keep a connect timeout on the `HttpClient` you build (the SDK's own client uses 10 seconds), so a connection that never opens fails fast instead of waiting for the attempt's whole time limit.

## Hooks

Hooks run on every attempt of every API call (not on downloads). Use them for metrics, tracing or correlation headers.

**Python**

```python
import uuid

import httpx

from echonova import EchoNova


def on_request(request: httpx.Request) -> None:
    request.headers["X-Trace-Id"] = uuid.uuid4().hex  # for your own proxy or gateway


def on_response(response: httpx.Response) -> None:
    request_id = response.headers.get("x-request-id")
    print(response.request.method, response.request.url.path, response.status_code, request_id)


client = EchoNova(on_request=on_request, on_response=on_response)
```

With `AsyncEchoNova`, the hooks may be async functions.

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova({
  onRequest: (request) => {
    request.headers.set('X-Trace-Id', crypto.randomUUID()); // for your own proxy or gateway
  },
  onResponse: (response, request) => {
    const requestId = response.headers.get('x-request-id');
    console.log(request.operation, `attempt ${request.attempt}`, response.status, requestId);
  },
});
```

**Dart** has no hook options: wrap the HTTP client, as in [the example above](#custom-http-client-or-fetch).

The request a hook sees **includes your credentials** in its headers. Never log the headers, and never send them anywhere.

## Logging

The SDKs log only what helps you debug: the method, the route, the status, the request ID, the attempt number, the timing, and decisions such as "retrying in 1.2 s" or "waiting for the rate-limit window". They **never** log:

- the API key, or any header (so neither `Authorization` nor your proxy credentials);
- request or response bodies: your text, transcripts and audio;
- the query string of a signed download link, which is its signature;
- webhook secrets, or an agent session's room token.

**Python**

Records go to the standard `logging` module, under the `echonova` logger. `ECHONOVA_LOG=debug` prints them to stderr without any setup.

```python
import logging

logging.basicConfig(level=logging.INFO)
logging.getLogger("echonova").setLevel(logging.DEBUG)

# httpx logs each request's full URL at INFO, query string included, and the
# HTTP and WebSocket libraries log headers at DEBUG: keep them quiet.
for name in ("httpx", "httpcore", "websockets"):
    logging.getLogger(name).setLevel(logging.WARNING)
```

**TypeScript**

Logging is off by default. Set `logLevel` (`'debug'`, `'info'`, `'warn'` or `'error'`) or `ECHONOVA_LOG`, and optionally a `logger` with `error`, `warn`, `info` and `debug` methods (the default is `console`):

```ts
import EchoNova from '@echonova/ai';

const line = (level: string) => (message: string) => console.log(JSON.stringify({ level, message }));

const client = new EchoNova({
  logLevel: 'info',
  logger: { error: line('error'), warn: line('warn'), info: line('info'), debug: line('debug') },
});
```

**Dart**

REST calls are not logged; wrap the HTTP client to see them. Stream sessions report their lifecycle to `dart:developer`'s log under the name `echonova.streaming`, which DevTools shows.

In production, don't turn on debug logging in your HTTP or WebSocket libraries, or in a proxy in front of EchoNova: they print headers, including the API key.

## Raw responses and rate-limit information

Every result has the request ID (`request_id` / `requestId`). For the status, the headers and the rate-limit counters too, ask for the raw response:

**Python**

```python
from echonova import EchoNova

client = EchoNova()

raw = client.with_raw_response.text_to_speech.voices.list()
print(raw.status_code, raw.request_id, raw.rate_limit, raw.headers.get("content-type"))
voices = raw.parse()  # what voices.list() returns

print(client.rate_limits.get("text_to_speech.voices.list"))  # limit, remaining, reset_seconds
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();

const { data: voices, response, requestId, rateLimit } = await client.textToSpeech.voices.list().withResponse();
console.log(response.status, requestId, rateLimit?.remaining, response.headers.get('content-type'));

console.log(client.rateLimits['textToSpeech.voices.list']); // limit, remaining, resetSeconds
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova();

final raw = await client.textToSpeech.voices.listWithResponse(); // every method has a …WithResponse twin
print('${raw.statusCode} ${raw.requestId} ${raw.rateLimit?.remaining} ${raw.attempts} attempt(s)');
final voices = raw.parse();

print(client.rateLimits['textToSpeech.voices.list']); // limit, remaining, reset
client.close();
```

`rate_limits` / `rateLimits` holds the last `X-RateLimit-*` values seen for each operation, which helps you slow down before a limit is reached.

## Scoped copies

`with_options()` / `withOptions()` returns a copy of the client with some options changed. The copy shares the original's connections and, while the key, base URL and auth hook are unchanged, its rate-limit state and polling budget. Close the original, not the copy.

**Python**

```python
from echonova import EchoNova

client = EchoNova()
patient = client.with_options(timeout=300, max_retries=4)
voices = patient.text_to_speech.voices.list()
client.close()  # closes the shared connections; patient.close() would do nothing
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();
const patient = client.withOptions({ timeout: 300_000, maxRetries: 4 });
const voices = await patient.textToSpeech.voices.list();
await client.close(); // closes the copies too; closing a copy does nothing
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova();
final patient = client.withOptions(timeout: const Duration(minutes: 5), maxRetries: 4);
final voices = await patient.textToSpeech.voices.list();
client.close(); // patient.close() would do nothing
```

In Dart, `withOptions` changes `timeout`, `deadline`, `maxRetries`, `defaultHeaders` and `rateLimitPreflight`. Python and TypeScript copies can change any option.

## Closing clients

Create one client per process and reuse it. Close it when your program is done with it:

- **Python:** `client.close()`, or `with EchoNova() as client:`. For `AsyncEchoNova`: `await client.close()`, or `async with AsyncEchoNova() as client:`. HTTP clients you passed in stay open.
- **TypeScript:** `await client.close()` cancels calls still in flight and makes new ones throw `UsageError`. `await using client = new EchoNova()` closes it at the end of the scope.
- **Dart:** `client.close()` closes the connections the SDK opened. An `httpClient` you passed in stays open.

Stream sessions have their own lifecycle: close each one when you are done (see [Streaming](streaming.md)).
