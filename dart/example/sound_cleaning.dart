// Sound Cleaning: clean a recording, save the result, delete the job.
//
// Run:
//
//     ECHONOVA_API_KEY=... dart run example/sound_cleaning.dart noisy.wav clean.wav
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

Future<void> main(List<String> args) async {
  if (args.isEmpty) {
    stderr.writeln('usage: dart run example/sound_cleaning.dart IN [OUT]');
    exitCode = 64;
    return;
  }
  final output = args.length > 1 ? args[1] : 'clean.wav';

  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    final job = await client.soundCleaning.clean(
      AudioFile.fromPath(args[0]),
      targetLufs: -16,
      sampleRate: 48000,
      bitDepth: 24,
    );
    if (job.metrics case final metrics?) {
      stdout.writeln('loudness ${metrics.integratedLufs} LUFS, '
          'peak ${metrics.truePeakDbfs} dBFS');
    }
    await client.downloadTo(job.outputUrl!, output); // the link expires
    await client.soundCleaning.jobs.delete(job.id);
    stdout.writeln('saved $output (${job.creditsConsumed} credits)');
  } finally {
    client.close();
  }
}
