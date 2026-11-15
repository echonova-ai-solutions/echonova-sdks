// jobs.wait with a fake clock, the shared polling budget, and
// findCandidates.
import 'package:echonova_ai/echonova_ai.dart';
import 'package:echonova_ai/src/polling.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

import '../support/rest.dart';

/// Answers each poll with the next status.
Handler statuses(List<String> sequence, {String? error}) => (request, index) =>
    ok(jobJson(
      status: sequence[index < sequence.length ? index : sequence.length - 1],
      error: error,
    ));

Duration ms(int value) => Duration(milliseconds: value);

void main() {
  test('Text to Speech polls every 3 s', () async {
    final h = makeClient(statuses(['pending', 'processing', 'completed']));
    final job = await h.client.textToSpeech.jobs.wait(jobId);
    expect(job.status, JobStatus.completed);
    expect(h.api.requests, hasLength(3));
    expect(h.time.sleeps, [ms(3000), ms(3000)]);
    expect(h.api.last.url.path, '/v1/text-to-speech/jobs/$jobId');
  });

  test('Speech to Text polls every 5 s', () async {
    final h = makeClient(statuses(['processing', 'completed']));
    final job = await h.client.speechToText.jobs.wait(jobId);
    expect(job.id, jobId);
    expect(h.time.sleeps, [ms(5000)]);
  });

  test('the interval has ±10% jitter', () async {
    for (final (random, expected) in [(0.0, 2700), (0.999999, 3300)]) {
      final h = makeClient(statuses(['processing', 'completed']),
          time: FakeTime(random: random));
      await h.client.textToSpeech.jobs.wait(jobId);
      expect(h.time.sleeps.single.inMilliseconds, closeTo(expected, 1));
    }
  });

  test('a custom interval, and its minimum of 1 s', () async {
    final h = makeClient(statuses(['processing', 'completed']));
    await h.client.textToSpeech.jobs
        .wait(jobId, pollInterval: const Duration(seconds: 10));
    expect(h.time.sleeps, [ms(10000)]);
    expect(
      () => h.client.textToSpeech.jobs.wait(jobId, pollInterval: ms(500)),
      throwsA(isA<UsageException>()),
    );
  });

  test('unknown statuses are not terminal', () async {
    final h = makeClient(statuses(['queued', 'transcoding', 'completed']));
    final job = await h.client.speechToText.jobs.wait(jobId);
    expect(job.status, JobStatus.completed);
    expect(h.api.requests, hasLength(3));
  });

  test('a failed job throws, or is returned', () async {
    final h = makeClient(statuses(['failed'], error: 'bad audio'));
    await expectLater(
      h.client.speechToText.jobs.wait(jobId),
      throwsA(isA<JobFailedException>()
          .having((e) => e.message, 'message', contains('bad audio'))
          .having((e) => (e.job! as SttJob).id, 'job', jobId)),
    );
    final job =
        await h.client.speechToText.jobs.wait(jobId, raiseOnFailure: false);
    expect(job.status, JobStatus.failed);
    expect(job.error, 'bad audio');
  });

  test('a timeout throws with the last job, and waiting again is safe',
      () async {
    final h = makeClient(statuses(['processing']));
    await expectLater(
      h.client.textToSpeech.jobs
          .wait(jobId, timeout: const Duration(seconds: 10)),
      throwsA(isA<JobWaitTimeoutException>()
          .having((e) => e.jobId, 'jobId', jobId)
          .having((e) => (e.lastJob! as TtsJob).status, 'lastJob',
              JobStatus.processing)
          .having((e) => e.message, 'message', contains('processing'))),
    );
    // 0, 3, 6 and 9 s; the next poll would be after 10 s.
    expect(h.api.requests, hasLength(4));
    expect(h.time.sleeps, [ms(3000), ms(3000), ms(3000)]);
  });

  test('the default timeout is 20 minutes', () async {
    final h = makeClient(statuses(['processing']));
    await expectLater(h.client.speechToText.jobs.wait(jobId),
        throwsA(isA<JobWaitTimeoutException>()));
    final waited = h.time.sleeps.fold(Duration.zero, (a, b) => a + b);
    expect(waited, lessThanOrEqualTo(const Duration(minutes: 20)));
    expect(waited, greaterThan(const Duration(minutes: 19)));
  });

  test('transient errors keep polling; the cause is kept on timeout', () async {
    final h = makeClient((request, index) => switch (index) {
          0 => failure(500, 'Something went wrong'),
          // The client retried; then a lost response, retried as well.
          _ => index < 6 ? failure(503, 'Database unavailable') : ok(jobJson()),
        });
    final job = await h.client.textToSpeech.jobs.wait(jobId);
    expect(job.status, JobStatus.completed);
    expect(h.api.requests.length, greaterThan(3));

    final down = makeClient((_, __) => failure(502, 'Upstream service error'));
    await expectLater(
      down.client.textToSpeech.jobs
          .wait(jobId, timeout: const Duration(seconds: 20)),
      throwsA(isA<JobWaitTimeoutException>()
          .having((e) => e.cause, 'cause', isA<GatewayException>())),
    );
  });

  test('a throttle during wait sleeps for Retry-After', () async {
    final h = makeClient(
      (_, index) => index == 0
          ? failure(429, 'ThrottlerException: Too Many Requests',
              headers: {'retry-after': '40'})
          : ok(jobJson()),
      maxRetries: 0,
    );
    await h.client.textToSpeech.jobs.wait(jobId);
    expect(h.time.sleeps.first, const Duration(seconds: 40));
    expect(h.api.requests, hasLength(2));
  });

  test('permanent errors throw at once', () async {
    for (final (response, matcher) in [
      (failure(404, 'Job not found'), isA<JobNotFoundException>()),
      (failure(401, 'Invalid API key'), isA<AuthenticationException>()),
      (failure(403, 'Forbidden'), isA<PermissionDeniedException>()),
    ]) {
      final h = makeClient((_, __) => response);
      await expectLater(
          h.client.speechToText.jobs.wait(jobId), throwsA(matcher));
      expect(h.api.requests, hasLength(1));
    }
  });

  group('the shared polling budget', () {
    test('80 polls a minute per endpoint', () {
      var now = Duration.zero;
      final limiter = PollLimiter(clock: () => now);
      for (var i = 0; i < 80; i++) {
        expect(limiter.reserve('b'), Duration.zero);
      }
      expect(limiter.reserve('b'), const Duration(minutes: 1));
      expect(limiter.reserve('other'), Duration.zero);
      now += const Duration(minutes: 2);
      expect(limiter.reserve('b'), Duration.zero);
    });

    test('every wait on a client and its copies shares it', () async {
      final h = makeClient((_, __) => ok(jobJson()));
      final copy = h.client.withOptions(maxRetries: 0);
      final waits = [
        for (var i = 0; i < 80; i++) h.client.textToSpeech.jobs.wait('job-$i'),
        copy.textToSpeech.jobs.wait('job-80'),
      ];
      await Future.wait(waits);
      expect(h.api.requests, hasLength(81));
      // The 81st poll of the minute waits for the first slot to free.
      expect(h.time.sleeps, [const Duration(minutes: 1)]);
    });

    test('other endpoints have their own budget', () async {
      final h = makeClient((_, __) => ok(jobJson()));
      await Future.wait([
        for (var i = 0; i < 80; i++) h.client.textToSpeech.jobs.wait('job-$i'),
        h.client.speechToText.jobs.wait('stt-job'),
      ]);
      expect(h.time.sleeps, isEmpty);
    });
  });

  group('findCandidates', () {
    // FakeTime.start is 2026-11-09T12:00:00Z.
    final jobs = [
      jobJson(id: 'new', createdAt: '2026-11-09T12:00:30Z', text: 'hello'),
      jobJson(id: 'match', createdAt: '2026-11-09T12:00:02Z', text: ' hi '),
      jobJson(id: 'edge', createdAt: '2026-11-09T11:59:55Z', text: 'hi'),
      jobJson(id: 'old', createdAt: '2026-11-09T11:59:00Z', text: 'hi'),
    ];
    http.Response listed(http.Request request, int index) =>
        ok({'items': jobs, 'total': jobs.length});

    test('returns the jobs created since sentAt minus 5 s', () async {
      final h = makeClient(listed);
      final found = await h.client.textToSpeech.jobs
          .findCandidates(DateTime.utc(2026, 11, 9, 12));
      expect(found.map((j) => j.id), ['new', 'match', 'edge']);
      expect(h.api.last.url.queryParameters['limit'], '100');
      expect(h.api.requests, hasLength(1));
    });

    test('skips jobs made on a stream', () async {
      final h = makeClient((_, __) => ok({
            'items': [
              {
                ...jobJson(id: 'streamed', createdAt: '2026-11-09T12:00:01Z'),
                'stream': {'sessionId': 's', 'requestId': 'r'},
              },
              jobJson(id: 'rest', createdAt: '2026-11-09T12:00:01Z'),
            ],
            'total': 2,
          }));
      final tts = await h.client.textToSpeech.jobs
          .findCandidates(DateTime.utc(2026, 11, 9, 12));
      expect(tts.map((j) => j.id), ['rest']);
      final stt = await h.client.speechToText.jobs
          .findCandidates(DateTime.utc(2026, 11, 9, 12));
      expect(stt.map((j) => j.id), ['rest']);
    });

    test('filters Text to Speech jobs by text', () async {
      final h = makeClient(listed);
      final found = await h.client.textToSpeech.jobs
          .findCandidates(DateTime.utc(2026, 11, 9, 12), text: 'hi');
      expect(found.map((j) => j.id), ['match', 'edge']);
    });

    test('Speech to Text, with a local time', () async {
      final h = makeClient(listed);
      final found = await h.client.speechToText.jobs
          .findCandidates(DateTime.utc(2026, 11, 9, 12, 0, 20).toLocal());
      expect(found.map((j) => j.id), ['new']);
    });

    test('after a lost POST, with the exception\'s sentAt', () async {
      final h = makeClient((request, _) => request.method == 'POST'
          ? throw http.ClientException('Connection reset')
          : ok({
              'items': [
                jobJson(
                    id: 'created',
                    createdAt: '2026-11-09T12:00:01Z',
                    text: 'hello'),
              ],
              'total': 1,
            }));
      try {
        await h.client.textToSpeech.jobs.create('hello', voiceId: 'v1');
        fail('expected an APIConnectionException');
      } on APIConnectionException catch (error) {
        expect(error.mayHaveExecuted, isTrue);
        final found = await h.client.textToSpeech.jobs
            .findCandidates(error.sentAt!, text: 'hello');
        expect(found.single.id, 'created');
      }
    });
  });
}
