/// Speech to Text sessions against the mock server.
@TestOn('vm')
library;

import 'dart:async';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/core/pcm_framer.dart' show maxFrameBytes;
import 'package:echonova/src/streaming/streaming.dart';
import 'package:test/test.dart';

import 'helpers.dart';
import 'mock_server.dart';

/// Every event, then the error the stream ended with (if any).
Future<(List<SttEvent>, Object?)> drain(SttSession session) async {
  final events = <SttEvent>[];
  try {
    await for (final event in session.events) {
      events.add(event);
    }
  } on Object catch (error) {
    return (events, error);
  }
  return (events, null);
}

List<String> texts(List<Object> events) => [
      for (final e in events)
        if (e is Transcript) e.text
    ];

void main() {
  late MockServer server;
  late StreamOptions options;

  setUp(() async {
    server = await startServer();
    options = optionsFor(server);
  });

  Future<SttSession> open({
    int sampleRate = 16000,
    String language = 'ar',
    Map<String, Object?>? terminology,
  }) async {
    final session = await connectStt(
      options,
      sampleRate: sampleRate,
      language: language,
      terminology: terminology,
    );
    addTearDown(session.close);
    return session;
  }

  test('connect waits for session.started', () async {
    server.stt.startedDelay = const Duration(milliseconds: 200);
    final stt = await open();
    expect(stt.sessionId, server.sttConns[0].sessionId);
    expect(stt.jobId, server.sttConns[0].jobId);
    expect(stt.maxSessionSeconds, 1500);
    expect(stt.state, SttState.open);
    expect(stt.handshakeRequestId, startsWith('req-'));
    expect(server.sttConns[0].query, {
      'sample_rate': '16000',
      'language': 'ar',
      'encoding': 'pcm_s16le',
    });
  });

  test('transcribes segments and stops', () async {
    final stt = await open(language: 'en');
    final events = drain(stt);
    await stt.sendAudio(pcm(1));
    final first = await stt.endSegment();
    final empty = await stt.endSegment();
    await stt.sendAudio(pcm(0.02)); // 20 ms: too short for a transcript
    final short = await stt.endSegment();
    await stt.sendAudio(pcm(0.5));
    final summary = await stt.stop();
    final (received, error) = await events;
    expect(error, isNull);
    expect(first.index, 0);
    expect(first.audioOffset, const Duration(seconds: 1));
    expect(first.expectResult, isTrue);
    expect(empty.expectResult, isFalse);
    expect(short.expectResult, isFalse);
    expect(texts(received), ['segment 1', 'segment 2']);
    expect(
      [
        for (final e in received)
          if (e is Transcript) e.index
      ],
      [0, 1],
    );
    expect(
      received.skip(received.length - 2).map((e) => e.runtimeType),
      [SessionEnded, SessionSaved],
    );
    final jobId = server.sttConns[0].jobId;
    final saved = received.last as SessionSaved;
    expect(saved.jobId, jobId);
    expect(saved.status, SessionSaveStatus.saved);
    expect(saved.sessionId, stt.sessionId);
    expect(summary.reason, 'stopped');
    expect(summary.totalSeconds, 1.5);
    expect(summary.sessionId, stt.sessionId);
    expect(summary.jobId, jobId);
    expect(summary.savedStatus, SessionSaveStatus.saved);
    expect(stt.isClosed, isTrue);
    expect(stt.audioSent, const Duration(milliseconds: 1520));
  });

  test('a session with no transcript is saved as empty', () async {
    final stt = await open();
    final summary = await stt.stop();
    expect(summary.savedStatus, SessionSaveStatus.empty);
  });

  test('without session.saved, the summary has no job status', () async {
    server.stt.sendSaved = false;
    final stt = await open();
    await stt.sendAudio(pcm(0.2));
    final summary = await stt.stop();
    expect(summary.reason, 'stopped');
    expect(summary.jobId, isNull);
    expect(summary.savedStatus, isNull);
    expect(stt.jobId, server.sttConns[0].jobId); // from session.started
  });

  test('frames are split to fit the limit', () async {
    final stt = await open(sampleRate: 48000);
    final big = pcm(2, sampleRate: 48000); // 192 KB in one call
    await stt.sendAudio(big);
    await stt.stop();
    expect(server.sttConns[0].audio.toBytes(), big);
    await waitFor(() => server.sttConns[0].closeCode != null);
    // Never closed for a frame over 64 KiB.
    expect(server.sttConns[0].closeCode, 1000);
    expect(maxFrameBytes, 65536);
  });

  test('the caller can reuse its buffer', () async {
    final stt = await open();
    final buffer = pcm(0.25);
    final copy = List<int>.of(buffer);
    final sending = stt.sendAudio(buffer);
    buffer.fillRange(0, buffer.length, 0); // reused at once
    await sending;
    await stt.stop();
    expect(server.sttConns[0].audio.toBytes(), copy);
  });

  test('terminology at connect and later', () async {
    final stt = await open(terminology: {
      'keywords': ['KYC'],
    });
    final events = drain(stt);
    await stt.sendAudio(pcm(0.5));
    await stt.endSegment();
    final cleared = await stt.setTerminology(null);
    expect(cleared.active, isFalse);
    await expectLater(
      stt.setTerminology({'keywords': 'KYC'}),
      throwsA(isA<InvalidRequestException>()),
    );
    await stt.sendAudio(pcm(0.5));
    await stt.stop();
    final (received, _) = await events;
    final transcripts = received.whereType<Transcript>().toList();
    expect(transcripts[0].terminology, isNotNull);
    expect(transcripts[1].terminology, isNull);
    expect(server.sttConns[0].received.first, {
      'type': 'terminology',
      'terminology': {
        'keywords': ['KYC'],
      },
    });
  });

  test('an invalid terminology fails connect', () async {
    await expectLater(
      connectStt(
        options,
        sampleRate: 16000,
        language: 'ar',
        terminology: {'keywords': 'KYC'},
      ),
      throwsA(isA<InvalidRequestException>()
          .having((e) => e.errorMessage, 'errorMessage', contains('keywords'))),
    );
    await waitFor(() => server.sttConns[0].closeCode != null);
    // The SDK closed the half-configured session.
    expect(server.sttConns[0].closeCode, 1000);
  });

  test('an unreachable speech service fails connect', () async {
    server.stt.upstreamUnreachable = true;
    await expectLater(
      connectStt(options, sampleRate: 16000, language: 'ar'),
      throwsA(isA<UpstreamException>()
          .having((e) => e.errorMessage, 'errorMessage',
              'speech service unavailable')
          .having((e) => e.closeCode, 'closeCode', 1011)),
    );
  });

  test('no session.started in time is a timeout', () async {
    server.stt.startedDelay = const Duration(seconds: 2);
    options = optionsFor(
      server,
      sessionStartTimeout: const Duration(milliseconds: 200),
    );
    await expectLater(
      connectStt(options, sampleRate: 16000, language: 'ar'),
      throwsA(isA<APITimeoutException>()
          .having((e) => e.kind, 'kind', TimeoutKind.sessionStart)),
    );
  });

  test('a handshake rejection', () async {
    server.rejections.add(Rejection(
      403,
      'This API key does not have access to Speech-to-Text services',
    ));
    await expectLater(
      connectStt(options, sampleRate: 16000, language: 'ar'),
      throwsA(isA<PermissionDeniedException>()
          .having((e) => e.statusCode, 'statusCode', 403)),
    );
  });

  test('a bad sample rate fails before connecting', () {
    expect(
      () => connectStt(options, sampleRate: 0, language: 'ar'),
      throwsArgumentError,
    );
    expect(server.attempts, isEmpty);
  });

  for (final (reason, matcher) in [
    ('insufficient_balance', isA<InsufficientBalanceException>()),
    ('spending_limit', isA<SpendingLimitException>()),
    ('upstream_error', isA<UpstreamException>()),
  ]) {
    test('a fatal end ($reason) drains the events, then throws', () async {
      server.stt.failAfterSegments = (2, reason);
      final stt = await open();
      final events = drain(stt);
      for (var i = 0; i < 3; i++) {
        try {
          await stt.sendAudio(pcm(0.5));
          await stt.endSegment();
        } on EchoNovaException {
          break;
        }
      }
      final (received, error) = await events;
      // Paid for: never lost.
      expect(texts(received), ['segment 1', 'segment 2']);
      final ended = received[received.length - 2] as SessionEnded;
      expect(ended.reason, reason);
      final saved = received.last as SessionSaved;
      expect(saved.jobId, server.sttConns[0].jobId);
      expect(saved.status, SessionSaveStatus.saved);
      expect(error, matcher);
      await expectLater(stt.stop(), throwsA(matcher));
    });
  }

  test('a segment failure is a non-fatal event', () async {
    server.stt.segmentErrors = {1};
    final stt = await open();
    final events = drain(stt);
    await stt.sendAudio(pcm(0.5));
    await stt.endSegment();
    await stt.sendAudio(pcm(0.5));
    await stt.stop();
    final (received, error) = await events;
    expect(error, isNull);
    final first = received.first as StreamErrorEvent;
    expect(first.code, 'upstream_error');
    expect(first.error, isA<UpstreamException>());
    expect(texts(received), ['segment 2']);
  });

  test('max_duration is a normal end', () async {
    server.stt.enforceMaxDuration = const Duration(milliseconds: 200);
    final stt = await open();
    await stt.sendAudio(pcm(0.5));
    final (received, error) = await drain(stt);
    expect(error, isNull);
    expect(received.whereType<SessionEnded>().single.reason, 'max_duration');
    expect(received.last, isA<SessionSaved>());
    await expectLater(
      stt.sendAudio(pcm(0.1)),
      throwsA(isA<SessionEndedException>()
          .having((e) => e.message, 'message', contains('max_duration'))),
    );
    expect((await stt.stop()).reason, 'max_duration');
  });

  test('a dropped connection drains, then throws', () async {
    server.stt.actions.add(SttAction('abort', afterBytes: 20000));
    final stt = await open();
    final events = drain(stt);
    await stt.sendAudio(pcm(0.5));
    await stt.endSegment();
    await expectLater(
      () async {
        for (var i = 0; i < 20; i++) {
          await stt.sendAudio(pcm(0.1));
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
      }(),
      throwsA(anyOf(
        isA<StreamConnectionLostException>(),
        isA<SessionEndedException>(),
      )),
    );
    final (received, error) = await events;
    expect(texts(received), ['segment 1']);
    expect(error, isA<StreamConnectionLostException>());
    expect(stt.failure, isA<StreamConnectionLostException>());
  });

  test('stop() times out', () async {
    server.stt.drainDelay = const Duration(seconds: 1);
    final stt = await open();
    await stt.sendAudio(pcm(0.2));
    await expectLater(
      stt.stop(timeout: const Duration(milliseconds: 200)),
      throwsA(isA<APITimeoutException>()
          .having((e) => e.kind, 'kind', TimeoutKind.stopDrain)),
    );
  });

  test('close() without stop() discards the tail', () async {
    final stt = await open();
    await stt.sendAudio(pcm(0.2));
    await stt.close();
    expect(stt.isClosed, isTrue);
    expect(stt.failure, isNull); // the SDK's own close is not an error
    await expectLater(
      stt.sendAudio(pcm(0.1)),
      throwsA(isA<SessionEndedException>()),
    );
    expect(server.sttConns[0].received, isEmpty); // no stop was sent
  });

  test('feedFrom sends a source, then stops', () async {
    final stt = await open();
    final events = drain(stt);
    // An odd-length chunk: one byte carried, then dropped at the end.
    final summary = await stt.feedFrom(Stream.fromIterable([
      pcm(0.4).sublist(0, 9601),
      pcm(0.3),
    ]));
    final (received, error) = await events;
    expect(error, isNull);
    expect(summary.reason, 'stopped');
    expect(server.sttConns[0].audio.length, 9600 + 9600);
    expect(texts(received), ['segment 1']);
  });

  test('a microphone stream can be piped in', () async {
    final stt = await open();
    final events = drain(stt);
    final summary = await chunked(pcm(0.6), size: 1000).pipe(stt.audioSink);
    expect(summary, isA<SessionSummary>());
    final (received, _) = await events;
    expect(texts(received), ['segment 1']);
    expect(server.sttConns[0].audio.length, 19200);
  });

  test('transcripts filters the events', () async {
    final stt = await open();
    final transcripts = stt.transcripts.toList();
    await stt.sendAudio(pcm(0.5));
    await stt.endSegment();
    await stt.stop();
    expect([for (final t in await transcripts) t.text], ['segment 1']);
  });

  test('keepalive pings keep a quiet session open', () async {
    server.stt.idleTimeout = const Duration(milliseconds: 300);
    options = optionsFor(server, keepalive: const Duration(milliseconds: 50));
    final stt = await open();
    await Future<void>.delayed(const Duration(milliseconds: 700));
    expect(stt.isClosed, isFalse);
    expect(
      server.sttConns[0].received.where((f) => f['type'] == 'ping').length,
      greaterThanOrEqualTo(5),
    );
    await stt.stop();
  });
}
