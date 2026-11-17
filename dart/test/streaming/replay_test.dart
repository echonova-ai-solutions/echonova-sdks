/// Replays the stream traffic recorded from the live API
/// (`spec/fixtures/ws`).
///
/// [ReplayServer] plays each transcript's server side; the test drives a
/// session through its public API to send the recorded client frames
/// (`synthesize`, `cancel`, `close`, audio, `end_segment`, `terminology`,
/// `stop`, and keepalive pings), then checks what
/// `spec/fixtures/expected.json` says the caller sees.
///
/// Where the replay departs from a recording:
/// * A dropped connection (`abort`) was the recorder's own doing; the server
///   drops it instead, which the SDK sees the same way (1006).
/// * Speech to Text: `connect` returns once `session.started` has arrived,
///   so nothing can be sent before it. The server sends it as soon as the
///   socket opens (in `audio_before_started` and `ping` the recorder sent
///   frames first).
/// * Speech to Text: the SDK always sends `encoding` (`pcm_s16le`) with the
///   recorded query.
/// * Keepalive repeats, so pings after the recorded one are answered too.
/// * [departures] lists the rest, by fixture.
@TestOn('vm')
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:echonova_ai/src/core/retry.dart';
import 'package:echonova_ai/src/streaming/streaming.dart';
import 'package:test/test.dart';

import '../support/fixtures.dart';
import '../support/rest.dart' show testKey;
import '../support/spec.dart';
import 'helpers.dart' show waitFor;
import 'replay_server.dart';

/// A recording the SDK can't reproduce exactly.
final class Departure {
  const Departure({this.skip = const {}, this.ignore = const {}});

  /// Client frames (by JSON type, or `text` / `binary`) the SDK doesn't
  /// send: the server goes on without them.
  final Set<String> skip;

  /// Client frames (by JSON type) the SDK sends that the recorded server
  /// never saw: the server ignores them.
  final Set<String> ignore;
}

/// Where the replay of a fixture departs from the recording, and why.
const departures = {
  // The SDK sends no cancel when nothing is in flight.
  'tts/cancel_while_idle': Departure(skip: {'cancel'}),
  // The SDK never sends invalid JSON: only the server side is replayed.
  'tts/invalid_json': Departure(skip: {'text'}),
  // The SDK never sends binary on the Text to Speech stream: only the
  // server side is replayed.
  'tts/binary_frame': Departure(skip: {'binary'}),
  // sendAudio cuts audio into 100 ms frames, so the SDK never sends one over
  // the limit: only the server side is replayed.
  'stt/frame_too_large': Departure(skip: {'binary'}),
  // The SDK cancels r1 itself once r2 is rejected (the caller asked r1 to
  // stop); the recorded server never saw that cancel.
  'tts/invalid_while_running': Departure(ignore: {'cancel'}),
};

/// Keepalive in fixtures with a recorded ping (off in the others).
const keepalive = Duration(milliseconds: 50);

/// How long a ping may go unanswered.
const pongTimeout = Duration(milliseconds: 500);

const expectationKeys = {
  'requests',
  'session_error',
  'handshake_error',
  'pong',
  'transcripts',
  'ended',
  'saved',
  'events',
  'note',
};

/// [lines] as the replay plays them: Speech to Text's `session.started`
/// right after the socket opens.
List<TranscriptLine> replayOrder(String stream, List<TranscriptLine> lines) {
  final open = lines.indexWhere((line) => line.kind == 'open');
  final started =
      lines.indexWhere((line) => !line.isOut && line.type == 'session.started');
  if (stream != 'stt' || open < 0 || started < 0 || started == open + 1) {
    return lines;
  }
  final moved = [...lines]
    ..removeAt(started)
    ..insert(open + 1, lines[started]);
  return [for (var i = 0; i < moved.length; i++) moved[i].at(i)];
}

/// Whether a recorded `pong` arrived since the client frame before [index].
bool pongBefore(List<TranscriptLine> script, int index) {
  for (var i = index - 1; i >= 0 && !script[i].isOut; i--) {
    if (script[i].type == 'pong') return true;
  }
  return false;
}

/// A taxonomy name in an expectation, as the Dart class name.
String dartOutcome(String outcome) {
  final colon = outcome.indexOf(':');
  if (colon < 0) return outcome;
  return '${outcome.substring(0, colon)}:'
      '${dartName(outcome.substring(colon + 1))}';
}

/// What the recording says about each synthesis, by recorded request ID.
final class RecordedRequest {
  bool started = false;
  int audioBytes = 0;
  Map<String, Object?>? last; // done, cancelled or error

  num? get creditsConsumed => last?['creditsConsumed'] as num?;
}

Map<String, RecordedRequest> recordedRequests(List<TranscriptLine> lines) {
  final requests = <String, RecordedRequest>{};
  String? active;
  for (final line in lines) {
    final rid = line.kind == 'json' ? line.data['requestId'] : null;
    if (line.isOut) {
      if (line.type == 'synthesize') {
        requests[rid! as String] = RecordedRequest();
      }
      continue;
    }
    if (line.kind == 'binary' && active != null) {
      requests[active]!.audioBytes += line.bytes;
    }
    if (rid is! String) continue;
    final request = requests[rid]!;
    switch (line.type) {
      case 'start':
        request.started = true;
        active = rid;
      case 'done' || 'cancelled' || 'error':
        request.last = line.data;
        if (active == rid) active = null;
    }
  }
  return requests;
}

/// Options for the replay server.
StreamOptions replayOptions(ReplayServer server, {required bool pings}) {
  final connect = server.script.first.data;
  return StreamOptions(
    wsBaseUri: server.url,
    headers: () => connect['authorization'] == 'set'
        ? {'Authorization': 'Bearer $testKey'}
        : const {},
    keepalive: pings ? keepalive : null,
    pongTimeout: pongTimeout,
    openTimeout: const Duration(seconds: 5),
    closeTimeout: const Duration(seconds: 2),
    sessionStartTimeout: const Duration(seconds: 5),
    retryPolicy: RetryPolicy(random: () => 0),
    sleep: (_) async {},
  );
}

/// Runs one transcript's client side against its server.
abstract base class Replay {
  Replay(this.server);

  final ReplayServer server;

  List<TranscriptLine> get script => server.script;

  /// The handshake's error, when it was rejected.
  EchoNovaException? handshakeError;

  /// Whether a recorded pong was followed by a check that the connection
  /// stayed up past the pong timeout.
  bool pongChecked = false;

  /// Whether the session is up and has not failed.
  bool get alive;

  /// Whether the SDK has handled the barrier the server sent before client
  /// line [index].
  bool sawBarrier(int index);

  Future<void> connect();

  /// Does what client line [index] needs. Returns the last line it covered.
  Future<int> act(int index);

  Future<void> finish();

  Future<void> run() async {
    try {
      await connect();
    } on EchoNovaException catch (error) {
      handshakeError = error;
      return;
    }
    for (var i = 1; i < script.length; i++) {
      if (!script[i].isOut) continue;
      if (barrierBefore(script, i)) await waitFor(() => sawBarrier(i));
      if (pongBefore(script, i)) {
        // A ping nobody answers is given up on after pongTimeout.
        await Future<void>.delayed(pongTimeout + keepalive * 2);
        expect(alive, isTrue, reason: 'the answered ping was given up on');
        pongChecked = true;
      }
      i = await act(i);
    }
    await finish();
  }

  void expectHandshake(Object expected) {
    final rejected = script[1].data;
    expect(handshakeError, isA<APIStatusException>(),
        reason: 'the handshake should fail');
    final error = handshakeError! as APIStatusException;
    expect(exceptionName(error), dartName(expected as String));
    expect(error.statusCode, rejected['status']);
    final body = jsonMap(rejected['body']);
    expect(error.errorMessage, body['errorMessage']);
    expect(error.docsUrl, body['docs']);
    expect(error.requestId, (rejected['headers']! as Map)['x-request-id']);
    expect(error.transport, TransportKind.websocket);
    expect(server.handshakes, hasLength(1), reason: 'not retried');
  }

  void expectSessionError(Object expected, EchoNovaException? error) {
    expect(error, isA<APIStatusException>(), reason: 'the session fails');
    final failure = error! as APIStatusException;
    expect(exceptionName(failure), dartName(expected as String));
    // The close decides; the error frame just before it says why.
    final close = script.lastWhere((l) => !l.isOut && l.kind == 'close');
    final frame = script.lastWhere((l) => !l.isOut && l.type == 'error');
    expect(frame.index, lessThan(close.index));
    expect(failure.closeCode, close.data['code']);
    expect(failure.errorCode, frame.data['code']);
    expect(failure.errorMessage, frame.data['message']);
  }
}

/// A Text to Speech transcript.
final class TtsReplay extends Replay {
  TtsReplay(super.server, this.options);

  final StreamOptions options;
  TtsSession? session;

  /// The syntheses, by recorded request ID.
  final synths = <String, Synthesis>{};
  final audioBytes = <String, int>{};
  final audioFrames = <String, int>{};
  final audioErrors = <String, Object>{};
  final _audioDone = <Future<void>>[];

  String get _voiceId =>
      script
          .firstWhere((l) => l.isOut && l.type == 'synthesize',
              orElse: () => script.first)
          .data['voiceId'] as String? ??
      'voice';

  @override
  bool get alive => session!.isConnected && session!.failure == null;

  @override
  bool sawBarrier(int index) => session!.unknownEvents
      .any((e) => e.type == barrierType && e.raw['seq'] == index);

  @override
  Future<void> connect() async {
    session = await connectTts(options, voiceId: _voiceId);
  }

  @override
  Future<int> act(int index) async {
    final line = script[index];
    final tts = session!;
    if (server.rules.skip.contains(index)) {
      if (line.type == 'cancel') tts.cancel();
      server.proceed(index);
      return index;
    }
    switch (line.kind == 'json' ? line.type : line.kind) {
      case 'synthesize':
        final frame = Map.of(line.data)..remove('type');
        final rid = frame.remove('requestId')! as String;
        final text = frame.remove('text')! as String;
        final voiceId = frame.remove('voiceId') as String?;
        final synthesis = tts.synthesize(
          text,
          voiceId: voiceId == _voiceId ? null : voiceId,
          speed: (frame.remove('speed') as num?)?.toDouble(),
          cfg: (frame.remove('cfg') as num?)?.toDouble(),
          numSteps: frame.remove('numSteps') as int?,
          tashkeel: frame.remove('tashkeel') as bool?,
          normalize: frame.remove('normalize') as bool?,
          extraBody: frame.isEmpty ? null : frame,
        );
        synths[rid] = synthesis;
        audioBytes[rid] = 0;
        audioFrames[rid] = 0;
        final done = Completer<void>();
        synthesis.audio.listen(
          (chunk) {
            audioBytes[rid] = audioBytes[rid]! + chunk.length;
            audioFrames[rid] = audioFrames[rid]! + 1;
          },
          onError: (Object error) => audioErrors[rid] = error,
          onDone: done.complete,
        );
        _audioDone.add(done.future);
      case 'cancel':
        // The recorder cancelled what it had sent.
        for (final synthesis in synths.values) {
          await synthesis.whenSent.then((_) {}, onError: (Object _) {});
        }
        tts.cancel();
      case 'ping':
        break; // keepalive sends it
      case 'close':
        await tts.close();
      case 'abort':
        server.proceed(index);
      default:
        fail('cannot send ${script[index]}');
    }
    return index;
  }

  @override
  Future<void> finish() async {
    await Future.wait([
      for (final synthesis in synths.values)
        synthesis.result.then((_) {}, onError: (Object _) {}),
      ..._audioDone,
    ]).timeout(const Duration(seconds: 10));
    await server.finished.timeout(const Duration(seconds: 10),
        onTimeout: () => fail('the replay stopped ${server.position}'));
    if (!script.any((line) => line.isOut && line.kind == 'close')) {
      // The server ended it (a close or a drop).
      await waitFor(() => !session!.isConnected);
    }
    await session!.close();
  }

  Future<void> expectRequests(Object? expected) async {
    final outcomes = jsonMap(expected);
    final recorded = recordedRequests(script);
    expect(synths.keys.toSet(), outcomes.keys.toSet(),
        reason: 'the recorded requests');
    expect(server.requestIds.keys.toSet(), outcomes.keys.toSet());
    var delivered = 0;
    for (final MapEntry(key: rid, value: outcome) in outcomes.entries) {
      final synthesis = synths[rid]!;
      final record = recorded[rid]!;
      final reason = '$rid ($outcome)';
      expect(synthesis.requestId, server.requestIds[rid], reason: reason);
      expect(synthesis.isDone, isTrue, reason: reason);
      expect(synthesis.creditsConsumed, record.creditsConsumed,
          reason: '$reason: the recorded creditsConsumed');
      delivered += audioFrames[rid]!;
      final kind = (outcome! as String).split(':').first;
      switch (kind) {
        case 'completed' || 'cancelled' || 'superseded':
          final result = await synthesis.result;
          expect(result.outcome.name, kind, reason: reason);
          expect(result.requestId, synthesis.requestId, reason: reason);
          expect(result.creditsConsumed, record.creditsConsumed,
              reason: reason);
          expect(
              result.charged, record.started || record.creditsConsumed != null,
              reason: '$reason: charged');
          expect(audioErrors[rid], isNull, reason: reason);
          if (kind == 'completed') {
            expect(audioBytes[rid], record.audioBytes,
                reason: '$reason: all the recorded audio');
            expect(result.sampleRate, isNotNull, reason: reason);
          } else {
            // Audio after the cancel (or the newer request) is dropped.
            expect(server.audioBeforeStop, contains(rid), reason: reason);
            expect(audioBytes[rid], server.audioBeforeStop[rid],
                reason: '$reason: the audio sent before it was stopped');
          }
        case 'failed' || 'lost':
          Object? error;
          try {
            await synthesis.result;
          } on Object catch (caught) {
            error = caught;
          }
          expect(error, isA<EchoNovaException>(), reason: reason);
          expect(exceptionName(error! as EchoNovaException),
              dartOutcome(outcome as String).split(':').last,
              reason: reason);
          expect(synthesis.state.name, kind, reason: reason);
          expect(audioErrors[rid], same(error), reason: reason);
          expect(audioBytes[rid], record.audioBytes,
              reason: '$reason: the audio that arrived');
          expect(
            chargeStateOf(error),
            record.started
                ? ChargeState.yes
                : kind == 'lost'
                    ? ChargeState.unknown
                    : ChargeState.no,
            reason: '$reason: charge state',
          );
          if (record.last case {'type': 'error', 'message': final message}) {
            error as APIStatusException;
            expect(error.errorMessage, message, reason: reason);
            expect(error.errorCode, record.last!['code'], reason: reason);
            expect(error.requestId, synthesis.requestId, reason: reason);
          }
        default:
          fail('unknown outcome $outcome');
      }
    }
    final frames = script.where((l) => !l.isOut && l.kind == 'binary').length;
    expect(session!.droppedFrames, frames - delivered,
        reason: 'every recorded audio frame is delivered or dropped');
  }
}

/// A Speech to Text transcript.
final class SttReplay extends Replay {
  SttReplay(super.server, this.options);

  final StreamOptions options;
  SttSession? session;

  /// What the caller saw, in order: events, and errors thrown by
  /// setTerminology.
  final seen = <String>[];
  final transcripts = <Transcript>[];
  final terminologySets = <TerminologySet>[];
  final marks = <SegmentMark>[];
  final _barriers = <int>{};
  final _eventsDone = Completer<void>();
  SessionEnded? ended;
  SessionSaved? saved;
  Object? streamError;
  SessionSummary? summary;
  Object? stopError;

  @override
  bool get alive => !session!.isClosed && session!.failure == null;

  @override
  bool sawBarrier(int index) => _barriers.contains(index);

  @override
  Future<void> connect() async {
    final query =
        Uri.parse(script.first.data['path']! as String).queryParameters;
    session = await connectStt(
      options,
      sampleRate: int.parse(query['sample_rate']!),
      // Left out when the recording left it out, as the SDK can now do.
      language: query['language'],
    );
    session!.events.listen(
      (event) {
        switch (event) {
          case UnknownEvent(type: barrierType, :final raw):
            _barriers.add(raw['seq']! as int);
          case UnknownEvent(:final type):
            seen.add('unknown:$type');
          case Transcript():
            transcripts.add(event);
            seen.add('transcript');
          case TerminologySet():
            terminologySets.add(event);
            seen.add('terminology.set');
          case StreamErrorEvent(:final error):
            seen.add('error:${exceptionName(error)}');
          case SessionEnded():
            ended = event;
            seen.add('session.ended');
          case SessionSaved():
            saved = event;
            seen.add('session.saved');
        }
      },
      onError: (Object error) => streamError = error,
      onDone: _eventsDone.complete,
    );
  }

  @override
  Future<int> act(int index) async {
    final line = script[index];
    final stt = session!;
    if (server.rules.skip.contains(index)) {
      server.proceed(index);
      return index;
    }
    switch (line.kind == 'json' ? line.type : line.kind) {
      case 'binary':
        // One call for the run of frames: the SDK cuts it into the same
        // 100 ms frames, and holds the rest until the segment ends.
        var last = index;
        var bytes = 0;
        while (last < script.length &&
            script[last].isOut &&
            script[last].kind == 'binary') {
          bytes += script[last].bytes;
          last += 1;
        }
        await stt.sendAudio(Uint8List(bytes));
        return last - 1;
      case 'end_segment':
        marks.add(await stt.endSegment());
      case 'terminology':
        final terminology = line.data['terminology'] as Map?;
        try {
          await stt.setTerminology(terminology?.cast());
        } on EchoNovaException catch (error) {
          seen.add('error:${exceptionName(error)}');
        }
      case 'stop':
        try {
          summary = await stt.stop();
        } on EchoNovaException catch (error) {
          stopError = error;
        }
      case 'ping':
        break; // keepalive sends it
      case 'close':
        await stt.close();
      default:
        fail('cannot send ${script[index]}');
    }
    return index;
  }

  @override
  Future<void> finish() async {
    await _eventsDone.future.timeout(const Duration(seconds: 10),
        onTimeout: () => fail('the session did not end'));
    await server.finished.timeout(const Duration(seconds: 10),
        onTimeout: () => fail('the replay stopped ${server.position}'));
    if (summary == null && stopError == null) {
      try {
        summary = await session!.stop();
      } on EchoNovaException catch (error) {
        stopError = error;
      }
    }
  }

  List<Map<String, Object?>> recorded(String type) => [
        for (final line in script)
          if (!line.isOut && line.type == type) line.data,
      ];

  /// The session matches the recorded events.
  void expectRecordedSession() {
    final started = recorded('session.started').single;
    expect(session!.sessionId, started['sessionId']);
    expect(session!.jobId, started['jobId']);
    final texts = recorded('transcript');
    expect(transcripts, hasLength(texts.length));
    for (var i = 0; i < texts.length; i++) {
      final transcript = transcripts[i];
      expect(transcript.index, i);
      expect(transcript.segmentId, texts[i]['segmentId']);
      expect(transcript.text, texts[i]['text']);
      expect(transcript.language, texts[i]['language']);
      expect(transcript.durationSeconds, texts[i]['durationSeconds']);
      expect(transcript.creditsConsumed, texts[i]['creditsConsumed']);
      expect(transcript.sessionId, started['sessionId']);
    }
    final sets = recorded('terminology.set');
    expect([for (final set in terminologySets) set.active],
        [for (final set in sets) set['active']]);
    final end = recorded('session.ended');
    if (end.isNotEmpty) {
      final summary = this.summary!;
      expect(stopError, isNull);
      expect(ended?.reason, end.single['reason']);
      expect(summary.reason, end.single['reason']);
      expect(summary.totalSeconds, end.single['totalSeconds']);
      expect(summary.creditsConsumed, end.single['creditsConsumed']);
      expect(summary.sessionId, started['sessionId']);
    }
    final save = recorded('session.saved');
    if (save.isNotEmpty) {
      expect(saved?.jobId, save.single['jobId']);
      expect(saved?.status.name, save.single['status']);
      expect(summary!.jobId, save.single['jobId']);
      expect(summary!.savedStatus?.name, save.single['status']);
    }
  }
}

void main() {
  final fixtures = recordedFixtures('ws', '.jsonl');
  final expectations = fixtureExpectations('ws');

  fixtureCoverageTests('ws', fixtures, expectations);

  test('ws: every departure names a recorded fixture', () {
    final names = {for (final fixture in fixtures) fixture.name};
    expect(departures.keys.toSet().difference(names), isEmpty);
  });

  for (final fixture in fixtures) {
    test(fixture.name, () async {
      final expectation = expectations[fixture.name];
      if (expectation == null) fail('no expectation in expected.json');
      expect(expectation.keys.toSet().difference(expectationKeys), isEmpty,
          reason: 'unknown expectation');
      final stream = fixture.name.split('/').first;
      final script = replayOrder(stream, readTranscript(fixture.file));
      final departure = departures[fixture.name] ?? const Departure();
      final pings = script.any((line) => line.isOut && line.type == 'ping');
      final skip = {
        for (final line in script)
          if (line.isOut && departure.skip.contains(line.type ?? line.kind))
            line.index,
      };
      expect(skip.length, departure.skip.length,
          reason: 'each departure matches a recorded client frame');
      final server = await ReplayServer.start(
        script,
        ReplayRules(
          skip: skip,
          ignore: {...departure.ignore, if (pings) 'ping'},
        ),
        apiKey: testKey,
      );
      addTearDown(server.stop);
      final options = replayOptions(server, pings: pings);
      final replay = stream == 'tts'
          ? TtsReplay(server, options)
          : SttReplay(server, options);
      await replay.run();
      await server.finished.timeout(const Duration(seconds: 10),
          onTimeout: () => fail('the replay stopped ${server.position}'));
      expect(server.problems, isEmpty);
      expect(server.handshakes, hasLength(1), reason: 'one connection');
      final handshake = server.handshakes.single;
      if (stream == 'stt') {
        // What was recorded, and the encoding the SDK always sends: a
        // recording without a language is replayed without one.
        final recorded = Uri.parse(script.first.data['path']! as String);
        expect(handshake.query,
            {...recorded.queryParameters, 'encoding': 'pcm_s16le'});
      }

      // Frames the SDK sent that the recording has not.
      final ignoredTypes = [for (final frame in server.ignored) frame['type']];
      expect(ignoredTypes.where((type) => type != 'ping'),
          [for (final type in departure.ignore) type],
          reason: 'the departure happens');

      final handshakeError = expectation['handshake_error'];
      if (handshakeError != null) {
        replay.expectHandshake(handshakeError);
      } else {
        expect(replay.handshakeError, isNull);
      }
      if (expectation['pong'] == true) {
        expect(replay.pongChecked, isTrue);
        expect(ignoredTypes, everyElement('ping'));
      }

      switch (replay) {
        case TtsReplay():
          final session = replay.session;
          if (session == null) break;
          await replay.expectRequests(expectation['requests'] ?? const {});
          final sessionError = expectation['session_error'];
          if (sessionError != null) {
            replay.expectSessionError(sessionError, session.failure);
          } else {
            expect(session.failure, isNull);
          }
        case SttReplay():
          final session = replay.session;
          if (session == null) break;
          final sessionError = expectation['session_error'];
          if (sessionError != null) {
            final failure = session.failure;
            replay.expectSessionError(sessionError, failure);
            expect(replay.streamError, same(failure));
            expect(replay.stopError, same(failure));
            break;
          }
          expect(session.failure, isNull);
          expect(replay.streamError, isNull);
          replay.expectRecordedSession();
          switch (expectation['transcripts']) {
            case null:
              break;
            case final int count:
              expect(replay.transcripts, hasLength(count));
            case 'in order':
              // Segments of growing length: each result has its segment's
              // duration, in the order they were cut.
              expect(replay.transcripts, hasLength(replay.marks.length));
              for (var i = 0; i < replay.marks.length; i++) {
                final mark = replay.marks[i];
                expect(replay.transcripts[i].durationSeconds * 1000,
                    closeTo(mark.duration.inMicroseconds / 1000, 1e-6));
              }
            case final other:
              fail('unknown transcripts expectation $other');
          }
          if (expectation['ended'] case final String reason) {
            expect(replay.summary?.reason, reason);
            expect(replay.ended?.reason, reason);
          }
          if (expectation['saved'] == true) {
            expect(replay.saved, isNotNull);
            expect(replay.saved!.jobId, isNotEmpty);
            expect(replay.summary?.jobId, replay.saved!.jobId);
          }
          if (expectation['events'] case final List<Object?> events) {
            // ended and saved are their own keys.
            expect(
              replay.seen
                  .where((e) => e != 'session.ended' && e != 'session.saved'),
              [for (final event in events) dartOutcome(event! as String)],
            );
          }
      }
    });
  }
}
