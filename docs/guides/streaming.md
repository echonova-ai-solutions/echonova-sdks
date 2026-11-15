# Streaming

EchoNova has two WebSocket streams: Text to Speech sends audio while the speech is still being generated, and Speech to Text returns a transcript for each piece of speech while the audio is still flowing. Use them when someone is speaking or listening right now: a voice agent, a phone call, live captions. For recordings and for audio you keep, the REST calls in [Text to Speech](text-to-speech.md) and [Speech to Text](speech-to-text.md) are simpler, and for Speech to Text cheaper.

Every message and field is in the API reference: [Text to Speech stream](https://echonova.ai/docs/reference/tts-stream), [Speech to Text stream](https://echonova.ai/docs/reference/stt-stream).

- **Open streams from your server.** A browser can't send the API key on a WebSocket, and the key must never reach a page or an app anyway. Browsers and Flutter apps stream through your own proxy, with the same SDK calls (see [Browser](#browser-through-your-proxy-with-an-audioworklet) and [Flutter](#flutter)).
- **Python** has blocking sessions on `EchoNova` and asyncio sessions on `AsyncEchoNova`, with the same methods. On the async client, the methods that talk to the server are awaited (`await tts.interrupt()`, `await stt.send_audio(pcm)`); `synthesize()` and `enqueue()` return their synthesis at once.
- Both streams count toward one limit of concurrent streams per workspace (see [Limits](#limits)). `connect()` raises `ConcurrencyLimitError` when no slot is free; pass `wait_for_slot` (seconds in Python, milliseconds in TypeScript, a `Duration` in Dart) to keep trying for that long.

## Text to Speech

### Sessions

`text_to_speech.connect()` opens a session: one socket that carries many syntheses, one at a time. Open it before you need it (when a call starts, say) and keep it for the whole conversation. The voice and options you give `connect()` apply to every synthesis on it; each synthesis can override them.

Each `synthesize()` returns a synthesis you iterate for its audio: 16-bit little-endian mono PCM chunks, as the speech is generated. When it ends, its result says how: `completed`, `cancelled` or `superseded` (replaced by a newer one), with the credits it finally cost. A cancellation you asked for is an outcome, not an error.

**Python**

```python
from echonova import EchoNova

client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

with client.text_to_speech.connect(voice_id=voice_id) as tts:
    synth = tts.synthesize("أهلاً بك، كيف يمكنني مساعدتك اليوم؟")
    for pcm in synth:  # PCM16 mono chunks, as the speech is generated
        print(len(pcm), "bytes at", synth.sample_rate, "Hz")  # send them to your player
    result = synth.result()
    print(result.outcome, result.credits_consumed, result.charged)
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

await using tts = await client.textToSpeech.connect({ voiceId });
const synth = tts.synthesize('أهلاً بك، كيف يمكنني مساعدتك اليوم؟');
for await (const pcm of synth) {
  console.log(pcm.byteLength, 'bytes at', synth.sampleRate, 'Hz'); // send them to your player
}
const result = await synth.result;
console.log(result.outcome, result.creditsConsumed, result.charged);
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

final tts = await client.textToSpeech.connect(voiceId: voiceId);
final synthesis = tts.synthesize('أهلاً بك، كيف يمكنني مساعدتك اليوم؟');
await for (final pcm in synthesis.audio) {
  print('${pcm.length} bytes at ${synthesis.sampleRate} Hz'); // send them to your player
}
final result = await synthesis.result;
print('${result.outcome.name} ${result.creditsConsumed} ${result.charged}');
await tts.close();
client.close();
```

`text_to_speech.speak(text, voice_id=...)` is a one-shot shortcut: it opens a stream of its own, synthesizes the text and returns all the audio with its sample rate (`Audio`), usually sooner than `generate()` returns a file.

### synthesize, enqueue and speak_stream

Only one text is spoken at a time on a socket, and on the server a new synthesis cancels the one that is running. The SDK gives you both behaviours:

| Method | What it does |
|---|---|
| `synthesize(text)` | Speak now: replaces the running synthesis and drops anything queued. |
| `enqueue(text)` | Queue it: the SDK sends it once everything before it has finished, so nothing is cut off. There can be a short pause between queued texts. |
| `speak_stream(texts)` (`speakStream`) | Speak a reply as it is written: takes a string, a list of texts, or a stream of text deltas from a language model, splits it into sentences, queues them in order and yields one continuous stream of audio. |

Each text keeps the per-request character limit (see the [reference](https://echonova.ai/docs/reference/tts-stream)); `speak_stream()` keeps its sentences within it. Every synthesis gets a `request_id` (`requestId`) from the SDK, which the job saved for it carries too (see [Jobs](jobs.md#jobs-from-streams)).

`speak_stream()` yields only audio chunks. Their sample rate is the session's `tts.sample_rate` (`sampleRate`): the rate of the latest synthesis to start, set before the first chunk of each sentence is delivered. Read it when the first chunk arrives, as you would `synth.sample_rate`.

### Cancel and barge-in

| Call | Stops |
|---|---|
| `synth.cancel()` | That synthesis, running or queued. |
| `tts.cancel()` | The running synthesis. Queued ones still play afterwards. |
| `tts.interrupt()` | The running synthesis and everything queued: barge-in. It also ends `speak_stream()`. |

Leaving the loop early cancels the synthesis in TypeScript (`break`), and so does cancelling the subscription to `audio` in Dart. In Python, use `with tts.synthesize(...) as synth:`: leaving the block cancels it if it is still running.

The server stops at its next chunk boundary, so a few frames can still arrive after a cancel; the SDK drops them for you. **Stop your player and clear its buffer yourself, at once**, or the listener hears the rest of what was buffered. A voice agent that hears the user start talking does both:

**Python**

```python
import asyncio
from collections.abc import AsyncIterator

from echonova import AsyncEchoNova

voice_id = "..."  # a voice ID from voices.list()


async def llm_reply() -> AsyncIterator[str]:  # stands in for your model's streamed reply
    for delta in ["أهلاً بك! ", "كيف يمكنني ", "مساعدتك اليوم؟ ", "أنا هنا لخدمتك."]:
        yield delta


def play(pcm: bytes) -> None: ...  # write to your audio output


def stop_playback() -> None: ...  # discard what your player has buffered


async with AsyncEchoNova() as client, client.text_to_speech.connect(voice_id=voice_id) as tts:

    async def speak() -> None:
        async for pcm in tts.speak_stream(llm_reply()):  # sentence by sentence, in order
            play(pcm)

    speaking = asyncio.create_task(speak())
    await asyncio.sleep(1.5)  # ...until your voice activity detector hears the user
    await tts.interrupt()  # barge-in: stop speaking and drop the queued sentences
    stop_playback()
    await speaking  # speak_stream() ends after interrupt()
```

**TypeScript**

```ts
import { setTimeout as sleep } from 'node:timers/promises';
import EchoNova from '@echonova/ai';

const client = new EchoNova();
const voiceId = '...'; // a voice ID from voices.list()

async function* llmReply(): AsyncGenerator<string> {
  // stands in for your model's streamed reply
  for (const delta of ['أهلاً بك! ', 'كيف يمكنني ', 'مساعدتك اليوم؟ ', 'أنا هنا لخدمتك.']) yield delta;
}
function play(pcm: Uint8Array): void {} // write to your audio output
function stopPlayback(): void {} // discard what your player has buffered

await using tts = await client.textToSpeech.connect({ voiceId });
const speaking = (async () => {
  for await (const pcm of tts.speakStream(llmReply())) play(pcm); // sentence by sentence, in order
})();
await sleep(1500); // ...until your voice activity detector hears the user
tts.interrupt(); // barge-in: stop speaking and drop the queued sentences
stopPlayback();
await speaking; // speakStream() ends after interrupt()
```

**Dart**

```dart
import 'dart:typed_data';

import 'package:echonova_ai/echonova_ai.dart';

Stream<String> llmReply() async* {
  // stands in for your model's streamed reply
  for (final delta in ['أهلاً بك! ', 'كيف يمكنني ', 'مساعدتك اليوم؟ ', 'أنا هنا لخدمتك.']) {
    yield delta;
  }
}

void play(Uint8List pcm) {} // write to your audio output
void stopPlayback() {} // discard what your player has buffered

Future<void> main() async {
  final client = EchoNova();
  const voiceId = '...'; // a voice ID from voices.list()
  final tts = await client.textToSpeech.connect(voiceId: voiceId);

  final speaking = tts.speakStream(llmReply()).listen(play).asFuture<void>(); // in order
  await Future<void>.delayed(const Duration(milliseconds: 1500)); // ...until your VAD hears the user
  tts.interrupt(); // barge-in: stop speaking and drop the queued sentences
  stopPlayback();
  await speaking; // speakStream() ends after interrupt()

  await tts.close();
  client.close();
}
```

### Audio format

- Audio is 16-bit signed little-endian mono PCM, with no header, at the sample rate the server announces in its `start` event. `synth.sample_rate` (`sampleRate`) holds it from then on (it is set before the first chunk is delivered); for `speak_stream()`, the session's `tts.sample_rate` does. The API docs give 24 kHz today but ask you to read it rather than hard-code it: a player at another rate plays too fast, too slow or as noise.
- Audio is generated a few seconds of speech at a time, so it arrives in bursts. Give your player a small buffer, a few hundred milliseconds, so it doesn't run dry between bursts.
- To keep the audio, `synth.collect()` returns it all as `Audio`, which writes a WAV file (`to_wav()`, `toWav()`). To write a WAV file while it streams, use `echonova.audio.WavWriter` in Python, `wavHeader()` from `@echonova/ai/streaming` in TypeScript, or `wavStream()` in Dart.
- The stream can't send MP3 or Opus: encode the PCM yourself, or use `generate()` for a WAV file.

### Keepalive, reconnects and rotation

- **Keepalive.** The SDK sends a ping whenever it has sent nothing for 30 seconds, which keeps a quiet socket inside the server's idle timeout. It treats the connection as lost when a ping gets no answer within 15 seconds or nothing at all arrives for 60 seconds, and raises `StreamConnectionLostError`. The client's `stream_keepalive` option changes the interval (`stream: { keepalive }` in TypeScript, `streamKeepalive` in Dart); `None` (`null`) turns keepalive and these checks off.
- **Reconnects.** When a socket closes in a way that allows it (a server restart, the session's time limit, an idle timeout or a dropped connection), the session reconnects on the next `synthesize()` or `enqueue()`; nothing reconnects while you aren't speaking. A close that means you must act first, such as running out of credits, ends the session with an error.
- **Rotation.** Sessions have a maximum length. Shortly before it, the session closes its socket once it is idle and opens a new one when you next speak, so it never holds two of your stream slots.
- **Nothing that may have been charged is sent twice.** If the socket closes while a synthesis is in flight, the synthesis fails (with `StreamConnectionLostError` when the connection dropped, `ServerRestartingError` when the server restarted) and says whether it was charged: `charge_state` (`chargeState`) is `"yes"` when its audio had started, `"unknown"` when it was sent but nothing came back for it, and `"no"` when it was never sent. The SDK never resends a synthesis that was sent, since it may have started and been charged: you decide. Texts still queued and never sent are sent normally after the reconnect. The one automatic resend: when the speech service fails a synthesis before its audio started, it never started, so the SDK sends it once more.

**Python**

```python
from echonova import EchoNova, StreamConnectionLostError

client = EchoNova()
voice_id = "..."  # a voice ID from voices.list()
text = "شكراً لاتصالك، سنعود إليك قريباً."

with client.text_to_speech.connect(voice_id=voice_id) as tts:
    synth = tts.synthesize(text)
    try:
        audio = synth.collect()
    except StreamConnectionLostError:
        if synth.charge_state == "no":  # never sent, so never charged: safe to send again
            audio = tts.synthesize(text).collect()
        else:  # "yes" or "unknown": it was (or may have been) charged, so decide before resending
            raise
```

**TypeScript**

```ts
import EchoNova, { StreamConnectionLostError } from '@echonova/ai';

const client = new EchoNova();
const voiceId = '...'; // a voice ID from voices.list()
const text = 'شكراً لاتصالك، سنعود إليك قريباً.';

await using tts = await client.textToSpeech.connect({ voiceId });
const synth = tts.synthesize(text);
try {
  const audio = await synth.collect();
} catch (err) {
  if (!(err instanceof StreamConnectionLostError)) throw err;
  if (synth.chargeState === 'no') {
    const audio = await tts.synthesize(text).collect(); // never sent, so never charged: safe to send again
  } else {
    throw err; // 'yes' or 'unknown': it was (or may have been) charged, so decide before resending
  }
}
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();
const voiceId = '...'; // a voice ID from voices.list()
const text = 'شكراً لاتصالك، سنعود إليك قريباً.';

final tts = await client.textToSpeech.connect(voiceId: voiceId);
final synthesis = tts.synthesize(text);
try {
  final audio = await synthesis.collect();
} on StreamConnectionLostException {
  if (synthesis.chargeState == ChargeState.no) {
    // Never sent, so never charged: safe to send again.
    final audio = await tts.synthesize(text).collect();
  } else {
    rethrow; // yes or unknown: it was (or may have been) charged, so decide before resending
  }
}
await tts.close();
client.close();
```

Other failures raise the matching error from iteration and from `result()`: `InvalidRequestError` for a text the server rejects (the session stays open), `VoiceNotFoundError`, and `InsufficientBalanceError` or `SpendingLimitError` when the workspace or the key runs out (these end the session). See [Errors](errors.md).

### Billing

As the [API docs](https://echonova.ai/docs/developers/tts-streaming#billing) describe it:

- A synthesis is charged per character of its text, at the same rate as the other Text to Speech calls, when it starts: before its first audio.
- A synthesis that stops after its audio started (a cancel, a newer synthesis replacing it, the socket closing, or a failure of the speech service midway) costs only the share of the audio that was sent, at least 1 credit, and the rest is refunded.
- One that fails before any audio is sent is refunded in full. One cancelled before it was charged costs nothing.
- The key's Credit Limit applies to every synthesis.

In the SDK, `result.credits_consumed` (`creditsConsumed`) is the final cost the server reported. `result.charged` is true when the synthesis was billed, false when it was cancelled before it was charged, and unknown (`None`, `null`) when the SDK had to end it itself before its audio started. For a synthesis that failed after its audio started, the final cost is on its error in Python (`credits_consumed`) and on the synthesis in TypeScript and Dart (`creditsConsumed`).

## Speech to Text

### Connect

`speech_to_text.connect()` opens a session and returns once the server has started it (and confirmed your terminology, when you give one), so setup errors are raised right there.

- `sample_rate` (`sampleRate`) is required, and has no default: it must be the rate of the audio you send. A wrong rate raises no error; it produces wrong transcripts. The stream accepts a range of rates (see the [reference](https://echonova.ai/docs/reference/stt-stream)); 16 kHz is enough for speech, and 8 kHz suits telephone audio.
- `language` is `ar` (Arabic, and mixed Arabic and English) or `en` (speech that is all English).
- The session's `session_id` (`sessionId`) identifies it if you contact support, and `job_id` (`jobId`) is the ID of the Speech to Text job it is saved as.

### Send audio

Send 16-bit little-endian mono PCM with no file header, at the rate you declared. Decode compressed audio and mix stereo down to mono first.

- `send_audio()` (`sendAudio`) copies the audio and sends it in frames of about 100 ms, never larger than the API's frame limit and never splitting a sample. It waits while the socket's send buffer is full.
- `feed_from(source)` (`feedFrom`) sends everything from a source (an iterable of chunks, an async iterable, a stream) and then calls `stop()`. It runs alongside your loop over the events and gives you the session summary.
- Send live audio as it is captured. When you send a recording, pace it at real time, about 100 ms of audio every 100 ms, as the API docs advise. (For a recording, an upload costs less; see [Speech to Text](speech-to-text.md).)

### End segments

Transcripts come per segment, and each is final: there are no partial results while someone is still speaking. A segment ends when you call `end_segment()` (`endSegment`), or after 15 seconds of audio if you don't. Where segments end decides how soon you see text and how well it reads:

- Detect pauses on your side, with a voice activity detector, and end the segment when the speaker has been silent for 300 to 700 ms. Each transcript is then one sentence or turn. In a voice agent, end it as soon as your turn detection decides the caller has finished.
- Don't end segments on a fixed timer: short segments lose context, and each segment is charged separately, rounded to a whole credit.

`end_segment()` returns a mark with where the cut fell, in seconds of audio sent in this session.

### Read the events

Iterate the session for its events (`stt.events` in Dart). Keep sending and reading at the same time: a transcript can arrive while you send the next segment's audio.

| Event | What it is |
|---|---|
| `Transcript` | The final text of one segment, with its duration, its credits and, while terminology is set, its corrections. The text is empty when the segment held no speech. |
| `TerminologySet` | The server accepted new terminology. |
| `StreamErrorEvent` | A non-fatal error, such as one segment failing. The session continues. |
| `SessionEnded` | The session ended: the reason, the total seconds and credits. |
| `SessionSaved` | Whether the session was kept as a job: `saved`, `empty` (nothing was transcribed) or `failed`. |
| `UnknownEvent` | An event this SDK version doesn't know yet. It is kept, never raised. |

`stt.transcripts()` (a `transcripts` stream in Dart) yields only the transcripts. If a session ends abnormally, iteration first delivers every event already received, then raises: transcripts that were sent, and charged, are never lost.

### Terminology

Give `terminology` to `connect()`, or call `set_terminology()` (`setTerminology`) at any time; it applies to every segment after it, and the SDK waits for the server to confirm. Pass the full list each time (it replaces the previous one), or `None` (`null`) to clear it. Each transcript then carries the server's terminology report for its segment, with the corrected text. The terms work as in [Speech to Text](speech-to-text.md#terminology); in Dart, pass `Terminology(...).toJson()` to `setTerminology()`.

### Stop and the session summary

`stop()` sends the end of the audio and waits for the remaining transcripts, `session.ended` and, when the server sends it, `session.saved`. It returns the summary: the reason, the total seconds and credits, the `job_id` and the `saved_status` (`savedStatus`). `close()`, or leaving the `with` block, ends the session at once and discards audio not yet transcribed: call `stop()` first.

Every session is kept as a Speech to Text job, with its transcript segments and a recording of the audio you sent: get the job with the summary's `job_id` for its `audio_url`. A session that transcribed nothing (`empty`) isn't kept. If `session.saved` doesn't arrive in time, the summary's `job_id` and `saved_status` are empty; the session is still kept, unless nothing was transcribed, under the ID it announced when it started (`stt.job_id`, `jobId`).

**Python**

```python
import time
import wave
from collections.abc import Iterator

from echonova import EchoNova
from echonova.audio import iter_wav_pcm
from echonova.types.streaming import Transcript

client = EchoNova()

with wave.open("call.wav") as wav:  # a 16-bit mono PCM WAV file
    rate = wav.getframerate()


def live(path: str) -> Iterator[bytes]:
    """Stands in for a microphone: the file's audio, 100 ms at a time, in real time."""
    for chunk in iter_wav_pcm(path, chunk_bytes=rate // 10 * 2):
        yield chunk
        time.sleep(0.1)


with client.speech_to_text.connect(sample_rate=rate, language="ar") as stt:
    print("session", stt.session_id, "is saved as job", stt.job_id)
    sending = stt.feed_from(live("call.wav"))  # sends on a thread, then calls stop()
    for event in stt:  # ends with the session
        if isinstance(event, Transcript) and event.text:
            print(f"{event.index}: {event.text}")
    summary = sending.result()

print(summary.reason, summary.total_seconds, summary.credits_consumed)
if summary.saved_status == "saved" and summary.job_id:
    job = client.speech_to_text.jobs.get(summary.job_id)
    client.download(job.audio_url, to="call-recording.wav")  # the audio the session received
```

**TypeScript**

```ts
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import EchoNova from '@echonova/ai';
import { iterFrames, parseWav } from '@echonova/ai/streaming';

const client = new EchoNova();
const wav = parseWav(await readFile('call.wav')); // a 16-bit mono PCM WAV file

/** Stands in for a microphone: the file's audio, 100 ms at a time, in real time. */
async function* live(): AsyncGenerator<Uint8Array> {
  for (const frame of iterFrames(wav.pcm, wav.sampleRate)) {
    yield frame;
    await sleep(100);
  }
}

await using stt = await client.speechToText.connect({ sampleRate: wav.sampleRate, language: 'ar' });
console.log('session', stt.sessionId, 'is saved as job', stt.jobId);
const feeding = stt.feedFrom(live()); // sends the audio, then stop()
for await (const event of stt) {
  if (event.type === 'transcript' && event.text) console.log(`${event.index}: ${event.text}`);
}
const summary = await feeding;

console.log(summary.reason, summary.totalSeconds, summary.creditsConsumed);
if (summary.savedStatus === 'saved' && summary.jobId) {
  const job = await client.speechToText.jobs.get(summary.jobId);
  await client.download(job.audioUrl, { to: 'call-recording.wav' }); // the audio the session received
}
```

**Dart**

```dart
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();
final wav = parseWav(await File('call.wav').readAsBytes()); // a 16-bit mono PCM WAV file

/// Stands in for a microphone: the file's audio, 100 ms at a time, in real time.
Stream<List<int>> live() async* {
  for (final frame in pcmFrames(wav.pcm, wav.sampleRate)) {
    yield frame;
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
}

final stt = await client.speechToText.connect(sampleRate: wav.sampleRate, language: 'ar');
print('session ${stt.sessionId} is saved as job ${stt.jobId}');
final feeding = stt.feedFrom(live()); // sends the audio, then stop()
await for (final event in stt.events) {
  if (event is Transcript && event.text.isNotEmpty) print('${event.index}: ${event.text}');
}
final summary = await feeding;

print('${summary.reason} ${summary.totalSeconds} ${summary.creditsConsumed}');
final jobId = summary.jobId;
if (summary.savedStatus == SessionSaveStatus.saved && jobId != null) {
  final job = await client.speechToText.jobs.get(jobId);
  await client.downloadTo(job.audioUrl!, 'call-recording.wav'); // the audio the session received
}
client.close();
```

### Sessions don't reconnect; transcribe_stream does

A Speech to Text session is one server session: a new connection would be a different session, with a new ID, no terminology and no open segment. So a session never reconnects on its own. When it ends early, `session.ended` gives the reason, and the error you get says whether reconnecting makes sense (`ServerRestartingError`, `SessionExpiredError`, `UpstreamError` and `StreamConnectionLostError` do; `InsufficientBalanceError`, `SpendingLimitError` and `ProtocolError` don't). Audio sent after the last transcript you received was neither transcribed nor charged; keep the last few seconds on your side if you want to send them again on a new session.

For audio of any length, or a source that must survive a dropped connection, use `transcribe_stream()` (`transcribeStream`). It is built on the same public session calls:

- **Its own segment cuts.** It ends a segment every 14 seconds of audio (`segment_seconds`, `segmentSeconds`, or `segmentLength` in Dart), just under the server's automatic cut, so it always knows where each segment starts and ends. Fixed cuts can fall in the middle of a word: for conversation, where you can detect pauses, a session with your own `end_segment()` calls reads better.
- **Rollover past the session limit.** Shortly before a session's maximum length, it ends the segment, stops the session, waits for its last transcripts and opens a new one with the same terminology. Audio that arrives meanwhile is held and sent to the new session. It yields `Reconnected` with reason `rollover`, and it holds only one stream slot at a time.
- **Reconnects after a drop.** After a server restart, a dropped connection, a speech service failure or an expired session, it reconnects a limited number of times (`reconnect`, a `ReconnectPolicy`), sends the terminology again and replays the audio sent since the last cut. That audio never produced a transcript, so it wasn't charged. Segments that were cut but got no transcript are reported as `AudioDropped`, not resent.
- It never reconnects after running out of credits, reaching the spending limit, or a protocol error.
- Each session it opens is kept as a job of its own, and its `SessionSaved` is passed on with the transcripts.
- `realtime=True` (`realtime: true`) sends no faster than real time, to treat a recording like a live source.

**Python**

```python
from echonova import EchoNova
from echonova.audio import iter_wav_pcm
from echonova.types.streaming import AudioDropped, Reconnected, SessionSaved, Transcript

client = EchoNova()

events = client.speech_to_text.transcribe_stream(
    iter_wav_pcm("broadcast-16k.wav"),  # 16 kHz, 16-bit mono PCM, of any length
    sample_rate=16_000,
    language="ar",
    realtime=True,  # paced like a live source
)
for event in events:
    if isinstance(event, Transcript) and event.text:
        print(event.text)
    elif isinstance(event, Reconnected):
        print("new session:", event.reason)  # rollover, or why the last one ended
    elif isinstance(event, AudioDropped):
        print(f"{event.seconds:.1f} s of audio got no transcript")
    elif isinstance(event, SessionSaved):
        print("session saved as job", event.job_id, event.status)
```

**TypeScript**

```ts
import { readFile } from 'node:fs/promises';
import EchoNova from '@echonova/ai';
import { iterFrames, parseWav } from '@echonova/ai/streaming';

const client = new EchoNova();
const wav = parseWav(await readFile('broadcast.wav')); // 16-bit mono PCM, of any length

const events = client.speechToText.transcribeStream(iterFrames(wav.pcm, wav.sampleRate), {
  sampleRate: wav.sampleRate,
  language: 'ar',
  realtime: true, // paced like a live source
});
for await (const event of events) {
  if (event.type === 'transcript' && event.text) console.log(event.text);
  else if (event.type === 'reconnected') console.log('new session:', event.reason); // rollover, or why the last one ended
  else if (event.type === 'audio.dropped') console.log(`${event.seconds.toFixed(1)} s of audio got no transcript`);
  else if (event.type === 'session.saved') console.log('session saved as job', event.jobId, event.status);
}
```

**Dart**

```dart
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();
final wav = parseWav(await File('broadcast.wav').readAsBytes()); // 16-bit mono PCM, of any length

final events = client.speechToText.transcribeStream(
  Stream.fromIterable(pcmFrames(wav.pcm, wav.sampleRate)),
  sampleRate: wav.sampleRate,
  language: 'ar',
  realtime: true, // paced like a live source
);
await for (final event in events) {
  switch (event) {
    case Transcript(:final text) when text.isNotEmpty:
      print(text);
    case Reconnected(:final reason):
      print('new session: $reason'); // rollover, or why the last one ended
    case AudioDropped(:final duration):
      print('${duration.inMilliseconds / 1000} s of audio got no transcript');
    case SessionSaved(:final jobId, :final status):
      print('session saved as job $jobId ${status.name}');
    case Transcript() || StreamErrorEvent() || UnknownEvent():
      break;
  }
}
client.close();
```

### Billing

As the [API docs](https://echonova.ai/docs/developers/stt-streaming#billing) describe it: the stream is charged at the Live Speech to Text rate, per second of audio. Each segment is charged when its transcript is sent, rounded to a whole credit. A segment with no speech comes back with empty text and isn't charged. The key's Credit Limit applies to every segment. Each `Transcript` carries its `credits_consumed` (`creditsConsumed`), and the summary carries the session's total.

## Limits

The API docs list these stream limits at the time of writing; check [Rate limits](https://echonova.ai/docs/developers/rate-limits#streams), [Stream speech as it is generated](https://echonova.ai/docs/developers/tts-streaming#limits) and [Transcribe live audio](https://echonova.ai/docs/developers/stt-streaming#limits) for the current values.

| Limit | Value |
|---|---|
| Concurrent streams | 10 open at once per workspace, Text to Speech and Speech to Text together |
| Connection attempts | 100 a minute per key, on each stream |
| Session length | 30 minutes for Text to Speech, 25 minutes for Speech to Text |
| Idle timeout | 120 seconds without any frame; a Speech to Text session also ends after 5 minutes without audio, pings or not |
| Speech to Text segment | 15 seconds; longer speech is cut and transcribed in parts |
| Text to Speech | One synthesis at a time per socket; the per-request character limit applies to each text |

- A stream holds its slot until its socket closes. Close sessions you no longer use, and send many texts over one Text to Speech session rather than opening one per text.
- The SDK handles the session limits for you where it can: Text to Speech sessions rotate their socket, and `transcribe_stream()` rolls over to a new session. An `SttSession` used directly ends at its limit with `SessionExpiredError`.

## Recipes

### Python: microphone to transcripts

With [sounddevice](https://python-sounddevice.readthedocs.io/): capture 16 kHz mono 16-bit audio, end a segment after half a second of silence, and stop when you press Enter. The energy gate is deliberately crude; use a real voice activity detector in production.

**Python**

```python
import asyncio
from array import array
from typing import Any

import sounddevice as sd  # pip install sounddevice

from echonova import AsyncEchoNova
from echonova.types.streaming import Transcript

RATE = 16_000  # Hz: plenty for speech


def loud(pcm: bytes, threshold: int = 500) -> bool:
    return max(map(abs, array("h", pcm)), default=0) > threshold


async def main() -> None:
    loop = asyncio.get_running_loop()
    microphone: asyncio.Queue[bytes] = asyncio.Queue()

    def on_audio(indata: Any, frames: int, time: Any, status: Any) -> None:  # runs on the audio thread
        loop.call_soon_threadsafe(microphone.put_nowait, bytes(indata))

    async with AsyncEchoNova() as client, client.speech_to_text.connect(sample_rate=RATE, language="ar") as stt:
        enter = asyncio.create_task(asyncio.to_thread(input, "Speak. Press Enter to stop.\n"))

        async def send() -> None:
            heard, quiet = False, 0
            with sd.RawInputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=RATE // 10, callback=on_audio):
                while not enter.done():
                    chunk = await microphone.get()  # 100 ms of audio
                    await stt.send_audio(chunk)
                    heard, quiet = (True, 0) if loud(chunk) else (heard, quiet + 1)
                    if heard and quiet == 5:  # 500 ms of silence after speech: transcribe it now
                        await stt.end_segment()
                        heard = False
            summary = await stt.stop()  # transcribes the rest, then ends the session
            print(f"{summary.total_seconds:.1f} s, {summary.credits_consumed} credits, job {summary.job_id}")

        sending = asyncio.create_task(send())
        async for event in stt:  # ends with the session
            if isinstance(event, Transcript) and event.text:
                print(event.text)
        await sending


asyncio.run(main())
```

### Python: play a synthesis

Open the output stream once the first chunk has arrived, at the rate the server announced. `write()` blocks while the device's buffer is full, which paces the loop. For barge-in, call `tts.interrupt()` and `player.abort()`, which drops what is buffered, instead of `player.stop()`, which plays it out.

**Python**

```python
import sounddevice as sd  # pip install sounddevice

from echonova import EchoNova

client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

with client.text_to_speech.connect(voice_id=voice_id) as tts:
    synth = tts.synthesize("أهلاً بك، كيف يمكنني مساعدتك اليوم؟")
    player = None
    for pcm in synth:
        if player is None:  # the rate is known from the first chunk on
            player = sd.RawOutputStream(samplerate=synth.sample_rate, channels=1, dtype="int16", latency=0.3)
            player.start()
        player.write(pcm)
    if player is not None:
        player.stop()  # plays out what is buffered
        player.close()
```

### Browser: through your proxy with an AudioWorklet

A web page can't hold the API key, and a browser can't send headers on a WebSocket. Run a proxy on your backend (the [reference proxies](../../proxy-examples/README.md) do this) and authenticate the stream with a cookie or a short-lived token in the URL: the client's `stream.query` option adds it to every connection. The reference proxies hand out such tokens from `POST <prefix>/stream-token`.

The page below captures the microphone with an AudioWorklet and streams it to Speech to Text, and plays Text to Speech audio with the Web Audio API. Browsers start an `AudioContext` only after a user gesture, so run this from a click handler.

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const proxy = 'https://api.example.com/echonova'; // your proxy, not api.echonova.ai

async function appToken(): Promise<string> {
  return '...'; // your app's own access token for the signed-in user
}

async function streamToken(): Promise<string> {
  const response = await fetch(`${proxy}/stream-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await appToken()}` },
  });
  const { token } = (await response.json()) as { token: string };
  return token;
}

const client = new EchoNova({
  baseURL: proxy,
  auth: async () => ({ Authorization: `Bearer ${await appToken()}` }), // REST calls
  stream: { query: async () => ({ access_token: await streamToken() }) }, // stream connections
});

const audioContext = new AudioContext();

// Microphone to Speech to Text. The worklet (pcm-capture.js, below) posts 16-bit PCM.
await audioContext.audioWorklet.addModule('/pcm-capture.js');
const microphone = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
const capture = new AudioWorkletNode(audioContext, 'pcm-capture');
audioContext.createMediaStreamSource(microphone).connect(capture);

// Declare the rate you send: the context's own rate, usually 44.1 or 48 kHz.
const stt = await client.speechToText.connect({ sampleRate: audioContext.sampleRate, language: 'ar' });
capture.port.onmessage = (message: MessageEvent<ArrayBuffer>) => {
  stt.sendAudio(message.data).catch(() => capture.disconnect()); // the session ended
};
// Call stt.endSegment() when your voice activity detector hears a pause, and stt.stop() at the end.
(async () => {
  for await (const transcript of stt.transcripts()) console.log(transcript.text);
})();

// Text to Speech to the speakers: schedule each chunk right after the previous one.
let playhead = 0;
const playing = new Set<AudioBufferSourceNode>();

function play(pcm: Uint8Array, sampleRate: number): void {
  if (pcm.byteLength < 2) return;
  const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const buffer = audioContext.createBuffer(1, pcm.byteLength >> 1, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < channel.length; i++) channel[i] = samples.getInt16(i * 2, true) / 32768;
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  playhead = Math.max(playhead, audioContext.currentTime + 0.2); // a small buffer against bursts
  source.start(playhead);
  playhead += buffer.duration;
  playing.add(source);
  source.onended = () => playing.delete(source);
}

function stopPlayback(): void {
  for (const source of playing) source.stop(); // barge-in: silence at once
  playing.clear();
  playhead = 0;
}

const tts = await client.textToSpeech.connect({ voiceId: '...' }); // a voice ID from voices.list()
const synth = tts.synthesize('أهلاً بك، كيف يمكنني مساعدتك اليوم؟');
for await (const pcm of synth) play(pcm, synth.sampleRate ?? audioContext.sampleRate);
// When the user starts talking over it: tts.interrupt(); stopPlayback();
```

The worklet runs on the audio thread. It turns the microphone's samples into 16-bit integers and posts about 100 ms at a time:

**JavaScript** (`pcm-capture.js`, served by your site)

```js
// pcm-capture.js
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(Math.round(sampleRate / 10)); // sampleRate: the context's, a worklet global
    this.length = 0;
  }

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) {
      for (const sample of samples) {
        this.chunk[this.length++] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
        if (this.length === this.chunk.length) {
          this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
          this.chunk = new Int16Array(this.chunk.length);
          this.length = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
```

### Flutter

Flutter apps use proxy mode: `EchoNova.proxy(baseUrl: ..., auth: ...)`, never an API key. On Android, iOS and desktop the `auth` headers go on the stream connections too; on Flutter web, authenticate streams with cookies or `streamQuery`, as in the browser above. The streaming calls are the same as in the Dart samples here. A complete app with microphone capture, transcripts and playback is in [`samples/flutter/`](../../samples/flutter/).

## See also

- [Text to Speech](text-to-speech.md) and [Speech to Text](speech-to-text.md): the REST calls, voices, options and terminology.
- [Errors](errors.md): every error, including the stream close codes.
- [Authentication](authentication.md#proxy-mode-for-web-and-mobile-apps): proxy mode for browsers and apps; [Configuration](configuration.md): client options.
