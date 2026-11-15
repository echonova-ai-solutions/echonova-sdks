# Troubleshooting

Answers to the problems developers hit most often. Error class names are given as in Python and TypeScript; in Dart they end in `Exception` (`AuthenticationException`). Every status error includes the server's message and the request ID, so start by printing the error.

- [401: AuthenticationError](#401-authenticationerror)
- [402: InsufficientBalanceError](#402-insufficientbalanceerror)
- [403: PermissionDeniedError](#403-permissiondeniederror)
- [429: three different errors](#429-three-different-errors)
- [Garbled or empty transcripts from the Speech to Text stream](#garbled-or-empty-transcripts-from-the-speech-to-text-stream)
- ["Unsupported file type" and other content-type errors](#unsupported-file-type-and-other-content-type-errors)
- [Expired download links](#expired-download-links)
- [Too many concurrent streams](#too-many-concurrent-streams)
- [Corporate proxies, firewalls and custom certificates](#corporate-proxies-firewalls-and-custom-certificates)
- [Still stuck?](#still-stuck)

## 401: AuthenticationError

The API answers `401 Unauthorized` with the same message for every cause: the `Authorization` header is missing or malformed, no key matches (a typo, or a key from another workspace), the key was deleted or disabled, or the account is closed.

1. **Is the key reaching the process?** `ECHONOVA_API_KEY` must be set where the program runs: in the service's unit file, the container, or the CI secret, not only in your shell. If neither `api_key` nor the variable is set, the SDK raises `UsageError` before sending anything, so a `401` means *some* key was sent.
2. **Is it the right key?** The portal lists each key by its first 8 characters. Print the same 8 characters of the key your program uses (never the whole key) and compare. A key belongs to one workspace.
3. **Is the key enabled?** Check its **Status** under **Developers**, **API Keys**. A disabled key returns `401`, not `403`. A deleted key can't come back: create a new one.
4. **Using proxy mode?** The `401` may come from your proxy: its user check rejected the session, or a stream token expired. The reference proxies answer `Unauthorized` too; their logs say which.

Rejected requests also count against a limit per IP address. Once it is reached, requests from that address get `429` for a while, whatever key they carry: fix the `401`s first.

## 402: InsufficientBalanceError

The workspace's balance can't cover the request, so it didn't run. Add credits or upgrade the plan in the portal, then try again. A stream that runs out of credits mid-session closes with code `4002` and raises the same class. It is never retried automatically.

## 403: PermissionDeniedError

The key is valid, but the request isn't allowed. The error's `error_message` / `errorMessage` says why:

| Message | Fix |
| --- | --- |
| `Subscription not found` | The key's workspace has no plan. Check the workspace in the portal. |
| `Subscription expired or inactive` | Renew the subscription. |
| `This API key does not have access to Text-to-Speech services` (or Speech-to-Text, Sound Cleaning) | Edit the key's **Access** to include the service, or use another key. |

`FeatureNotEnabledError`, a subclass, means a feature isn't enabled for your account. If you run one of the reference proxies, `403 Origin not allowed` comes from the proxy: add your web app's origin to `PROXY_ALLOWED_ORIGINS`.

A `403` from a **download** link raises `DownloadExpiredError` instead: see [Expired download links](#expired-download-links).

## 429: three different errors

A `429` can mean three things, and the SDK raises a different class for each:

| Class | Server message | What it means | What to do |
| --- | --- | --- | --- |
| `RateLimitError` | `ThrottlerException: Too Many Requests` | Too many requests to one endpoint with one key. The SDK already waited for `Retry-After` and retried. | Slow down: queue the work and retry after `retry_after`. Poll with `jobs.wait()`, which stays under the limit, or use webhooks. Give each system its own key. |
| `SpendingLimitError` | `Monthly spending limit exhausted` | The key reached its Credit Limit for this billing cycle. Waiting a few seconds won't help. | Raise or clear the limit on the key, or wait for the next cycle. Subscribe to `spending.warning` to hear about it earlier. |
| `ConcurrencyLimitError` | `Too many concurrent streams` | The workspace has no free stream slot. | See [Too many concurrent streams](#too-many-concurrent-streams). |

`SpendingLimitError` is deliberately not a subclass of `RateLimitError`, so a handler that retries rate limits never retries a spending limit. The reference proxies also answer `429 Too many requests` when a user exceeds the proxy's own per-user quota; the SDK treats it like any other throttle. See [Rate limits](https://echonova.ai/docs/developers/rate-limits) for the limits themselves.

## Garbled or empty transcripts from the Speech to Text stream

The Speech to Text stream takes **raw PCM**: 16-bit signed little-endian samples, one channel, at exactly the `sample_rate` you declare when you connect. Raw PCM has no header, so the bytes can't say what they are: when they don't match the declaration, speech sounds too fast or too slow to the model, and transcripts come back garbled, wrong or empty. Check each of these:

- **The sample rate.** Declare the rate your audio really has. Microphones and browsers often capture at 44,100 or 48,000 Hz, and phone audio is often 8,000 Hz. Audio captured at 48,000 Hz but declared as 16,000 sounds three times slower to the model.
- **One channel.** Stereo audio sent as mono is garbled. Mix it down to mono first.
- **16-bit integers.** The Web Audio API, for example, gives 32-bit floats: convert them.
- **Raw samples only.** Don't send a WAV file's header or a compressed format such as MP3 or Opus; decode them first.

For a WAV file, read the rate from its header instead of guessing. The SDKs' WAV helpers accept only mono 16-bit PCM files and raise an error for anything else, which catches the other mistakes too:

**Python**

```python
from echonova import EchoNova
from echonova.audio import read_wav
from echonova.types.streaming import Transcript

client = EchoNova()

audio = read_wav("call.wav")  # ValueError unless the file is mono 16-bit PCM
print(f"{audio.sample_rate} Hz, {audio.duration:.1f} s")

for event in client.speech_to_text.transcribe_stream(audio.pcm, sample_rate=audio.sample_rate, language="ar"):
    if isinstance(event, Transcript):
        print(event.text)
```

**TypeScript**

```ts
import { readFile } from 'node:fs/promises';
import EchoNova from '@echonova/ai';
import { parseWav } from '@echonova/ai/streaming';

const client = new EchoNova();

const audio = parseWav(await readFile('call.wav')); // RangeError unless the file is mono 16-bit PCM
console.log(`${audio.sampleRate} Hz`);

for await (const event of client.speechToText.transcribeStream(audio.pcm, { sampleRate: audio.sampleRate, language: 'ar' })) {
  if (event.type === 'transcript') console.log(event.text);
}
```

**Dart**

```dart
import 'dart:io';

import 'package:echonova/echonova.dart';

final client = EchoNova();

final audio = parseWav(await File('call.wav').readAsBytes()); // FormatException unless mono 16-bit PCM
print('${audio.sampleRate} Hz, ${audio.duration}');

final events = client.speechToText.transcribeStream(
  Stream.value(audio.pcm),
  sampleRate: audio.sampleRate,
  language: 'ar',
);
await for (final event in events) {
  if (event is Transcript) print(event.text);
}
client.close();
```

The same applies in reverse to the Text to Speech stream: it sends PCM at the synthesis's own `sample_rate` / `sampleRate`. Played at another rate, the voice sounds sped up or slowed down. See [Streaming](streaming.md).

## "Unsupported file type" and other content-type errors

**`400 Unsupported file type: <type>. Please upload an audio file.`** The upload's content type didn't start with `audio/`. The SDK names the type from the file extension (mp3, wav, flac, ogg, opus, m4a, aac, webm, amr) or, failing that, from the file's first bytes, and never sends `application/octet-stream`. So with the SDK, this message usually means a content type you set yourself was wrong, or something between you and EchoNova changed it.

**`UsageError` before anything is sent.** The SDK couldn't tell the audio type: the file has no known extension and its first bytes don't identify it. Name the type yourself:

**Python**

```python
from pathlib import Path

from echonova import EchoNova

client = EchoNova()

data = Path("upload.bin").read_bytes()  # a recording stored without a telling name
result = client.speech_to_text.transcribe(("voicemail.ogg", data, "audio/ogg"), language="en")
```

**TypeScript**

```ts
import { readFile } from 'node:fs/promises';
import EchoNova, { toFile } from '@echonova/ai';

const client = new EchoNova();

const data = await readFile('upload.bin'); // a recording stored without a telling name
const result = await client.speechToText.transcribe({
  file: toFile(data, 'voicemail.ogg', { type: 'audio/ogg' }),
  language: 'en',
});
```

**Dart**

```dart
import 'dart:io';

import 'package:echonova/echonova.dart';

final client = EchoNova();

final data = await File('upload.bin').readAsBytes(); // a recording stored without a telling name
final result = await client.speechToText.transcribe(
  AudioFile.fromBytes(data, 'voicemail.ogg', contentType: 'audio/ogg'),
  language: 'en',
);
client.close();
```

A type the API accepts is not a promise that every file of that type decodes: see [Speech to Text formats](https://echonova.ai/docs/developers/stt-formats-and-output) for what the API documents.

Other errors in this family:

- **`415 Content-Type must be application/json`.** The SDK always sends JSON with that type, so something in between, such as your proxy or an API gateway, changed the header.
- **`413 File too large`**, or **`Request body is larger than 100 KB`**. The upload or the JSON body is over the API's limit: see the [API reference](https://echonova.ai/docs/reference/stt-transcribe) for the current limits. Split long audio, or send shorter text. The reference proxies have their own upload limit too (`413 Request body too large`).
- **`400 Audio exceeds the 10-minute limit.`** The recording is longer than the endpoint accepts. Split it into shorter parts, or stream it with `transcribe_stream()`, which handles audio of any length.

All of these raise `InvalidRequestError` and are never retried: the same request would fail the same way.

## Expired download links

`audio_url`, `output_url` and a stream recording's `audio_url` are signed links to a storage host, and they expire. Downloading an expired one raises `DownloadExpiredError`. Get the job again for a fresh link; `jobs.download()` does that for you:

**Python**

```python
from echonova import DownloadExpiredError, EchoNova

client = EchoNova()
job_id = "..."  # a Text to Speech job ID you stored
audio_url = "https://..."  # a link you kept from earlier

try:
    client.download(audio_url, to="speech.wav")
except DownloadExpiredError:
    client.text_to_speech.jobs.download(job_id, to="speech.wav")  # gets a fresh link first
```

**TypeScript**

```ts
import EchoNova, { DownloadExpiredError } from '@echonova/ai';

const client = new EchoNova();
const jobId = '...'; // a Text to Speech job ID you stored
const audioUrl = 'https://...'; // a link you kept from earlier

try {
  await client.download(audioUrl, { to: 'speech.wav' });
} catch (err) {
  if (!(err instanceof DownloadExpiredError)) throw err;
  await client.textToSpeech.jobs.download(jobId, { to: 'speech.wav' }); // gets a fresh link first
}
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova();
const jobId = '...'; // a Text to Speech job ID you stored
const audioUrl = 'https://...'; // a link you kept from earlier

try {
  await client.downloadTo(audioUrl, 'speech.wav');
} on DownloadExpiredException {
  await client.textToSpeech.jobs.downloadTo(jobId, 'speech.wav'); // gets a fresh link first
} finally {
  client.close();
}
```

Better still, don't keep links: keep job IDs, and download when you need the file. The `audio_url` in a `job.completed` webhook expires too, so download it when the event arrives. Sound Cleaning jobs have `sound_cleaning.jobs.download()` in the same way.

## Too many concurrent streams

Opening a stream raises `ConcurrencyLimitError` ("Too many concurrent streams") when the workspace already has as many streams open as it may. The limit covers Text to Speech and Speech to Text streams together, across every key, server and user of the workspace (see [Rate limits](https://echonova.ai/docs/developers/rate-limits)). A stream counts until its socket closes.

- **Close sessions you are done with.** Use `with` / `async with` in Python, `await using` in TypeScript, or call `close()` in `finally`. A session you forget keeps its slot: the SDK's keepalive pings stop it from timing out.
- **Reuse one Text to Speech socket.** One session carries many syntheses, one after another (`synthesize`, `enqueue`, `speak_stream`). Don't open a stream per sentence.
- **Don't stream batch work.** For files and texts that aren't needed in real time, use `generate`, `transcribe` or async jobs: they don't use stream slots.
- **Budget slots per user** when end users can open streams, for example in your proxy. The reference proxies cap streams per user and in total.
- **Wait for a slot** when a short queue is acceptable. `wait_for_slot` / `waitForSlot` keeps retrying for that long before raising:

**Python**

```python
from echonova import EchoNova

client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

with client.text_to_speech.connect(voice_id=voice_id, wait_for_slot=30) as tts:  # seconds
    audio = b"".join(tts.synthesize("أهلاً بك"))
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

await using tts = await client.textToSpeech.connect({ voiceId, waitForSlot: 30_000 }); // milliseconds
for await (const pcm of tts.synthesize('أهلاً بك')) console.log(pcm.byteLength);
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

final tts = await client.textToSpeech.connect(voiceId: voiceId, waitForSlot: const Duration(seconds: 30));
try {
  await for (final pcm in tts.synthesize('أهلاً بك').audio) {
    print(pcm.length);
  }
} finally {
  await tts.close();
  client.close();
}
```

Opening streams very often hits a different limit, on connection attempts per key, and raises `RateLimitError`. Keep sessions open and reuse them instead of reconnecting for each request.

## Corporate proxies, firewalls and custom certificates

**What to allow.** The SDK talks to `api.echonova.ai` over HTTPS, for REST and for the `wss://` streams, and downloads signed links from the storage host named in each link. Streams need WebSocket upgrades and long-lived connections to be allowed through the proxy.

**Python.** The SDK's HTTP clients (`httpx`) use the standard proxy variables, `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and `NO_PROXY`, and trust the certificates in `SSL_CERT_FILE` or `SSL_CERT_DIR`. Recent versions of the `websockets` library, which the streams use, read the same proxy variables. To configure proxies or certificates in code, pass your own `http_client` and `download_http_client` (see [Configuration](configuration.md#custom-http-client-or-fetch)).

**TypeScript on Node.js.** Node's built-in `fetch` ignores the proxy variables by default. The `undici` package can route it through your proxy, for the whole process:

<!-- snippet: skip (needs the undici package) -->
```ts
import EchoNova from '@echonova/ai';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

// Node's fetch, and with it the SDK's API calls and downloads, now honour HTTPS_PROXY, HTTP_PROXY and NO_PROXY.
setGlobalDispatcher(new EnvHttpProxyAgent());

const client = new EchoNova();
```

To route only EchoNova's traffic, pass the client a `fetch` option that does the same; it covers API calls and downloads. Streams don't go through `fetch` and have no proxy option: they need a direct route to `wss://api.echonova.ai`. For a corporate certificate authority, start Node with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

**Dart.** `dart:io`'s `HttpClient` doesn't read the proxy variables unless told to. Pass clients that do, for API calls and for downloads:

```dart
import 'dart:io';

import 'package:echonova/echonova.dart';
import 'package:http/io_client.dart';

IOClient proxied() {
  final context = SecurityContext(withTrustedRoots: true)
    ..setTrustedCertificates('/etc/ssl/certs/corporate-ca.pem'); // only for a corporate CA
  return IOClient(
    HttpClient(context: context)
      ..findProxy = HttpClient.findProxyFromEnvironment
      ..connectionTimeout = const Duration(seconds: 10),
  );
}

Future<void> main() async {
  final api = proxied();
  final downloads = proxied();
  final client = EchoNova(httpClient: api, downloadHttpClient: downloads);
  try {
    print((await client.textToSpeech.voices.list()).length);
  } finally {
    client.close();
    api.close();
    downloads.close();
  }
}
```

Streams on Android, iOS, desktop and servers open their own connection and need a direct route to `wss://api.echonova.ai`.

## Still stuck?

- Turn on the SDK's logs to see each attempt, its status and its request ID: `ECHONOVA_LOG=debug` in Python and TypeScript (see [Configuration](configuration.md#logging)).
- Look up a request ID in the portal: **Activity**, then **Logs**, then **Find by request ID**.
- The API docs' [Errors](https://echonova.ai/docs/developers/errors) page lists every status and message the API returns.
- Contact EchoNova support with the request ID, the job ID, the exact error text and when it happened (see [Errors](errors.md#request-ids-and-support)). Never include an API key or a webhook secret.
