/// Transport rules: frame limits, keepalive and liveness timing, attempt
/// limits, handshake retries, the close-code map.
library;

import 'dart:convert';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:echonova_ai/src/core/classifier.dart';
import 'package:echonova_ai/src/core/retry.dart';
import 'package:echonova_ai/src/streaming/link.dart';
import 'package:echonova_ai/src/streaming/options.dart';
import 'package:echonova_ai/src/streaming/stream_errors.dart';
import 'package:test/test.dart';

Duration s(num seconds) =>
    Duration(microseconds: (seconds * Duration.microsecondsPerSecond).round());

APIStatusException rejection(
  int status,
  String? message, {
  Map<String, String> headers = const {},
  String? rawBody,
}) =>
    buildStatusError(
      status,
      {'x-request-id': 'r1', ...headers},
      rawBody != null
          ? utf8.encode(rawBody)
          : utf8.encode(jsonEncode({
              'data': null,
              'success': false,
              'statusCode': status,
              'errorMessage': message,
            })),
      method: 'WS',
      transport: TransportKind.websocket,
    );

HandshakeRetry retry({
  Duration? waitForSlot,
  bool afterAbnormal = false,
}) =>
    HandshakeRetry(
      RetryPolicy(random: () => 0),
      now: Duration.zero,
      waitForSlot: waitForSlot,
      afterAbnormal: afterAbnormal,
      slotWaitAfterLoss: s(90),
    );

void main() {
  group('frames', () {
    test('JSON frames over 64 KiB throw a usage exception', () {
      expect(
        encodeJson({'type': 'synthesize', 'text': 'x' * 1000}),
        contains('"text"'),
      );
      expect(
        () => encodeJson(
            {'type': 'terminology', 'blob': 'x' * maxJsonFrameBytes}),
        throwsA(isA<UsageException>()
            .having((e) => e.message, 'message', contains('terminology'))),
      );
    });

    test('the size counts UTF-8 bytes', () {
      // 22,000 three-byte characters are 66,000 bytes.
      expect(
        () => encodeJson({'type': 'synthesize', 'text': '€' * 22000}),
        throwsA(isA<UsageException>()),
      );
    });

    test('decoding never throws', () {
      expect(decodeEvent('{"type":"pong"}'), {'type': 'pong'});
      expect(decodeEvent('not json'), {'raw_text': 'not json'});
      expect(decodeEvent('[1,2]'), {
        'raw_value': [1, 2],
      });
    });
  });

  group('liveness', () {
    Liveness liveness() => Liveness(
          Duration.zero,
          keepalive: s(30),
          pongTimeout: s(15),
          silenceTimeout: s(60),
        );

    test('pings after 30 s without sending', () {
      final l = liveness();
      expect(l.poll(s(29.9)), isNull);
      expect(l.poll(s(30)), LinkAction.ping);
      expect(l.nextDeadline(), s(30));
    });

    test('data frames postpone the ping', () {
      final l = liveness()..sent(s(20));
      expect(l.poll(s(30)), isNull);
      expect(l.nextDeadline(), s(50));
      expect(l.poll(s(50)), LinkAction.ping);
    });

    test('no pong within 15 s is a lost connection', () {
      final l = liveness()
        ..pingSent(s(30))
        ..received(s(40)); // something else arrived, but not the pong
      expect(l.poll(s(44.9)), isNull);
      expect(l.nextDeadline(), s(45));
      expect(l.poll(s(45)), LinkAction.lostPong);
      expect(l.describe(LinkAction.lostPong), contains('15 s'));
    });

    test('a pong clears the ping', () {
      final l = liveness()
        ..pingSent(s(30))
        ..pong(s(31));
      expect(l.poll(s(50)), isNull);
      expect(l.poll(s(60)), LinkAction.ping);
    });

    test('silence for 60 s is a lost connection', () {
      final l = liveness();
      for (var t = 0; t < 60; t += 10) {
        l.sent(s(t));
      }
      expect(l.poll(s(60)), LinkAction.lostSilence);
      expect(l.describe(LinkAction.lostSilence), contains('60 s'));
    });

    test('keepalive null turns everything off', () {
      final l = Liveness(
        Duration.zero,
        keepalive: null,
        pongTimeout: s(15),
        silenceTimeout: s(60),
      );
      expect(l.poll(s(1000)), isNull);
      expect(l.nextDeadline(), isNull);
    });
  });

  test('at most 6 attempts per 60 s', () {
    final limiter = AttemptLimiter();
    for (var i = 0; i < 6; i++) {
      expect(limiter.waitTime(s(i)), Duration.zero);
      limiter.record(s(i));
    }
    expect(limiter.waitTime(s(10)), s(50));
    expect(limiter.waitTime(s(60)), Duration.zero); // the first one left
    final error = limiter.error();
    expect(error, isA<APIConnectionException>());
    expect(error.retryDisabledReason, 'attempt_limit');
  });

  group('handshake retries', () {
    test('401 is not retried', () {
      expect(
        () => retry().onStatus(rejection(401, 'Unauthorized'), Duration.zero),
        throwsA(isA<AuthenticationException>()
            .having((e) => e.transport, 'transport', TransportKind.websocket)
            .having((e) => e.requestId, 'requestId', 'r1')),
      );
    });

    for (final (status, message, matcher) in [
      (
        402,
        'Insufficient subscription balance',
        isA<InsufficientBalanceException>(),
      ),
      (429, 'Monthly spending limit exhausted', isA<SpendingLimitException>()),
      (503, 'Streaming is not enabled', isA<FeatureNotEnabledException>()),
      (
        403,
        'Workspace is not active',
        isA<PermissionDeniedException>(),
      ),
    ]) {
      test('$status "$message" is not retried', () {
        expect(
          () => retry().onStatus(rejection(status, message), Duration.zero),
          throwsA(matcher),
        );
      });
    }

    test('a throttle waits Retry-After, then gives up', () {
      final policy = retry();
      final error = rejection(
        429,
        'ThrottlerException: Too Many Requests',
        headers: {'retry-after': '3'},
      );
      expect(policy.onStatus(error, Duration.zero), s(3));
      expect(policy.onStatus(error, s(3)), s(3));
      expect(
        () => policy.onStatus(error, s(6)),
        throwsA(isA<RateLimitException>()),
      );
    });

    test('a throttle with a long Retry-After is not retried', () {
      expect(
        () => retry().onStatus(
          rejection(
            429,
            'ThrottlerException: Too Many Requests',
            headers: {'retry-after': '45'},
          ),
          Duration.zero,
        ),
        throwsA(isA<RateLimitException>()),
      );
    });

    test('a concurrency 429 needs waitForSlot', () {
      final error = rejection(429, 'Too many concurrent streams');
      expect(
        () => retry().onStatus(error, Duration.zero),
        throwsA(isA<ConcurrencyLimitException>()),
      );
      final waiting = retry(waitForSlot: s(5));
      var now = Duration.zero;
      for (var i = 0; i < 4; i++) {
        now += waiting.onStatus(error, now);
      }
      expect(now, lessThanOrEqualTo(s(5)));
      expect(
        () => retry(waitForSlot: s(5)).onStatus(error, s(10)),
        throwsA(isA<ConcurrencyLimitException>()), // past the 5 s budget
      );
    });

    test('a concurrency 429 is retried for 90 s after an abnormal loss', () {
      final error = rejection(429, 'Too many concurrent streams');
      final policy = retry(afterAbnormal: true);
      expect(policy.onStatus(error, s(1)), greaterThan(Duration.zero));
      expect(policy.mayWait(s(1), s(30)), isTrue);
      expect(policy.mayWait(s(1), s(95)), isFalse);
      expect(
        () => policy.onStatus(error, s(89.999)),
        throwsA(isA<ConcurrencyLimitException>()),
      );
    });

    test('a non-JSON 503 is retried twice', () {
      final policy = retry();
      final error = rejection(503, null, rawBody: '<html>busy</html>');
      expect(policy.onStatus(error, Duration.zero), s(0.25));
      expect(policy.onStatus(error, Duration.zero), s(0.5));
      expect(
        () => policy.onStatus(error, Duration.zero),
        throwsA(isA<ServiceUnavailableException>()),
      );
    });

    test('network errors are retried twice, then thrown', () {
      final policy = retry();
      final error = APIConnectionException('refused');
      expect(policy.onNetwork(error), greaterThanOrEqualTo(Duration.zero));
      expect(policy.onNetwork(error), greaterThanOrEqualTo(Duration.zero));
      expect(() => policy.onNetwork(error), throwsA(same(error)));
    });

    test('a bad upgrade without a rule counts as a network failure', () {
      final policy = retry();
      final error = ProtocolException(statusCode: 200);
      expect(policy.onStatus(error, Duration.zero), s(0.25));
    });
  });

  group('error frames and closes', () {
    test('error frames map to classes', () {
      final error = errorFromFrame({
        'type': 'error',
        'code': 'upstream_error',
        'message': 'boom',
        'requestId': 'r',
      });
      expect(error, isA<UpstreamException>());
      expect(error.errorCode, 'upstream_error');
      expect(error.errorMessage, 'boom');
      expect(error.requestId, 'r');
      expect(error.transport, TransportKind.websocket);
      expect(errorFromFrame({'code': 'validation_failed'}),
          isA<InvalidRequestException>());
      expect(errorFromFrame({'code': 'voice_not_found'}),
          isA<VoiceNotFoundException>());
      expect(errorFromFrame({'code': 'frame_too_large'}),
          isA<ProtocolException>());
      expect(
        errorFromFrame({'code': 'brand_new'}).runtimeType,
        APIStatusException,
      );
    });

    for (final (info, ended, expected) in <(CloseInfo, bool, Type?)>[
      (const CloseInfo(1000), true, null),
      (const CloseInfo(1000), false, StreamClosedException),
      (const CloseInfo(1006), false, StreamConnectionLostException),
      (
        const CloseInfo(1000, lostReason: 'no pong within 15 s'),
        false,
        StreamConnectionLostException
      ),
      (const CloseInfo(1001), false, ServerRestartingException),
      (const CloseInfo(1002), false, ProtocolException),
      (const CloseInfo(1007), false, ProtocolException),
      (
        const CloseInfo(1008, reason: 'invalid_message'),
        false,
        ProtocolException
      ),
      (const CloseInfo(1009), false, ProtocolException),
      (const CloseInfo(1011), false, UpstreamException),
      (const CloseInfo(4002), true, InsufficientBalanceException),
      (const CloseInfo(4029), true, SpendingLimitException),
      (const CloseInfo(4008, reason: 'max_duration'), true, null),
      (
        const CloseInfo(4008, reason: 'idle_timeout'),
        false,
        SessionExpiredException
      ),
      (const CloseInfo(4999), false, StreamClosedException),
      (const CloseInfo(1000, local: true), false, null),
    ]) {
      test('close $info (session.ended: $ended) -> $expected', () {
        final error = closeError(info, endedNormally: ended);
        if (expected == null) {
          expect(error, isNull);
          return;
        }
        expect(error.runtimeType, expected);
        if (info.lostReason != null) return;
        switch (error) {
          case APIStatusException(:final closeCode):
            expect(closeCode, info.code);
          case StreamClosedException(:final closeCode):
            expect(closeCode, info.code);
          default:
            break;
        }
      });
    }

    test('a close carries the preceding error frame', () {
      final error = closeError(
        const CloseInfo(1008, reason: 'frame_too_large'),
        lastError: {
          'type': 'error',
          'code': 'frame_too_large',
          'message': 'frames must be at most 64 KiB',
        },
      );
      expect(
        error,
        isA<ProtocolException>()
            .having((e) => e.errorCode, 'errorCode', 'frame_too_large')
            .having((e) => e.errorMessage, 'errorMessage',
                'frames must be at most 64 KiB')
            .having((e) => e.closeCode, 'closeCode', 1008),
      );
    });

    test('the abnormal flag', () {
      expect(const CloseInfo(1006).abnormal, isTrue);
      expect(const CloseInfo(1001).abnormal, isTrue);
      expect(const CloseInfo(1000, lostReason: 'silence').abnormal, isTrue);
      expect(const CloseInfo(1011).abnormal, isFalse);
      expect(const CloseInfo(4008).abnormal, isFalse);
    });
  });

  group('URLs', () {
    for (final (base, expected) in [
      (
        'wss://api.echonova.ai',
        'wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&language=ar',
      ),
      (
        'https://api.echonova.ai/',
        'wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&language=ar',
      ),
      (
        'https://api.echonova.ai/v1',
        'wss://api.echonova.ai/v1/speech-to-text/stream?sample_rate=16000&language=ar',
      ),
      (
        'http://127.0.0.1:9000',
        'ws://127.0.0.1:9000/v1/speech-to-text/stream?sample_rate=16000&language=ar',
      ),
      (
        'https://proxy.example/echonova',
        'wss://proxy.example/echonova/v1/speech-to-text/stream?sample_rate=16000&language=ar',
      ),
    ]) {
      test(base, () {
        final options = StreamOptions(wsBaseUri: Uri.parse(base));
        expect(
          options.url(sttStreamPath,
              {'sample_rate': '16000', 'language': 'ar'}).toString(),
          expected,
        );
      });
    }

    test('a bad base URL is a usage exception', () {
      expect(
        () => StreamOptions(wsBaseUri: Uri.parse('ftp://x')).url(ttsStreamPath),
        throwsA(isA<UsageException>()),
      );
    });
  });

  test('reconnect delays double up to the maximum', () {
    const policy = ReconnectPolicy();
    expect(policy.delay(1), s(0.5));
    expect(policy.delay(2), s(1));
    expect(policy.delay(10), s(8));
  });
}
