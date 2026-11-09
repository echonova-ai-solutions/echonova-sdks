/// The browser WebSocket transport (`ws_web.dart`), compiled to JavaScript.
///
/// Runs on Node 22 or later, which has the browser `WebSocket` built in:
///
///     dart test -p node test/streaming/web_transport_test.dart
///
/// The mock server runs in the VM (a hybrid isolate).
@TestOn('node')
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/streaming/streaming.dart';
import 'package:test/test.dart';

void main() {
  late StreamIterator<Object?> replies;
  late void Function(Object?) send;
  late Uri proxy;

  setUp(() async {
    final channel = spawnHybridUri('web_server_hybrid.dart');
    replies = StreamIterator(channel.stream);
    send = channel.sink.add;
    addTearDown(channel.sink.close);
    await replies.moveNext();
    proxy = Uri.parse('ws://127.0.0.1:${replies.current}/echonova');
  });

  Future<Object?> ask(List<Object?> command) async {
    send(command);
    await replies.moveNext();
    return replies.current;
  }

  StreamOptions options() => StreamOptions(
        wsBaseUri: proxy,
        // A browser can't send these; the proxy reads the query instead.
        headers: () => {'Authorization': 'Bearer app-session'},
        query: () => {'token': 'short-lived'},
        closeTimeout: const Duration(seconds: 1),
      );

  test('Text to Speech through a proxy, authenticated by the query', () async {
    final tts = await connectTts(options(), voiceId: 'v1');
    addTearDown(tts.close);
    expect(tts.handshakeRequestId, isNull); // browsers hide it
    final synthesis = tts.synthesize('hello');
    final chunks = <Uint8List>[];
    await for (final chunk in synthesis.audio) {
      chunks.add(chunk);
    }
    expect(chunks, hasLength(3));
    expect(synthesis.sampleRate, 22050);
    final result = await synthesis.result;
    expect(result.outcome, SynthesisOutcome.completed);
    expect(result.creditsConsumed, 5);
    final attempts = await ask(['attempts']) as List<Object?>;
    final attempt = attempts.single! as Map<Object?, Object?>;
    expect(attempt['path'], '/echonova/v1/text-to-speech/stream');
    expect(attempt['query'], {'token': 'short-lived'});
    expect(attempt['authorization'], isNull); // headers are never sent
  });

  test('cancelling the audio subscription cancels the synthesis', () async {
    final tts = await connectTts(options(), voiceId: 'v1');
    addTearDown(tts.close);
    final synthesis = tts.synthesize('[slow] long text');
    await synthesis.audio.first;
    final result = await synthesis.result;
    expect(result.outcome, SynthesisOutcome.cancelled);
    expect(result.charged, isTrue);
  });

  test('Speech to Text through a proxy', () async {
    final stt = await connectStt(options(), sampleRate: 16000, language: 'ar');
    final events = stt.events.toList();
    await stt.sendAudio(Uint8List(16000));
    await stt.endSegment();
    final summary = await stt.stop();
    final received = await events;
    expect([
      for (final e in received)
        if (e is Transcript) e.text,
    ], [
      'segment 1',
    ]);
    expect(received.last, isA<SessionSaved>());
    expect(summary.savedStatus, SessionSaveStatus.saved);
    expect(summary.jobId, stt.jobId);
    final conns = await ask(['stt']) as List<Object?>;
    expect((conns.single! as Map<Object?, Object?>)['audio'], 16000);
  });

  test('a rejected handshake is a connection error with a hint', () async {
    // A browser can't tell a rejection from a network failure, so it is
    // retried like one: three attempts in all.
    for (var i = 0; i < 3; i++) {
      expect(await ask(['reject', 401, 'Unauthorized']), 'ok');
    }
    await expectLater(
      connectTts(options(), voiceId: 'v1'),
      throwsA(isA<APIConnectionException>()
          .having((e) => e.message, 'message', contains('Authorization'))
          .having((e) => e.message, 'message', contains('proxy'))),
    );
    final attempts = await ask(['attempts']) as List<Object?>;
    expect([
      for (final a in attempts) (a! as Map<Object?, Object?>)['rejected'],
    ], [
      401,
      401,
      401,
    ]);
  });

  test('the EchoNova API itself is refused in a browser', () async {
    await expectLater(
      connectTts(
        StreamOptions(wsBaseUri: Uri.parse('wss://api.echonova.ai')),
        voiceId: 'v1',
      ),
      throwsA(isA<UnsupportedEnvironmentException>()),
    );
  });
}
