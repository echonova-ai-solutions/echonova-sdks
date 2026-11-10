# Text to Speech

Turn text into speech in one of three ways: wait for a WAV file, start a job and collect the file later, or stream the audio while it is generated. This guide covers voices, the options, long text and downloading the audio. Every parameter, limit and error is in the [API reference](https://echonova.ai/docs/reference/tts-generate-sync).

## Pick a way to call it

| | `generate()` | `jobs.create()`, then `jobs.wait()` | Stream: `connect()` or `speak()` |
|---|---|---|---|
| What you get | A link to a WAV file, in the response | A job ID at once; the WAV link once the job completes | PCM audio chunks while the speech is generated |
| Use it when | Someone is waiting for a file: a chat reply, a prompt to play | Batches, clients with short timeouts, or when you want a `job.completed` webhook | Someone is listening right now: a voice agent, a phone call |
| Good to know | Diacritics (`tashkeel`) apply here | The API accepts `tashkeel` but reads the text as written, and cloned voices are refused | Many texts, one after another, on one socket; you can stop speaking midway |

All three charge the same for the same text: per character, spaces included. See [Credits](https://echonova.ai/docs/developers/credits). Every call creates a job, even `generate()`, so the result can be read back later (see [Jobs](jobs.md)). Streaming has its own guide: [Streaming](streaming.md).

## Voices

`voices.list()` returns every voice you can use, in one response. Each voice has an `id` (send it as the voice ID), `name`, a display name, `language` (`ar` or `en`) and `gender`. The voice also fixes the dialect, which the API doesn't report: see the voice cards in the portal.

The list changes rarely, so fetch it once (at start-up, or when you configure your app) and keep the ID you choose. A voice can be withdrawn; a request that names it then fails with `VoiceNotFoundError`. List the voices again when that happens.

**Python**

```python
from echonova import EchoNova, VoiceNotFoundError

client = EchoNova()

voices = client.text_to_speech.voices.list()  # every voice, in one call: keep it
arabic = [voice for voice in voices if voice.language == "ar"]
for voice in arabic:
    print(voice.id, voice.display_name, voice.gender)

try:
    speech = client.text_to_speech.generate("مرحبا", voice_id=arabic[0].id)
except VoiceNotFoundError:
    voices = client.text_to_speech.voices.list()  # the voice was withdrawn: choose again
```

**TypeScript**

```ts
import EchoNova, { VoiceNotFoundError } from 'echonova';

const client = new EchoNova();

let voices = await client.textToSpeech.voices.list(); // every voice, in one call: keep it
const arabic = voices.items.filter((voice) => voice.language === 'ar');
for (const voice of arabic) console.log(voice.id, voice.displayName, voice.gender);

try {
  await client.textToSpeech.generate({ text: 'مرحبا', voiceId: arabic[0]!.id });
} catch (err) {
  if (!(err instanceof VoiceNotFoundError)) throw err;
  voices = await client.textToSpeech.voices.list(); // the voice was withdrawn: choose again
}
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova();

var voices = await client.textToSpeech.voices.list(); // every voice, in one call: keep it
final arabic = voices.where((voice) => voice.language == 'ar').toList();
for (final voice in arabic) {
  print('${voice.id} ${voice.displayName} ${voice.gender}');
}

try {
  await client.textToSpeech.generate('مرحبا', voiceId: arabic.first.id);
} on VoiceNotFoundException {
  voices = await client.textToSpeech.voices.list(); // the voice was withdrawn: choose again
}
client.close();
```

## Generate speech

`generate()` waits for the audio and returns its link with the job ID, the duration and the credits charged. The link is signed and expires, so download the file soon (see [Download the audio](#download-the-audio)).

**Python**

```python
from echonova import EchoNova

client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

speech = client.text_to_speech.generate(
    "الطقس اليوم جميل والسماء صافية في المدينة",
    voice_id=voice_id,
    speed=1.1,
)
print(speech.job_id, speech.duration_seconds, speech.credits_consumed)
client.download(speech.audio_url, to="weather.wav")
```

**TypeScript**

```ts
import EchoNova from 'echonova';

const client = new EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

const speech = await client.textToSpeech.generate({
  text: 'الطقس اليوم جميل والسماء صافية في المدينة',
  voiceId,
  speed: 1.1,
});
console.log(speech.jobId, speech.durationSeconds, speech.creditsConsumed);
await client.download(speech.audioUrl, { to: 'weather.wav' });
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

final speech = await client.textToSpeech.generate(
  'الطقس اليوم جميل والسماء صافية في المدينة',
  voiceId: voiceId,
  speed: 1.1,
);
print('${speech.jobId} ${speech.durationSeconds} ${speech.creditsConsumed}');
await client.downloadTo(speech.audioUrl!, 'weather.wav');
client.close();
```

`generate()` is a paid POST, so the SDK never resends it once it may have reached the server. If the response is lost, the error says so (`may_have_executed`); see [Errors](errors.md).

## Options

Every way of calling Text to Speech takes the same options. Those you leave out aren't sent, so the API's defaults apply.

| Python | TypeScript and Dart | What it does |
|---|---|---|
| `speed` | `speed` | The reading pace: lower is slower, higher is faster. |
| `cfg` | `cfg` | How closely the voice follows the text. Leave it at the default unless you are comparing outputs in your own listening tests. |
| `num_steps` | `numSteps` | Diffusion steps: more are slower and cleaner. It takes one of a few fixed values, not any number. |
| `tashkeel` | `tashkeel` | Adds Arabic diacritics to the text before it is read. Fusha voices only; on other voices the text is read as written. The async job endpoint accepts it but doesn't apply it, so use `generate()` for diacritised speech. |
| `normalize` | `normalize` | Reads numbers, dates, times, money, units, URLs and e-mail addresses the way a speaker of the voice's dialect says them. On by default; pass `false` to read them as written. |

The ranges, allowed values and defaults are in the [reference](https://echonova.ai/docs/reference/tts-generate-sync) and on [Voices and options](https://echonova.ai/docs/developers/tts-voices-and-options). The SDK doesn't check them itself, so that a change on the server never makes it reject a valid request: a value out of range comes back as `InvalidRequestError` with the API's own message.

On a stream, the options you give `connect()` apply to every synthesis on it, and each `synthesize()` can override them, the voice included.

## Async jobs

`jobs.create()` returns as soon as the job is accepted. Wait for it with `jobs.wait()`, which polls every 3 seconds by default, or let a `job.completed` [webhook](webhooks.md) tell you. Cloned voices work with `generate()` only.

**Python**

```python
from echonova import EchoNova

client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()

job = client.text_to_speech.jobs.create("مرحبا بكم في إيكونوفا", voice_id=voice_id)
print(job.job_id, job.status)  # keep the ID: everything after this is a GET

done = client.text_to_speech.jobs.wait(job)  # raises JobFailedError if the job failed
client.text_to_speech.jobs.download(done, to="welcome.wav")  # gets a fresh link first
```

**TypeScript**

```ts
import EchoNova from 'echonova';

const client = new EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

const job = await client.textToSpeech.jobs.create({ text: 'مرحبا بكم في إيكونوفا', voiceId });
console.log(job.jobId, job.status); // keep the ID: everything after this is a GET

const done = await client.textToSpeech.jobs.wait(job); // throws JobFailedError if the job failed
await client.textToSpeech.jobs.download(done, { to: 'welcome.wav' }); // gets a fresh link first
```

**Dart**

```dart
import 'package:echonova/echonova.dart';

final client = EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()

final job = await client.textToSpeech.jobs.create('مرحبا بكم في إيكونوفا', voiceId: voiceId);
print('${job.jobId} ${job.status.value}'); // keep the ID: everything after this is a GET

final done = await client.textToSpeech.jobs.wait(job.jobId); // throws JobFailedException if it failed
await client.textToSpeech.jobs.downloadTo(done.id, 'welcome.wav'); // gets a fresh link first
client.close();
```

Polling intervals, timeouts, webhooks, listing and deleting are in [Jobs](jobs.md).

## Long text

Each request takes a limited number of characters (500 at the time of writing; the [reference](https://echonova.ai/docs/reference/tts-generate-sync) has the current limit), and the SDK doesn't cut text for you on REST. Split long text at sentence ends, never in the middle of a word, so each piece keeps its natural rhythm.

You can send each piece to `generate()` or `jobs.create()` and keep one file per piece. For one continuous recording, queue the pieces on a stream with `enqueue()`: they are spoken one after another, and each comes back as PCM audio with its sample rate. `speak_stream(long_text)` (`speakStream`) would split the text for you, with the rate in the session's `sample_rate` (`sampleRate`), but it sends one request per sentence, and there can be a short pause between requests; pieces packed close to the limit mean fewer pauses.

**Python**

```python
import re
from pathlib import Path

from echonova import Audio, EchoNova


def split_text(text: str, limit: int = 500) -> list[str]:
    """Whole sentences, packed into pieces of at most `limit` characters."""
    pieces: list[str] = []
    current = ""
    for sentence in re.split(r"(?<=[.!?؟])\s+|\n+", text.strip()):
        sentence = sentence.strip()
        if not sentence:
            continue
        if current and len(current) + 1 + len(sentence) > limit:
            pieces.append(current)
            current = ""
        while len(sentence) > limit:  # one very long sentence: cut it at a space
            cut = sentence.rfind(" ", 0, limit + 1)
            cut = cut if cut > 0 else limit
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        current = f"{current} {sentence}".strip()
    if current:
        pieces.append(current)
    return pieces


client = EchoNova()
voice_id = "..."  # a voice ID from client.text_to_speech.voices.list()
long_text = Path("chapter.txt").read_text(encoding="utf-8")

with client.text_to_speech.connect(voice_id=voice_id) as tts:
    parts = [tts.enqueue(piece) for piece in split_text(long_text)]  # spoken in order
    audio = [part.collect() for part in parts]

Audio(b"".join(a.pcm for a in audio), audio[0].sample_rate).to_wav("chapter.wav")
```

**TypeScript**

```ts
import { readFile, writeFile } from 'node:fs/promises';
import EchoNova from 'echonova';
import { pcmToWav } from 'echonova/streaming';

/** Whole sentences, packed into pieces of at most `limit` characters. */
function splitText(text: string, limit = 500): string[] {
  const pieces: string[] = [];
  let current = '';
  for (let sentence of text.trim().split(/(?<=[.!?؟])\s+|\n+/)) {
    sentence = sentence.trim();
    if (!sentence) continue;
    if (current && current.length + 1 + sentence.length > limit) {
      pieces.push(current);
      current = '';
    }
    while (sentence.length > limit) {
      // one very long sentence: cut it at a space
      let cut = sentence.lastIndexOf(' ', limit);
      if (cut <= 0) cut = limit;
      pieces.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) pieces.push(current);
  return pieces;
}

const client = new EchoNova();
const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()
const longText = await readFile('chapter.txt', 'utf8');

await using tts = await client.textToSpeech.connect({ voiceId });
const parts = splitText(longText).map((piece) => tts.enqueue(piece)); // spoken in order
const audio = await Promise.all(parts.map((part) => part.collect()));

await writeFile('chapter.wav', pcmToWav(Buffer.concat(audio.map((a) => a.pcm)), audio[0]!.sampleRate));
```

**Dart**

```dart
import 'dart:io';
import 'dart:typed_data';

import 'package:echonova/echonova.dart';

/// Whole sentences, packed into pieces of at most [limit] characters.
List<String> splitText(String text, {int limit = 500}) {
  final pieces = <String>[];
  var current = '';
  for (var sentence in text.trim().split(RegExp(r'(?<=[.!?؟])\s+|\n+'))) {
    sentence = sentence.trim();
    if (sentence.isEmpty) continue;
    if (current.isNotEmpty && current.length + 1 + sentence.length > limit) {
      pieces.add(current);
      current = '';
    }
    while (sentence.length > limit) {
      // one very long sentence: cut it at a space
      var cut = sentence.lastIndexOf(' ', limit);
      if (cut <= 0) cut = limit;
      pieces.add(sentence.substring(0, cut).trim());
      sentence = sentence.substring(cut).trim();
    }
    current = current.isEmpty ? sentence : '$current $sentence';
  }
  if (current.isNotEmpty) pieces.add(current);
  return pieces;
}

Future<void> main() async {
  final client = EchoNova();
  const voiceId = '...'; // a voice ID from client.textToSpeech.voices.list()
  final longText = await File('chapter.txt').readAsString();

  final tts = await client.textToSpeech.connect(voiceId: voiceId);
  final parts = [for (final piece in splitText(longText)) tts.enqueue(piece)]; // spoken in order
  final audio = await Future.wait([for (final part in parts) part.collect()]);
  await tts.close();

  final pcm = BytesBuilder(copy: false);
  for (final a in audio) {
    pcm.add(a.pcm);
  }
  await File('chapter.wav').writeAsBytes(pcmToWav(pcm.takeBytes(), audio.first.sampleRate));
  client.close();
}
```

Streams are for servers: a browser or app reaches them only through your proxy (see [Streaming](streaming.md)). Each synthesis on a stream is also saved as a Text to Speech job.

## Download the audio

`audio_url` (`audioUrl`) is a signed link to a WAV file, and it expires. Download it when you get it, or get the job again later: every `jobs.get()` returns a fresh link, and `jobs.download()` does that for you.

- `client.download()` sends no API key: the link points at a storage host, not at EchoNova. It returns the bytes, or writes a file: with `to` in Python and TypeScript (a path, or an existing folder to keep the link's file name), and with `downloadTo()` in Dart (not on the web).
- An expired link raises `DownloadExpiredError` (`DownloadExpiredException` in Dart). Get the job again for a fresh one.
- The API produces WAV only. Convert it yourself if you need another format.
- Audio from a stream arrives as raw PCM. `Audio` turns it into a WAV file (`to_wav()` and `wav_bytes()` in Python, `toWav()` in TypeScript and Dart), and so does `pcmToWav()` in TypeScript and Dart.

**Python**

```python
from echonova import DownloadExpiredError, EchoNova

client = EchoNova()
job_id = "..."  # a Text to Speech job ID

job = client.text_to_speech.jobs.get(job_id)
try:
    wav = client.download(job.audio_url)  # bytes; or to="speech.wav", or to="a folder/"
except DownloadExpiredError:
    wav = client.text_to_speech.jobs.download(job_id)  # gets the job again for a fresh link
```

**TypeScript**

```ts
import EchoNova, { DownloadExpiredError } from 'echonova';

const client = new EchoNova();
const jobId = '...'; // a Text to Speech job ID

const job = await client.textToSpeech.jobs.get(jobId);
let wav: Uint8Array;
try {
  wav = await client.download(job.audioUrl); // bytes; or { to: 'speech.wav' } in Node.js, Bun and Deno
} catch (err) {
  if (!(err instanceof DownloadExpiredError)) throw err;
  wav = await client.textToSpeech.jobs.download(jobId); // gets the job again for a fresh link
}
```

**Dart**

```dart
import 'dart:typed_data';

import 'package:echonova/echonova.dart';

final client = EchoNova();
const jobId = '...'; // a Text to Speech job ID

final job = await client.textToSpeech.jobs.get(jobId);
Uint8List wav;
try {
  wav = await client.download(job.audioUrl!); // or client.downloadTo(url, 'speech.wav')
} on DownloadExpiredException {
  wav = await client.textToSpeech.jobs.download(jobId); // gets the job again for a fresh link
}
client.close();
```

## See also

- [Streaming](streaming.md): sessions, barge-in, playback and billing on the stream.
- [Jobs](jobs.md): waiting, webhooks, listing, deleting and downloads.
- [Errors](errors.md): what each error means and what to do.
- API reference: [generate speech](https://echonova.ai/docs/reference/tts-generate-sync), [async job](https://echonova.ai/docs/reference/tts-generate-async), [voices](https://echonova.ai/docs/reference/tts-list-voices).
