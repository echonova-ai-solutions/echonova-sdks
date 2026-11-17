# Speech to Text

Turn recorded audio into a transcript, with speaker labels and your own terminology, and download it as text, subtitles or JSON. For live audio, see [Streaming](streaming.md). Every parameter, limit and error is in the [API reference](https://echonova.ai/docs/reference/stt-transcribe-sync).

## Pick a way to call it

| | `transcribe()` | `jobs.create()`, then `jobs.wait()` | Stream: `connect()` or `transcribe_stream()` |
|---|---|---|---|
| Input | A recorded file | A recorded file | Live 16-bit PCM audio |
| Result | The transcript, in the response | A job ID at once; the transcript once the job completes | A final transcript for each segment of speech, while the audio flows |
| Use it when | Short files, with someone waiting | Long files, batches, a `job.completed` webhook, or to learn why a file failed | Audio that doesn't exist as a file yet: a voice agent, live captions |

Both upload styles take the same files and cost the same. The stream is billed at the Live Speech to Text rate, which is higher: for a recording that is already on disk, upload it. See [Credits](https://echonova.ai/docs/developers/credits).

## Files and content types

What you can pass as the file:

- **Python:** a path, bytes, a binary file object, or `(filename, content)` / `(filename, content, content_type)`.
- **TypeScript:** a file path (Node.js, Bun, Deno), a `Blob` or `File`, bytes, a byte stream, or `toFile(content, name, { type })`.
- **Dart:** an `AudioFile`: `AudioFile.fromPath()` (not on the web), `AudioFile.fromBytes()` or `AudioFile.fromStream()`.

The API checks the upload's content type, which must be an audio type; it doesn't read the file name. The SDK sets the type from the file extension (mp3, wav, flac, ogg, opus, m4a, aac, webm, amr) or, failing that, from the file's first bytes. When it can't tell, it raises `UsageError` (`UsageException` in Dart) before sending anything: give the type yourself.

**Python**

```python
from pathlib import Path

from echonova import EchoNova

client = EchoNova()

result = client.speech_to_text.transcribe("call.mp3", language="ar")  # the type comes from the extension

note = Path("voice-note").read_bytes()  # no extension: name the type yourself
result = client.speech_to_text.transcribe(("voice-note.ogg", note, "audio/ogg"), language="ar")
```

**TypeScript**

```ts
import { readFile } from 'node:fs/promises';
import EchoNova, { toFile } from '@echonova/ai';

const client = new EchoNova();

let result = await client.speechToText.transcribe({ file: 'call.mp3', language: 'ar' }); // the type comes from the extension

const note = await readFile('voice-note'); // no extension: name the type yourself
result = await client.speechToText.transcribe({
  file: toFile(note, 'voice-note.ogg', { type: 'audio/ogg' }),
  language: 'ar',
});
```

**Dart**

```dart
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();

var result = await client.speechToText.transcribe(
  AudioFile.fromPath('call.mp3'), // the type comes from the extension
  language: 'ar',
);

final note = await File('voice-note').readAsBytes(); // no extension: name the type yourself
result = await client.speechToText.transcribe(
  AudioFile.fromBytes(note, 'voice-note.ogg', contentType: 'audio/ogg'),
  language: 'ar',
);
client.close();
```

A few things the API docs say about files:

- **What decodes:** WAV, FLAC, OGG (Opus) and MP3. Try a short file before you rely on another container, such as M4A or WebM.
- **A file that can't be decoded** passes the upload checks and fails afterwards, with the charge refunded. `transcribe()` then gets a 503 that the API documents as refunded: the SDK retries it like any refunded failure and finally raises `ServiceUnavailableError`, without the reason. A job fails instead, with the reason in its `error`, so use `jobs.create()` to find out why a file fails.
- **Duration and size** are limited per upload; the [reference](https://echonova.ai/docs/reference/stt-transcribe-sync) has the current limits.
- **Pricing** is per second of audio, worked out from the file's header before the job starts. A file without a readable duration is priced from its size, so upload files written by an encoder, with a complete header.

## Transcribe a file

`transcribe()` uploads the file and waits for the transcript. The options:

| Python | TypeScript and Dart | What it does |
|---|---|---|
| `language` | `language` | Optional. Leave it out (or pass `auto`) and the API detects Arabic or English. `ar` for Arabic and for mixed Arabic and English; `en` only for speech that is all English (Arabic sent as `en` comes back garbled). |
| `numbers_as_digits` | `numbersAsDigits` | Spoken Arabic numbers are written as digits by default (a phone number, a price). Pass `false` to keep them as they were said. English transcripts are never converted. |
| `identify_speakers` | `identifySpeakers` | Also return the transcript as timed segments, each with its speaker. It doesn't change the price. |
| `terminology` | `terminology` | Your names, products and acronyms, applied to a corrected copy of the transcript. Free. |

Options you leave out aren't sent, so the API's defaults apply.

`transcribe()` sends an idempotency key, so the SDK can retry it after a lost response or a server error without a second charge. A long file still processing after 220 seconds is waited for, and you get the transcript as usual. See [Errors](errors.md#idempotency-keys).

### Speakers

With `identify_speakers`, a completed job also has `segments` (each with `start` and `end` in seconds, `text` and `speaker`) and `speakers` (each with its `id` and talk time). Speakers are named `spk0`, `spk1` and so on, in the order they first speak; a segment's `speaker` is null (`None`) when it couldn't be given one. There are no word timestamps.

Speaker identification may not be available on every workspace yet, and some recordings can't be told apart. The transcript is complete either way, but `segments` is empty, so check `segments`, not `identify_speakers`, to know whether a job has speaker data.

**Python**

```python
from echonova import EchoNova

client = EchoNova()

result = client.speech_to_text.transcribe("call.mp3", language="ar", identify_speakers=True)
print(result.transcription)
for segment in result.segments or ():
    print(f"{segment.start:7.2f} {segment.end:7.2f}  {segment.speaker}: {segment.text}")
for speaker in result.speakers or ():
    print(speaker.id, speaker.talk_time)
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();

const result = await client.speechToText.transcribe({ file: 'call.mp3', language: 'ar', identifySpeakers: true });
console.log(result.transcription);
for (const segment of result.segments) {
  console.log(segment.start.toFixed(2), segment.end.toFixed(2), `${segment.speaker}: ${segment.text}`);
}
for (const speaker of result.speakers) console.log(speaker.id, speaker.talkTime);
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();

final result = await client.speechToText.transcribe(
  AudioFile.fromPath('call.mp3'),
  language: 'ar',
  identifySpeakers: true,
);
print(result.transcription);
for (final segment in result.segments ?? const <SttSegment>[]) {
  print('${segment.start} ${segment.end}  ${segment.speaker}: ${segment.text}');
}
for (final speaker in result.speakers ?? const <SttSpeaker>[]) {
  print('${speaker.id} ${speaker.talkTime}');
}
client.close();
```

### Terminology

The model writes what it hears, so a bank name or an acronym can come out spelled the way it sounds. Send your terms and the result carries a corrected copy of the transcript, with every change listed:

- `transcription` stays exactly as heard. The corrected text is in `terminology.corrected`, and `terminology.edits` lists each replacement with its character offsets into the text as heard.
- `near_misses` (`nearMisses`) lists close matches that were not applied. Show them to a person, and add the confirmed ones to that term's variants next time: nothing is remembered between requests, so send the full list every time.
- The text as heard is also in `terminology.raw` in TypeScript, `terminology.raw_text` in Python (`.raw` holds the JSON on every Python result) and `terminology.rawText` in Dart.
- Exports use the corrected text.

A keyword is a plain term, or a term with options: `variants` (spellings you have seen it misheard as), `blocked` (phrases that must never become it), `context_words` and `needs_context`. Their meaning and limits are on [Custom terminology](https://echonova.ai/docs/developers/stt-terminology).

**Python**

```python
from echonova import EchoNova

client = EchoNova()

result = client.speech_to_text.transcribe(
    "call.mp3",
    language="ar",
    terminology={
        "keywords": [
            "KYC",
            {"term": "Emirates NBD", "variants": ["امريتس ان بي دي"]},
            {"term": "SWIFT", "context_words": ["transfer", "تحويل"]},
        ]
    },
)
print(result.transcription)  # as heard
if result.terminology:
    print(result.terminology.corrected)  # spelled your way
    for edit in result.terminology.edits or ():
        print(edit.original, "->", edit.replacement, edit.stage)
```

**TypeScript**

```ts
import EchoNova from '@echonova/ai';

const client = new EchoNova();

const result = await client.speechToText.transcribe({
  file: 'call.mp3',
  language: 'ar',
  terminology: {
    keywords: [
      'KYC',
      { term: 'Emirates NBD', variants: ['امريتس ان بي دي'] },
      { term: 'SWIFT', context_words: ['transfer', 'تحويل'] },
    ],
  },
});
console.log(result.transcription); // as heard
if (result.terminology) {
  console.log(result.terminology.corrected); // spelled your way
  for (const edit of result.terminology.edits) console.log(edit.original, '->', edit.replacement, edit.stage);
}
```

**Dart**

```dart
import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();

final result = await client.speechToText.transcribe(
  AudioFile.fromPath('call.mp3'),
  language: 'ar',
  terminology: const Terminology([
    Keyword('KYC'),
    Keyword('Emirates NBD', variants: ['امريتس ان بي دي']),
    Keyword('SWIFT', contextWords: ['transfer', 'تحويل']),
  ]),
);
print(result.transcription); // as heard
final terminology = result.terminology;
if (terminology != null) {
  print(terminology.corrected); // spelled your way
  for (final edit in terminology.edits ?? const <TerminologyEdit>[]) {
    print('${edit.original} -> ${edit.replacement} ${edit.stage}');
  }
}
client.close();
```

## Async jobs and exports

`jobs.create()` takes the same file and options and returns as soon as the file is accepted. `jobs.wait()` polls every 5 seconds by default; a `job.completed` [webhook](webhooks.md) carries the transcription too, but not the segments or speakers, so get the job for those.

A completed job can be downloaded with `jobs.export()`:

| `format` | Python and TypeScript return | Dart |
|---|---|---|
| `txt` | The transcript, as a string | `export(format: ExportFormat.txt)` |
| `srt` | Subtitles, as a string. Each cue is prefixed with its speaker label when the job has speaker data; without it, the file is one cue for the whole recording. | `export(format: ExportFormat.srt)` |
| `json` | A `TranscriptExport`: the text, the speakers with their labels and talk time, and the timed segments | `exportJson()` |

`lang` sets the language of the speaker labels (`en`, the default, gives "Speaker 1"; `ar` gives "المتحدث 1"); it doesn't translate the transcript. Exporting a job that hasn't completed raises `InvalidRequestError`. Exports aren't charged.

**Python**

```python
from pathlib import Path

from echonova import EchoNova

client = EchoNova()

job = client.speech_to_text.jobs.create("meeting.wav", language="en", identify_speakers=True)
done = client.speech_to_text.jobs.wait(job)  # raises JobFailedError, with the reason, if it failed
print(done.transcription, done.duration_seconds)

srt = client.speech_to_text.jobs.export(done, format="srt", lang="en")
Path("meeting.srt").write_text(srt, encoding="utf-8")

data = client.speech_to_text.jobs.export(done, format="json")
for segment in data.segments or ():
    print(segment.speaker_label, segment.start, segment.text)
```

**TypeScript**

```ts
import { writeFile } from 'node:fs/promises';
import EchoNova from '@echonova/ai';

const client = new EchoNova();

const job = await client.speechToText.jobs.create({ file: 'meeting.wav', language: 'en', identifySpeakers: true });
const done = await client.speechToText.jobs.wait(job); // throws JobFailedError, with the reason, if it failed
console.log(done.transcription, done.durationSeconds);

const srt = await client.speechToText.jobs.export(done, { format: 'srt', lang: 'en' });
await writeFile('meeting.srt', srt);

const data = await client.speechToText.jobs.export(done, { format: 'json' });
for (const segment of data.segments ?? []) console.log(segment.speakerLabel, segment.start, segment.text);
```

**Dart**

```dart
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

final client = EchoNova();

final job = await client.speechToText.jobs.create(
  AudioFile.fromPath('meeting.wav'),
  language: 'en',
  identifySpeakers: true,
);
final done = await client.speechToText.jobs.wait(job.jobId); // throws JobFailedException if it failed
print('${done.transcription} ${done.durationSeconds}');

final srt = await client.speechToText.jobs.export(done.id, format: ExportFormat.srt, lang: 'en');
await File('meeting.srt').writeAsString(srt);

final data = await client.speechToText.jobs.exportJson(done.id);
for (final segment in data.segments ?? const <TranscriptExportSegment>[]) {
  print('${segment.speakerLabel} ${segment.start} ${segment.text}');
}
client.close();
```

The job's `duration_seconds` (`durationSeconds`) is an estimate while it runs and the measured length once it completes. To reconcile spend, use `credits_consumed`, which is what was charged. Waiting, webhooks, listing and deleting are in [Jobs](jobs.md).

## See also

- [Streaming](streaming.md): live transcription, segments, terminology on a stream and microphone recipes.
- [Jobs](jobs.md): waiting, webhooks, listing, deleting and downloads.
- [Errors](errors.md): what each error means and what to do.
- API docs: [formats and output](https://echonova.ai/docs/developers/stt-formats-and-output), [custom terminology](https://echonova.ai/docs/developers/stt-terminology), [export reference](https://echonova.ai/docs/reference/stt-export-job).
