// Text to Speech over a stream: audio arrives while it is being generated,
// for voice apps and assistants.
//
// One stream serves many syntheses. Audio comes as 16-bit mono PCM chunks;
// here it is saved as WAV files, in an app it goes to a player.
//
// Run:
//
//     ECHONOVA_API_KEY=... dart run example/tts_stream.dart VOICE_ID
import 'dart:io';
import 'dart:typed_data';

import 'package:echonova/echonova.dart';

Future<void> main(List<String> args) async {
  if (args.isEmpty) {
    stderr.writeln('usage: dart run example/tts_stream.dart VOICE_ID');
    exitCode = 64;
    return;
  }
  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    final tts = await client.textToSpeech.connect(voiceId: args[0]);
    try {
      // One reply. Start playing the first chunk as soon as it arrives.
      final reply = tts.synthesize('مرحبا! كيف يمكنني مساعدتك اليوم؟');
      final pcm = BytesBuilder(copy: false);
      await for (final chunk in reply.audio) {
        pcm.add(chunk);
      }
      final result = await reply.result;
      final sampleRate = result.sampleRate!;
      stdout.writeln('first audio after ${reply.ttfb?.inMilliseconds} ms, '
          '${result.durationSeconds} s, ${result.creditsConsumed} credits');
      await File('reply.wav')
          .writeAsBytes(pcmToWav(pcm.takeBytes(), sampleRate));

      // Text that arrives in pieces, such as a language model's output:
      // speakStream cuts it into sentences and speaks them in order, as one
      // PCM stream. Call tts.interrupt() when the user starts talking.
      final deltas = Stream.fromIterable(
        ['أهلاً ', 'بك. ', 'هذه ', 'جملة ', 'ثانية.'],
      );
      final answer = File('answer.wav').openWrite();
      // speakStream's chunks don't say their sample rate; this assumes the
      // reply's, as it is the same voice.
      await answer.addStream(wavStream(tts.speakStream(deltas), sampleRate));
      await answer.close();
      stdout.writeln('saved reply.wav and answer.wav');
    } finally {
      await tts.close();
    }
  } finally {
    client.close();
  }
}
