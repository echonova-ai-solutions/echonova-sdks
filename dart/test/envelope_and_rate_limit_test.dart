import 'dart:convert';

import 'package:echonova_ai/src/core/envelope.dart';
import 'package:echonova_ai/src/core/rate_limit.dart';
import 'package:test/test.dart';

class FakeClock {
  Duration now = const Duration(seconds: 1000);
  Duration call() => now;
}

void main() {
  group('unwrapSuccess', () {
    test('returns data', () {
      final body = utf8.encode(jsonEncode({
        'data': {'jobId': 'a1'},
        'success': true,
        'statusCode': 200,
        'errorMessage': null,
      }));
      expect(unwrapSuccess(body), {'jobId': 'a1'});
    });

    test('accepts null data and a byte-order mark', () {
      expect(unwrapSuccess(utf8.encode('﻿{"data": null}')), isNull);
    });

    for (final body in [
      '<html>oops</html>',
      '[1, 2]',
      '{"jobId": "a1"}',
      '{"data": null, "success": false}',
      '',
    ]) {
      test('rejects ${jsonEncode(body)}', () {
        expect(
          () => unwrapSuccess(utf8.encode(body)),
          throwsA(isA<MalformedEnvelope>()),
        );
      });
    }

    test('rejects invalid UTF-8', () {
      expect(
        () => unwrapSuccess([0x7B, 0xFF, 0x7D]),
        throwsA(isA<MalformedEnvelope>()),
      );
    });
  });

  group('parseErrorBody', () {
    test('keeps unknown fields out of the way', () {
      final parsed = parseErrorBody(utf8.encode(jsonEncode({
        'data': null,
        'success': false,
        'statusCode': 400,
        'errorMessage': 'a, b',
        'docs': 'd',
        'newField': 1,
      })));
      expect(parsed.isJson, isTrue);
      expect(parsed.errorMessage, 'a, b');
      expect(parsed.docsUrl, 'd');
      expect(parsed.errorCode, isNull);
    });

    test('non-JSON bodies become a trimmed message', () {
      final parsed = parseErrorBody(utf8.encode('  no healthy upstream  '));
      expect(parsed.isJson, isFalse);
      expect(parsed.errorMessage, 'no healthy upstream');
      expect(parsed.rawBody, '  no healthy upstream  ');
    });

    test('an empty body has no message', () {
      final parsed = parseErrorBody(const []);
      expect(parsed.isJson, isFalse);
      expect(parsed.errorMessage, isNull);
      expect(parsed.rawBody, isNull);
    });

    test('non-string fields are ignored', () {
      final parsed = parseErrorBody(utf8.encode(
        '{"success": false, "errorMessage": 5, "errorCode": [], "docs": {}}',
      ));
      expect(parsed.isJson, isTrue);
      expect(parsed.errorMessage, isNull);
      expect(parsed.errorCode, isNull);
      expect(parsed.docsUrl, isNull);
    });

    test('JSON that is not an envelope is treated as text', () {
      final parsed = parseErrorBody(utf8.encode('{"message": "nope"}'));
      expect(parsed.isJson, isFalse);
      expect(parsed.errorMessage, '{"message": "nope"}');
    });

    test('the raw body is capped at 4 KiB, the message at 500 characters', () {
      // Characters outside the BMP count once, as in every SDK.
      final text = '😀' * 3000;
      final parsed = parseErrorBody(utf8.encode(text));
      expect(parsed.errorMessage!.runes.length, nonJsonMessageLimit);
      expect(utf8.encode(parsed.rawBody!).length, rawBodyLimit);
    });

    test('a multi-byte character cut by the cap is replaced', () {
      final parsed = parseErrorBody(utf8.encode('a${'é' * 3000}'));
      expect(parsed.rawBody, endsWith('�'));
    });
  });

  group('parseRetryAfter', () {
    for (final (value, expected) in [
      ('30', const Duration(seconds: 30)),
      ('0', Duration.zero),
      ('1.5', const Duration(milliseconds: 1500)),
      (' 7 ', const Duration(seconds: 7)),
      (null, null),
      ('soon', null),
      ('-4', Duration.zero),
    ]) {
      test('$value', () => expect(parseRetryAfter(value), expected));
    }

    test('an HTTP date', () {
      final now = DateTime.utc(2026, 11, 5, 12);
      expect(
        parseRetryAfter('Thu, 05 Nov 2026 12:00:45 GMT', now: now),
        const Duration(seconds: 45),
      );
      expect(
        parseRetryAfter('Thu, 05 Nov 2026 11:00:00 GMT', now: now),
        Duration.zero,
      );
    });

    test('other HTTP date formats', () {
      final when = DateTime.utc(1994, 11, 6, 8, 49, 37);
      expect(parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT'), when);
      expect(parseHttpDate('Sunday, 06-Nov-94 08:49:37 GMT'), when);
      expect(parseHttpDate('Sun Nov  6 08:49:37 1994'), when);
      expect(parseHttpDate('Sun, 06 Nov 1994 10:49:37 +0200'), when);
      expect(parseHttpDate('06 Nov 1994 08:49:37'), when);
      expect(parseHttpDate('Sun, 06 Foo 1994 08:49:37 GMT'), isNull);
      expect(parseHttpDate('tomorrow'), isNull);
    });

    test('huge and infinite values are clamped', () {
      expect(parseRetryAfter('Infinity')!.inDays, greaterThan(365));
      expect(parseRetryAfter('1e300')!.inDays, greaterThan(365));
      expect(parseRetryAfter('NaN'), Duration.zero);
    });
  });

  test('header lookup is case-insensitive', () {
    expect(header({'X-Request-Id': 'abc'}, 'x-request-id'), 'abc');
    expect(header({'x-request-id': 'abc'}, 'X-Request-Id'), 'abc');
    expect(header(const {}, 'x-request-id'), isNull);
  });

  group('rate limits', () {
    test('headers are parsed', () {
      final info = parseRateLimit({
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': '7',
        'X-RateLimit-Reset': '42',
      })!;
      expect(info.limit, 100);
      expect(info.remaining, 7);
      expect(info.reset, const Duration(seconds: 42));
      expect(parseRateLimit(const {}), isNull);
      expect(parseRateLimit({'x-ratelimit-remaining': 'many'}), isNull);
    });

    test('preflight waits for the window when nothing remains', () {
      final clock = FakeClock();
      final tracker = RateLimitTracker(clock: clock.call);
      tracker.observe('tts.jobs.get', {
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '20',
      });
      expect(tracker.waitTime('tts.jobs.get'), const Duration(seconds: 20));
      expect(tracker.waitTime('tts.jobs.get', preflight: false), Duration.zero);
      // Other endpoints have their own bucket.
      expect(tracker.waitTime('tts.jobs.list'), Duration.zero);
      clock.now += const Duration(seconds: 21);
      expect(tracker.waitTime('tts.jobs.get'), Duration.zero);
    });

    test('a window with requests left needs no wait', () {
      final tracker = RateLimitTracker(clock: FakeClock().call);
      tracker.observe('b', {
        'X-RateLimit-Remaining': '3',
        'X-RateLimit-Reset': '20',
      });
      expect(tracker.waitTime('b'), Duration.zero);
      expect(tracker.last('b')!.remaining, 3);
      expect(tracker.snapshot().keys, ['b']);
    });

    test('a throttle block applies even without preflight', () {
      final clock = FakeClock();
      final tracker = RateLimitTracker(clock: clock.call);
      tracker.block('stt.transcribe', const Duration(seconds: 60));
      clock.now += const Duration(seconds: 15);
      expect(
        tracker.waitTime('stt.transcribe', preflight: false),
        const Duration(seconds: 45),
      );
      // A shorter block never shortens the current one.
      tracker.block('stt.transcribe', const Duration(seconds: 10));
      expect(tracker.waitTime('stt.transcribe'), const Duration(seconds: 45));
      // Blocks don't count as observed headers.
      expect(tracker.snapshot(), isEmpty);
    });

    test('the default clock is monotonic', () {
      final tracker = RateLimitTracker();
      tracker.block('b', const Duration(seconds: 30));
      final wait = tracker.waitTime('b');
      expect(wait, greaterThan(const Duration(seconds: 29)));
      expect(wait, lessThanOrEqualTo(const Duration(seconds: 30)));
    });
  });
}
