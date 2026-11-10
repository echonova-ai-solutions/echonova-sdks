// Speech to Text: transcribe a file with your own terminology and speaker
// labels.
//
// Run:
//
//     ECHONOVA_API_KEY=... dart run example/stt_transcribe.dart call.mp3
import 'dart:io';

import 'package:echonova/echonova.dart';

Future<void> main(List<String> args) async {
  if (args.isEmpty) {
    stderr.writeln('usage: dart run example/stt_transcribe.dart AUDIO_FILE');
    exitCode = 64;
    return;
  }
  // Names and terms the transcript should spell your way.
  const terminology = Terminology([
    Keyword('KYC'),
    Keyword('Emirates NBD', variants: ['امريتس ان بي دي']),
  ]);

  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    final result = await client.speechToText.transcribe(
      AudioFile.fromPath(args[0]),
      language: 'ar', // ar also covers mixed Arabic and English
      identifySpeakers: true,
      terminology: terminology,
    );
    stdout.writeln(result.transcription);
    if (result.terminology?.corrected case final corrected?) {
      stdout.writeln('with your terms: $corrected');
    }
    for (final segment in result.segments ?? const <SttSegment>[]) {
      final start = (segment.start ?? 0).toStringAsFixed(2).padLeft(7);
      final speaker = (segment.speaker ?? '-').padLeft(6);
      stdout.writeln('$start  $speaker  ${segment.text}');
    }
    stdout.writeln('${result.creditsConsumed} credits '
        '(request ${result.requestId})');
  } finally {
    client.close();
  }
}
