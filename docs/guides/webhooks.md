# Webhooks

EchoNova can call your server when an async job completes or fails, and when an API key nears or reaches its Credit Limit. This guide shows how to verify those deliveries with the SDK, handle each event once, and answer fast enough. Recipes for FastAPI, Flask, Express, Next.js and Dart's shelf are at the end.

Create a webhook in the portal (**Developers**, then **Webhooks**) with an `https` URL and the events you want. Its signing secret starts with `whsec_` and is shown only once: store it like an API key, on the server that receives the deliveries. See [Configure a webhook](https://echonova.ai/docs/developers/webhooks-configure) and [Webhook events](https://echonova.ai/docs/developers/webhooks-events) for the events and their fields.

## Verify every delivery

Each delivery is a `POST` with a JSON body and three headers: `X-Webhook-Event` (the event name), `X-Webhook-Timestamp` and `X-Webhook-Signature`, an HMAC-SHA256 of the timestamp and the body, signed with the webhook's secret. Anyone can send a request to your URL, so **check the signature before you act on a delivery**.

The SDK's `verify` function checks the headers, rejects timestamps more than 5 minutes from your clock (change it with `tolerance` / `toleranceSeconds`), compares the signature in constant time, and returns a typed event:

**Python**

```python
import os

from echonova import WebhookVerificationError, webhooks

SECRETS = [s.strip() for s in os.environ["ECHONOVA_WEBHOOK_SECRETS"].split(",") if s.strip()]


def on_delivery(raw_body: bytes, headers: dict[str, str]) -> int:
    """Verify one delivery and return the HTTP status to answer with."""
    try:
        event = webhooks.verify(raw_body, headers, SECRETS)
    except WebhookVerificationError as err:
        print(f"rejected a webhook: {err.reason}")  # headers, timestamp, signature or payload
        return 401

    match event:
        case webhooks.JobCompleted(service="tts"):
            print(f"audio ready for job {event.job_id}")
        case webhooks.JobCompleted():
            print(f"transcript ready for job {event.job_id}: {event.transcription}")
        case webhooks.JobFailed():
            print(f"{event.service} job {event.job_id} failed: {event.error}")
        case webhooks.SpendingWarning():
            print(f"key {event.api_key_id} has used {event.percentage_used}% of its Credit Limit")
        case webhooks.SpendingExhausted():
            print(f"key {event.api_key_id} reached its Credit Limit")
        case webhooks.UnknownEvent():
            pass  # an event this SDK version doesn't know: acknowledge it
    return 200
```

**TypeScript**

```ts
import { verifyWebhook, WebhookVerificationError, type WebhookEvent } from 'echonova';

const secrets = (process.env.ECHONOVA_WEBHOOK_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Verify one delivery and return the HTTP status to answer with. */
async function onDelivery(rawBody: Uint8Array, headers: Headers): Promise<number> {
  let event: WebhookEvent;
  try {
    event = await verifyWebhook(rawBody, headers, secrets);
  } catch (err) {
    if (!(err instanceof WebhookVerificationError)) throw err;
    console.warn(`rejected a webhook: ${err.reason}`); // headers, timestamp, signature or payload
    return 401;
  }

  switch (event.type) {
    case 'job.completed':
      console.log(event.service === 'tts' ? `audio ready for job ${event.jobId}` : `transcript: ${event.transcription}`);
      break;
    case 'job.failed':
      console.log(`${event.service} job ${event.jobId} failed: ${event.error}`);
      break;
    case 'spending.warning':
      console.log(`key ${event.apiKeyId} has used ${event.percentageUsed}% of its Credit Limit`);
      break;
    case 'spending.exhausted':
      console.log(`key ${event.apiKeyId} reached its Credit Limit`);
      break;
    case 'unknown':
      break; // an event this SDK version doesn't know: acknowledge it
  }
  return 200;
}
```

**Dart**

```dart
import 'dart:io';

import 'package:echonova/echonova.dart';

final secrets = Platform.environment['ECHONOVA_WEBHOOK_SECRETS']!
    .split(',')
    .map((s) => s.trim())
    .where((s) => s.isNotEmpty)
    .toList();

/// Verifies one delivery and returns the HTTP status to answer with.
int onDelivery(List<int> rawBody, Map<String, String> headers) {
  final WebhookEvent event;
  try {
    event = verifyWebhook(rawBody, headers, secrets);
  } on WebhookVerificationException catch (error) {
    print('rejected a webhook: ${error.reason}'); // headers, timestamp, signature or payload
    return 401;
  }

  switch (event) {
    case JobCompleted(:final jobId, service: 'tts'):
      print('audio ready for job $jobId');
    case JobCompleted(:final jobId, :final transcription):
      print('transcript ready for job $jobId: $transcription');
    case JobFailed(:final jobId, :final service, :final error):
      print('$service job $jobId failed: $error');
    case SpendingWarning(:final apiKeyId, :final percentageUsed):
      print('key $apiKeyId has used $percentageUsed% of its Credit Limit');
    case SpendingExhausted(:final apiKeyId):
      print('key $apiKeyId reached its Credit Limit');
    case UnknownWebhookEvent():
      break; // an event this SDK version doesn't know: acknowledge it
  }
  return 200;
}
```

Answer `401` when verification fails, and do nothing else with the request. Keep your server's clock synchronized (NTP): a drifting clock makes every delivery look stale.

## Use the raw body

The signature covers the body **exactly as it arrived**. If your framework parses the JSON and you serialize it again, key order, spacing or escaping can change, and the signature no longer matches. Read the raw bytes on the webhook route:

| Framework | Raw body |
| --- | --- |
| FastAPI, Starlette | `await request.body()` |
| Flask | `request.get_data()`, before anything reads `request.json` |
| Express | `express.raw({ type: 'application/json' })` on the webhook route, then `req.body` (a `Buffer`) |
| Next.js route handler | `new Uint8Array(await request.arrayBuffer())` |
| Dart shelf | `await request.read().expand((chunk) => chunk).toList()` |

`verify` takes bytes or a string. In Dart, if a framework only gives you a string, pass `utf8.encode(body)`.

## Several secrets during a switch-over

A webhook's secret can't be changed. To move to a new secret, the [API docs](https://echonova.ai/docs/developers/webhooks-verify-signature) describe this switch-over:

1. Create a second webhook with the same URL and events. Copy its secret.
2. Deploy your endpoint with **both** secrets. `verify` accepts a list and passes a delivery signed with any of them.
3. Delete the first webhook.
4. Remove the old secret from your configuration.

The examples here read a comma-separated list from `ECHONOVA_WEBHOOK_SECRETS` for that reason. While both webhooks exist, each event is delivered twice, once per webhook: the dedupe keys below make sure you handle it once.

## Handle each event once

The same event can arrive more than once: when your server processes a delivery but answers too late, EchoNova sends it again, and during a secret switch-over two webhooks deliver it. The body has no delivery ID, so every event the SDK parses has a `dedupe_key` (`dedupeKey` in TypeScript and Dart), built from the event's content:

| Event | Dedupe key |
| --- | --- |
| `job.completed`, `job.failed` | the event name and the job ID |
| `spending.warning`, `spending.exhausted` | the event name, the API key ID, the credits used and the limit |
| an event the SDK doesn't know | none: hash the raw body instead, which a retry repeats byte for byte |

Record the key **before** you do the work, in a store that every instance of your server shares and that survives restarts: a unique column in your database, or Redis `SET key value NX` with an expiry. Skip the event when the key was already there. The recipes below use an in-memory set to stay short; don't use one in production.

## Acknowledge fast

EchoNova waits only a few seconds for your answer (10 seconds when this was written; see [Delivery, retries and failures](https://echonova.ai/docs/developers/webhooks-retries)). A late answer counts as a failure, even a `200`, and the delivery is retried. After several deliveries in a row fail, the webhook is disabled, and events that happen while it is disabled are never sent.

So: verify, record the dedupe key, hand the event to a background task or a queue, and answer `200` at once. Do the slow work, such as downloads and database updates, afterwards:

**Python**

```python
from echonova import EchoNova, webhooks

client = EchoNova()


def process(event: webhooks.WebhookEvent) -> None:
    """Runs after the delivery was acknowledged."""
    if isinstance(event, webhooks.JobCompleted) and event.service == "tts":
        # The event's audio_url expires; jobs.download() gets a fresh link first.
        client.text_to_speech.jobs.download(event.job_id, to=f"{event.job_id}.wav")
    elif isinstance(event, webhooks.JobCompleted):
        job = client.speech_to_text.jobs.get(event.job_id)  # segments and speakers aren't in the event
        print(job.transcription, len(job.segments or ()))
    elif isinstance(event, webhooks.SpendingExhausted):
        print(f"key {event.api_key_id} is at its Credit Limit: paid calls with it now fail")
```

**TypeScript**

```ts
import EchoNova, { type WebhookEvent } from 'echonova';

const client = new EchoNova();

/** Runs after the delivery was acknowledged. */
async function processEvent(event: WebhookEvent): Promise<void> {
  if (event.type === 'job.completed' && event.service === 'tts') {
    // The event's audioUrl expires; jobs.download() gets a fresh link first.
    await client.textToSpeech.jobs.download(event.jobId, { to: `${event.jobId}.wav` });
  } else if (event.type === 'job.completed') {
    const job = await client.speechToText.jobs.get(event.jobId); // segments and speakers aren't in the event
    console.log(job.transcription, job.segments?.length);
  } else if (event.type === 'spending.exhausted') {
    console.log(`key ${event.apiKeyId} is at its Credit Limit: paid calls with it now fail`);
  }
}
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova();

/// Runs after the delivery was acknowledged.
Future<void> process(WebhookEvent event) async {
  switch (event) {
    case JobCompleted(:final jobId, service: 'tts'):
      // The event's audioUrl expires; jobs.downloadTo() gets a fresh link first.
      await client.textToSpeech.jobs.downloadTo(jobId, '$jobId.wav');
    case JobCompleted(:final jobId):
      final job = await client.speechToText.jobs.get(jobId); // segments and speakers aren't in the event
      print('${job.transcription} ${job.segments?.length}');
    case SpendingExhausted(:final apiKeyId):
      print('key $apiKeyId is at its Credit Limit: paid calls with it now fail');
    default:
      break;
  }
}
```

Webhooks are the efficient way to learn that a job finished, but not the only one: a job that times out on the server sends no webhook. If no event arrives for a job within 15 minutes, get the job once (see [Jobs](jobs.md)).

## Recipes

Each recipe verifies the raw body, answers `401` on failure, skips duplicates, and acknowledges before processing. Replace the `process` function with your own, and the in-memory set with a shared store.

### FastAPI

```python
import os

from fastapi import BackgroundTasks, FastAPI, Request, Response

from echonova import WebhookVerificationError, webhooks

SECRETS = [s.strip() for s in os.environ["ECHONOVA_WEBHOOK_SECRETS"].split(",") if s.strip()]
seen: set[str] = set()  # use your database or Redis in production

app = FastAPI()


def process(event: webhooks.WebhookEvent) -> None:
    print("processing", event.event)


@app.post("/webhooks/echonova")
async def echonova_webhook(request: Request, background: BackgroundTasks) -> Response:
    try:
        event = webhooks.verify(await request.body(), request.headers, SECRETS)
    except WebhookVerificationError:
        return Response(status_code=401)
    key = event.dedupe_key
    if key is None or key not in seen:
        if key is not None:
            seen.add(key)
        background.add_task(process, event)  # runs after the response is sent
    return Response(status_code=200)
```

### Flask

```python
import os
import threading

from flask import Flask, request

from echonova import WebhookVerificationError, webhooks

SECRETS = [s.strip() for s in os.environ["ECHONOVA_WEBHOOK_SECRETS"].split(",") if s.strip()]
seen: set[str] = set()  # use your database or Redis in production

app = Flask(__name__)


def process(event: webhooks.WebhookEvent) -> None:
    print("processing", event.event)


@app.post("/webhooks/echonova")
def echonova_webhook() -> tuple[str, int]:
    raw_body = request.get_data()  # before anything reads request.json
    try:
        event = webhooks.verify(raw_body, dict(request.headers), SECRETS)
    except WebhookVerificationError:
        return "", 401
    key = event.dedupe_key
    if key is None or key not in seen:
        if key is not None:
            seen.add(key)
        threading.Thread(target=process, args=(event,), daemon=True).start()  # or your task queue
    return "", 200
```

### Express

```ts
import express from 'express';
import { verifyWebhook, WebhookVerificationError, type WebhookEvent } from 'echonova';

const secrets = (process.env.ECHONOVA_WEBHOOK_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const seen = new Set<string>(); // use your database or Redis in production

async function processEvent(event: WebhookEvent): Promise<void> {
  console.log('processing', event.event);
}

const app = express();

// The raw body for this route only. Don't put express.json() in front of it.
app.post('/webhooks/echonova', express.raw({ type: 'application/json' }), async (req, res) => {
  let event: WebhookEvent;
  try {
    event = await verifyWebhook(req.body, req.headers, secrets);
  } catch (err) {
    if (!(err instanceof WebhookVerificationError)) throw err;
    res.sendStatus(401);
    return;
  }
  const key = event.dedupeKey;
  const isNew = key === null || !seen.has(key);
  if (key !== null) seen.add(key);
  res.sendStatus(200); // acknowledge first...
  if (isNew) processEvent(event).catch((err) => console.error('webhook processing failed', err)); // ...then work
});

app.listen(3000);
```

### Next.js route handler

In the App Router, put this in `app/webhooks/echonova/route.ts`. `after()` runs the work once the response is sent (Next.js 15.1 or later).

```ts
import { after } from 'next/server';
import { verifyWebhook, WebhookVerificationError, type WebhookEvent } from 'echonova';

const secrets = (process.env.ECHONOVA_WEBHOOK_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const seen = new Set<string>(); // serverless instances don't share memory: use your database or Redis

async function processEvent(event: WebhookEvent): Promise<void> {
  console.log('processing', event.event);
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  let event: WebhookEvent;
  try {
    event = await verifyWebhook(rawBody, request.headers, secrets);
  } catch (err) {
    if (!(err instanceof WebhookVerificationError)) throw err;
    return new Response(null, { status: 401 });
  }
  const key = event.dedupeKey;
  if (key === null || !seen.has(key)) {
    if (key !== null) seen.add(key);
    after(() => processEvent(event));
  }
  return new Response(null, { status: 200 });
}
```

### Dart shelf

```dart
import 'dart:async';
import 'dart:io';

import 'package:echonova/echonova.dart';
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;

final secrets = Platform.environment['ECHONOVA_WEBHOOK_SECRETS']!
    .split(',')
    .map((s) => s.trim())
    .where((s) => s.isNotEmpty)
    .toList();
final seen = <String>{}; // use your database or Redis in production

Future<void> process(WebhookEvent event) async {
  print('processing ${event.event}');
}

Future<Response> handle(Request request) async {
  if (request.method != 'POST' || request.url.path != 'webhooks/echonova') {
    return Response.notFound(null);
  }
  final rawBody = await request.read().expand((chunk) => chunk).toList();
  final WebhookEvent event;
  try {
    event = verifyWebhook(rawBody, request.headers, secrets);
  } on WebhookVerificationException {
    return Response(401);
  }
  final key = event.dedupeKey;
  if (key == null || seen.add(key)) {
    // Acknowledge first, then do the work.
    unawaited(process(event).catchError((Object error) => print('webhook processing failed: $error')));
  }
  return Response.ok(null);
}

Future<void> main() async {
  final server = await shelf_io.serve(handle, InternetAddress.anyIPv4, 8080);
  print('listening on port ${server.port}');
}
```

## Checklist

- [ ] The endpoint is `https`, and verifies every delivery before acting on it. Don't rely on IP allow-lists: rely on the signature.
- [ ] The secret lives in your secrets manager or environment, never in source control.
- [ ] The webhook route reads the raw body.
- [ ] Dedupe keys go into a shared, durable store before the work starts.
- [ ] The endpoint answers `2xx` within seconds and does slow work afterwards.
- [ ] Jobs whose event never arrives are checked once by polling.
- [ ] Webhooks go straight to your server, not through the [reference proxies](../../proxy-examples/README.md).
