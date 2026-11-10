/// transcribeStream: segmentation, rollover, reconnect with replay.
@TestOn('vm')
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/streaming/streaming.dart';
import 'package:test/test.dart';

import 'helpers.dart';
import 'mock_server.dart';

const ReconnectPolicy fast = ReconnectPolicy(
  initialDelay: Duration(milliseconds: 10),
);

/// 1 second of 16 kHz audio, in bytes.
const int segment = 32000;

const Duration oneSecond = Duration(seconds: 1);

/// Every event, then the error the stream ended with (if any).
Future<(List<TranscribeEvent>, Object?)> run(
  Stream<TranscribeEvent> stream,
) async {
  final events = <TranscribeEvent>[];
  try {
    await for (final event in stream) {
      events.add(event);
    }
  } on Object catch (error) {
    return (events, error);
  }
  return (events, null);
}

List<Transcript> transcripts(List<TranscribeEvent> events) =>
    events.whereType<Transcript>().toList();

List<Type> kinds(List<TranscribeEvent> events) =>
    [for (final e in events) e.runtimeType];

double seconds(List<TranscribeEvent> events) =>
    transcripts(events).fold(0, (sum, t) => sum + t.durationSeconds);

void main() {
  late MockServer server;

  setUp(() async {
    server = await startServer();
  });

  test('cuts its own segments', () async {
    final audio = pcm(3.5);
    final (events, error) = await run(transcribeStream(
      optionsFor(server),
      chunked(audio),
      sampleRate: 16000,
      language: 'ar',
      segmentLength: oneSecond,
    ));
    expect(error, isNull);
    expect(
      [for (final t in transcripts(events)) t.text],
      ['segment 1', 'segment 2', 'segment 3', 'segment 4'],
    );
    expect([for (final t in transcripts(events)) t.index], [0, 1, 2, 3]);
    final conn = server.sttConns.single;
    expect(conn.audio.toBytes(), audio);
    expect(
      [for (final f in conn.received) f['type']],
      [...List.filled(3, 'end_segment'), 'stop'],
    );
    final saved = events.last as SessionSaved;
    expect(saved.jobId, conn.jobId);
    expect(saved.status, SessionSaveStatus.saved);
  });

  test('a whole buffer as one chunk', () async {
    final audio = pcm(1.2);
    final (events, error) = await run(transcribeStream(
      optionsFor(server),
      Stream.value(audio),
      sampleRate: 16000,
      language: 'en',
      segmentLength: oneSecond,
    ));
    expect(error, isNull);
    expect(transcripts(events), hasLength(2));
    expect(server.sttConns.single.audio.toBytes(), audio);
  });

  test('rolls over before the session limit', () async {
    server.stt.maxSessionSeconds = 2;
    // Hand over 0.4 s into each session. A slow machine sends for longer and
    // rolls over more often, so the connection attempt limit (a separate
    // test) is lifted here.
    final options = optionsFor(
      server,
      rolloverMargin: const Duration(milliseconds: 1600),
      maxConnectAttempts: 1000,
    );
    final audio = pcm(2);
    final (events, error) = await run(transcribeStream(
      options,
      // 0.8 s of sending: at least one rollover.
      chunked(audio, delay: const Duration(milliseconds: 40)),
      sampleRate: 16000,
      language: 'ar',
      terminology: {
        'keywords': ['KYC'],
      },
      segmentLength: const Duration(seconds: 5),
      reconnect: fast,
    ));
    expect(error, isNull);
    final rollovers = events.whereType<Reconnected>().toList();
    expect(rollovers, isNotEmpty);
    expect(rollovers.every((r) => r.reason == 'rollover'), isTrue);
    expect(server.sttConns, hasLength(rollovers.length + 1));
    expect(events.whereType<AudioDropped>(), isEmpty);
    // Nothing lost, nothing sent twice.
    final sent = BytesBuilder();
    for (final conn in server.sttConns) {
      sent.add(conn.audio.toBytes());
    }
    expect(sent.toBytes(), audio);
    await waitFor(() => server.sttConns.every((c) => c.closeCode != null));
    for (final conn in server.sttConns) {
      expect(conn.received.first, {
        'type': 'terminology',
        'terminology': {
          'keywords': ['KYC'],
        },
      });
      expect(conn.closeCode, 1000); // each session stopped cleanly
    }
    expect(seconds(events), closeTo(2, 1e-9));
    expect(
      [for (final t in transcripts(events)) t.index],
      List.generate(transcripts(events).length, (i) => i),
    );
    // One job per session.
    expect(events.whereType<SessionSaved>(), hasLength(server.sttConns.length));
  });

  test('reconnects and replays only uncut audio', () async {
    // Half-way through segment 2.
    server.stt.actions.add(SttAction('abort', afterBytes: segment + 16000));
    final audio = pcm(3);
    final (events, error) = await run(transcribeStream(
      optionsFor(server),
      chunked(audio, delay: const Duration(milliseconds: 5)),
      sampleRate: 16000,
      language: 'ar',
      terminology: {
        'keywords': ['KYC'],
      },
      segmentLength: oneSecond,
      reconnect: fast,
    ));
    expect(error, isNull);
    expect(kinds(events).take(2), [Transcript, Reconnected]);
    final reconnected = events[1] as Reconnected;
    expect(reconnected.reason, 'connection_lost');
    expect(reconnected.attempt, 1);
    expect(reconnected.sessionId, server.sttConns[1].sessionId);
    final [first, second] = server.sttConns;
    // Replayed from the last cut, not from the start.
    expect(second.audio.toBytes(), audio.sublist(segment));
    expect(
      [...first.audio.toBytes().sublist(0, segment), ...second.audio.toBytes()],
      audio,
    );
    expect(second.received.first['type'], 'terminology'); // re-sent
    expect(seconds(events), closeTo(3, 1e-9));
  });

  test('cut segments without a result are reported as dropped', () async {
    server.stt.actions.add(SttAction('abort_on_cut', afterBytes: 2));
    final audio = pcm(3);
    final (events, error) = await run(transcribeStream(
      optionsFor(server),
      chunked(audio, delay: const Duration(milliseconds: 5)),
      sampleRate: 16000,
      language: 'ar',
      segmentLength: oneSecond,
      reconnect: fast,
    ));
    expect(error, isNull);
    final dropped = events.whereType<AudioDropped>().single;
    final mark = dropped.segmentMarks.single;
    expect(mark.index, 1);
    expect(mark.audioOffset, const Duration(seconds: 2));
    expect(mark.duration, oneSecond);
    expect(dropped.duration, oneSecond);
    expect(
      kinds(events).indexOf(AudioDropped),
      lessThan(kinds(events).indexOf(Reconnected)),
    );
    expect(server.sttConns[1].audio.toBytes(), audio.sublist(2 * segment));
    expect(seconds(events), closeTo(2, 1e-9));
  });

  for (final (kind, reason) in [
    ('restart', 'server_restarting'),
    ('upstream', 'upstream_error'),
  ]) {
    test('reconnects after a $reason close', () async {
      server.stt.actions.add(SttAction(kind, afterBytes: 8000));
      final (events, error) = await run(transcribeStream(
        optionsFor(server),
        chunked(pcm(1.5), delay: const Duration(milliseconds: 5)),
        sampleRate: 16000,
        language: 'ar',
        segmentLength: oneSecond,
        reconnect: fast,
      ));
      expect(error, isNull);
      expect([
        for (final e in events.whereType<Reconnected>()) e.reason
      ], [
        reason,
      ]);
      expect(server.sttConns, hasLength(2));
    });
  }

  test('never reconnects after a billing close; drains first', () async {
    server.stt.failAfterSegments = (1, 'insufficient_balance');
    final (events, error) = await run(transcribeStream(
      optionsFor(server),
      chunked(pcm(3), delay: const Duration(milliseconds: 5)),
      sampleRate: 16000,
      language: 'ar',
      segmentLength: oneSecond,
      reconnect: fast,
    ));
    expect(error, isA<InsufficientBalanceException>());
    expect([for (final t in transcripts(events)) t.text], ['segment 1']);
    expect(kinds(events).skip(events.length - 2), [
      StreamErrorEvent,
      SessionSaved,
    ]);
    expect(server.sttConns, hasLength(1));
  });

  test('never reconnects after a protocol close', () async {
    final closer = Timer(
      const Duration(milliseconds: 100),
      () => unawaited(server.closeAll(1008, 'invalid_message')),
    );
    addTearDown(closer.cancel);
    final (events, error) = await run(transcribeStream(
      optionsFor(server),
      chunked(pcm(2), delay: const Duration(milliseconds: 10)),
      sampleRate: 16000,
      language: 'ar',
      segmentLength: oneSecond,
      reconnect: fast,
    ));
    expect(
      error,
      isA<ProtocolException>().having((e) => e.closeCode, 'closeCode', 1008),
    );
    expect(events.whereType<Reconnected>(), isEmpty);
    expect(server.sttConns, hasLength(1));
  });

  test('gives up after the maximum attempts', () async {
    for (var i = 0; i < 3; i++) {
      server.stt.actions.add(SttAction('abort', afterBytes: 4000));
    }
    final (events, error) = await run(transcribeStream(
      optionsFor(server),
      chunked(pcm(3), delay: const Duration(milliseconds: 5)),
      sampleRate: 16000,
      language: 'ar',
      segmentLength: const Duration(seconds: 10),
      reconnect: const ReconnectPolicy(
        maxAttempts: 2,
        initialDelay: Duration(milliseconds: 10),
      ),
    ));
    expect(error, isA<StreamConnectionLostException>());
    expect(
        [for (final e in events.whereType<Reconnected>()) e.attempt], [1, 2]);
    expect(server.sttConns, hasLength(3));
  });

  test('a server max_duration is followed by a new session', () async {
    server.stt.enforceMaxDuration = const Duration(milliseconds: 250);
    final audio = pcm(1);
    final (events, error) = await run(transcribeStream(
      optionsFor(server),
      // 0.5 s of sending: outlives the first session.
      chunked(audio, delay: const Duration(milliseconds: 50)),
      sampleRate: 16000,
      language: 'ar',
      segmentLength: const Duration(seconds: 5),
      // Not counted as a failure.
      reconnect: const ReconnectPolicy(
        maxAttempts: 0,
        initialDelay: Duration(milliseconds: 10),
      ),
    ));
    expect(error, isNull);
    final reasons = {for (final e in events.whereType<Reconnected>()) e.reason};
    expect(reasons, {'max_duration'});
    // The open segment was dropped by the server, uncharged; it is replayed
    // into the next session.
    final last = server.sttConns.last.audio.toBytes();
    expect(
      last.sublist(last.length - 3200),
      audio.sublist(audio.length - 3200),
    );
  });

  test('invalid arguments fail before connecting', () {
    expect(
      () => transcribeStream(
        optionsFor(server),
        const Stream.empty(),
        sampleRate: 16000,
        language: 'ar',
        segmentLength: Duration.zero,
      ),
      throwsArgumentError,
    );
    expect(
      () => transcribeStream(
        optionsFor(server),
        const Stream.empty(),
        sampleRate: -1,
        language: 'ar',
      ),
      throwsArgumentError,
    );
    expect(server.attempts, isEmpty);
  });

  test('realtime paces sending at 1x', () async {
    final watch = Stopwatch()..start();
    final (_, error) = await run(transcribeStream(
      optionsFor(server),
      chunked(pcm(0.4)),
      sampleRate: 16000,
      language: 'ar',
      realtime: true,
    ));
    expect(error, isNull);
    // A file is sent no faster than it would play.
    expect(
        watch.elapsed, greaterThanOrEqualTo(const Duration(milliseconds: 300)));
  });

  test('cancelling the subscription closes the session', () async {
    final source = StreamController<List<int>>();
    addTearDown(source.close);
    final events = <TranscribeEvent>[];
    final subscription = transcribeStream(
      optionsFor(server),
      source.stream,
      sampleRate: 16000,
      language: 'ar',
      segmentLength: oneSecond,
    ).listen(events.add);
    source.add(pcm(1.2));
    await waitFor(() => events.whereType<Transcript>().isNotEmpty);
    await subscription.cancel();
    await waitFor(() => server.sttConns.single.closeCode != null);
    expect(server.sttConns.single.closeCode, 1000);
    expect(source.hasListener, isFalse); // the source is no longer read
  });

  test('a source error ends the stream with it', () async {
    final (events, error) = await run(transcribeStream(
      optionsFor(server),
      Stream<List<int>>.error(StateError('microphone unplugged')),
      sampleRate: 16000,
      language: 'ar',
    ));
    expect(events, isEmpty);
    expect(error, isA<StateError>());
  });
}
