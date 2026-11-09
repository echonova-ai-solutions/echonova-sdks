// Retries through the resources: a POST that may have run is never sent
// again, uploads are replayed only when they can be, throttles are shared,
// and deadlines are kept.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/core/rules.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

import '../support/rest.dart';

Never lostResponse() => throw http.ClientException('Connection reset by peer');

Never refused() => throw const SocketException('Connection refused',
    osError: OSError('Connection refused', 111));

final initiated = {'jobId': jobId, 'status': 'processing'};

void main() {
  group('a POST whose response was lost is not sent again', () {
    final posts = <String, Future<Object?> Function(EchoNova client)>{
      'textToSpeech.generate': (c) =>
          c.textToSpeech.generate('hi', voiceId: 'v1'),
      'textToSpeech.jobs.create': (c) =>
          c.textToSpeech.jobs.create('hi', voiceId: 'v1'),
      'speechToText.jobs.create': (c) => c.speechToText.jobs
          .create(AudioFile.fromBytes(mp3, 'a.mp3'), language: 'ar'),
      'speechToText.transcribe': (c) => c.speechToText
          .transcribe(AudioFile.fromBytes(mp3, 'a.mp3'), language: 'ar'),
      'soundCleaning.clean': (c) =>
          c.soundCleaning.clean(AudioFile.fromBytes(wav, 'a.wav')),
      'widgets.createTicket': (c) => c.widgets.createTicket('wdg_1'),
      'agents.sessions.start': (c) => c.agents.sessions.start('agent-1'),
      'agents.sessions.end': (c) => c.agents.sessions.end('agent-1', 's-1'),
    };
    for (final MapEntry(key: name, value: call) in posts.entries) {
      test(name, () async {
        final h = makeClient((_, __) => lostResponse());
        await expectLater(
          call(h.client),
          throwsA(isA<APIConnectionException>()
              .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isTrue)
              .having((e) => e.sentAt, 'sentAt', h.time.now())
              .having((e) => e.message, 'message', contains('may have run'))),
        );
        expect(h.api.requests, hasLength(1));
        expect(h.time.sleeps, isEmpty);
      });
    }
  });

  test(
      'a retried agent session start would open a second session, so a '
      'timeout is not retried either', () async {
    final h = makeClient(
      (_, __) => Completer<http.Response>().future,
      timeout: const Duration(milliseconds: 50),
    );
    await expectLater(
      h.client.agents.sessions.start('agent-1'),
      throwsA(isA<APITimeoutException>()
          .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isTrue)),
    );
    expect(h.api.requests, hasLength(1));
  });

  test('an agent session start that failed to connect is retried', () async {
    final h = makeClient((_, index) => index == 0
        ? refused()
        : ok({
            'id': 's-1',
            'agentId': 'agent-1',
            'channel': 'voice',
            'status': 'active',
            'token': 'room-token',
          }));
    final started = await h.client.agents.sessions.start('agent-1');
    expect(started.id, 's-1');
    expect(h.api.requests, hasLength(2));
  });

  test(
      'an agent session start is retried when live sessions are '
      'unavailable (nothing was opened)', () async {
    final h = makeClient((_, index) => index == 0
        ? failure(
            503, 'Live sessions are not available right now. Try again later.')
        : ok({'id': 's-1', 'status': 'active', 'token': 'room-token'}));
    await h.client.agents.sessions.start('agent-1');
    expect(h.api.requests, hasLength(2));
  });

  test('agent session refusals are not retried', () async {
    for (final (response, matcher) in [
      (
        failure(409, 'This agent has reached its limit of 3 concurrent calls'),
        isA<ConcurrencyLimitException>()
      ),
      (
        failure(402, 'Insufficient balance'),
        isA<InsufficientBalanceException>()
      ),
      (failure(404, 'Agent not found'), isA<NotFoundException>()),
      (failure(403, 'Forbidden'), isA<PermissionDeniedException>()),
    ]) {
      final h = makeClient((_, __) => response);
      await expectLater(
          h.client.agents.sessions.start('agent-1'), throwsA(matcher));
      expect(h.api.requests, hasLength(1));
    }
  });

  test('getting an agent session is retried after a lost response', () async {
    final h = makeClient((_, index) =>
        index == 0 ? lostResponse() : ok({'id': 's-1', 'status': 'ended'}));
    final session = await h.client.agents.sessions.get('agent-1', 's-1');
    expect(session.status, AgentSessionStatus.ended);
    expect(h.api.requests, hasLength(2));
  });

  test('a GET whose response was lost is retried', () async {
    final h =
        makeClient((_, index) => index == 0 ? lostResponse() : ok(jobJson()));
    final job = await h.client.textToSpeech.jobs.get(jobId);
    expect(job.id, jobId);
    expect(h.api.requests, hasLength(2));
    expect(h.time.sleeps, hasLength(1));
  });

  test('POST 500 and ingress 504 are not retried; GET 500 is', () async {
    for (final response in [
      failure(500, 'Something went wrong'),
      http.Response('<html>504 Gateway Time-out</html>', 504),
    ]) {
      final h = makeClient((_, __) => response);
      await expectLater(h.client.textToSpeech.jobs.create('x', voiceId: 'v'),
          throwsA(isA<ServerException>()));
      expect(h.api.requests, hasLength(1));
    }
    final h = makeClient((_, index) =>
        index == 0 ? failure(500, 'Something went wrong') : ok(jobJson()));
    await h.client.speechToText.jobs.get(jobId);
    expect(h.api.requests, hasLength(2));
  });

  test('bytes are uploaded again after a refunded 503', () async {
    final h = makeClient((_, index) => index == 0
        ? failure(503, 'Speech to Text is temporarily unavailable')
        : ok(initiated));
    await h.client.speechToText.jobs
        .create(AudioFile.fromBytes(mp3, 'a.mp3'), language: 'ar');
    expect(h.api.requests, hasLength(2));
    for (final request in h.api.requests) {
      expect(multipartParts(request)['file']!.value, mp3);
    }
  });

  test('a stream that was read is not uploaded again', () async {
    final file = AudioFile.fromStream(Stream.value(mp3), mp3.length, 'a.mp3');
    final h = makeClient(
        (_, __) => failure(503, 'Speech to Text is temporarily unavailable'));
    await expectLater(
      h.client.speechToText.jobs.create(file, language: 'ar'),
      throwsA(isA<ServiceUnavailableException>()),
    );
    expect(h.api.requests, hasLength(1));
    expect(file.isReplayable, isFalse);

    // A connect failure is retryable, but not with a stream already read.
    final again = AudioFile.fromStream(Stream.value(mp3), mp3.length, 'a.mp3');
    final h2 = makeClient((_, __) => refused());
    await expectLater(
      h2.client.speechToText.jobs.create(again, language: 'ar'),
      throwsA(isA<APIConnectionException>()
          .having((e) => e.retryDisabledReason, 'retryDisabledReason',
              'body_not_replayable')
          .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isFalse)),
    );
    expect(h2.api.requests, hasLength(1));
  });

  test('a stream not read yet is replayable after a connect failure', () async {
    final controller = StreamController<List<int>>();
    final file = AudioFile.fromStream(controller.stream, 4, 'a.mp3');
    expect(file.isReplayable, isTrue);
    expect(file.contentType, 'audio/mpeg');
    controller
      ..add([1, 2, 3, 4])
      ..close().ignore();
    final h = makeClient((_, __) => ok(initiated));
    await h.client.speechToText.jobs.create(file, language: 'ar');
    expect(multipartParts(h.api.last)['file']!.value, [1, 2, 3, 4]);
    expect(file.isReplayable, isFalse);
  });

  group('throttling', () {
    test('after a throttle 429, other calls on that endpoint wait it out',
        () async {
      final h = makeClient(
        (request, index) => index == 0
            ? failure(429, 'ThrottlerException: Too Many Requests',
                headers: {'retry-after': '30'})
            : ok(jobJson()),
        maxRetries: 0,
      );
      await expectLater(h.client.textToSpeech.jobs.get(jobId),
          throwsA(isA<RateLimitException>()));
      h.time.monotonic += const Duration(seconds: 10);
      // Another job, same endpoint (bucket): waits the remaining 20 s.
      await h.client.textToSpeech.jobs.get('other-job');
      expect(h.time.sleeps, [const Duration(seconds: 20)]);
      // A copy from withOptions shares the block; other endpoints don't.
      await h.client.speechToText.jobs.get('j');
      expect(h.time.sleeps, hasLength(1));
      expect(h.client.rateLimits, isEmpty);
    });

    test('withOptions copies share the throttle state', () async {
      final h = makeClient(
        (request, index) => index == 0
            ? failure(429, 'ThrottlerException: Too Many Requests',
                headers: {'retry-after': '30'})
            : ok(jobJson()),
        maxRetries: 0,
      );
      await expectLater(h.client.textToSpeech.jobs.get(jobId),
          throwsA(isA<RateLimitException>()));
      final copy = h.client.withOptions(timeout: const Duration(seconds: 5));
      await copy.textToSpeech.jobs.get(jobId);
      expect(h.time.sleeps, [const Duration(seconds: 30)]);
    });

    test('a throttle 429 is retried after Retry-After', () async {
      final h = makeClient((_, index) => index == 0
          ? failure(429, 'ThrottlerException: Too Many Requests',
              headers: {'retry-after': '12'})
          : ok(initiated));
      await h.client.textToSpeech.jobs.create('hi', voiceId: 'v1');
      expect(h.api.requests, hasLength(2));
      expect(h.time.sleeps, [const Duration(milliseconds: 12500)]);
    });

    test('a spending limit is never retried', () async {
      final h = makeClient(
          (_, __) => failure(429, 'Monthly spending limit exhausted'));
      await expectLater(h.client.textToSpeech.generate('hi', voiceId: 'v1'),
          throwsA(isA<SpendingLimitException>()));
      expect(h.api.requests, hasLength(1));
    });

    test('preflight waits for the window when nothing remains', () async {
      for (final preflight in [true, false]) {
        final h = makeClient(
          (_, __) => ok(jobJson(), headers: {
            'x-ratelimit-limit': '100',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '20',
          }),
          rateLimitPreflight: preflight,
        );
        await h.client.textToSpeech.jobs.get(jobId);
        await h.client.textToSpeech.jobs.get(jobId);
        expect(
            h.time.sleeps, preflight ? [const Duration(seconds: 20)] : isEmpty);
        expect(h.client.rateLimits['textToSpeech.jobs.get']!.remaining, 0);
      }
    });

    test('a wait longer than 60 s is not taken: nothing is sent', () async {
      final h = makeClient((_, __) => ok(jobJson(), headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '90',
          }));
      await h.client.textToSpeech.jobs.get(jobId);
      await expectLater(
        h.client.textToSpeech.jobs.get(jobId),
        throwsA(isA<RateLimitException>()
            .having((e) => e.message, 'message', contains('nothing was sent'))
            .having((e) => e.retryAfter, 'retryAfter',
                const Duration(seconds: 90))),
      );
      expect(h.api.requests, hasLength(1));
    });
  });

  group('delete', () {
    test('a retry after a lost response that finds the job gone succeeds',
        () async {
      final h = makeClient((_, index) =>
          index == 0 ? lostResponse() : failure(404, 'Job not found'));
      final result = await h.client.speechToText.jobs.delete(jobId);
      expect(result.deleted, isTrue);
      expect(result.alreadyDeleted, isTrue);
      expect(h.api.requests, hasLength(2));
    });

    test('a 404 on the first attempt is an error', () async {
      final h = makeClient((_, __) => failure(404, 'Job not found'));
      await expectLater(h.client.speechToText.jobs.delete(jobId),
          throwsA(isA<JobNotFoundException>()));
    });

    test('a storage failure is retried', () async {
      final h = makeClient((_, index) => index == 0
          ? failure(503, 'The stored file could not be deleted. Try again.')
          : ok({'deleted': true}));
      final result = await h.client.soundCleaning.jobs.delete(jobId);
      expect(result.alreadyDeleted, isFalse);
      expect(h.api.requests, hasLength(2));
    });
  });

  group('deadline', () {
    test('stops retries that would end after it', () async {
      final h = makeClient(
        (_, __) => failure(500, 'Something went wrong'),
        deadline: const Duration(seconds: 1),
      );
      await expectLater(h.client.textToSpeech.jobs.get(jobId),
          throwsA(isA<ServerException>()));
      // Backoff with random 0.5: 0.375 s, then 0.75 s would pass 1 s.
      expect(h.api.requests, hasLength(2));
      expect(h.time.sleeps, [const Duration(milliseconds: 375)]);
    });

    test('per call, and expired before sending', () async {
      final h = makeClient((_, __) => ok(jobJson(), headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '20',
          }));
      await h.client.textToSpeech.jobs.get(jobId);
      await expectLater(
        h.client.textToSpeech.jobs.get(jobId,
            options: const RequestOptions(deadline: Duration(seconds: 5))),
        throwsA(isA<RateLimitException>()),
      );
      expect(h.api.requests, hasLength(1));
    });
  });

  group('malformed success', () {
    test('a GET missing the job ID is retried once, then a protocol error',
        () async {
      final h = makeClient((_, __) => ok({'status': 'completed'}));
      await expectLater(
        h.client.textToSpeech.jobs.get(jobId),
        throwsA(isA<ProtocolException>()
            .having((e) => e.rule, 'rule', 'malformed_success')
            .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isFalse)),
      );
      expect(h.api.requests, hasLength(2));
    });

    test('a POST is not retried and may have run', () async {
      final h = makeClient((_, __) => http.Response('not json', 200));
      await expectLater(
        h.client.textToSpeech.generate('hi', voiceId: 'v1'),
        throwsA(isA<ProtocolException>()
            .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isTrue)),
      );
      expect(h.api.requests, hasLength(1));
    });
  });

  group('request options', () {
    test('maxRetries, headers and timeout per call', () async {
      final h = makeClient((_, __) => failure(500, 'Something went wrong'));
      await expectLater(
        h.client.speechToText.jobs.get(jobId,
            options: const RequestOptions(
                maxRetries: 0, headers: {'X-Trace': 'abc'})),
        throwsA(isA<ServerException>()),
      );
      expect(h.api.requests, hasLength(1));
      expect(h.api.last.headers['x-trace'], 'abc');
      expect(h.api.last.headers['authorization'], 'Bearer $testKey');

      final slow = makeClient((_, __) => Completer<http.Response>().future);
      await expectLater(
        slow.client.textToSpeech.jobs.get(jobId,
            options: const RequestOptions(
                timeout: Duration(milliseconds: 20), maxRetries: 0)),
        throwsA(isA<APITimeoutException>()),
      );
      expect(
          () => h.client.textToSpeech.jobs
              .get(jobId, options: const RequestOptions(maxRetries: -1)),
          throwsArgumentError);
    });

    test('client-level default headers are sent', () async {
      final h = makeClient((_, __) => ok(jobJson()),
          defaultHeaders: {'X-App': 'demo'});
      await h.client.textToSpeech.jobs.get(jobId);
      expect(h.api.last.headers['x-app'], 'demo');
    });
  });

  test('an upload is sent again only when it cannot have run', () async {
    for (var status = 400; status < 600; status++) {
      final h = makeClient((_, __) => http.Response.bytes(
            utf8.encode('{"success":false,"errorMessage":"x"}'),
            status,
          ));
      try {
        await h.client.speechToText.jobs.create(
            AudioFile.fromBytes(Uint8List.fromList(mp3), 'a.mp3'),
            language: 'ar');
        fail('HTTP $status succeeded');
      } on APIStatusException catch (error) {
        final rule = errorRules.ruleById(error.rule!)!;
        if (h.api.requests.length > 1) {
          expect(rule.mayHaveExecuted, Executed.no, reason: 'HTTP $status');
        }
        if (rule.mayHaveExecuted != Executed.no) {
          expect(h.api.requests, hasLength(1), reason: 'HTTP $status');
        }
      }
    }
  });
}
