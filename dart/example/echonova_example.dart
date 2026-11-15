// Text to Speech and Speech to Text with the EchoNova SDK, from server-side
// Dart. In a Flutter app, use EchoNova.proxy with your own backend instead:
// never ship an API key in an app.
//
// Run:
//
//     ECHONOVA_API_KEY=... dart run example/echonova_example.dart
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

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
