// Speech to Text over a stream: transcripts while the audio is still
// coming, for live captions and voice input.
//
// The stream takes 16-bit mono PCM. This reads it from a WAV file and sends
// it at the pace of real time, as a microphone would. For a long recording,
// use client.speechToText.transcribeStream instead: it moves to a new
// session before a session's time limit.
//
// Run:
//
//     ECHONOVA_API_KEY=... dart run example/stt_stream.dart speech.wav [ar|en]
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

Future<void> main(List<String> args) async {
  if (args.isEmpty) {
    stderr.writeln('usage: dart run example/stt_stream.dart MONO_16BIT.wav '
        '[ar|en]');
    exitCode = 64;
    return;
  }
  final audio = parseWav(await File(args[0]).readAsBytes());
  final language = args.length > 1 ? args[1] : 'ar';

  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    // The sample rate must be the audio's own: a wrong one gives wrong
    // transcripts without any error.
    final stt = await client.speechToText.connect(
      sampleRate: audio.sampleRate,
      language: language,
    );
    try {
      final printing = stt.transcripts.forEach((t) => stdout.writeln(t.text));

      for (final frame in pcmFrames(audio.pcm, audio.sampleRate)) {
        await stt.sendAudio(frame);
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
      // When the speaker pauses, stt.endSegment() gets that part's
      // transcript right away. stop() transcribes the rest and waits for it.
      final summary = await stt.stop();
      await printing;
      stdout.writeln('${summary.totalSeconds} s, '
          '${summary.creditsConsumed} credits; kept as job ${summary.jobId}');
    } finally {
      await stt.close();
    }
  } finally {
    client.close();
  }
}
