/// Text to Speech sessions against the mock server.
@TestOn('vm')
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/streaming/streaming.dart';
import 'package:test/test.dart';

import 'helpers.dart';
import 'mock_server.dart';

List<Map<String, Object?>> synthFrames(MockServer server, [int conn = 0]) => [
      for (final frame in server.ttsConns[conn].received)
        if (frame is Map<String, Object?> && frame['type'] == 'synthesize')
          frame,
    ];

List<Object?> frameTypes(MockServer server, [int conn = 0]) => [
      for (final frame in server.ttsConns[conn].received)
        if (frame is Map<String, Object?>) frame['type'],
    ];

Map<String, Object?>? sentFrame(MockServer server, String type, String rid) {
  for (final conn in server.ttsConns) {
    for (final frame in conn.sent) {
      if (frame['type'] == type && frame['requestId'] == rid) return frame;
    }
  }
  return null;
}

Future<TtsSession> open(MockServer server, [StreamOptions? options]) async {
  final tts = await connectTts(options ?? optionsFor(server), voiceId: 'v1');
  addTearDown(tts.close);
  return tts;
}

void main() {
  late MockServer server;

  setUp(() async {
    server = await startServer();
  });

  test('synthesize streams audio at the server sample rate', () async {
    final options = optionsFor(
      server,
      headers: () async => {'Authorization': 'Bearer ek_test'},
      userAgent: 'echonova-dart/test',
    );
    final tts = await open(server, options);
    expect(tts.isConnected, isTrue);
    expect(tts.handshakeRequestId, startsWith('req-'));
    final synthesis = tts.synthesize('hello', speed: 1.1);
    final chunks = <Uint8List>[];
    int? rateAtFirstChunk;
    await for (final chunk in synthesis.audio) {
      rateAtFirstChunk ??= synthesis.sampleRate;
      chunks.add(chunk);
    }
    expect(chunks, hasLength(3));
    expect(chunks.first, hasLength(960));
    expect(rateAtFirstChunk, 22050);
    final result = await synthesis.result;
    expect(result.outcome, SynthesisOutcome.completed);
    expect(result.charged, isTrue);
    expect(result.creditsConsumed, 5);
    expect(result.characters, 5);
    expect(result.sampleRate, 22050);
    expect(synthesis.ttfb, isNotNull);
    expect(synthesis.metrics.frames, 3);
    expect(synthesis.state, SynthesisState.completed);
    final frame = synthFrames(server).single;
    expect(frame, {
      'type': 'synthesize',
      'requestId': synthesis.requestId,
      'text': 'hello',
      'voiceId': 'v1',
      'speed': 1.1,
    });
    final attempt = server.attempts.single;
    expect(attempt.path, '/v1/text-to-speech/stream');
    expect(attempt.headers['authorization'], 'Bearer ek_test');
    expect(attempt.headers['user-agent'], 'echonova-dart/test');
  });

  test('a new synthesis supersedes the running one (barge-in)', () async {
    final tts = await open(server);
    final first = tts.synthesize('[slow] first');
    final firstChunks = <Uint8List>[];
    final firstAudio = first.audio.listen(firstChunks.add);
    await waitFor(() => firstChunks.isNotEmpty);
    final second = tts.synthesize('second');
    final result = await first.result;
    expect(result.outcome, SynthesisOutcome.superseded);
    expect(result.charged, isTrue);
    expect(result.creditsConsumed, greaterThanOrEqualTo(1));
    expect(
      result.creditsConsumed,
      sentFrame(server, 'cancelled', first.requestId)!['creditsConsumed'],
    );
    expect((await second.collect()).pcm, hasLength(3 * 960));
    expect((await second.result).outcome, SynthesisOutcome.completed);
    await firstAudio.cancel();
    // The server cancels the old one itself: no cancel frame.
    expect(frameTypes(server), isNot(contains('cancel')));
  });

  test('cancel() reports the outcome and the final cost', () async {
    final tts = await open(server);
    final synthesis = tts.synthesize('[slow] long text');
    final chunks = <Uint8List>[];
    synthesis.audio.listen(chunks.add);
    await waitFor(() => chunks.length >= 2);
    synthesis.cancel();
    final result = await synthesis.result;
    expect(result.outcome, SynthesisOutcome.cancelled);
    expect(result.charged, isTrue);
    expect(result.creditsConsumed, greaterThanOrEqualTo(1));
    expect(synthesis.chargeState, ChargeState.yes);
    expect(frameTypes(server).where((t) => t == 'cancel'), hasLength(1));
  });

  test('cancelling the audio subscription cancels the synthesis', () async {
    final tts = await open(server);
    final synthesis = tts.synthesize('[slow] long text');
    await synthesis.audio.first; // takes one chunk, then cancels
    final result = await synthesis.result;
    expect(result.outcome, SynthesisOutcome.cancelled);
    expect(result.charged, isTrue);
    expect(frameTypes(server), contains('cancel'));
  });

  test('a cancel before any audio is not charged', () async {
    server.tts.startDelay = const Duration(milliseconds: 300);
    final tts = await open(server);
    final synthesis = tts.synthesize('hello');
    await synthesis.whenSent;
    synthesis.cancel();
    final result = await synthesis.result;
    expect(result.outcome, SynthesisOutcome.cancelled);
    expect(result.charged, isFalse); // `cancelled` came without a cost
    expect(result.creditsConsumed, isNull);
    expect(synthesis.chargeState, ChargeState.no);
  });

  test('cancel() on a queued synthesis sends nothing', () async {
    final tts = await open(server);
    final running = tts.enqueue('one');
    final queued = tts.enqueue('two');
    queued.cancel();
    expect((await queued.result).charged, isFalse);
    await running.result;
    tts.cancel(); // nothing in flight: nothing sent
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(frameTypes(server), ['synthesize']);
  });

  test('enqueue plays in order, one at a time', () async {
    final tts = await open(server);
    final handles = [
      for (final text in ['one', 'two', 'three']) tts.enqueue(text)
    ];
    for (final handle in handles) {
      expect((await handle.result).outcome, SynthesisOutcome.completed);
    }
    expect([for (final f in synthFrames(server)) f['text']],
        ['one', 'two', 'three']);
  });

  group('speakStream', () {
    test('splits a string into sentences', () async {
      final tts = await open(server);
      final audio =
          await tts.speakStream('First one. Second one! مرحبا؟ ').toList();
      expect(
        [for (final f in synthFrames(server)) f['text']],
        ['First one.', 'Second one!', 'مرحبا؟'],
      );
      expect(audio, hasLength(9));
    });

    test('speaks LLM deltas from a stream', () async {
      final tts = await open(server);
      Stream<String> deltas() async* {
        for (final piece in ['Hel', 'lo world. How ', 'are you', '? Bye']) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          yield piece;
        }
      }

      final audio = await tts.speakStream(deltas()).toList();
      expect(
        [for (final f in synthFrames(server)) f['text']],
        ['Hello world.', 'How are you?', 'Bye'],
      );
      expect(audio, hasLength(9));
    });

    test('the session sample rate is known for every chunk', () async {
      final tts = await open(server);
      expect(tts.sampleRate, isNull); // no synthesis has started yet
      final rates = <int?>[];
      await for (final _ in tts.speakStream('First one. Second one.')) {
        rates.add(tts.sampleRate);
      }
      expect(rates, List.filled(6, 22050)); // set before each first chunk
      server.tts.sampleRate = 16000;
      final later = tts.synthesize('Later');
      await later.result;
      expect(later.sampleRate, 16000);
      expect(tts.sampleRate, 16000); // the most recent start
      await tts.close();
      expect(tts.sampleRate, 16000); // still readable after close
    });

    test('treats iterable items as whole texts', () async {
      final tts = await open(server);
      await tts.speakStream(['one', 'two. three']).drain<void>();
      expect(
        [for (final f in synthFrames(server)) f['text']],
        ['one', 'two.', 'three'],
      );
    });

    test('interrupt() ends it and drops the queue', () async {
      final tts = await open(server);
      final chunks = <Uint8List>[];
      final done = Completer<void>();
      tts
          .speakStream('[slow] one. [slow] two. [slow] three.')
          .listen(chunks.add, onDone: done.complete);
      await waitFor(() => chunks.length >= 2);
      tts.interrupt();
      await done.future.timeout(const Duration(seconds: 5));
      expect([for (final f in synthFrames(server)) f['text']], ['[slow] one.']);
      expect(frameTypes(server), contains('cancel'));
    });

    test('cancelling the subscription cancels what is left', () async {
      final tts = await open(server);
      await tts.speakStream('[slow] one. [slow] two.').first;
      await waitFor(() => frameTypes(server).contains('cancel'));
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect([for (final f in synthFrames(server)) f['text']], ['[slow] one.']);
    });
  });

  test('a pre-audio upstream_error is resent once', () async {
    final tts = await open(server);
    final synthesis = tts.synthesize('[upstream_pre] hello');
    expect((await synthesis.collect()).pcm, hasLength(3 * 960));
    expect((await synthesis.result).outcome, SynthesisOutcome.completed);
    final failing = tts.synthesize('[upstream_pre_always] hello');
    await expectLater(failing.result, throwsA(isA<UpstreamException>()));
    expect(failing.chargeState, ChargeState.no);
    final frames = synthFrames(server);
    // The same request, sent twice; the always-failing one twice too, never
    // more.
    expect(
      [for (final f in frames.take(2)) f['requestId']],
      [synthesis.requestId, synthesis.requestId],
    );
    expect(frames, hasLength(4));
  });

  test('a mid-stream upstream_error keeps the audio, then throws', () async {
    final tts = await open(server);
    final synthesis = tts.synthesize('[upstream_mid] text');
    final chunks = <Uint8List>[];
    Object? error;
    try {
      await for (final chunk in synthesis.audio) {
        chunks.add(chunk);
      }
    } on UpstreamException catch (e) {
      error = e;
    }
    expect(chunks, hasLength(1));
    expect(error, isA<UpstreamException>());
    expect(chargeStateOf(error!), ChargeState.yes);
    final reported =
        sentFrame(server, 'error', synthesis.requestId)!['creditsConsumed'];
    expect(reported, greaterThanOrEqualTo(1)); // the share of audio sent
    expect(creditsConsumedOf(error), reported);
    expect(synthesis.creditsConsumed, reported);
    expect(synthesis.charged, isTrue);
    await expectLater(synthesis.result, throwsA(same(error)));
    expect(synthFrames(server), hasLength(1)); // charged: never resent
  });

  test('a dropped connection loses the request and reconnects lazily',
      () async {
    final tts = await open(server);
    final synthesis = tts.synthesize('[drop] text');
    await expectLater(
      synthesis.collect(),
      throwsA(isA<StreamConnectionLostException>()),
    );
    expect(synthesis.state, SynthesisState.lost);
    expect(synthesis.chargeState, ChargeState.yes);
    await waitFor(() => !tts.isConnected);
    expect(server.ttsConns, hasLength(1));
    expect(
      (await tts.synthesize('again').result).outcome,
      SynthesisOutcome.completed,
    );
    expect(server.ttsConns, hasLength(2));
  });

  test('the server idle close is silent; the next request reconnects',
      () async {
    server.tts.idleTimeout = const Duration(milliseconds: 150);
    final tts = await open(server, optionsFor(server, keepalive: null));
    await waitFor(
      () => !tts.isConnected && server.ttsConns[0].closeCode != null,
    );
    expect(server.ttsConns[0].closeCode, 4008);
    expect(
      (await tts.synthesize('hello').result).outcome,
      SynthesisOutcome.completed,
    );
    expect(server.ttsConns, hasLength(2));
  });

  test('keepalive pings keep an idle socket open', () async {
    server.tts.idleTimeout = const Duration(milliseconds: 300);
    final tts = await open(
      server,
      optionsFor(server, keepalive: const Duration(milliseconds: 50)),
    );
    await Future<void>.delayed(const Duration(milliseconds: 800));
    expect(tts.isConnected, isTrue);
    expect(
      frameTypes(server).where((t) => t == 'ping').length,
      greaterThanOrEqualTo(5),
    );
    expect(
      (await tts.synthesize('hello').result).outcome,
      SynthesisOutcome.completed,
    );
    expect(server.ttsConns, hasLength(1));
  });

  test('no pong means the connection is lost', () async {
    server.tts.answerPings = false;
    final tts = await open(
      server,
      optionsFor(
        server,
        keepalive: const Duration(milliseconds: 50),
        pongTimeout: const Duration(milliseconds: 200),
      ),
    );
    final synthesis = tts.synthesize('[nostart] text');
    await expectLater(
      synthesis.result,
      throwsA(isA<StreamConnectionLostException>()
          .having((e) => e.message, 'message', contains('no pong'))),
    );
    // Sent, never started: probably charged, so never resent.
    expect(synthesis.chargeState, ChargeState.unknown);
    expect(synthFrames(server), hasLength(1));
  });

  test('silence means the connection is lost', () async {
    final tts = await open(
      server,
      optionsFor(
        server,
        keepalive: const Duration(seconds: 5),
        silenceTimeout: const Duration(milliseconds: 200),
      ),
    );
    final synthesis = tts.synthesize('[nostart] text');
    await expectLater(
      synthesis.result,
      throwsA(isA<StreamConnectionLostException>()
          .having((e) => e.message, 'message', contains('nothing received'))),
    );
  });

  test('a billing close fails the session', () async {
    final tts = await open(server);
    final synthesis = tts.synthesize('[close:4002] text');
    await expectLater(
      synthesis.result,
      throwsA(isA<InsufficientBalanceException>()
          .having((e) => e.closeCode, 'closeCode', 4002)),
    );
    expect(tts.failure, isA<InsufficientBalanceException>());
    expect(() => tts.synthesize('more'), throwsA(isA<SessionEndedException>()));
  });

  test('a protocol close is a protocol error', () async {
    final tts = await open(server);
    await expectLater(
      tts.synthesize('[close:1002] text').result,
      throwsA(isA<ProtocolException>()),
    );
  });

  test('a rejected synthesis leaves the server running, so the SDK cancels',
      () async {
    final tts = await open(server);
    final first = tts.synthesize('[slow] first');
    await first.audio.listen(null).asFuture<void>().timeout(
          const Duration(milliseconds: 100),
          onTimeout: () {},
        );
    final rejected = tts.synthesize('   ');
    await expectLater(rejected.result, throwsA(isA<InvalidRequestException>()));
    // Stopped, as the caller asked.
    expect((await first.result).outcome, SynthesisOutcome.superseded);
    expect(frameTypes(server).where((t) => t == 'cancel'), hasLength(1));
  });

  test('the server session limit mid-synthesis', () async {
    server.tts.maxDuration = const Duration(milliseconds: 300);
    final tts = await open(server);
    final synthesis = tts.synthesize('[slow] long');
    await expectLater(
      synthesis.collect(),
      throwsA(isA<SessionExpiredException>()),
    );
    expect(synthesis.state, SynthesisState.lost);
    expect(synthesis.chargeState, ChargeState.yes);
    expect(
      (await tts.synthesize('next').result).outcome,
      SynthesisOutcome.completed,
    );
    expect(server.ttsConns[0].closeCode, 4008);
  });

  test('whenSent completes once the request is sent', () async {
    final tts = await open(server);
    final synthesis = tts.synthesize('hello');
    await synthesis.whenSent;
    expect(
      synthesis.state,
      isIn([
        SynthesisState.sent,
        SynthesisState.streaming,
        SynthesisState.completed,
      ]),
    );
    await synthesis.result;
  });

  test('rejections are per request', () async {
    final tts = await open(server);
    await expectLater(
      tts.synthesize('hi', voiceId: 'missing').result,
      throwsA(isA<VoiceNotFoundException>()),
    );
    await expectLater(
      tts.synthesize('   ').result,
      throwsA(isA<InvalidRequestException>()),
    );
    expect(
      (await tts.synthesize('still fine').result).outcome,
      SynthesisOutcome.completed,
    );
  });

  test('an oversized frame throws before sending', () async {
    final tts = await open(server);
    expect(
      () => tts.synthesize('hi', extraBody: {'padding': 'x' * 70000}),
      throwsA(isA<UsageException>()),
    );
    await tts.close();
    expect(synthFrames(server), isEmpty);
  });

  test('an idle socket is rotated', () async {
    final tts = await open(
      server,
      optionsFor(server, rotateAfter: const Duration(milliseconds: 200)),
    );
    await waitFor(
      () => !tts.isConnected && server.ttsConns[0].closeCode != null,
    );
    // Closed by the SDK, before the server's limit.
    expect(server.ttsConns[0].closeCode, 1000);
    expect(
      (await tts.synthesize('hello').result).outcome,
      SynthesisOutcome.completed,
    );
    expect(server.ttsConns, hasLength(2));
  });

  test('rotation waits for the running synthesis', () async {
    server.tts
      ..frames = 10
      ..frameInterval = const Duration(milliseconds: 30);
    final tts = await open(
      server,
      optionsFor(server, rotateAfter: const Duration(milliseconds: 100)),
    );
    final synthesis = tts.synthesize('takes 0.3 s');
    expect((await synthesis.collect()).pcm, hasLength(10 * 960));
    expect((await synthesis.result).outcome, SynthesisOutcome.completed);
    await waitFor(
      () => !tts.isConnected && server.ttsConns[0].closeCode != null,
    );
    expect(server.ttsConns[0].closeCode, 1000);
    expect(server.ttsConns, hasLength(1));
  });

  test('the connection attempt limit', () async {
    final tts = await open(server, optionsFor(server, maxConnectAttempts: 1));
    await expectLater(
      tts.synthesize('[drop] x').result,
      throwsA(isA<StreamConnectionLostException>()),
    );
    final synthesis = tts.synthesize('needs a new socket');
    await expectLater(
      synthesis.result,
      throwsA(isA<APIConnectionException>().having(
        (e) => e.retryDisabledReason,
        'retryDisabledReason',
        'attempt_limit',
      )),
    );
    expect(synthesis.chargeState, ChargeState.no);
  });

  test('close() ends what is running as cancelled', () async {
    final tts = await open(server);
    final running = tts.synthesize('[slow] long');
    await running.audio.first.timeout(const Duration(seconds: 2));
    final queued = tts.enqueue('later');
    await tts.close();
    expect((await running.result).outcome, SynthesisOutcome.cancelled);
    expect((await queued.result).outcome, SynthesisOutcome.cancelled);
    expect(() => tts.synthesize('x'), throwsA(isA<SessionEndedException>()));
  });

  test('unknown events are kept', () async {
    final tts = await open(server);
    await tts.synthesize('hello').result;
    expect(tts.unknownEvents, isEmpty);
    expect(tts.droppedFrames, 0);
  });

  group('handshake', () {
    for (final (rejection, matcher) in [
      (Rejection(401, 'Unauthorized'), isA<AuthenticationException>()),
      (
        Rejection(402, 'Insufficient subscription balance'),
        isA<InsufficientBalanceException>()
      ),
      (
        Rejection(429, 'Monthly spending limit exhausted'),
        isA<SpendingLimitException>()
      ),
      (
        Rejection(429, 'Too many concurrent streams'),
        isA<ConcurrencyLimitException>()
      ),
      (
        Rejection(503, 'Streaming is not enabled'),
        isA<FeatureNotEnabledException>()
      ),
      (
        Rejection(
          429,
          'ThrottlerException: Too Many Requests',
          retryAfter: '120',
        ),
        isA<RateLimitException>()
      ),
    ]) {
      test('${rejection.status} "${rejection.message}" is not retried',
          () async {
        server.rejections.add(rejection);
        await expectLater(
          connectTts(optionsFor(server), voiceId: 'v1'),
          throwsA(allOf(
            matcher,
            isA<APIStatusException>()
                .having((e) => e.statusCode, 'statusCode', rejection.status)
                .having(
                    (e) => e.transport, 'transport', TransportKind.websocket)
                .having((e) => e.requestId, 'requestId', startsWith('req-')),
          )),
        );
        expect(server.attempts, hasLength(1));
      });
    }

    for (final rejection in [
      Rejection(429, 'ThrottlerException: Too Many Requests', retryAfter: '0'),
      Rejection(503, '<html>upstream busy</html>', jsonBody: false),
    ]) {
      test('${rejection.status} is retried', () async {
        server.rejections.add(rejection);
        final sleeps = <Duration>[];
        await open(server, optionsFor(server, sleeps: sleeps));
        expect(
          [for (final a in server.attempts) a.rejected],
          [rejection.status, null],
        );
        expect(sleeps, hasLength(1));
      });
    }

    test('waitForSlot retries concurrency rejections', () async {
      server.rejections.addAll(
        List.generate(3, (_) => Rejection(429, 'Too many concurrent streams')),
      );
      final tts = await connectTts(
        optionsFor(server, instantSleep: true),
        voiceId: 'v1',
        waitForSlot: const Duration(seconds: 5),
      );
      await tts.close();
      expect(
          [for (final a in server.attempts) a.rejected], [429, 429, 429, null]);
    });

    test('a reconnect after a dropped connection waits for a slot', () async {
      final sleeps = <Duration>[];
      final tts = await open(
        server,
        optionsFor(server, sleeps: sleeps, instantSleep: true),
      );
      await expectLater(
        tts.synthesize('[drop] x').result,
        throwsA(isA<StreamConnectionLostException>()),
      );
      // The dropped socket still holds its slot for a while.
      server.rejections.addAll(
        List.generate(2, (_) => Rejection(429, 'Too many concurrent streams')),
      );
      expect(
        (await tts.synthesize('again').result).outcome,
        SynthesisOutcome.completed,
      );
      expect([for (final a in server.attempts) a.rejected],
          [null, 429, 429, null]);
      expect(sleeps, hasLength(2));
    });

    test(
        'the query provider and an async headers provider reach the '
        'handshake', () async {
      var calls = 0;
      final tts = await open(
        server,
        optionsFor(
          server,
          headers: () async {
            calls += 1;
            return {'Authorization': 'Bearer app-token-$calls'};
          },
          query: () async => {'token': 'short-lived'},
        ),
      );
      await tts.synthesize('hello').result;
      final attempt = server.attempts.single;
      expect(attempt.headers['authorization'], 'Bearer app-token-1');
      expect(attempt.query, {'token': 'short-lived'});
    });
  });

  test('speak() returns all the audio over a stream of its own', () async {
    final audio = await speak(optionsFor(server), 'hello', voiceId: 'v1');
    expect(audio.sampleRate, 22050);
    expect(audio.pcm, hasLength(3 * 960));
    expect(audio.duration, const Duration(microseconds: 65306));
    await waitFor(() => server.ttsConns.single.closeCode != null);
    expect(server.ttsConns.single.closeCode, 1000);
  });
}
