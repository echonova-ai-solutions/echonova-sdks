# EchoNova JavaScript and TypeScript SDK

Official JavaScript and TypeScript SDK for the [EchoNova API](https://echonova.ai/docs/developers): Text to Speech, Speech to Text, Sound Cleaning and agent sessions.

> **Status: pre-release.** This package is under active development and is not yet published to npm. The first beta will be `0.9.0-beta.1`.

- Typed results that mirror the API's JSON, with the request ID on every result.
- Retries that never charge you twice, client-side rate limiting, job polling and safe downloads.
- No runtime dependencies for REST: it uses the platform's `fetch`, `FormData` and `Blob`.

## Requirements

| Runtime | REST | Streaming | File paths |
|---|---|---|---|
| Node.js 22 or later, Bun, Deno 2 | yes | yes | yes |
| Cloudflare Workers | yes | yes, through a `fetch()` upgrade | only with the `nodejs_compat` flag, for files in the Worker's own `/tmp` |
| Vercel Edge | yes | no | no |
| Browsers | [proxy mode](#proxy-mode-and-browsers) | proxy mode | no |

Without file paths, pass a `Blob`, bytes or a stream, and download to memory. A stream refused at the handshake (401, 402, 429...) raises the same error as REST everywhere except in browsers, which don't say why.

## Install

```bash
npm install echonova
```

## Quick start

```ts
import EchoNova from 'echonova';

const client = new EchoNova(); // reads ECHONOVA_API_KEY

const voices = await client.textToSpeech.voices.list(); // changes rarely: cache it
const voice = voices.items.find((v) => v.language === 'ar')!;

const speech = await client.textToSpeech.generate({ text: 'أهلاً بك في إيكونوفا', voiceId: voice.id });
console.log(speech.durationSeconds, speech.creditsConsumed, speech.requestId);
await client.download(speech.audioUrl, { to: 'speech.wav' });
```

CommonJS works too: `const { EchoNova } = require('echonova');`.

Create one client and reuse it: it keeps the rate-limit state that all calls share. `await client.close()` cancels calls still in flight and refuses new ones; `await using client = new EchoNova()` closes it at the end of the scope.

## Configuration

| Option | Default | |
|---|---|---|
| `apiKey` | `ECHONOVA_API_KEY` | Surrounding whitespace is removed. |
| `baseURL` | `ECHONOVA_BASE_URL`, else `https://api.echonova.ai` | The host only: request paths already start with `/v1`. |
| `auth` | none | A function returning headers, called before every request ([proxy mode](#proxy-mode-and-browsers)). |
| `timeout` | per operation | Milliseconds for one attempt. |
| `maxRetries` | `2` | |
| `deadline` | none | Total milliseconds for one call, retries and rate-limit waits included. |
| `rateLimitPreflight` | `true` | Wait for the rate-limit window instead of sending a request that would be refused. |
| `defaultHeaders` | none | Sent with every API request. A `null` value removes a header. |
| `fetch` | `globalThis.fetch` | Your own `fetch` (proxies, instrumentation). |
| `onRequest`, `onResponse` | none | Called for each attempt of an API call (not downloads). `onRequest` may add headers. |
| `logLevel`, `logger` | `ECHONOVA_LOG`, else off; `console` | See [Logging](#logging). |
| `dangerouslyAllowBrowser` | `false` | See [Proxy mode and browsers](#proxy-mode-and-browsers). |

Every API method takes per-call options as its last argument: `signal`, `timeout`, `maxRetries`, `deadline` and `headers`.

```ts
import EchoNova from 'echonova';

const client = new EchoNova();
const jobId = '...'; // a job ID from jobs.create()
const controller = new AbortController();

await client.textToSpeech.jobs.get(jobId, { timeout: 5_000, maxRetries: 0, signal: controller.signal });
const fast = client.withOptions({ timeout: 10_000 }); // a copy that shares the rate-limit state
```

`fetch` has a single deadline per attempt, so the default for each operation is 10 s to connect, plus the time to send the body, plus the time to wait for the answer. An upload is given time for its size at about 4 Mbit/s, between the write time below and 300 s (the server's own limit).

| Operation | send (s) | answer (s) | default per attempt |
|---|---|---|---|
| Get, list, delete; `agents.sessions.*`, `widgets.createTicket` | 10 | 30 | 50 s |
| `speechToText.jobs.export` | 10 | 60 | 80 s |
| `textToSpeech.jobs.create` | 10 | 30 | 50 s |
| `textToSpeech.generate` | 10 | 120 | 140 s |
| `speechToText.jobs.create` | 60 to 300 | 120 | 190 s or more |
| `speechToText.transcribe`, `soundCleaning.clean` | 60 to 300 | 600 | 670 s or more |

## Text to Speech

```ts
import EchoNova from 'echonova';

const client = new EchoNova();
const text = 'أهلاً بك في إيكونوفا';
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

const speech = await client.textToSpeech.generate({ text, voiceId, speed: 1.1, numSteps: 64 });

const job = await client.textToSpeech.jobs.create({ text, voiceId });
const done = await client.textToSpeech.jobs.wait(job); // polls every 3 s, for up to 20 minutes
await client.textToSpeech.jobs.download(done, { to: 'job.wav' }); // gets a fresh link first
await client.textToSpeech.jobs.delete(done);
```

Options you don't pass are not sent, so the API's defaults apply.

### Streaming

Keep one socket open and send a synthesis per sentence or reply. Audio arrives as PCM16LE mono chunks at `synth.sampleRate`, well before the whole text is spoken.

```ts
import EchoNova from 'echonova';

// Your app's audio output, voice activity detection and LLM text:
declare const speaker: { write(pcm: Uint8Array): void };
declare function userStartedTalking(): boolean;
declare function llmTextDeltas(): AsyncIterable<string>;

const client = new EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

await using tts = await client.textToSpeech.connect({ voiceId });
const synth = tts.synthesize('أهلاً بك، كيف يمكنني مساعدتك؟');
for await (const pcm of synth) {
  speaker.write(pcm);
  if (userStartedTalking()) break; // leaving the loop cancels the synthesis
}
const { outcome, creditsConsumed, charged } = await synth.result;

// A voice agent: LLM text in, gap-free audio out, sentence by sentence
for await (const pcm of tts.speakStream(llmTextDeltas())) speaker.write(pcm);

const audio = await client.textToSpeech.speak('مرحبا', { voiceId }); // one-shot: Audio with toWav()
```

A synthesis is charged per character when it starts. One stopped after its audio started (a cancel, a barge-in or a service failure) costs only the share of audio sent, at least 1 credit; `result.creditsConsumed` reports the final cost. The SDK never resends a synthesis that was sent but not started, because it may already have been charged.

## Speech to Text

`file` is a file path (Node.js, Bun, Deno), a `Blob` or `File`, bytes (`Uint8Array`, `Buffer`, `ArrayBuffer`), a stream of bytes (`ReadableStream`, a Node.js stream), or `toFile(content, name, { type })`.

```ts
import { readFile } from 'node:fs/promises';
import EchoNova, { toFile } from 'echonova';

const client = new EchoNova();
const bytes = await readFile('meeting.wav');

const result = await client.speechToText.transcribe({
  file: 'call.mp3',
  language: 'ar',
  identifySpeakers: true,
  terminology: { keywords: ['KYC', { term: 'Emirates NBD', variants: ['امريتس ان بي دي'] }] },
});
console.log(result.transcription);
if (result.terminology) console.log(result.terminology.corrected);
for (const segment of result.segments) console.log(segment.start.toFixed(2), segment.speaker, segment.text);

const job = await client.speechToText.jobs.create({ file: toFile(bytes, 'meeting.wav'), language: 'en' });
const done = await client.speechToText.jobs.wait(job); // polls every 5 s
const srt = await client.speechToText.jobs.export(done, { format: 'srt' }); // string
const data = await client.speechToText.jobs.export(done, { format: 'json' }); // TranscriptExport
```

The SDK names the audio type from the file name (mp3, wav, flac, ogg, opus, m4a, aac, webm, amr), then from a `Blob`'s own type, then from the file's first bytes. If it can't tell, it throws `UsageError` before sending anything; set the type with `toFile(content, name, { type: 'audio/mpeg' })`.

Uploads are never read into memory: a path is streamed from disk (`fs.openAsBlob`) and a stream is piped through. A path, `Blob` or bytes can be sent again on a retry; a stream only while none of it has been read.

### Streaming

Send live PCM16LE mono audio and receive transcripts as each segment is cut (every 15 s of audio, or when you call `endSegment()`).

```ts
import { createReadStream } from 'node:fs';
import EchoNova from 'echonova';

declare function microphone(): AsyncIterable<Uint8Array>; // your audio: PCM16LE mono at 16 kHz
const chunks = createReadStream('meeting.pcm'); // the same format, from a file

const client = new EchoNova();

await using stt = await client.speechToText.connect({ sampleRate: 16_000, language: 'ar' });
const feeding = stt.feedFrom(microphone()); // sends the audio, then stop()
for await (const event of stt) {
  if (event.type === 'transcript') console.log(event.text);
}
const summary = await feeding; // { reason, totalSeconds, creditsConsumed, jobId, savedStatus }

// Long or file-backed audio: rolls over to a new session before the session limit
for await (const event of client.speechToText.transcribeStream(chunks, { sampleRate: 16_000, language: 'en' })) {
  if (event.type === 'transcript') console.log(event.text);
}
```

Sessions never reconnect on their own; `transcribeStream()` does, replaying only audio that was never cut into a segment. Each session is saved as a Speech to Text job: `summary.jobId`, or a `session.saved` event. Streaming code loads on first use, so it costs nothing until you open a stream; its helpers (`Audio`, `pcmToWav`, `connectTts`, ...) are importable from `echonova/streaming`.

In browsers, streams only work in proxy mode: set `stream: { query: async () => ({ access_token: await getStreamToken() }) }`, because a browser can't send headers on a WebSocket.

## Sound Cleaning

```ts
import EchoNova from 'echonova';

const client = new EchoNova();

const job = await client.soundCleaning.clean({ file: 'noisy.wav', targetLufs: -16, sampleRate: 48000, bitDepth: 24 });
console.log(job.metrics?.integratedLufs, job.creditsConsumed);
await client.download(job.outputUrl, { to: 'clean.wav' });
await client.soundCleaning.jobs.delete(job);
```

## Agent sessions

Start a live voice or chat session with an agent from your server. The key needs the `agents:talk` scope.

```ts
import EchoNova from 'echonova';

declare function sendToYourClient(wsUrl: string, token: string): void; // your app's own channel

const client = new EchoNova();
const agentId = '...'; // your agent's ID

const session = await client.agents.sessions.start(agentId, { channel: 'voice' }); // or 'chat'
sendToYourClient(session.wsUrl, session.token); // only the client that joins the room

const { status } = await client.agents.sessions.get(agentId, session.id); // active, ended, failed, out_of_credits
await client.agents.sessions.end(agentId, session.id); // ending one that already ended is fine
```

The room `token` is a secret, returned only by `start()`. Hand it only to the client that joins the room, and don't log or store it. The SDK never logs it or copies it into an error, and `console.log(session)` in Node.js shows it as `[secret]`; `JSON.stringify(session)` keeps it. A chat session's first agent message is in `session.greeting`.

`start()` is never sent twice once it may have reached the server, because a retried start opens a second session: a lost response throws an error with `mayHaveExecuted: true`. An agent at its call or chat limit throws `ConcurrencyLimitError`.

Widget tickets for one visitor: `await client.widgets.createTicket(publicId, { user: { id, name }, channel: 'chat', ttlSeconds: 300 })`.

## Jobs, pages and downloads

- `get`, `wait`, `delete`, `download` and `export` accept a job ID or any job object.
- `jobs.list({ offset, limit })` gives a `Page` with `items`, `total`, `hasNextPage()` and `nextPage()`. `for await (const job of client.textToSpeech.jobs.list({ limit: 100 }))` walks every page and skips jobs it has already returned (a new job shifts later pages by one).
- `jobs.wait(job, { pollInterval, timeoutMs, raiseOnFailure, signal })` throws `JobFailedError` for a failed job and `JobWaitTimeoutError` when it gives up; calling it again is safe. All `wait()` calls on one client share a budget of 80 polls a minute per endpoint.
- Download links are signed and expire. `client.download(url, { to })` sends no API key, streams to a file (Node.js, Bun, Deno) or resolves to a `Uint8Array`, and throws `DownloadExpiredError` for an expired link. `jobs.download()` gets the job again for a fresh link.

## Errors and retries

```ts
import EchoNova from 'echonova';

declare function alertOps(): void;
declare function retryLater(seconds: number | null): void;

const client = new EchoNova();
const text = 'أهلاً بك في إيكونوفا';
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

try {
  await client.textToSpeech.generate({ text, voiceId });
} catch (err) {
  if (err instanceof EchoNova.InvalidRequestError) console.error(err.errorMessage, err.requestId);
  else if (err instanceof EchoNova.SpendingLimitError) alertOps(); // the key reached its Credit Limit: never retried
  else if (err instanceof EchoNova.RateLimitError) retryLater(err.retryAfter); // still limited after automatic retries
  else if (err instanceof EchoNova.APIConnectionError && err.mayHaveExecuted !== false) {
    // true or null (unknown): the response was lost, and the request may have run and been charged
    const candidates = await client.textToSpeech.jobs.findCandidates(err.sentAt!, { text });
  } else if (err instanceof EchoNova.APIStatusError) console.error(err.statusCode, err.errorMessage, err.requestId);
  else throw err;
}
```

Every error class is also exported by name (`import { RateLimitError } from 'echonova'`), and `instanceof` works across the ESM and CommonJS builds.

The SDK retries connection failures, rate limits and temporary outages, with backoff. It **never resends a request that may already have run**, because the API has no idempotency key and a second attempt could be charged again. Such errors carry `mayHaveExecuted: true` and `sentAt`; `findCandidates()` lists the jobs created since then so you can decide (skipping jobs made on a stream). It never picks one for you.

After a `429` with `Retry-After`, the client holds further calls to that endpoint until the wait is over, instead of sending more.

## Response metadata

```ts
import EchoNova from 'echonova';

const client = new EchoNova();
const jobId = '...'; // a job ID from jobs.create()

const { data: job, response, requestId, rateLimit } = await client.textToSpeech.jobs.get(jobId).withResponse();
console.log(response.status, requestId, rateLimit);

client.rateLimits; // the last rate-limit headers seen, per operation
```

Every result has `requestId`. Results mirror the API's JSON, including fields this SDK version doesn't know yet. Fields the API leaves out are `undefined`; fields it documents as nullable may also be `null`.

## Proxy mode and browsers

Never ship an API key in a browser or mobile app. Instead, run a small proxy on your backend that adds the key (see [`proxy-examples/`](../proxy-examples)), and point the SDK at it:

```ts
import EchoNova from 'echonova';

declare function sessionToken(): Promise<string>; // your app's own credentials

const client = new EchoNova({
  baseURL: 'https://api.example.com/echonova',
  auth: async () => ({ Authorization: `Bearer ${await sessionToken()}` }),
});
```

With `auth` set, `ECHONOVA_API_KEY` is not read, so the key never reaches your proxy by accident.

In a browser or browser worker, passing an API key throws `UnsupportedEnvironmentError`, because anyone using the page could read it. Proxy mode works in browsers. `dangerouslyAllowBrowser: true` turns the check off, for internal tools only.

## Logging

Set `logLevel` (`'debug'`, `'info'`, `'warn'`, `'error'`) or `ECHONOVA_LOG=debug`. The SDK logs the method, route, status, request ID, attempt and timing. It never logs your API key, request or response bodies, or the query string of a download link. Pass `logger` to send the lines somewhere other than `console`.

## Development

```bash
cd js
npm ci
npm run typecheck
npm test               # unit and conformance tests (no network, no API key)
npm run build
npm run lint:package   # attw, publint, ESM and CommonJS smoke tests, size budget
```

Tests read the shared contract in [`../spec`](../spec): the vendored API specs, the error rules, the parameter mapping and the test vectors every EchoNova SDK must pass.
