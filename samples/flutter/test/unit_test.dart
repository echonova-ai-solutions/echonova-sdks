// Configuration, proxy sign-in, error messages and the audio helpers.

import 'dart:convert';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:echonova_sample/src/audio/pcm.dart';
import 'package:echonova_sample/src/audio/pcm_player.dart';
import 'package:echonova_sample/src/config.dart';
import 'package:echonova_sample/src/errors.dart';
import 'package:echonova_sample/src/format.dart';
import 'package:echonova_sample/src/proxy_auth.dart';
import 'package:echonova_sample/src/stt/pause_detector.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'fakes.dart';

void main() {
  group('AppConfig', () {
    AppConfig parse({
      String url = '',
      String token = 'demo',
      bool isWeb = false,
      TargetPlatform platform = TargetPlatform.iOS,
      bool isRelease = false,
    }) => AppConfig.parse(
      proxyUrl: url,
      demoToken: token,
      isWeb: isWeb,
      platform: platform,
      isRelease: isRelease,
    );

    test(
      'defaults to a proxy on this computer, as each platform reaches it',
      () {
        expect(
          parse(platform: TargetPlatform.android).proxyUrl.toString(),
          'http://10.0.2.2:8080/echonova',
        );
        expect(parse().proxyUrl.toString(), 'http://127.0.0.1:8080/echonova');
        expect(
          parse(
            isWeb: true,
            platform: TargetPlatform.android,
          ).proxyUrl.toString(),
          'http://localhost:8080/echonova',
        );
      },
    );

    test('takes the proxy URL given', () {
      expect(
        parse(url: ' https://api.example.com/echonova ').proxyUrl.toString(),
        'https://api.example.com/echonova',
      );
    });

    test('refuses an API key in the app', () {
      expect(
        () => parse(token: 'ek_REDACTED_flutter_test'),
        throwsA(
          isA<ConfigException>().having(
            (e) => e.message,
            'message',
            contains('API key'),
          ),
        ),
      );
    });

    test('refuses to call the API directly', () {
      expect(
        () => parse(url: 'https://api.echonova.ai'),
        throwsA(isA<ConfigException>()),
      );
    });

    test('refuses a URL that is not absolute http(s)', () {
      for (final url in ['api.example.com', 'ftp://example.com/x', '::']) {
        expect(
          () => parse(url: url),
          throwsA(isA<ConfigException>()),
          reason: url,
        );
      }
    });

    test('needs https in release builds, except to this computer', () {
      expect(
        () => parse(url: 'http://api.example.com/echonova', isRelease: true),
        throwsA(isA<ConfigException>()),
      );
      expect(parse(isRelease: true).proxyUrl.scheme, 'http');
    });
  });

  group('DemoTokenAuth', () {
    test('sends the token as a bearer token', () async {
      expect(await const DemoTokenAuth('change-me').headers(), {
        'Authorization': 'Bearer change-me',
      });
    });

    test('explains a missing token', () {
      expect(
        const DemoTokenAuth('').headers(),
        throwsA(
          isA<ProxyAuthException>().having(
            (e) => e.message,
            'message',
            contains('PROXY_DEMO_TOKEN'),
          ),
        ),
      );
    });
  });

  group('StreamTokens', () {
    test('asks the proxy for a token with the app credentials', () async {
      late http.Request sent;
      final tokens = StreamTokens(
        Uri.parse('http://localhost:8080/echonova/'),
        const DemoTokenAuth('change-me'),
        httpClient: () => MockClient((request) async {
          sent = request;
          return http.Response(
            jsonEncode({'token': 'short-lived', 'expiresIn': 60}),
            200,
          );
        }),
      );
      expect(await tokens.query(), {'access_token': 'short-lived'});
      expect(sent.method, 'POST');
      expect(
        sent.url.toString(),
        'http://localhost:8080/echonova/stream-token',
      );
      expect(sent.headers['Authorization'], 'Bearer change-me');
    });

    test('reports a refusal', () {
      final tokens = StreamTokens(
        Uri.parse('http://localhost:8080/echonova'),
        const DemoTokenAuth('wrong'),
        httpClient: () =>
            MockClient((_) async => http.Response('{"success": false}', 401)),
      );
      expect(
        tokens.query(),
        throwsA(
          isA<ProxyAuthException>().having(
            (e) => e.message,
            'message',
            contains('401'),
          ),
        ),
      );
    });
  });

  group('describeError', () {
    test('explains the common SDK errors', () {
      expect(
        describeError(AuthenticationException(statusCode: 401)),
        contains('credentials'),
      );
      expect(
        describeError(
          RateLimitException(
            statusCode: 429,
            retryAfter: const Duration(seconds: 3),
          ),
        ),
        contains('3 s'),
      );
      expect(
        describeError(APIConnectionException('connection refused')),
        contains('Could not reach the proxy'),
      );
      expect(
        describeError(
          InvalidRequestException(
            statusCode: 422,
            errorMessage: 'text is too long',
            requestId: 'req_9',
          ),
        ),
        'text is too long (HTTP 422). Request ID: req_9.',
      );
      expect(describeError(UsageException('bad call')), 'bad call');
      expect(describeError(StateError('odd')), contains('odd'));
    });
  });

  group('PCM16', () {
    test('converts samples to floats', () {
      final floats = pcm16ToFloat32(
        Uint8List.fromList([
          ...pcm(1, value: 16384),
          ...pcm(1, value: -32768),
          ...pcm(1),
        ]),
      );
      expect(floats, [0.5, -1.0, 0.0]);
    });

    test('measures loudness', () {
      expect(pcm16Rms(Uint8List.fromList(pcm(10))), 0);
      expect(
        pcm16Rms(Uint8List.fromList(pcm(10, value: 16384))),
        closeTo(0.5, 1e-9),
      );
    });

    test('rejoins samples split across chunks', () {
      final joiner = Pcm16Joiner();
      final bytes = Uint8List.fromList(pcm(3, value: 0x0102));
      expect(joiner.add(Uint8List.sublistView(bytes, 0, 3)), [2, 1]);
      expect(joiner.add(Uint8List.sublistView(bytes, 3, 4)), [2, 1]);
      expect(joiner.add(Uint8List.sublistView(bytes, 4, 5)), isEmpty);
      expect(joiner.add(Uint8List.sublistView(bytes, 5, 6)), [2, 1]);
    });

    test('times audio', () {
      expect(pcm16Duration(32000, 16000), const Duration(seconds: 1));
    });
  });

  group('PauseDetector', () {
    // 100 ms chunks at 16 kHz.
    Uint8List chunk({bool loud = false}) =>
        Uint8List.fromList(pcm(1600, value: loud ? 8000 : 50));

    test('fires once a pause follows enough speech', () {
      final detector = PauseDetector(sampleRate: 16000);
      final fired = [
        for (var i = 0; i < 3; i++) detector.add(chunk(loud: true)),
        for (var i = 0; i < 7; i++) detector.add(chunk()),
      ];
      expect(fired.where((f) => f), hasLength(1));
      expect(fired.last, isTrue);
      expect(detector.add(chunk()), isFalse); // no speech since
    });

    test('ignores a blip shorter than minSpeech', () {
      final detector = PauseDetector(sampleRate: 16000);
      expect(detector.add(chunk(loud: true)), isFalse);
      expect([
        for (var i = 0; i < 20; i++) detector.add(chunk()),
      ], everyElement(isFalse));
    });
  });

  group('PlaybackClock', () {
    test('plays chunks back to back and completes when they have played', () {
      fakeAsync((async) {
        final clock = PlaybackClock(now: () => async.elapsed);
        clock
          ..add(const Duration(milliseconds: 300))
          ..add(const Duration(milliseconds: 200));
        expect(clock.remaining, const Duration(milliseconds: 500));

        var drained = false;
        clock.drained().then((_) => drained = true);
        async.elapse(const Duration(milliseconds: 499));
        expect(drained, isFalse);
        async.elapse(const Duration(milliseconds: 1));
        expect(drained, isTrue);

        // After a gap, the next chunk plays from now.
        async.elapse(const Duration(seconds: 1));
        clock.add(const Duration(milliseconds: 100));
        expect(clock.remaining, const Duration(milliseconds: 100));
      });
    });

    test('reset ends the wait at once', () {
      fakeAsync((async) {
        final clock = PlaybackClock(now: () => async.elapsed)
          ..add(const Duration(seconds: 5));
        var drained = false;
        clock.drained().then((_) => drained = true);
        clock.reset();
        async.flushMicrotasks();
        expect(drained, isTrue);
        expect(clock.remaining, Duration.zero);
      });
    });
  });

  test('formatNumber keeps at most two decimals', () {
    expect(formatNumber(3), '3');
    expect(formatNumber(0.5), '0.5');
    expect(formatNumber(12.256), '12.26');
    expect(formatNumber(100), '100');
  });
}
