# EchoNova examples

<!-- The code below is example/echonova_example.dart; keep the two the same. pub.dev shows this file on the Example tab. -->

Text to Speech and Speech to Text from server-side Dart. In a Flutter app, use `EchoNova.proxy` with your own backend instead ([`proxy_mode.dart`](proxy_mode.dart)): never ship an API key in an app.

```dart
// Text to Speech and Speech to Text with the EchoNova SDK, from server-side
// Dart. In a Flutter app, use EchoNova.proxy with your own backend instead:
// never ship an API key in an app.
//
// Run:
//
//     ECHONOVA_API_KEY=... dart run example/echonova_example.dart
import 'dart:io';

import 'package:echonova/echonova.dart';

Future<void> main() async {
  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    // Voices change rarely: list them once and cache them.
    final voices = await client.textToSpeech.voices.list();
    final voice = voices.firstWhere(
      (v) => v.language == 'ar',
      orElse: () => voices.first,
    );
    stdout.writeln('voice: ${voice.displayName ?? voice.name} (${voice.id})');

    // Synthesize and download the WAV. The link expires: download it soon.
    final speech = await client.textToSpeech.generate(
      'مرحبا بكم في إيكونوفا',
      voiceId: voice.id,
    );
    final audio = await client.download(speech.audioUrl!);
    await File('speech.wav').writeAsBytes(audio);
    stdout.writeln('speech.wav: ${speech.durationSeconds} s, '
        '${speech.creditsConsumed} credits (request ${speech.requestId})');

    // Transcribe it back, as an async job.
    final job = await client.speechToText.jobs.create(
      AudioFile.fromBytes(audio, 'speech.wav'),
      language: 'ar',
    );
    final done = await client.speechToText.jobs.wait(job.jobId);
    stdout.writeln('transcript: ${done.transcription}');
    stdout.writeln(await client.speechToText.jobs
        .export(done.id, format: ExportFormat.srt));

    // Clean up.
    await client.speechToText.jobs.delete(done.id);
    await client.textToSpeech.jobs.delete(speech.jobId);
  } on APIConnectionException catch (error) {
    // The response was lost. When mayHaveExecuted is true, the request may
    // have run (and been charged): look before sending it again.
    stdout.writeln('no response: ${error.message}');
  } on EchoNovaException catch (error) {
    stdout.writeln('failed: $error');
    exitCode = 1;
  } finally {
    client.close();
  }
}
```

## More examples

Run them from the `dart/` folder of the repository. Most need a key in `ECHONOVA_API_KEY` (`proxy_mode.dart` needs your proxy instead); each file starts with its exact command.

| Example | What it shows |
| --- | --- |
| [`echonova_example.dart`](echonova_example.dart) | The example above: a voice, speech, a transcription job and an SRT export |
| [`tts_generate.dart`](tts_generate.dart) | Text to Speech: pick a voice, synthesize, save the WAV |
| [`tts_stream.dart`](tts_stream.dart) | Text to Speech over a stream: audio while it is generated, and `speakStream` for text that arrives in pieces |
| [`stt_transcribe.dart`](stt_transcribe.dart) | Speech to Text of a file, with terminology and speaker labels |
| [`stt_stream.dart`](stt_stream.dart) | Speech to Text over a stream: transcripts while the audio is still coming |
| [`sound_cleaning.dart`](sound_cleaning.dart) | Sound Cleaning: clean a recording, save it, delete the job |
| [`error_handling.dart`](error_handling.dart) | Handling each kind of error, and checking for a job when a response was lost |
| [`proxy_mode.dart`](proxy_mode.dart) | `EchoNova.proxy` for Flutter apps: your backend holds the key |
| [`agent_session.dart`](agent_session.dart) | Starting, checking and ending an agent session from your server |
