/// The Speech to Text protocol and SegmentPlan as pure state machines.
library;

import 'dart:typed_data';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/core/pcm_framer.dart' show maxFrameBytes;
import 'package:echonova/src/streaming/stream_errors.dart';
import 'package:echonova/src/streaming/stt_protocol.dart';
import 'package:test/test.dart';

const Map<String, Object?> startedFrame = {
  'type': 'session.started',
  'sessionId': 's1',
  'language': 'ar',
  'sampleRate': 16000,
  'maxSessionSeconds': 1500,
  'jobId': 'job-1',
};

const Duration at5 = Duration(seconds: 5);
const Duration at6 = Duration(seconds: 6);

SttProtocol started([int sampleRate = 16000]) =>
    SttProtocol(sampleRate)..receiveEvent(startedFrame, at5);

Map<String, Object?> transcript([
  String text = 'hi',
  Map<String, Object?> extra = const {},
]) =>
    {
      'type': 'transcript',
      'segmentId': 'a' * 24,
      'text': text,
      'durationSeconds': 1.0,
      'creditsConsumed': 3.33,
      'isFinal': true,
      ...extra,
    };

Map<String, Object?> ended(String reason, [num total = 2, num credits = 6.7]) =>
    {
      'type': 'session.ended',
      'reason': reason,
      'totalSeconds': total,
      'creditsConsumed': credits,
    };

Uint8List zeros(int length) => Uint8List(length);

SegmentMark sessionMark({required bool expect}) => SegmentMark(
      index: 0,
      audioOffset: Duration.zero,
      duration: Duration.zero,
      expectResult: expect,
    );

void main() {
  test('session.started', () {
    final p = started();
    expect(p.state, SttState.open);
    expect(p.sessionId, 's1');
    expect(p.language, 'ar');
    expect(p.maxSessionSeconds, 1500);
    expect(p.startedAt, at5);
    expect(p.jobId, 'job-1');
  });

  for (final status in SessionSaveStatus.values.take(3)) {
    test('session.saved ($status) follows session.ended', () {
      final p = started()..receiveEvent(ended('stopped'), at6);
      final before = p.summary()!;
      expect(before.jobId, isNull); // not saved yet
      expect(before.savedStatus, isNull);
      p
        ..receiveEvent(
          {'type': 'session.saved', 'jobId': 'job-1', 'status': status.name},
          at6,
        )
        // A repeat is ignored.
        ..receiveEvent(
          {'type': 'session.saved', 'jobId': 'job-1', 'status': 'failed'},
          at6,
        )
        ..connectionClosed(const CloseInfo(1000, reason: 'stopped'));
      expect(p.events.map((e) => e.runtimeType), [SessionEnded, SessionSaved]);
      final saved = p.events.last as SessionSaved;
      expect(saved.jobId, 'job-1');
      expect(saved.status, status);
      expect(saved.sessionId, 's1');
      expect(saved.raw, {
        'type': 'session.saved',
        'jobId': 'job-1',
        'status': status.name,
      });
      final summary = p.summary()!;
      expect(summary.reason, 'stopped');
      expect(summary.totalSeconds, 2.0);
      expect(summary.creditsConsumed, 6.7);
      expect(summary.sessionId, 's1');
      expect(summary.jobId, 'job-1');
      expect(summary.savedStatus, status);
      expect(p.fatal, isNull);
    });
  }

  test('session.saved is read leniently', () {
    final p = started()
      ..receiveEvent(ended('stopped', 0, 0), at6)
      // No jobId or status: the job ID comes from session.started.
      ..receiveEvent({'type': 'session.saved'}, at6);
    final summary = p.summary()!;
    expect(summary.jobId, 'job-1');
    expect(summary.savedStatus, SessionSaveStatus.unknown);
    final legacy = SttProtocol(16000)
      ..receiveEvent({...startedFrame}..remove('jobId'), at5);
    expect(legacy.jobId, isNull);
  });

  test('audio is framed even and at most 64 KiB', () {
    final p = started(48000);
    final frames = p.pushAudio(zeros(300001));
    expect(
      frames.every((f) => f.length.isEven && f.length <= maxFrameBytes),
      isTrue,
    );
    final (flushed, mark) = p.cut();
    final total = [...frames, ...flushed].fold<int>(0, (n, f) => n + f.length);
    expect(total, 300000); // the odd byte waits
    expect(mark.audioOffset.inMicroseconds, 300000 ~/ 2 * 1000000 ~/ 48000);
  });

  test('segment marks', () {
    final p = started()..pushAudio(zeros(32000));
    final (_, first) = p.cut();
    expect(first.index, 0);
    expect(first.audioOffset, const Duration(seconds: 1));
    expect(first.duration, const Duration(seconds: 1));
    expect(first.expectResult, isTrue);
    final (_, empty) = p.cut();
    expect(empty.index, 1);
    expect(empty.expectResult, isFalse);
    p.pushAudio(zeros(1598)); // 49.9 ms
    expect(p.cut().$2.expectResult, isFalse);
    p.pushAudio(zeros(1600)); // 50 ms
    final (_, enough) = p.cut();
    expect(enough.expectResult, isTrue);
    expect(
      enough.audioOffset.inMicroseconds,
      (32000 + 1598 + 1600) ~/ 2 * 1000000 ~/ 16000,
    );
  });

  test('events in order', () {
    final p = started()
      ..receiveEvent(transcript('  '), at6)
      ..receiveEvent({'type': 'terminology.set', 'active': true}, at6)
      ..receiveEvent(
        {'type': 'error', 'code': 'upstream_error', 'message': 'failed'},
        at6,
      )
      ..receiveEvent(
        transcript('two', {
          'terminology': {'corrected': 'TWO'},
        }),
        at6,
      )
      ..receiveEvent({'type': 'mystery', 'x': 1}, at6)
      ..receiveEvent(ended('stopped'), at6);
    final events = p.events.toList();
    expect(events.map((e) => e.runtimeType), [
      Transcript,
      TerminologySet,
      StreamErrorEvent,
      Transcript,
      UnknownEvent,
      SessionEnded,
    ]);
    final first = events[0] as Transcript;
    expect(first.text, '  '); // passed through unchanged
    final error = events[2] as StreamErrorEvent;
    expect(error.error, isA<UpstreamException>());
    final second = events[3] as Transcript;
    expect(second.index, 1);
    expect(second.terminology, {'corrected': 'TWO'});
    expect(second.sessionId, 's1');
    expect((events[4] as UnknownSttEvent).type, 'mystery');
    expect(p.summary()!.reason, 'stopped');
  });

  test('terminology reply and rejection', () {
    final p = started()
      ..beginTerminology({
        'keywords': ['KYC']
      });
    p.receiveEvent({'type': 'terminology.set', 'active': true}, at6);
    expect(p.terminologyReply, isA<TerminologySet>());
    p
      ..beginTerminology({'keywords': 'nope'})
      ..receiveEvent({
        'type': 'error',
        'code': 'validation_failed',
        'message': 'keywords must be a list',
      }, at6);
    expect(p.terminologyReply, isA<InvalidRequestException>());
    // It was the reply, not a stream event.
    expect(p.events.whereType<StreamErrorEvent>(), isEmpty);
    expect(
      () => p.beginTerminology({
        'keywords': ['x' * 70000],
      }),
      throwsA(isA<UsageException>()),
    );
  });

  test('normal stop', () {
    final p = started()..pushAudio(zeros(101));
    final (frames, dropped) = p.beginStop();
    expect(frames.fold<int>(0, (n, f) => n + f.length), 100);
    expect(dropped, 1);
    expect(
      () => p.pushAudio(zeros(2)),
      throwsA(isA<SessionEndedException>()
          .having((e) => e.message, 'message', contains('stop'))),
    );
    p
      ..receiveEvent(ended('stopped', 0, 0), at6)
      ..connectionClosed(const CloseInfo(1000, reason: 'stopped'));
    expect(p.fatal, isNull);
    expect(p.state, SttState.closed);
  });

  for (final (code, reason, matcher) in [
    (4002, 'insufficient_balance', isA<InsufficientBalanceException>()),
    (4029, 'spending_limit', isA<SpendingLimitException>()),
  ]) {
    test('a $code close after session.ended is fatal but events are kept', () {
      final p = started()
        ..receiveEvent(transcript('paid for'), at6)
        ..receiveEvent({
          'type': 'error',
          'code': reason,
          'message': reason.replaceAll('_', ' '),
        }, at6)
        ..receiveEvent(ended(reason, 1, 3), at6)
        ..connectionClosed(CloseInfo(code, reason: reason));
      expect(p.fatal, matcher);
      expect(
        (p.fatal! as APIStatusException).errorMessage,
        reason.replaceAll('_', ' '),
      );
      expect(p.events.first, isA<Transcript>()); // drained before the error
      expect(() => p.pushAudio(zeros(2)), throwsA(matcher));
    });
  }

  test('max_duration is a normal end', () {
    final p = started()
      ..receiveEvent(ended('max_duration', 1, 3), at6)
      ..connectionClosed(const CloseInfo(4008, reason: 'max_duration'));
    expect(p.fatal, isNull);
    expect(
      () => p.pushAudio(zeros(2)),
      throwsA(isA<SessionEndedException>()
          .having((e) => e.message, 'message', contains('max_duration'))),
    );
  });

  test('4008 without session.ended is expired', () {
    final p = started()
      ..connectionClosed(const CloseInfo(4008, reason: 'idle_timeout'));
    expect(p.fatal, isA<SessionExpiredException>());
  });

  test('a drop is a lost connection', () {
    final p = started()..connectionClosed(const CloseInfo(1006));
    expect(p.fatal, isA<StreamConnectionLostException>());
  });

  for (final closeCode in [1011, 1000]) {
    test(
        'session.ended before session.started is an upstream error '
        '($closeCode)', () {
      final p = SttProtocol(16000)
        ..receiveEvent({
          'type': 'error',
          'code': 'upstream_error',
          'message': 'speech service unavailable',
        }, at5)
        ..receiveEvent(ended('upstream_error', 0, 0), at5)
        ..connectionClosed(CloseInfo(closeCode, reason: 'upstream_error'));
      expect(
        p.fatal,
        isA<UpstreamException>()
            .having((e) => e.errorMessage, 'errorMessage',
                'speech service unavailable')
            .having((e) => e.closeCode, 'closeCode', closeCode),
      );
    });
  }

  test('a waiting terminology frame is answered by a close', () {
    final p = started()
      ..beginTerminology(null)
      ..connectionClosed(const CloseInfo(1006));
    expect(p.terminologyReply, isA<StreamConnectionLostException>());
  });

  group('SegmentPlan', () {
    test('cuts every segment across chunks', () {
      final plan = SegmentPlan(8000, const Duration(seconds: 1));
      final pieces = [
        ...plan.split(zeros(10000)),
        ...plan.split(zeros(10000)),
        ...plan.split(zeros(13000)),
      ];
      expect([
        for (final p in pieces) (p.data.length, p.cut)
      ], [
        (10000, false),
        (6000, true),
        (4000, false),
        (12000, true),
        (1000, false),
      ]);
    });

    test('keeps samples aligned', () {
      final plan = SegmentPlan(8000, const Duration(seconds: 1));
      final pieces = [
        ...plan.split([1, 2, 3]),
        ...plan.split([4]),
      ];
      expect([for (final p in pieces) ...p.data], [1, 2, 3, 4]);
      expect(pieces.every((p) => p.data.length.isEven), isTrue);
      plan.split([5]);
      expect(plan.finish(), 1);
    });

    test('replays only uncut audio and reports dropped segments', () {
      final plan = SegmentPlan(8000, const Duration(seconds: 1));
      final audio = [
        ...List.filled(16000, 65),
        ...List.filled(16000, 66),
        ...List.filled(3000, 67),
      ];
      for (final piece in plan.split(audio)) {
        plan.delivered(piece.data);
        if (piece.cut) plan.cut(sessionMark(expect: true));
      }
      expect(plan.replay(), List.filled(3000, 67));
      expect([for (final m in plan.pending) m.index], [0, 1]);
      plan.result(); // segment 0 answered
      final dropped = plan.takeDropped();
      expect(dropped, hasLength(1));
      expect(dropped.single.index, 1);
      expect(dropped.single.audioOffset, const Duration(seconds: 2));
      expect(dropped.single.duration, const Duration(seconds: 1));
      expect(plan.takeDropped(), isEmpty);
    });

    test('ignores cuts that expect no result', () {
      final plan = SegmentPlan(8000, const Duration(seconds: 1));
      final mark = plan.cut(sessionMark(expect: false));
      expect(mark.expectResult, isFalse);
      expect(plan.pending, isEmpty);
    });

    test('knows when the final segment was answered', () {
      final plan = SegmentPlan(8000, const Duration(seconds: 1))
        ..cut(sessionMark(expect: true))
        ..result(); // answers the cut
      expect(plan.tailAnswered, isFalse);
      plan.result(); // a result beyond every cut: the final segment
      expect(plan.tailAnswered, isTrue);
      plan.newSession();
      expect(plan.tailAnswered, isFalse);
    });
  });
}
