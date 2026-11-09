/// The Text to Speech protocol as a pure state machine, on a fake clock.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/streaming/stream_errors.dart';
import 'package:echonova/src/streaming/tts_protocol.dart';
import 'package:test/test.dart';

const Duration t0 = Duration(seconds: 100);

Duration ms(int value) => Duration(milliseconds: value);

/// A protocol plus a fake wire: the frames the session would send, and
/// helpers to answer as the server.
final class Harness {
  Harness({
    SynthesisOptions defaults = const SynthesisOptions(),
  }) : p = TtsProtocol(
          voiceId: 'v1',
          defaults: defaults,
          newRequestId: () => 'r${_ids++}',
        ) {
    _ids = 1;
    p.connectionOpened(now);
  }

  static int _ids = 1;

  final TtsProtocol p;
  Duration now = t0;
  final List<Map<String, Object?>> wire = [];

  /// Sends everything the protocol has queued; returns the frames sent.
  List<Map<String, Object?>> flush() {
    final sent = <Map<String, Object?>>[];
    while (true) {
      final item = p.nextOutbound(now);
      if (item == null) break;
      sent.add(jsonDecode(item.text) as Map<String, Object?>);
      p.sent(item, now);
    }
    wire.addAll(sent);
    return sent;
  }

  SynthesisCore synth([
    String text = 'hello',
    SynthesisOptions options = const SynthesisOptions(),
  ]) =>
      p.synthesize(text, options, now);

  SynthesisCore enqueue(String text) =>
      p.enqueue(text, const SynthesisOptions(), now);

  void event(String type, [Map<String, Object?> fields = const {}]) =>
      p.receiveEvent({'type': type, ...fields}, now);

  void start(String rid, {int rate = 24000}) => event('start', {
        'requestId': rid,
        'sampleRate': rate,
        'encoding': 'pcm_s16le',
        'channels': 1,
      });

  void audio([int n = 1]) {
    for (var i = 0; i < n; i++) {
      p.receiveBinary(Uint8List.fromList(List.filled(20, 1)), now);
    }
  }

  void done(String rid) => event('done', {
        'requestId': rid,
        'durationSeconds': 1.5,
        'characters': 5,
        'creditsConsumed': 5,
      });

  void tick(Duration step) {
    now += step;
    p.tick(now);
  }
}

void main() {
  test('happy path', () {
    final h = Harness();
    final core = h.synth('hello', const SynthesisOptions(speed: 1.2));
    expect(core.state, SynthesisState.queued);
    expect(h.flush(), [
      {
        'type': 'synthesize',
        'requestId': 'r1',
        'text': 'hello',
        'voiceId': 'v1',
        'speed': 1.2,
      },
    ]);
    expect(core.state, SynthesisState.sent);
    h.now += ms(200);
    h.start('r1', rate: 22050);
    h.now += ms(50);
    h.audio(3);
    h.done('r1');
    expect(core.state, SynthesisState.completed);
    expect(core.sampleRate, 22050);
    expect(core.chunks, hasLength(3));
    final result = core.result();
    expect(result.outcome, SynthesisOutcome.completed);
    expect(result.charged, isTrue);
    expect(result.creditsConsumed, 5.0);
    expect(result.characters, 5);
    expect(result.durationSeconds, 1.5);
    final metrics = core.metrics();
    expect(metrics.timeToStart, ms(200));
    expect(metrics.ttfb, ms(250));
    expect(metrics.frames, 3);
  });

  test('only set options are sent and defaults merge', () {
    final h = Harness(defaults: const SynthesisOptions(speed: 0.9));
    h.synth(
      'x',
      const SynthesisOptions(numSteps: 32, voiceId: 'v2', extraBody: {'z': 1}),
    );
    expect(h.flush(), [
      {
        'type': 'synthesize',
        'requestId': 'r1',
        'text': 'x',
        'voiceId': 'v2',
        'speed': 0.9,
        'numSteps': 32,
        'z': 1,
      },
    ]);
  });

  test('an oversized frame is a usage error and nothing is queued', () {
    final h = Harness();
    expect(
      () => h.synth('x', SynthesisOptions(extraBody: {'blob': 'y' * 70000})),
      throwsA(isA<UsageException>()),
    );
    expect(h.flush(), isEmpty);
  });

  test('the frame limit counts UTF-8 bytes', () {
    final h = Harness();
    // 33,000 Arabic letters are 66,000 bytes.
    expect(
      () => h.synth('م' * 33000),
      throwsA(isA<UsageException>()),
    );
  });

  test('supersede with a cancelled ack', () {
    final h = Harness();
    final a = h.synth('first');
    h.flush();
    h.start('r1');
    h.audio(2);
    final b = h.synth('second');
    expect(a.state, SynthesisState.cancelling);
    // The server cancels A itself: no cancel frame.
    expect([for (final f in h.flush()) f['type']], ['synthesize']);
    h.audio(2); // A's audio still in flight: dropped
    expect(a.droppedFrames, 2);
    expect(a.chunks, hasLength(2));
    h.event('cancelled', {'requestId': 'r1', 'creditsConsumed': 2});
    expect(a.state, SynthesisState.superseded);
    expect(a.result().charged, isTrue);
    expect(a.result().creditsConsumed, 2.0);
    expect(a.result().outcome, SynthesisOutcome.superseded);
    h.start('r2');
    h.audio();
    expect(b.chunks, hasLength(1));
    expect(b.state, SynthesisState.streaming);
  });

  test('supersede without a cancelled ack', () {
    final h = Harness();
    final a = h.synth('first');
    h.flush();
    h.start('r1');
    h.synth('second');
    h.flush();
    h.start('r2'); // a newer start ends A even without cancelled
    expect(a.state, SynthesisState.superseded);
    expect(a.charged, isTrue); // it had started
    h.event('cancelled', {'requestId': 'r1'}); // late: ignored
    expect(a.state, SynthesisState.superseded);
  });

  test('supersede of an unstarted request is charge unknown', () {
    final h = Harness();
    final a = h.synth('first');
    h.flush();
    h.synth('second');
    h.flush();
    h.start('r2');
    expect(a.state, SynthesisState.superseded);
    expect(a.chargeState, ChargeState.unknown);
  });

  test('orphan frames are dropped and counted', () {
    final h = Harness();
    h.audio(2); // nothing started
    final a = h.synth();
    h.flush();
    h.start('r1');
    h.done('r1');
    h.audio(); // after done
    h.start('zzz'); // a start for something never sent
    h.audio();
    expect(h.p.orphanFrames, 4);
    expect(a.chunks, isEmpty);
  });

  test('duplicate and unknown done frames are ignored', () {
    final h = Harness();
    final a = h.synth();
    h.flush();
    h.start('r1');
    h.done('r1');
    h.done('r1');
    h.event('cancelled', {'requestId': 'r1'});
    h.done('unknown');
    expect(a.state, SynthesisState.completed);
  });

  test('never sends cancel when nothing is in flight', () {
    final h = Harness();
    h.p.cancelActive(h.now);
    h.p.interrupt(h.now);
    expect(h.flush(), isEmpty);
    final a = h.synth();
    h.flush();
    h.start('r1');
    h.done('r1');
    h.p.cancel(a, h.now); // finished: nothing to cancel
    h.p.cancelActive(h.now);
    expect(h.flush(), isEmpty);
  });

  test('cancelling a queued request drops it locally', () {
    final h = Harness();
    final a = h.synth();
    h.p.cancel(a, h.now);
    expect(a.state, SynthesisState.cancelled);
    expect(a.charged, isFalse);
    expect(h.flush(), isEmpty);
  });

  group('charge state on cancel', () {
    test('a cancel in flight sends one cancel and reports the cost', () {
      final h = Harness();
      final a = h.synth();
      h.flush();
      h.start('r1');
      h.p.cancel(a, h.now);
      h.p.cancel(a, h.now);
      expect(h.flush(), [
        {'type': 'cancel'},
      ]);
      h.event('cancelled', {'requestId': 'r1', 'creditsConsumed': 1});
      expect(a.state, SynthesisState.cancelled);
      final result = a.result();
      expect(result.outcome, SynthesisOutcome.cancelled);
      expect(result.charged, isTrue);
      expect(result.creditsConsumed, 1.0);
      expect(result.raw, {
        'type': 'cancelled',
        'requestId': 'r1',
        'creditsConsumed': 1,
      });
      // Only done carries these.
      expect(result.durationSeconds, isNull);
      expect(result.characters, isNull);
      expect(a.chargeState, ChargeState.yes);
    });

    test('cancelled without a cost was not charged', () {
      final h = Harness();
      final a = h.synth();
      h.flush();
      h.p.cancel(a, h.now);
      h.flush();
      h.event('cancelled', {'requestId': 'r1'});
      final result = a.result();
      expect(result.charged, isFalse);
      expect(result.creditsConsumed, isNull);
      expect(a.chargeState, ChargeState.no);
    });

    test('cancelled without a cost after audio started counts as charged', () {
      final h = Harness();
      final a = h.synth();
      h.flush();
      h.start('r1');
      h.audio();
      h.p.cancel(a, h.now);
      h.flush();
      h.event('cancelled', {'requestId': 'r1'});
      expect(a.result().charged, isTrue);
      expect(a.result().creditsConsumed, isNull);
      expect(a.chargeState, ChargeState.yes);
    });

    test('superseded without a cost before start was not charged', () {
      final h = Harness();
      final a = h.synth('first');
      h.flush();
      final b = h.synth('second');
      h.flush();
      h.event('cancelled', {'requestId': 'r1'});
      h.start('r2');
      expect(a.state, SynthesisState.superseded);
      expect(a.charged, isFalse);
      expect(a.chargeState, ChargeState.no);
      expect(b.state, SynthesisState.streaming);
    });

    for (final (started, charged) in [(true, true), (false, null)]) {
      test('a cancel ack times out after 5 s (started: $started)', () {
        final h = Harness();
        final a = h.synth();
        h.flush();
        if (started) h.start('r1');
        h.p.cancel(a, h.now);
        h.flush();
        expect(h.p.nextDeadline(), h.now + const Duration(seconds: 5));
        h.tick(ms(4900));
        expect(a.state, SynthesisState.cancelling);
        h.tick(ms(200));
        expect(a.state, SynthesisState.cancelled);
        expect(a.charged, charged); // resolved locally
      });
    }
  });

  test('no start within 30 s is a timeout, and the request is cancelled', () {
    final h = Harness();
    final a = h.synth();
    h.flush();
    h.tick(const Duration(seconds: 29));
    expect(a.state, SynthesisState.sent);
    h.tick(const Duration(seconds: 1));
    expect(a.state, SynthesisState.failed);
    expect(a.error, isA<APITimeoutException>());
    expect(a.chargeState, ChargeState.unknown);
    expect(chargeStateOf(a.error!), ChargeState.unknown);
    expect(h.flush(), [
      {'type': 'cancel'},
    ]);
    h.event('cancelled', {'requestId': 'r1'}); // late ack: ignored
    expect(a.state, SynthesisState.failed);
  });

  test('charge state when the connection drops', () {
    final h = Harness();
    final started = h.synth('a');
    h.flush();
    h.start('r1');
    final queued = h.enqueue('b');
    h.p.connectionClosed(const CloseInfo(1006), h.now);
    expect(started.state, SynthesisState.lost);
    expect(started.error, isA<StreamConnectionLostException>());
    expect(started.chargeState, ChargeState.yes);
    expect(chargeStateOf(started.error!), ChargeState.yes);
    expect(
      (started.error! as StreamConnectionLostException).mayHaveExecuted,
      isTrue,
    );
    expect(queued.state, SynthesisState.queued); // survives the reconnect
    expect(queued.chargeState, ChargeState.no);
    expect(h.p.afterAbnormal, isTrue);
  });

  test('a sent but unstarted request is lost, never resent', () {
    final h = Harness();
    final a = h.synth('a');
    h.flush();
    h.p.connectionClosed(const CloseInfo(1006), h.now);
    expect(a.state, SynthesisState.lost);
    expect(a.chargeState, ChargeState.unknown);
    expect(chargeStateOf(a.error!), ChargeState.unknown);
    h.p.connectionOpened(h.now);
    expect(h.flush(), isEmpty); // probably charged: never sent again
  });

  group('upstream_error', () {
    test('before any audio it is resent once', () {
      final h = Harness();
      final a = h.synth('a');
      h.flush();
      h.event('error', {
        'code': 'upstream_error',
        'message': 'could not synthesize this text',
        'requestId': 'r1',
      });
      expect(a.state, SynthesisState.queued);
      expect(a.chargeState, ChargeState.no); // refunded
      expect([for (final f in h.flush()) f['requestId']], ['r1']);
      h.event('error', {
        'code': 'upstream_error',
        'message': 'could not synthesize this text',
        'requestId': 'r1',
      });
      expect(a.state, SynthesisState.failed);
      expect(a.error, isA<UpstreamException>());
      expect(a.chargeState, ChargeState.no);
      expect(h.flush(), isEmpty);
    });

    test('mid-stream it fails, keeps the audio, and is charged', () {
      final h = Harness();
      final a = h.synth('a');
      h.flush();
      h.start('r1');
      h.audio();
      h.event('error', {
        'code': 'upstream_error',
        'message': 'stopped during this synthesis',
        'requestId': 'r1',
      });
      expect(a.state, SynthesisState.failed);
      expect(a.chargeState, ChargeState.yes);
      expect(creditsConsumedOf(a.error!), isNull); // no cost reported
      expect(a.chunks, hasLength(1));
      expect(h.flush(), isEmpty);
    });

    test('mid-stream it reports the final cost', () {
      final h = Harness();
      final a = h.synth('a');
      h.flush();
      h.start('r1');
      h.audio();
      h.event('error', {
        'code': 'upstream_error',
        'message': 'stopped',
        'requestId': 'r1',
        'creditsConsumed': 3,
      });
      expect(a.state, SynthesisState.failed);
      expect(a.charged, isTrue);
      expect(a.creditsConsumed, 3.0);
      expect(a.error, isA<UpstreamException>());
      expect(chargeStateOf(a.error!), ChargeState.yes);
      expect(creditsConsumedOf(a.error!), 3.0);
      expect(h.flush(), isEmpty); // charged: never resent
    });

    test('with a cost it is never resent', () {
      final h = Harness();
      final a = h.synth('a');
      h.flush();
      h.event('error', {
        'code': 'upstream_error',
        'message': 'stopped',
        'requestId': 'r1',
        'creditsConsumed': 1,
      });
      expect(a.state, SynthesisState.failed);
      expect(a.resends, 0);
      expect(a.chargeState, ChargeState.yes);
      expect(h.flush(), isEmpty);
    });

    test('on a cancelling request it ends as cancelled', () {
      final h = Harness();
      final a = h.synth('a');
      h.flush();
      h.p.cancel(a, h.now);
      h.flush();
      h.event('error', {
        'code': 'upstream_error',
        'message': 'stopped',
        'requestId': 'r1',
        'creditsConsumed': 1,
      });
      final result = a.result();
      expect(result.outcome, SynthesisOutcome.cancelled);
      expect(result.charged, isTrue);
      expect(result.creditsConsumed, 1.0);
    });

    test('without a request ID it goes to the only request in flight', () {
      final h = Harness();
      final a = h.synth('a');
      h.flush();
      h.event('error', {'code': 'upstream_error', 'message': 'x'});
      expect(a.state, SynthesisState.queued); // resent
      expect(a.resends, 1);
    });
  });

  test('a rejected request leaves the running one, so the SDK cancels it', () {
    final h = Harness();
    final a = h.synth('a');
    h.flush();
    h.start('r1');
    final b = h.synth('');
    h.flush();
    h.event('error', {
      'code': 'validation_failed',
      'message': 'text must be 1 to 500 characters',
      'requestId': 'r2',
    });
    expect(b.state, SynthesisState.failed);
    expect(b.error, isA<InvalidRequestException>());
    expect(b.chargeState, ChargeState.no);
    expect(h.flush(), [
      {'type': 'cancel'},
    ]); // the caller asked for A to stop
    h.event('cancelled', {'requestId': 'r1', 'creditsConsumed': 1});
    expect(a.state, SynthesisState.superseded);
  });

  test('a rejected request does not cancel when a newer one is pending', () {
    final h = Harness();
    h.synth('a');
    h.flush();
    h.start('r1');
    h.synth('');
    h.flush();
    h.synth('c'); // pending; it replaces A on the server
    h.event('error', {
      'code': 'validation_failed',
      'message': 'bad',
      'requestId': 'r2',
    });
    expect([for (final f in h.flush()) f['type']], ['synthesize']);
  });

  test('voice_not_found fails the new request', () {
    final h = Harness();
    final a = h.synth('a');
    h.flush();
    h.start('r1');
    final b = h.synth('b', const SynthesisOptions(voiceId: 'missing'));
    h.flush();
    h.event('cancelled', {'requestId': 'r1', 'creditsConsumed': 1});
    h.event('error', {
      'code': 'voice_not_found',
      'message': 'Voice not found',
      'requestId': 'r2',
    });
    expect(a.state, SynthesisState.superseded);
    expect(b.error, isA<VoiceNotFoundException>());
    expect(b.charged, isFalse);
  });

  test('an unattributable error is attached to the next close', () {
    final h = Harness();
    final a = h.synth('a');
    h.flush();
    h.event('error', {
      'code': 'invalid_message',
      'message': 'frame is not valid JSON',
    });
    expect(a.state, SynthesisState.sent);
    h.p.connectionClosed(
      const CloseInfo(1008, reason: 'invalid_message'),
      h.now,
    );
    expect(a.error, isA<ProtocolException>());
    expect(
      (a.error! as ProtocolException).errorMessage,
      'frame is not valid JSON',
    );
    expect(h.p.fatal, isA<ProtocolException>());
    expect(() => h.synth('again'), throwsA(isA<SessionEndedException>()));
  });

  test('a held error expires after 1 s', () {
    final h = Harness();
    h.event('error', {'code': 'invalid_message', 'message': 'x'});
    expect(h.p.nextDeadline(), h.now + const Duration(seconds: 1));
    h.tick(const Duration(seconds: 1));
    expect(h.p.nextDeadline(), isNull);
  });

  test('a billing close fails everything', () {
    final h = Harness();
    final a = h.synth('a');
    h.flush();
    h.start('r1');
    final queued = h.enqueue('b');
    h.p.connectionClosed(
      const CloseInfo(4002, reason: 'insufficient_balance'),
      h.now,
    );
    expect(a.error, isA<InsufficientBalanceException>());
    expect(a.state, SynthesisState.failed);
    expect(queued.error, isA<InsufficientBalanceException>());
    expect(queued.chargeState, ChargeState.no);
    expect(h.p.nextOutbound(h.now), isNull);
  });

  test('session expiry and restart closes are lazy reconnects', () {
    final h = Harness();
    final a = h.synth('a');
    h.flush();
    h.p.connectionClosed(
      const CloseInfo(4008, reason: 'max_duration'),
      h.now,
    );
    expect(a.error, isA<SessionExpiredException>());
    expect(h.p.fatal, isNull);
    expect(h.p.afterAbnormal, isFalse);
    h.p.connectionOpened(h.now);
    final b = h.synth('b');
    h.flush();
    h.p.connectionClosed(
      const CloseInfo(1001, reason: 'server_restarting'),
      h.now,
    );
    expect(b.error, isA<ServerRestartingException>());
    expect(h.p.afterAbnormal, isTrue);
  });

  test('a local close ends in-flight requests as cancelled', () {
    final h = Harness();
    final a = h.synth('a');
    h.flush();
    h.start('r1');
    final queued = h.enqueue('b');
    h.p.close(h.now);
    expect(queued.state, SynthesisState.cancelled);
    h.p.connectionClosed(const CloseInfo(1000, local: true), h.now);
    expect(a.state, SynthesisState.cancelled);
    expect(a.charged, isTrue);
  });

  test('enqueue sends the next only after done', () {
    final h = Harness();
    final a = h.enqueue('a');
    final b = h.enqueue('b');
    expect([for (final f in h.flush()) f['text']], ['a']);
    h.start('r1');
    expect(h.flush(), isEmpty);
    h.done('r1');
    expect([for (final f in h.flush()) f['text']], ['b']);
    expect(a.state, SynthesisState.completed);
    expect(b.state, SynthesisState.sent);
  });

  test('synthesize clears the queue', () {
    final h = Harness();
    final a = h.enqueue('a');
    h.flush();
    final b = h.enqueue('b');
    final c = h.synth('c');
    expect(b.state, SynthesisState.superseded);
    expect(b.charged, isFalse);
    expect(a.state, SynthesisState.cancelling);
    expect([for (final f in h.flush()) f['text']], ['c']);
    expect(c.state, SynthesisState.sent);
  });

  test('interrupt cancels and drops the queue', () {
    final h = Harness();
    final a = h.enqueue('a');
    final b = h.enqueue('b');
    h.flush();
    h.start('r1');
    h.p.interrupt(h.now);
    expect(b.state, SynthesisState.cancelled);
    expect(h.flush(), [
      {'type': 'cancel'},
    ]);
    h.event('cancelled', {'requestId': 'r1', 'creditsConsumed': 1});
    expect(a.state, SynthesisState.cancelled);
    expect(h.p.idle, isTrue);
  });

  test('a cancel during the send is sent after the request', () {
    final h = Harness();
    final a = h.synth('a');
    final item = h.p.nextOutbound(h.now)!; // being written...
    h.p.cancel(a, h.now); // ...when the caller cancels
    h.p.sent(item, h.now);
    expect(a.state, SynthesisState.cancelling);
    expect(h.flush(), [
      {'type': 'cancel'},
    ]);
  });

  test('a request written while the socket closed is lost', () {
    final h = Harness();
    final a = h.synth('a');
    final item = h.p.nextOutbound(h.now)!;
    h.p.connectionClosed(const CloseInfo(1006), h.now);
    h.p.sent(item, h.now);
    expect(a.state, SynthesisState.lost);
    expect(a.chargeState, ChargeState.unknown);
  });

  test('requeue sends it on the next socket', () {
    final h = Harness();
    final a = h.synth('a');
    final item = h.p.nextOutbound(h.now)!;
    h.p.connectionClosed(const CloseInfo(1006), h.now);
    h.p.requeue(item, h.now);
    h.p.connectionOpened(h.now);
    expect([for (final f in h.flush()) f['requestId']], ['r1']);
    expect(a.state, SynthesisState.sent);
  });

  test('unknown events are kept', () {
    final h = Harness();
    h.event('brand.new', {'x': 1});
    expect(h.p.unknownEvents.first.type, 'brand.new');
  });

  group('sentence splitter', () {
    test('splits at sentence marks', () {
      final splitter = SentenceSplitter();
      const text = 'Hello there. It costs 3.5 dollars! Really? '
          'مرحبا، كيف حالك؟ تمام؛ شكرا\nnext line';
      expect([
        ...splitter.push(text),
        ...splitter.flush()
      ], [
        'Hello there.',
        'It costs 3.5 dollars!',
        'Really?',
        'مرحبا،',
        'كيف حالك؟',
        'تمام؛',
        'شكرا',
        'next line',
      ]);
    });

    test('streams deltas', () {
      final splitter = SentenceSplitter();
      final out = <String>[];
      for (final delta in ['Hel', 'lo.', ' How a', 're you', '? Fine', '...']) {
        out.addAll(splitter.push(delta));
      }
      expect(out, ['Hello.', 'How are you?']);
      expect(splitter.flush(), ['Fine...']);
    });

    test('caps the length and skips punctuation', () {
      final splitter = SentenceSplitter();
      final long = '${List.filled(150, 'word').join(' ')}.';
      final pieces = [...splitter.push('$long ... '), ...splitter.flush()];
      expect(pieces.every((p) => p.length <= 500), isTrue);
      expect(pieces.join(' ').split(' '), long.split(' '));
      expect(SentenceSplitter().push('! ? '), isEmpty);
      expect(
        [for (final p in SentenceSplitter().push('x' * 1200)) p.length],
        [500, 500],
      );
    });
  });
}
