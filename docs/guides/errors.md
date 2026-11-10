# Errors

Every SDK raises the same error classes, grouped by what went wrong rather than how it reached you. "Out of credits" is one class whether it came from a REST `402`, a rejected stream handshake or a stream closed mid-session. This guide shows how to handle them, what the SDK retries for you, and how to recover when a paid request may have run.

## The error classes

The tree is the same in Python, TypeScript and Dart. In Dart, each name ends in `Exception` instead of `Error` (`RateLimitException`), and the root is `EchoNovaException`.

```text
EchoNovaError
├─ UsageError                       the SDK was called incorrectly; nothing was sent
│  └─ SessionEndedError             a stream session was used after it ended
├─ UnsupportedEnvironmentError      e.g. an API key in a browser
├─ APIConnectionError               no response: connect, send or read failed
│  ├─ APITimeoutError               a time limit expired (.kind)
│  └─ StreamConnectionLostError     a stream dropped without a close frame
├─ APIStatusError                   the server answered with an error
│  ├─ InvalidRequestError           400, 405, 409, 413, 415, 422
│  ├─ AuthenticationError           401
│  ├─ PermissionDeniedError         403
│  │  └─ FeatureNotEnabledError
│  ├─ NotFoundError                 404
│  │  ├─ VoiceNotFoundError
│  │  └─ JobNotFoundError
│  ├─ RequestTimeoutError           408
│  ├─ BillingError                  retrying won't help
│  │  ├─ InsufficientBalanceError   402: not enough credits
│  │  └─ SpendingLimitError         429: the key reached its Credit Limit
│  ├─ RateLimitError                429: throttled (.retry_after)
│  ├─ ConcurrencyLimitError         no free stream slot, or an agent at its limit
│  ├─ ServerError                   5xx
│  │  ├─ ServiceUnavailableError    503
│  │  ├─ GatewayError               502, 504
│  │  └─ UpstreamError              a speech service failed during a stream
│  └─ ProtocolError                 a response that breaks the documented contract
├─ StreamClosedError                a stream closed for another reason
│  ├─ ServerRestartingError
│  └─ SessionExpiredError           idle timeout or maximum session length
├─ JobFailedError                   wait(): the job failed (.job)
├─ JobWaitTimeoutError              wait() gave up; calling it again is safe
├─ DownloadExpiredError             a signed link expired; get the job again
└─ WebhookVerificationError         a webhook failed verification (.reason)
```

Two choices in this tree matter when you write handlers:

- **`SpendingLimitError` is not a `RateLimitError`.** A rate limit clears by waiting; a spending limit doesn't. Code that catches `RateLimitError` and retries later can never retry a spending limit by accident.
- **Unknown messages fall back to the generic class for their status.** A new `404` message raises `NotFoundError`, never a more specific class.

Import them from the package: `from echonova import RateLimitError` in Python, `import { RateLimitError } from 'echonova'` (or `EchoNova.RateLimitError`) in TypeScript, and `package:echonova/echonova.dart` in Dart. In TypeScript, `instanceof` works across the ESM and CommonJS builds. In Dart, `EchoNovaException` is `sealed`, so a `switch` over it is exhaustive.

## What an error tells you

| | Python | TypeScript | Dart |
| --- | --- | --- | --- |
| Summary with status, server message and request ID | `str(err)` | `err.message` | `e.message` |
| The server's message, exactly as sent | `error_message` | `errorMessage` | `errorMessage` |
| HTTP status | `status_code` | `statusCode` | `statusCode` |
| Request ID, for support | `request_id` | `requestId` | `requestId` |
| How long to wait | `retry_after` (seconds) | `retryAfter` (seconds) | `retryAfter` (`Duration`) |
| Whether a request may have run | `may_have_executed` | `mayHaveExecuted` | `mayHaveExecuted` |
| When the request was sent | `sent_at` | `sentAt` | `sentAt` |
| Link to the API docs for the error | `docs_url` | `docsUrl` | `docsUrl` |
| Response headers, start of the body (4 KiB at most) | `headers`, `raw_body` | `headers`, `rawBody` | `headers`, `rawBody` |

Any field may be empty. Status errors from streams also carry `close_code`, `error_code` and `session_id`, and a failed synthesis on the Text to Speech stream says whether it was charged: `err.charge_state` in Python, `chargeStateOf(err)` in TypeScript and Dart (see [Streaming](streaming.md)). `APITimeoutError` has `kind` (`connect`, `write`, `read`, `pool`, `total`, …), and `GatewayError` has `from_proxy` / `fromProxy`, true when the `502` or `504` came from the hosting infrastructure rather than the API.

The server's message is never split or rewritten: when several validation rules fail, the API joins their messages with a comma, and `error_message` keeps the whole text.

## Handling errors

Catch the specific classes you can act on, and let the rest reach your general error handling.

**Python**

```python
import echonova
from echonova import EchoNova

client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

try:
    speech = client.text_to_speech.generate("أهلاً بك", voice_id=voice_id)
except echonova.VoiceNotFoundError:
    print("that voice is gone: refresh your cached voice list")
except echonova.InvalidRequestError as err:
    print(f"fix the request: {err.error_message} (request {err.request_id})")
except echonova.BillingError as err:
    print(f"out of credits or over the key's Credit Limit: {err}")  # waiting won't help
except echonova.RateLimitError as err:
    print(f"still throttled after the automatic retries; try again in {err.retry_after} s")
except echonova.APIConnectionError as err:
    print(f"no response (may have run: {err.may_have_executed}): {err}")
except echonova.APIStatusError as err:
    print(f"EchoNova answered with an error: {err}")  # status, message and request ID
```

**TypeScript**

```ts
import EchoNova from 'echonova';

const client = new EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

try {
  const speech = await client.textToSpeech.generate({ text: 'أهلاً بك', voiceId });
} catch (err) {
  if (err instanceof EchoNova.VoiceNotFoundError) {
    console.error('that voice is gone: refresh your cached voice list');
  } else if (err instanceof EchoNova.InvalidRequestError) {
    console.error(`fix the request: ${err.errorMessage} (request ${err.requestId})`);
  } else if (err instanceof EchoNova.BillingError) {
    console.error(`out of credits or over the key's Credit Limit: ${err.message}`); // waiting won't help
  } else if (err instanceof EchoNova.RateLimitError) {
    console.error(`still throttled after the automatic retries; try again in ${err.retryAfter} s`);
  } else if (err instanceof EchoNova.APIConnectionError) {
    console.error(`no response (may have run: ${err.mayHaveExecuted}): ${err.message}`);
  } else if (err instanceof EchoNova.APIStatusError) {
    console.error(`EchoNova answered with an error: ${err.message}`); // status, message and request ID
  } else {
    throw err;
  }
}
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

try {
  final speech = await client.textToSpeech.generate('أهلاً بك', voiceId: voiceId);
} on EchoNovaException catch (error) {
  final advice = switch (error) {
    VoiceNotFoundException() => 'that voice is gone: refresh your cached voice list',
    InvalidRequestException(:final errorMessage, :final requestId) =>
      'fix the request: $errorMessage (request $requestId)',
    BillingException() => "out of credits or over the key's Credit Limit", // waiting won't help
    RateLimitException(:final retryAfter) => 'still throttled; try again in $retryAfter',
    APIConnectionException(:final mayHaveExecuted) => 'no response (may have run: $mayHaveExecuted)',
    _ => 'EchoNova call failed',
  };
  print('$advice: $error');
} finally {
  client.close();
}
```

## What the SDK retries

Most EchoNova `POST` requests are paid: they synthesize, transcribe or clean audio. The API has no idempotency key, so it can't tell a retry from a new request:

> A `POST` that is sent twice is charged twice.
> — [Retry requests safely](https://echonova.ai/docs/developers/retries-and-idempotency)

So the SDK retries a request only when a second attempt can't cost you twice:

| Failure | `GET`, `DELETE` | `POST` |
| --- | --- | --- |
| Connecting failed, so nothing was sent (DNS, TCP, TLS) | retried | retried |
| The body was not fully sent, and the SDK can tell | retried | retried, if the body can be sent again |
| `429` with `Retry-After` (throttled) | retried after `Retry-After` | retried after `Retry-After` |
| `408` | retried | retried |
| `503` with a message the API documents as temporary, such as "…temporarily unavailable…" (the API refunds the charge) | retried | retried |
| `503` that isn't from the API (not its JSON error) | retried | retried |
| Sent, but no response arrived (read timeout, connection reset) | retried | **not retried**, `may_have_executed` true |
| `500`, `502`, another `503`, `504` | retried | **not retried**, `may_have_executed` unknown or true |
| A `2xx` whose body isn't valid | `GET` retried once, `DELETE` not retried | **not retried**, `may_have_executed` true |
| `400`, `401`, `402`, `403`, `404`, `405`, `409`, `413`, `415`, `422` | not retried | not retried |
| `429` "Monthly spending limit exhausted", or `429` without `Retry-After` | not retried | not retried |

Some details:

- **The `503` rule for `POST` is an allow-list** of messages the API documents as temporary. A new `503` message is not retried for a `POST` until the SDK learns it, so a change on the server can never quietly start double charges.
- **A retried `DELETE` that then gets `404`** reports success with `already_deleted` / `alreadyDeleted` set: the first attempt removed the job.
- **Uploads are retried only when they can be sent again.** A file path is reopened, bytes are reused and a seekable file is rewound. A stream that was already partly read is not retried; its error has `retry_disabled_reason` / `retryDisabledReason` set to `body_not_replayable`.
- The number of retries, the backoff and the `Retry-After` cap are in [Configuration](configuration.md#retries).

The API docs suggest retrying `5xx` responses in general. The SDK is stricter for `POST` because a `5xx` can arrive after the work already started: it raises instead, with `may_have_executed` set, so you can check before you send the request again.

**Don't wrap SDK calls in a generic retry layer** (tenacity, p-retry, a job queue's automatic retries) for `POST` requests. It would resend exactly the requests the SDK held back. If you need one, retry only errors whose `may_have_executed` is false.

## `may_have_executed`

`APIConnectionError` and `APIStatusError` both carry `may_have_executed` (`mayHaveExecuted` in TypeScript and Dart):

| Value | Meaning | What to do |
| --- | --- | --- |
| `False` / `false` | The request did not run. | Handle the error; sending it again is safe. |
| `True` / `true` | The request was fully sent and the response was lost. It may have run and been charged. | Look for the job before you send it again. |
| `None` / `null` | Unknown: the server failed after receiving it. | Look for the job before you send it again. |

It is always false for `GET` and `DELETE`, which are safe to repeat. `sent_at` / `sentAt` records when the request finished sending, so you know where to look.

## Recovering from a POST that may have run

The API docs' advice is: **don't send the `POST` again until you have looked**. Jobs are listed newest first. A Text to Speech job can be matched on its text and creation time; a Speech to Text job, which keeps no reference to the uploaded file, only on its creation time.

`find_candidates()` (`findCandidates()` in TypeScript and Dart) does the looking: it lists the jobs created from `sent_at` minus 5 seconds until now, skipping jobs made on a stream, and for Text to Speech optionally only those with the same text. It returns a **list** and never picks one for you, because other requests can match too, for example when the same text was sent concurrently.

**Python**

```python
from echonova import APIConnectionError, APIStatusError, EchoNova

client = EchoNova()
text = "أهلاً بك في إيكونوفا"
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

try:
    job_id = client.text_to_speech.jobs.create(text, voice_id=voice_id).job_id
except (APIConnectionError, APIStatusError) as err:
    if err.may_have_executed is False or err.sent_at is None:
        raise  # it did not run: handle the error as usual
    candidates = client.text_to_speech.jobs.find_candidates(err.sent_at, text=text)
    if not candidates:
        job_id = client.text_to_speech.jobs.create(text, voice_id=voice_id).job_id  # nothing ran
    elif len(candidates) == 1:
        job_id = candidates[0].id
    else:
        raise  # several matches: decide with what you know about your own traffic

done = client.text_to_speech.jobs.wait(job_id)
```

**TypeScript**

```ts
import EchoNova, { APIConnectionError, APIStatusError } from 'echonova';

const client = new EchoNova();
const text = 'أهلاً بك في إيكونوفا';
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

async function createOnce(): Promise<string> {
  try {
    return (await client.textToSpeech.jobs.create({ text, voiceId })).jobId;
  } catch (err) {
    if (!(err instanceof APIConnectionError || err instanceof APIStatusError)) throw err;
    if (err.mayHaveExecuted === false || err.sentAt === null) throw err; // it did not run
    const candidates = await client.textToSpeech.jobs.findCandidates(err.sentAt, { text });
    if (candidates.length === 0) return (await client.textToSpeech.jobs.create({ text, voiceId })).jobId; // nothing ran
    if (candidates.length === 1) return candidates[0]!.id;
    throw err; // several matches: decide with what you know about your own traffic
  }
}

const done = await client.textToSpeech.jobs.wait(await createOnce());
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova();
const text = 'أهلاً بك في إيكونوفا';
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

Future<String> createOnce() async {
  try {
    return (await client.textToSpeech.jobs.create(text, voiceId: voiceId)).jobId;
  } on EchoNovaException catch (error) {
    final (bool? mayHaveRun, DateTime? sentAt) = switch (error) {
      APIConnectionException(:final mayHaveExecuted, :final sentAt) => (mayHaveExecuted, sentAt),
      APIStatusException(:final mayHaveExecuted, :final sentAt) => (mayHaveExecuted, sentAt),
      _ => (false, null),
    };
    if (mayHaveRun == false || sentAt == null) rethrow; // it did not run
    final candidates = await client.textToSpeech.jobs.findCandidates(sentAt, text: text);
    if (candidates.isEmpty) {
      return (await client.textToSpeech.jobs.create(text, voiceId: voiceId)).jobId; // nothing ran
    }
    if (candidates.length == 1) return candidates.single.id;
    rethrow; // several matches: decide with what you know about your own traffic
  }
}

final done = await client.textToSpeech.jobs.wait(await createOnce());
client.close();
```

[Jobs](jobs.md#if-the-response-to-a-post-is-lost) walks through the same recovery for async jobs. The pattern works for the other paid calls too:

- **Speech to Text** (`transcribe`, `jobs.create`): `speech_to_text.jobs.find_candidates(sent_at)` matches on time only. Compare the candidates' duration and language with what you sent.
- **Sound Cleaning** (`clean`): list `sound_cleaning.jobs.list()` and look at the newest jobs' file name and creation time.
- **Agent sessions** (`agents.sessions.start`): never sent twice, because a second start would open a second session. See [Agents and widgets](agents-and-widgets.md).
- **Streams:** a synthesis that was sent but not started is never resent, because it may already have been charged. Its error says whether it was (`charge_state`, or `chargeStateOf()`). See [Streaming](streaming.md).

## Rate limits and `Retry-After`

The API limits each key per endpoint (see [Rate limits](https://echonova.ai/docs/developers/rate-limits)). A request over the limit gets `429` with a `Retry-After` header. The SDK:

1. waits `Retry-After` (plus up to a second of jitter) and retries, counting it as one of the call's retries;
2. meanwhile holds every other call to that endpoint on the same client, instead of letting each one be refused;
3. raises `RateLimitError` when the retries run out, or at once when `Retry-After` is longer than 60 seconds or reaches past the call's `deadline`. `retry_after` / `retryAfter` says how long to wait.

A `RateLimitError` that reaches your code means the endpoint is busier than the limit allows. Slow down: queue the work and try again after `retry_after`, spread polling across fewer jobs, or give each system its own key.

Two other errors also use `429` or concern limits, but **waiting won't clear them the same way**:

- **`SpendingLimitError`** (`429` "Monthly spending limit exhausted", or a stream closed with code `4029`): the key reached its Credit Limit for the billing cycle. It is never retried. Raise or clear the limit on the key, or wait for the next cycle.
- **`ConcurrencyLimitError`**: the workspace has no free stream slot ("Too many concurrent streams"), or an agent is at its call or chat limit. Close streams you no longer need. When opening a stream, `wait_for_slot` / `waitForSlot` keeps retrying for a while.

`InsufficientBalanceError` (`402`, or stream close `4002`) means the workspace has no credits left. A REST call that gets `402` did not run. Add credits.

## Jobs and downloads

- **`JobFailedError`**: `jobs.wait()` found the job `failed`. The job is on the error (`err.job`), with the reason in its `error` field. The API refunds a failed job's credits. Pass `raise_on_failure=False` / `raiseOnFailure: false` to get the failed job back instead.
- **`JobWaitTimeoutError`**: `wait()` gave up after its `timeout`. The job may still finish: calling `wait()` again is safe. The error has `job_id` and the last state seen (`last_job`).
- **`DownloadExpiredError`**: a signed link expired. Get the job again for a fresh one, or use `jobs.download()`, which does that for you.

See [Jobs](jobs.md).

## Request IDs and support

Every API response has an `X-Request-Id` header, and the SDKs put it everywhere you might need it:

- on every result: `speech.request_id` / `speech.requestId`;
- on every `APIStatusError`, and in its message, so a logged error already contains it;
- on raw responses (see [Configuration](configuration.md#raw-responses-and-rate-limit-information)).

In the portal, **Activity**, then **Logs**, then **Find by request ID** shows that call. A connection error has no request ID, because no response arrived: use `sent_at` / `sentAt` to say when it happened.

When you contact EchoNova support, send:

- the request ID, and the job ID when there is one;
- the exact error text: `str(err)` / `err.message` is safe to share, because the SDK never puts your key or webhook secrets into an error;
- the endpoint or SDK method, and when it happened, with the time zone;
- your workspace's name.

Never send an API key or a webhook secret. If one has leaked, disable it in the portal first (see [Authentication](authentication.md#rotate-keys)).
