import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:echonova_ai/echonova_ai.dart';
import 'package:test/test.dart';

import 'support/spec.dart';

final vectors = maps(loadSpecMap('fixtures/webhooks/vectors.json')['vectors']);

Map<String, Object?> vector(String name) =>
    vectors.firstWhere((v) => v['name'] == name);

Map<String, String> headersOf(Map<String, Object?> v) =>
    (v['headers']! as Map).cast<String, String>();

List<String> secretsOf(Map<String, Object?> v) =>
    (v['secrets']! as List<Object?>).cast<String>();

DateTime nowOf(Map<String, Object?> v) =>
    DateTime.fromMillisecondsSinceEpoch((v['now']! as int) * 1000, isUtc: true);

List<int> bodyOf(Map<String, Object?> v) => utf8.encode(v['body']! as String);

WebhookEvent verifyVector(Map<String, Object?> v) => verifyWebhook(
      bodyOf(v),
      headersOf(v),
      secretsOf(v),
      tolerance: Duration(seconds: v['tolerance_seconds']! as int),
      now: nowOf(v),
    );

const testSecret = 'whsec_TEST0000000000000000000000000000000000000000';

/// Signs [body] like EchoNova does.
Map<String, String> signed(String event, String body, {int timestamp = 1000}) {
  final message = utf8.encode('$timestamp.$body');
  final signature = Hmac(sha256, utf8.encode(testSecret)).convert(message);
  return {
    'X-Webhook-Event': event,
    'X-Webhook-Timestamp': '$timestamp',
    'X-Webhook-Signature': '$signature',
  };
}

WebhookEvent verifySigned(String event, Object payload) {
  final body = jsonEncode(payload);
  return verifyWebhook(
    utf8.encode(body),
    signed(event, body),
    [testSecret],
    now: DateTime.fromMillisecondsSinceEpoch(1000 * 1000),
  );
}

String typeName(WebhookEvent event) => switch (event) {
      JobCompleted() => 'JobCompleted',
      JobFailed() => 'JobFailed',
      SpendingWarning() => 'SpendingWarning',
      SpendingExhausted() => 'SpendingExhausted',
      UnknownWebhookEvent() => 'UnknownEvent',
    };

void main() {
  group('shared vectors', () {
    for (final v in vectors) {
      test('${v['name']}', () {
        if (v['expect'] == 'valid') {
          expect(typeName(verifyVector(v)), v['expect_type']);
        } else {
          expect(
            () => verifyVector(v),
            throwsA(isA<WebhookVerificationException>()
                .having((e) => e.reason.name, 'reason', v['reason'])),
          );
        }
      });
    }
  });

  test('parsed fields and dedupe key', () {
    final v = vector('tts job.completed');
    final event = verifyWebhook(bodyOf(v), headersOf(v), [secretsOf(v).first],
        now: nowOf(v)) as JobCompleted;
    expect(event.service, 'tts');
    expect(event.text, 'مرحبا بكم في إيكونوفا');
    expect(event.durationSeconds, 3.4);
    expect(event.dedupeKey, 'job.completed:000000000000000000000001');
    expect(event.raw['audioUrl'], startsWith('https://'));
    expect(event.timestamp, 1762300800);
    expect(event.event, 'job.completed');
  });

  test('stt job.completed carries the transcript and terminology', () {
    final event = verifyVector(vector('stt job.completed with terminology'))
        as JobCompleted;
    expect(event.service, 'stt');
    expect(event.transcription, 'hello from the KYC team');
    expect(event.terminology, isA<Map<String, Object?>>());
    expect(event.audioUrl, isNull);
  });

  group('a job.completed without its result fails as a payload problem', () {
    for (final (name, body) in [
      ('tts without audioUrl', {'jobId': 'j', 'service': 'tts'}),
      (
        'tts with an empty audioUrl',
        {'jobId': 'j', 'service': 'tts', 'audioUrl': ''}
      ),
      (
        'tts with a non-string audioUrl',
        {'jobId': 'j', 'service': 'tts', 'audioUrl': 1}
      ),
      (
        'tts with only a transcription',
        {'jobId': 'j', 'service': 'tts', 'transcription': 'hi'}
      ),
      ('stt without transcription', {'jobId': 'j', 'service': 'stt'}),
      (
        'stt with an empty transcription',
        {'jobId': 'j', 'service': 'stt', 'transcription': ''}
      ),
      (
        'stt with a null transcription',
        {'jobId': 'j', 'service': 'stt', 'transcription': null}
      ),
      (
        'stt with only an audioUrl',
        {'jobId': 'j', 'service': 'stt', 'audioUrl': 'https://x'}
      ),
    ]) {
      test(name, () {
        expect(
          () => verifySigned('job.completed', body),
          throwsA(isA<WebhookVerificationException>()
              .having((e) => e.reason, 'reason', WebhookFailure.payload)
              .having((e) => e.message, 'message', contains('missing'))),
        );
      });
    }
  });

  test('a job.completed for another service needs no particular result', () {
    final event = verifySigned('job.completed', {'jobId': 'j', 'service': 'x'})
        as JobCompleted;
    expect(event.service, 'x');
  });

  test('spending dedupe key', () {
    final event = verifyVector(vector('spending.warning')) as SpendingWarning;
    expect(event.percentageUsed, 80);
    expect(event.dedupeKey,
        'spending.warning:000000000000000000000a01:8000:10000');
  });

  test('dedupe keys format numbers like the other SDKs', () {
    String key(Object? used, Object? limit) => verifySigned(
          'spending.exhausted',
          {'apiKeyId': 'k', 'creditsUsed': used, 'creditLimit': limit},
        ).dedupeKey!;
    expect(key(8000.5, 10000.0), 'spending.exhausted:k:8000.5:10000');
    expect(key(0.00001, '25'), 'spending.exhausted:k:1e-05:25');
    expect(key(1.5e-7, 0.0001), 'spending.exhausted:k:1.5e-07:0.0001');
    expect(key(1e20, -0.0), 'spending.exhausted:k:100000000000000000000:0');
  });

  test('a spending event without its credits fails as a payload problem', () {
    for (final body in [
      {'apiKeyId': 'k', 'creditLimit': 10},
      {'apiKeyId': 'k', 'creditsUsed': 'lots', 'creditLimit': 10},
      {'apiKeyId': 'k', 'creditsUsed': 1, 'creditLimit': null},
    ]) {
      expect(
        () => verifySigned('spending.exhausted', body),
        throwsA(isA<WebhookVerificationException>()
            .having((e) => e.reason, 'reason', WebhookFailure.payload)),
      );
    }
  });

  test('percentages round half to even, like Python', () {
    int? percentage(Object value) => (verifySigned('spending.warning', {
          'apiKeyId': 'k',
          'creditsUsed': 1,
          'creditLimit': 2,
          'percentageUsed': value,
        }) as SpendingWarning)
            .percentageUsed;
    expect(percentage(80.5), 80);
    expect(percentage(81.5), 82);
    expect(percentage(79.6), 80);
    expect(percentage('90'), 90);
  });

  test('unknown events and non-object bodies parse as UnknownWebhookEvent', () {
    final event = verifySigned('job.completed', [1, 2]);
    expect(event, isA<UnknownWebhookEvent>());
    expect(event.raw, [1, 2]);
    expect(event.dedupeKey, isNull);
  });

  test('a known event without its id fails as a payload problem', () {
    expect(
      () => verifySigned('job.failed', {'service': 'tts'}),
      throwsA(isA<WebhookVerificationException>()
          .having((e) => e.reason, 'reason', WebhookFailure.payload)),
    );
  });

  test('a signed body that is not JSON fails as a payload problem', () {
    const body = 'not json';
    expect(
      () => verifyWebhook(
          utf8.encode(body), signed('job.failed', body), [testSecret],
          now: DateTime.fromMillisecondsSinceEpoch(1000 * 1000)),
      throwsA(isA<WebhookVerificationException>()
          .having((e) => e.reason, 'reason', WebhookFailure.payload)),
    );
  });

  test('headers are case-insensitive and string bodies work via utf8', () {
    final v = vector('job.failed');
    final lowered = {
      for (final MapEntry(:key, :value) in headersOf(v).entries)
        key.toLowerCase(): value,
    };
    final event = verifyWebhook(bodyOf(v), lowered, secretsOf(v), now: nowOf(v))
        as JobFailed;
    expect(event.error, 'Transcription failed. Try again.');
  });

  test('non-ASCII digits in the timestamp are rejected', () {
    final v = vector('job.failed');
    final headers = {...headersOf(v), 'X-Webhook-Timestamp': '١٧٦٢٣٠٠٨٠٠'};
    expect(
      () => verifyWebhook(bodyOf(v), headers, secretsOf(v), now: nowOf(v)),
      throwsA(isA<WebhookVerificationException>()
          .having((e) => e.reason, 'reason', WebhookFailure.timestamp)),
    );
  });

  test('an absurdly large timestamp is out of tolerance', () {
    final v = vector('job.failed');
    final headers = {...headersOf(v), 'X-Webhook-Timestamp': '9' * 40};
    expect(
      () => verifyWebhook(bodyOf(v), headers, secretsOf(v), now: nowOf(v)),
      throwsA(isA<WebhookVerificationException>()
          .having((e) => e.reason, 'reason', WebhookFailure.timestamp)),
    );
  });

  test('a timestamp header longer than 15 characters is refused', () {
    // Signed correctly, so only the length can be the reason.
    WebhookEvent verifyAt(String timestamp) {
      const body = '{"jobId":"j","service":"tts","error":"x"}';
      final signature = Hmac(sha256, utf8.encode(testSecret))
          .convert(utf8.encode('${timestamp.trim()}.$body'));
      return verifyWebhook(
        utf8.encode(body),
        {
          'X-Webhook-Event': 'job.failed',
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Signature': '$signature',
        },
        [testSecret],
        now: DateTime.fromMillisecondsSinceEpoch(1000 * 1000),
      );
    }

    expect(verifyAt('${'0' * 11}1000').timestamp, 1000); // 15 characters
    expect(verifyAt('  ${'0' * 11}1000\t').timestamp, 1000); // trimmed
    expect(
      () => verifyAt('${'0' * 12}1000'), // 16 characters
      throwsA(isA<WebhookVerificationException>()
          .having((e) => e.reason, 'reason', WebhookFailure.timestamp)),
    );
  });

  test('an empty header counts as missing', () {
    final v = vector('job.failed');
    final headers = {...headersOf(v), 'X-Webhook-Signature': ''};
    expect(
      () => verifyWebhook(bodyOf(v), headers, secretsOf(v), now: nowOf(v)),
      throwsA(isA<WebhookVerificationException>()
          .having((e) => e.reason, 'reason', WebhookFailure.headers)),
    );
  });

  for (final secrets in [
    <String>[],
    <String>['']
  ]) {
    test('secrets $secrets is a programming error', () {
      final v = vector('job.failed');
      expect(
        () => verifyWebhook(bodyOf(v), headersOf(v), secrets, now: nowOf(v)),
        throwsA(isA<ArgumentError>()
            .having((e) => e.message, 'message', contains('secret'))),
      );
    });
  }
}
