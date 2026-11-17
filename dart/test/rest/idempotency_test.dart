// ADR 0014 through the resources: the three operations that accept an
// Idempotency-Key send one on every attempt and are retried safely, and a
// `202 Processing` answer is waited out by polling the job.
import 'dart:convert';
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:echonova_ai/src/transport/http_transport.dart'
    show TimeoutProfile;
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

import '../support/rest.dart';

Never lostResponse() => throw http.ClientException('Connection reset by peer');

Never refused() => throw const SocketException('Connection refused',
    osError: OSError('Connection refused', 111));

final uuid4 = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

const inProgress = 'A request with this Idempotency-Key is still running.';
const starting =
    'The same request is still being started. Send it again in a few seconds.';
const reused = 'This Idempotency-Key was already used for a different request.';

String? keyOf(http.Request request) => request.headers['idempotency-key'];

Duration ms(int value) => Duration(milliseconds: value);

/// One of the three operations, with what it returns.
final class SyncOp {
  const SyncOp({
    required this.name,
    required this.path,
    required this.jobsPath,
    required this.interval,
    required this.call,
    required this.callRaw,
    required this.result,
    required this.job,
    required this.check,
    this.uploads,
  });

  final String name;
  final String path;
  final String jobsPath;
  final Duration interval;
  final Future<Object> Function(EchoNova client, RequestOptions? options) call;
  final Future<RawResponse<Object>> Function(
      EchoNova client, RequestOptions? options) callRaw;

  /// The `data` of a 200.
  final Map<String, Object?> result;

  /// The job, as its jobs `get` returns it once it has completed.
  final Map<String, Object?> job;

  /// Checks a result is the 200 type with the job's values.
  final void Function(Object result) check;

  /// The call with a given upload, for the operations that upload.
  final Future<Object> Function(EchoNova client, AudioFile file)? uploads;

  Map<String, Object?> jobWith(String status, {String? error}) => {
        ...job,
        'status': status,
        if (error != null) 'error': error,
      };

  @override
  String toString() => name;
}

final ops = [
  SyncOp(
    name: 'textToSpeech.generate',
    path: '/v1/text-to-speech/sync',
    jobsPath: '/v1/text-to-speech/jobs/$jobId',
    interval: const Duration(seconds: 3),
    call: (c, o) => c.textToSpeech.generate('hi', voiceId: 'v1', options: o),
    callRaw: (c, o) =>
        c.textToSpeech.generateWithResponse('hi', voiceId: 'v1', options: o),
    result: {
      'jobId': jobId,
      'status': 'completed',
      'audioUrl': signedUrl,
      'durationSeconds': 1.5,
      'creditsConsumed': 41,
    },
    job: {
      'id': jobId,
      'status': 'completed',
      'text': 'hi',
      'voiceId': 'v1',
      'audioUrl': signedUrl,
      'durationSeconds': 1.5,
      'creditsConsumed': 41,
      'createdAt': '2026-11-09T12:00:00.000Z',
    },
    check: (result) => expect(
      result,
      isA<TtsResult>()
          .having((r) => r.jobId, 'jobId', jobId)
          .having((r) => r.status, 'status', JobStatus.completed)
          .having((r) => r.audioUrl, 'audioUrl', signedUrl)
          .having((r) => r.durationSeconds, 'durationSeconds', 1.5)
          .having((r) => r.creditsConsumed, 'creditsConsumed', 41),
    ),
  ),
  SyncOp(
    name: 'speechToText.transcribe',
    path: '/v1/speech-to-text/sync',
    jobsPath: '/v1/speech-to-text/jobs/$jobId',
    interval: const Duration(seconds: 5),
    call: (c, o) => c.speechToText
        .transcribe(AudioFile.fromBytes(mp3, 'a.mp3'), options: o),
    callRaw: (c, o) => c.speechToText
        .transcribeWithResponse(AudioFile.fromBytes(mp3, 'a.mp3'), options: o),
    uploads: (c, file) => c.speechToText.transcribe(file),
    result: {
      'jobId': jobId,
      'status': 'completed',
      'transcription': 'مرحبا',
      'language': 'auto',
      'numbersAsDigits': true,
      'identifySpeakers': false,
      'segments': <Object?>[],
      'speakers': <Object?>[],
      'durationSeconds': 15.5,
      'creditsConsumed': 26,
    },
    job: {
      'id': jobId,
      'status': 'completed',
      'transcription': 'مرحبا',
      'language': 'auto',
      'numbersAsDigits': true,
      'identifySpeakers': false,
      'segments': <Object?>[],
      'speakers': <Object?>[],
      'durationSeconds': 15.5,
      'creditsConsumed': 26,
      'createdAt': '2026-11-09T12:00:00.000Z',
    },
    check: (result) => expect(
      result,
      isA<SttResult>()
          .having((r) => r.jobId, 'jobId', jobId)
          .having((r) => r.status, 'status', JobStatus.completed)
          .having((r) => r.transcription, 'transcription', 'مرحبا')
          .having((r) => r.language, 'language', 'auto')
          .having((r) => r.numbersAsDigits, 'numbersAsDigits', isTrue)
          .having((r) => r.durationSeconds, 'durationSeconds', 15.5)
          .having((r) => r.creditsConsumed, 'creditsConsumed', 26),
    ),
  ),
  SyncOp(
    name: 'soundCleaning.clean',
    path: '/v1/sound-cleaning',
    jobsPath: '/v1/sound-cleaning/jobs/$jobId',
    interval: const Duration(seconds: 5),
    call: (c, o) =>
        c.soundCleaning.clean(AudioFile.fromBytes(wav, 'a.wav'), options: o),
    callRaw: (c, o) => c.soundCleaning
        .cleanWithResponse(AudioFile.fromBytes(wav, 'a.wav'), options: o),
    uploads: (c, file) => c.soundCleaning.clean(file),
    result: {
      'id': jobId,
      'status': 'completed',
      'fileName': 'a.wav',
      'outputUrl': signedUrl,
      'creditsConsumed': 3,
    },
    job: {
      'id': jobId,
      'status': 'completed',
      'fileName': 'a.wav',
      'outputUrl': signedUrl,
      'creditsConsumed': 3,
      'createdAt': '2026-11-09T12:00:00.000Z',
    },
    check: (result) => expect(
      result,
      isA<CleanJob>()
          .having((r) => r.id, 'id', jobId)
          .having((r) => r.status, 'status', JobStatus.completed)
          .having((r) => r.outputUrl, 'outputUrl', signedUrl)
          .having((r) => r.creditsConsumed, 'creditsConsumed', 3),
    ),
  ),
];

/// The `202 Processing` answer.
http.Response processing(String path, {Map<String, Object?>? data}) =>
    http.Response.bytes(
      utf8.encode(jsonEncode({
        'data': data ??
            {
              'jobId': jobId,
              'status': 'processing',
              'resultUrl': path,
            },
        'success': true,
        'statusCode': 202,
        'errorMessage': null,
      })),
      202,
      headers: {'content-type': 'application/json', 'x-request-id': 'req-202'},
    );

/// A POST that answers 202, then polls that answer with [statuses] in
/// turn (the last one repeats), each with request ID `req-poll-<n>`.
Handler acceptedThenPolls(SyncOp op, List<String> statuses, {String? error}) {
  var polls = 0;
  return (request, index) {
    if (request.method == 'POST') return processing(op.jobsPath);
    final status =
        statuses[polls < statuses.length ? polls : statuses.length - 1];
    polls++;
    return ok(op.jobWith(status, error: error), requestId: 'req-poll-$polls');
  };
}

void main() {
  for (final op in ops) {
    group('$op', () {
      test('sends a new UUID per call, the same on every retry', () async {
        final h = makeClient((_, index) =>
            index == 0 ? failure(500, 'Something went wrong') : ok(op.result));
        op.check(await op.call(h.client, null));
        op.check(await op.call(h.client, null));
        expect(h.api.requests, hasLength(3));
        final keys = h.api.requests.map(keyOf).toList();
        expect(keys[0], matches(uuid4));
        expect(keys[1], keys[0], reason: 'the retry sends the same key');
        expect(keys[2], matches(uuid4));
        expect(keys[2], isNot(keys[0]), reason: 'a new call, a new key');
        expect(h.api.requests.map((r) => r.url.path), everyElement(op.path));
        expect(h.time.sleeps, [ms(375)]); // backoff, with jitter 0.5
      });

      for (final (name, response) in [
        ('a lost response', (int index) => lostResponse()),
        ('a refused connection', (int index) => refused()),
        ('500', (int index) => failure(500, 'Something went wrong')),
        ('502', (int index) => failure(502, 'Bad gateway')),
        ('503', (int index) => failure(503, 'Database unavailable')),
        ('504', (int index) => failure(504, 'Gateway timeout')),
        (
          'a proxy 504',
          (int index) => http.Response('upstream request timeout', 504)
        ),
        (
          'a proxy 503',
          (int index) => http.Response('no healthy upstream', 503)
        ),
        (
          'a refunded 503',
          (int index) =>
              failure(503, 'Speech to Text is temporarily unavailable')
        ),
        ('a 408', (int index) => failure(408, 'Request Timeout')),
      ]) {
        test('is retried with the same key after $name', () async {
          final h = makeClient(
              (_, index) => index == 0 ? response(index) : ok(op.result));
          op.check(await op.call(h.client, null));
          expect(h.api.requests, hasLength(2));
          expect(keyOf(h.api.requests[1]), keyOf(h.api.requests[0]));
        });
      }

      test('keeps to maxRetries, and the error carries the key', () async {
        final h = makeClient((_, __) => failure(500, 'Something went wrong'));
        Object? caught;
        try {
          await op.call(h.client, null);
        } on ServerException catch (error) {
          caught = error;
          expect(error.idempotencyKey, keyOf(h.api.last));
          expect(error.mayHaveExecuted, isNull);
        }
        expect(caught, isNotNull);
        expect(h.api.requests, hasLength(3));
        expect(h.api.requests.map(keyOf).toSet(), hasLength(1));
        expect(h.time.sleeps, [ms(375), ms(750)]);

        final once =
            makeClient((_, __) => failure(500, 'Something went wrong'));
        await expectLater(
          op.call(once.client, const RequestOptions(maxRetries: 0)),
          throwsA(isA<ServerException>()),
        );
        expect(once.api.requests, hasLength(1));
      });

      test('a lost response after the retries carries the key', () async {
        final h = makeClient((_, __) => lostResponse());
        await expectLater(
          op.call(h.client, null),
          throwsA(isA<APIConnectionException>()
              .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isTrue)
              .having((e) => e.idempotencyKey, 'idempotencyKey', matches(uuid4))
              .having((e) => e.idempotencyKey == keyOf(h.api.last),
                  'the key sent', isTrue)
              .having((e) => e.message, 'message',
                  contains('same idempotencyKey'))),
        );
        expect(h.api.requests, hasLength(3));
      });

      test('the deadline still stops retries', () async {
        final h = makeClient(
          (_, __) => failure(500, 'Something went wrong'),
          deadline: const Duration(seconds: 1),
        );
        await expectLater(
            op.call(h.client, null), throwsA(isA<ServerException>()));
        expect(h.api.requests, hasLength(2));
      });

      test(
          'the in-progress 409s are resent every 5 s, or after a longer '
          'Retry-After, without jitter', () async {
        final h = makeClient((_, index) => switch (index) {
              0 => failure(409, inProgress, headers: {'retry-after': '8'}),
              1 => failure(409, starting, headers: {'retry-after': '2'}),
              2 => failure(409, inProgress),
              _ => ok(op.result),
            });
        op.check(await op.call(h.client, null));
        expect(h.api.requests, hasLength(4));
        expect(h.api.requests.map(keyOf).toSet(), hasLength(1));
        expect(h.time.sleeps, [
          const Duration(seconds: 8),
          const Duration(seconds: 5),
          const Duration(seconds: 5),
        ]);
      });

      test(
          'the resends are outside maxRetries, and the first other answer '
          'decides', () async {
        final h = makeClient(
          (_, index) => switch (index) {
            < 6 => failure(409, index.isEven ? inProgress : starting),
            6 => failure(500, 'Something went wrong'),
            _ => ok(op.result),
          },
          maxRetries: 1,
        );
        op.check(await op.call(h.client, null));
        expect(h.api.requests, hasLength(8));
        expect(h.api.requests.map(keyOf).toSet(), hasLength(1));
        // Six resends, then the 500's one retry, with backoff.
        expect(h.time.sleeps,
            [...List.filled(6, const Duration(seconds: 5)), ms(375)]);

        final failing = makeClient(
          (_, index) =>
              index < 2 ? failure(409, inProgress) : failure(400, 'Bad'),
        );
        await expectLater(op.call(failing.client, null),
            throwsA(isA<InvalidRequestException>()));
        expect(failing.api.requests, hasLength(3));
      });

      test('past the wait budget: RequestInProgressException with the key',
          () async {
        final h = makeClient((_, __) => failure(409, inProgress));
        await expectLater(
          op.call(h.client,
              const RequestOptions(waitTimeout: Duration(seconds: 20))),
          throwsA(isA<RequestInProgressException>()
              .having((e) => e.statusCode, 'statusCode', 409)
              .having((e) => e.rule, 'rule', 'idempotency_in_progress')
              .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isTrue)
              .having((e) => e.idempotencyKey == keyOf(h.api.last),
                  'the key sent', isTrue)),
        );
        // Sent at 0, 5, 10 and 15 s: a resend at 20 s would land at the end
        // of the budget, so none is made.
        expect(h.api.requests, hasLength(4));
        expect(h.time.sleeps.fold(Duration.zero, (a, b) => a + b),
            lessThanOrEqualTo(const Duration(seconds: 20)));
      });

      if (op.uploads != null) {
        test('an upload that can\'t be sent again ends the wait at once',
            () async {
          final h = makeClient((_, __) => failure(409, inProgress));
          final file =
              AudioFile.fromStream(Stream.value(wav), wav.length, 'a.wav');
          await expectLater(
            op.uploads!(h.client, file),
            throwsA(isA<RequestInProgressException>()
                .having((e) => e.retryDisabledReason, 'retryDisabledReason',
                    'body_not_replayable')
                .having((e) => e.idempotencyKey, 'idempotencyKey', isNotNull)),
          );
          expect(h.api.requests, hasLength(1));
          expect(h.time.sleeps, isEmpty);
        });
      }

      test('a key used for a different request is not retried', () async {
        final h = makeClient((_, __) => failure(409, reused));
        await expectLater(
          op.call(h.client, null),
          throwsA(isA<InvalidRequestException>()
              .having((e) => e.rule, 'rule', 'idempotency_key_reused')
              .having((e) => e.idempotencyKey == keyOf(h.api.last),
                  'the key sent', isTrue)),
        );
        expect(h.api.requests, hasLength(1));
        expect(h.time.sleeps, isEmpty);
      });

      test('client errors are not retried, and carry the key', () async {
        final h =
            makeClient((_, __) => failure(400, 'text should not be empty'));
        await expectLater(
          op.call(h.client, null),
          throwsA(isA<InvalidRequestException>()
              .having((e) => e.idempotencyKey, 'idempotencyKey', isNotNull)
              .having((e) => e.idempotencyKey == keyOf(h.api.last),
                  'the key sent', isTrue)),
        );
        expect(h.api.requests, hasLength(1));
      });

      test('a malformed success is retried once', () async {
        final h = makeClient((_, __) => http.Response('not json', 200));
        await expectLater(
          op.call(h.client, null),
          throwsA(isA<ProtocolException>()
              .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isTrue)
              .having((e) => e.idempotencyKey, 'idempotencyKey', isNotNull)),
        );
        expect(h.api.requests, hasLength(2));
      });

      test('your own key is sent verbatim, on every attempt', () async {
        const key = 'order-42/Attempt_1';
        final h = makeClient((_, index) =>
            index == 0 ? lostResponse() : failure(402, 'Insufficient balance'));
        await expectLater(
          op.call(h.client, const RequestOptions(idempotencyKey: key)),
          throwsA(isA<InsufficientBalanceException>()
              .having((e) => e.idempotencyKey, 'idempotencyKey', key)),
        );
        expect(h.api.requests.map(keyOf), [key, key]);
      });

      test('an Idempotency-Key header in the options is the key', () async {
        final h = makeClient((_, __) => ok(op.result));
        await op.call(
            h.client,
            const RequestOptions(
                headers: {'idempotency-key': 'from-header', 'X-Trace': 't'}));
        expect(keyOf(h.api.last), 'from-header');
        expect(h.api.last.headers['x-trace'], 't');
        await op.call(
            h.client,
            const RequestOptions(
                idempotencyKey: 'from-options',
                headers: {'Idempotency-Key': 'from-header'}));
        expect(keyOf(h.api.last), 'from-options');
      });

      test('a key that is not a header value is refused before sending',
          () async {
        final h = makeClient((_, __) => ok(op.result));
        for (final key in ['', ' padded', 'line\nbreak', 'ключ']) {
          await expectLater(
            () => op.call(h.client, RequestOptions(idempotencyKey: key)),
            throwsArgumentError,
            reason: key,
          );
        }
        expect(h.api.requests, isEmpty);
      });

      group('202 Processing', () {
        test('polls the job and returns what a 200 returns', () async {
          final h = makeClient(
              acceptedThenPolls(op, ['processing', 'processing', 'completed']));
          final result = await op.call(h.client, null);
          op.check(result);
          expect((result as ApiResult).requestId, 'req-poll-3');
          final polls = h.api.requests.skip(1).toList();
          expect(polls, hasLength(3));
          for (final poll in polls) {
            expect(poll.method, 'GET');
            expect(poll.url.path, op.jobsPath);
            expect(poll.headers['authorization'], 'Bearer $testKey');
            expect(keyOf(poll), isNull, reason: 'only the POST sends the key');
          }
          // The first poll at once, then every interval.
          expect(h.time.sleeps, [op.interval, op.interval]);
        });

        test('the raw response is the last poll\'s', () async {
          final h =
              makeClient(acceptedThenPolls(op, ['processing', 'completed']));
          final raw = await op.callRaw(h.client, null);
          expect(raw.statusCode, 200);
          expect(raw.requestId, 'req-poll-2');
          op.check(raw.parse());
          expect((raw.parse() as ApiResult).requestId, 'req-poll-2');
        });

        test('a failed job throws JobFailedException with the job', () async {
          final h = makeClient(
              acceptedThenPolls(op, ['processing', 'failed'], error: 'bad'));
          await expectLater(
            op.call(h.client, null),
            throwsA(isA<JobFailedException>()
                .having((e) => e.message, 'message', contains('bad'))
                .having((e) => (e.job! as ApiResult).toJson()['status'], 'job',
                    'failed')),
          );
        });

        test('past waitTimeout it throws JobWaitTimeoutException', () async {
          final h = makeClient(acceptedThenPolls(op, ['processing']));
          await expectLater(
            op.call(h.client,
                const RequestOptions(waitTimeout: Duration(seconds: 10))),
            throwsA(isA<JobWaitTimeoutException>()
                .having((e) => e.jobId, 'jobId', jobId)
                .having((e) => (e.lastJob! as ApiResult).toJson()['status'],
                    'lastJob', 'processing')),
          );
          final waited = h.time.sleeps.fold(Duration.zero, (a, b) => a + b);
          expect(waited, lessThanOrEqualTo(const Duration(seconds: 10)));
          expect(h.api.requests.length, greaterThan(2));
        });

        test('a poll error carries the key', () async {
          final h = makeClient((request, _) => request.method == 'POST'
              ? processing(op.jobsPath)
              : failure(404, 'Job not found'));
          await expectLater(
            op.call(h.client, const RequestOptions(idempotencyKey: 'k-1')),
            throwsA(isA<JobNotFoundException>()
                .having((e) => e.idempotencyKey, 'idempotencyKey', 'k-1')),
          );
        });

        test('a 202 without a jobId is retried once, then a protocol error',
            () async {
          final h = makeClient((_, __) =>
              processing(op.jobsPath, data: {'status': 'processing'}));
          await expectLater(
            op.call(h.client, null),
            throwsA(isA<ProtocolException>()
                .having((e) => e.idempotencyKey, 'idempotencyKey', isNotNull)),
          );
          expect(h.api.requests, hasLength(2));
          expect(h.api.requests.map((r) => r.method), everyElement('POST'));
        });
      });
    });
  }

  group('202 Processing', () {
    test('waits 20 minutes by default', () async {
      final h = makeClient(acceptedThenPolls(ops[1], ['processing']));
      await expectLater(
          ops[1].call(h.client, null), throwsA(isA<JobWaitTimeoutException>()));
      final waited = h.time.sleeps.fold(Duration.zero, (a, b) => a + b);
      expect(waited, lessThanOrEqualTo(const Duration(minutes: 20)));
      expect(waited, greaterThan(const Duration(minutes: 19)));
    });

    test('Text to Speech polls at 0, 3, 6 and 9 s within 10 s', () async {
      final h = makeClient(acceptedThenPolls(ops[0], ['processing']));
      await expectLater(
        ops[0].call(
            h.client, const RequestOptions(waitTimeout: Duration(seconds: 10))),
        throwsA(isA<JobWaitTimeoutException>()),
      );
      expect(h.api.requests.where((r) => r.method == 'GET'), hasLength(4));
    });

    test('synchronous Text to Speech reads for 240 s, past the 202 at 220 s',
        () {
      // Connect and write (10 s each) plus the read limit.
      expect(TimeoutProfile.textToSpeechSync.duration,
          const Duration(seconds: 10 + 10 + 240));
    });

    test('the in-progress wait and the 202 wait share one budget', () async {
      final op = ops[0];
      var posts = 0;
      final h = makeClient((request, _) {
        if (request.method == 'POST') {
          return ++posts < 3
              ? failure(409, inProgress)
              : processing(op.jobsPath);
        }
        return ok(op.jobWith('processing'));
      }, maxRetries: 0);
      await expectLater(
        op.call(
            h.client, const RequestOptions(waitTimeout: Duration(seconds: 30))),
        throwsA(isA<JobWaitTimeoutException>()),
      );
      // 409s at 0 and 5 s, the 202 at 10 s, then polls every 3 s until 30 s.
      expect(h.time.sleeps.take(2), everyElement(const Duration(seconds: 5)));
      final waited = h.time.sleeps.fold(Duration.zero, (a, b) => a + b);
      expect(waited, lessThanOrEqualTo(const Duration(seconds: 30)));
      expect(waited, greaterThan(const Duration(seconds: 25)));
    });

    test('a Retry-After longer than 5 s is waited for; a shorter one is not',
        () async {
      for (final (retryAfter, expected) in [('12', 12), ('2', 5)]) {
        final h = makeClient(
          (_, index) => index < 2
              ? failure(409, inProgress, headers: {'retry-after': retryAfter})
              : ok(ops[0].result),
          maxRetries: 0,
        );
        await ops[0].call(h.client, null);
        expect(h.time.sleeps, List.filled(2, Duration(seconds: expected)),
            reason: retryAfter);
      }
    });

    test('a total deadline caps the 202 wait', () async {
      for (final perCall in [true, false]) {
        final h = makeClient(acceptedThenPolls(ops[1], ['processing']),
            deadline: perCall ? null : const Duration(seconds: 60));
        await expectLater(
          ops[1].call(
              h.client,
              perCall
                  ? const RequestOptions(deadline: Duration(seconds: 60))
                  : null),
          throwsA(isA<JobWaitTimeoutException>()),
        );
        final waited = h.time.sleeps.fold(Duration.zero, (a, b) => a + b);
        expect(waited, lessThanOrEqualTo(const Duration(seconds: 60)));
        expect(waited, greaterThan(const Duration(seconds: 50)));
      }
    });

    test('a total deadline caps the in-progress wait', () async {
      final h = makeClient((_, __) => failure(409, starting), maxRetries: 0);
      await expectLater(
        ops[2].call(
            h.client, const RequestOptions(deadline: Duration(seconds: 12))),
        throwsA(isA<RequestInProgressException>()
            .having((e) => e.rule, 'rule', 'same_request_starting')),
      );
      // At 0, 5 and 10 s; 15 s would be past the deadline.
      expect(h.api.requests, hasLength(3));
    });

    test('polls share the polling budget with jobs.wait', () async {
      final op = ops[0];
      var polls = 0;
      final h = makeClient((request, _) {
        if (request.method == 'POST') return processing(op.jobsPath);
        polls++;
        return ok(op.jobWith('completed'), requestId: 'req-poll-$polls');
      });
      await Future.wait([
        for (var i = 0; i < 80; i++) h.client.textToSpeech.jobs.wait('job-$i'),
      ]);
      expect(h.time.sleeps, isEmpty);
      op.check(await op.call(h.client, null));
      // The 81st poll of the minute waits for the first slot to free.
      expect(h.time.sleeps, [const Duration(minutes: 1)]);
    });

    test('a negative waitTimeout is refused before sending', () async {
      final h = makeClient((_, __) => ok(ops[0].result));
      expect(
        () => ops[0].call(
            h.client, const RequestOptions(waitTimeout: Duration(seconds: -1))),
        throwsArgumentError,
      );
      expect(h.api.requests, isEmpty);
    });

    test('a 202 from another operation is not waited for', () async {
      final h = makeClient((_, __) => processing('/v1/text-to-speech/jobs/j'));
      final job = await h.client.textToSpeech.jobs.create('hi', voiceId: 'v1');
      expect(job.jobId, jobId);
      expect(h.api.requests, hasLength(1));
    });
  });

  group('uploads', () {
    test('bytes are uploaded again on the retry', () async {
      final h = makeClient((_, index) => index == 0
          ? failure(502, 'Bad gateway')
          : ok({'jobId': jobId, 'status': 'completed'}));
      await h.client.speechToText.transcribe(AudioFile.fromBytes(mp3, 'a.mp3'));
      expect(h.api.requests, hasLength(2));
      for (final request in h.api.requests) {
        expect(multipartParts(request)['file']!.value, mp3);
      }
    });

    test('a stream that was read is not uploaded again', () async {
      final file = AudioFile.fromStream(Stream.value(wav), wav.length, 'a.wav');
      final h = makeClient((_, __) => lostResponse());
      await expectLater(
        h.client.soundCleaning.clean(file),
        throwsA(isA<APIConnectionException>()
            .having((e) => e.retryDisabledReason, 'retryDisabledReason',
                'body_not_replayable')
            .having((e) => e.idempotencyKey, 'idempotencyKey', isNotNull)),
      );
      expect(h.api.requests, hasLength(1));
    });
  });

  group('everything else is unchanged', () {
    test('async job creation is not retried after a 500 or a lost response',
        () async {
      for (final response in [
        () => failure(500, 'Something went wrong'),
        () => failure(502, 'Bad gateway'),
        lostResponse,
      ]) {
        final h = makeClient((_, __) => response());
        await expectLater(
          h.client.textToSpeech.jobs.create('hi', voiceId: 'v1'),
          throwsA(isA<EchoNovaException>()),
        );
        await expectLater(
          h.client.speechToText.jobs
              .create(AudioFile.fromBytes(mp3, 'a.mp3'), language: 'ar'),
          throwsA(isA<EchoNovaException>()),
        );
        expect(h.api.requests, hasLength(2));
        expect(h.api.requests.map(keyOf), everyElement(isNull));
      }
    });

    test('the in-progress 409 is not retried without a key', () async {
      final h = makeClient((_, __) => failure(409, inProgress));
      await expectLater(
        h.client.agents.sessions.start('agent-1'),
        throwsA(isA<RequestInProgressException>()
            .having((e) => e.idempotencyKey, 'idempotencyKey', isNull)),
      );
      expect(h.api.requests, hasLength(1));
      expect(keyOf(h.api.last), isNull);
    });

    test('no other call sends a key, and none accepts one', () async {
      final h = makeClient((_, __) => ok(jobJson()));
      await h.client.textToSpeech.jobs.get(jobId);
      expect(keyOf(h.api.last), isNull);
      for (final call in <Future<Object?> Function()>[
        () => h.client.textToSpeech.jobs.create('hi',
            voiceId: 'v1', options: const RequestOptions(idempotencyKey: 'k')),
        () => h.client.speechToText.jobs.create(
            AudioFile.fromBytes(mp3, 'a.mp3'),
            options: const RequestOptions(idempotencyKey: 'k')),
        () => h.client.textToSpeech.jobs
            .get(jobId, options: const RequestOptions(idempotencyKey: 'k')),
        () => h.client.agents.sessions.start('agent-1',
            options: const RequestOptions(idempotencyKey: 'k')),
      ]) {
        await expectLater(call, throwsArgumentError);
      }
      expect(h.api.requests, hasLength(1));
    });

    test('an Idempotency-Key header on another call is sent as given',
        () async {
      final h = makeClient((_, __) => failure(500, 'Something went wrong'));
      await expectLater(
        h.client.textToSpeech.jobs.create('hi',
            voiceId: 'v1',
            options: const RequestOptions(headers: {'Idempotency-Key': 'x'})),
        throwsA(isA<ServerException>()
            .having((e) => e.idempotencyKey, 'idempotencyKey', isNull)),
      );
      // Not an operation that accepts a key: not retried.
      expect(h.api.requests, hasLength(1));
      expect(keyOf(h.api.last), 'x');
    });
  });

  test('keys from many calls are distinct', () async {
    final h = makeClient((_, __) => ok(ops[0].result));
    await Future.wait(
        [for (var i = 0; i < 50; i++) ops[0].call(h.client, null)]);
    final keys = h.api.requests.map(keyOf).toSet();
    expect(keys, hasLength(50));
    expect(keys, everyElement(matches(uuid4)));
  });
}
