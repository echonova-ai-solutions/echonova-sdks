// Text to Speech: pick a voice, synthesize a sentence, save the WAV.
//
// Run:
//
//     ECHONOVA_API_KEY=... dart run example/tts_generate.dart "أهلاً بك في إيكونوفا" speech.wav
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

Future<void> main(List<String> args) async {
  final text = args.isNotEmpty ? args[0] : 'أهلاً بك في إيكونوفا';
  final output = args.length > 1 ? args[1] : 'speech.wav';

  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    // The voices change rarely: in a real app, list them once and cache them.
    final voices = await client.textToSpeech.voices.list();
    final voice = voices.firstWhere(
      (v) => v.language == 'ar',
      orElse: () => voices.first,
    );

    final speech = await client.textToSpeech.generate(text, voiceId: voice.id);
    stdout.writeln('${speech.durationSeconds} s of audio, '
        '${speech.creditsConsumed} credits (request ${speech.requestId})');

    // The signed link expires: download it now. To get the audio again
    // later, use client.textToSpeech.jobs.download(speech.jobId).
    await client.downloadTo(speech.audioUrl!, output);
    stdout.writeln('saved $output');
  } finally {
    client.close();
  }
}
