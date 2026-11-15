// Handle errors, including a request whose response was lost.
//
// A POST that was fully sent may have run, and been charged, even when no
// response arrived. The SDK never sends it again on its own; this shows how
// to check before you do.
//
// Run:
//
//     ECHONOVA_API_KEY=... dart run example/error_handling.dart VOICE_ID
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';

Future<void> main(List<String> args) async {
  if (args.isEmpty) {
    stderr.writeln('usage: dart run example/error_handling.dart VOICE_ID');
    exitCode = 64;
    return;
  }
  const text = 'مرحبا';
  final client = EchoNova(); // reads ECHONOVA_API_KEY
  try {
    final speech = await client.textToSpeech.generate(text, voiceId: args[0]);
    stdout.writeln('audio ready (request ${speech.requestId})');
  } on EchoNovaException catch (error) {
    exitCode = 1;
    // EchoNovaException is sealed: switch over the kinds you handle.
    switch (error) {
      case VoiceNotFoundException():
        stdout.writeln('no such voice; list the voices again');
      case InvalidRequestException(:final errorMessage, :final requestId):
        stdout.writeln('rejected: $errorMessage (request $requestId)');
      case SpendingLimitException():
        stdout.writeln('the key reached its Credit Limit; raise it in the '
            'portal');
      case InsufficientBalanceException():
        stdout.writeln('the workspace is out of credits');
      case RateLimitException(:final retryAfter):
        stdout.writeln('still rate limited after retries; try again in '
            '${retryAfter?.inSeconds ?? '?'} s');
      case APIConnectionException(mayHaveExecuted: false):
        stdout.writeln('the request did not run; it is safe to send it again');
      case APIConnectionException(:final sentAt):
        // It may have run. Look for the job it would have made.
        final candidates = sentAt == null
            ? const <TtsJob>[]
            : await client.textToSpeech.jobs.findCandidates(sentAt, text: text);
        stdout.writeln('no response, but ${candidates.length} matching '
            'job(s) exist; check them before sending it again');
      case APIStatusException(
          :final statusCode,
          :final errorMessage,
          :final requestId,
        ):
        stdout.writeln('$statusCode $errorMessage (request $requestId)');
      default:
        rethrow;
    }
  } finally {
    client.close();
  }
}
