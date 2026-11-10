import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/core/rate_limit.dart';
import 'package:echonova/src/core/rules.dart';
import 'package:echonova/src/platform/platform.dart' as platform;
import 'package:echonova/src/transport/http_transport.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

import 'support/spec.dart';

/// A fake clock that [sleep] advances, so waits are instant and recorded.
final class Harness {
  Harness(Handler handler, {int maxRetries = 2, this.preflight = true})
      : client = MockClient((request) async {
          final index = requests.length;
          requests.add(request);
          return handler(request, index);
        }) {
    transport = HttpTransport(
      baseUrl: Uri.parse('https://api.example.com/base/'),
      authHeaders: () {
        authCalls++;
        return {'Authorization': 'Bearer test-token'};
      },
      client: client,
      ownsClient: true,
      defaultHeaders: const {'X-Default': 'yes'},
      maxRetries: maxRetries,
      rateLimitPreflight: preflight,
      rateLimits: RateLimitTracker(clock: () => clock),
      random: () => 0.5,
      sleep: (duration) async {
        sleeps.add(duration);
        clock += duration;
      },
      now: () => DateTime.utc(2026, 11, 9),
    );
  }

  static final requests = <http.Request>[];
  final MockClient client;
  final bool preflight;
  late final HttpTransport transport;
  final sleeps = <Duration>[];
  Duration clock = Duration.zero;
  int authCalls = 0;

  Future<ApiResponse> send(
    String method, {
    String path = '/v1/text-to-speech/jobs',
    List<int>? body,
    bool expectEnvelope = true,
    Duration? timeout,
    String? bucket,
  }) =>
      transport.send(ApiRequest(
        method: method,
        path: path,
        body: body,
        contentType: body == null ? null : 'application/json',
        expectEnvelope: expectEnvelope,
        timeout: timeout,
        bucket: bucket,
      ));
}

typedef Handler = FutureOr<http.Response> Function(
    http.Request request, int index);

/// Counts the requests it passes to [inner].
final class CountingClient extends http.BaseClient {
  CountingClient(this.inner);

  final http.Client inner;
  int sends = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    sends++;
    return inner.send(request);
  }

  @override
  void close() => inner.close();
}

http.Response json(int status, List<int> body,
        [Map<String, String> headers = const {}]) =>
    http.Response.bytes(body, status,
        headers: {'content-type': 'application/json', ...headers});

http.Response ok([Object? data = const {'jobId': 'j1'}]) =>
    json(200, success(data), {'x-request-id': 'req-ok'});

http.Response error(int status, String? message,
        [Map<String, String> headers = const {}]) =>
    json(status, envelope(status, message), headers);

Duration seconds(num value) =>
    Duration(microseconds: (value * Duration.microsecondsPerSecond).round());

void main() {
  setUp(Harness.requests.clear);

  test('a success is unwrapped, with request ID and rate limits', () async {
    final h = Harness((request, _) => http.Response.bytes(
          success({'jobId': 'j1'}),
          200,
          headers: {
            'x-request-id': 'req-1',
            'x-ratelimit-limit': '100',
            'x-ratelimit-remaining': '99',
            'x-ratelimit-reset': '60',
          },
        ));
    final response = await h.send('GET', bucket: 'tts.jobs.list');
    expect(response.data, {'jobId': 'j1'});
    expect(response.requestId, 'req-1');
    expect(response.rateLimit!.remaining, 99);
    expect(response.attempts, 1);
    expect(h.transport.rateLimits.snapshot().keys, ['tts.jobs.list']);
  });

  test('requests carry the URL, headers and body', () async {
    final h = Harness((request, _) => ok());
    await h.transport.send(ApiRequest(
      method: 'post',
      path: '/v1/text-to-speech',
      query: const {'a': 'b c'},
      body: utf8.encode('{"text":"hi"}'),
      contentType: 'application/json',
      headers: const {'X-Call': '1'},
    ));
    final request = Harness.requests.single;
    expect(request.method, 'POST');
    expect(request.url.toString(),
        'https://api.example.com/base/v1/text-to-speech?a=b+c');
    expect(request.headers['authorization'], 'Bearer test-token');
    expect(request.headers['x-default'], 'yes');
    expect(request.headers['x-call'], '1');
    expect(request.headers['content-type'], 'application/json');
    expect(request.headers['user-agent'], startsWith('echonova-dart/'));
    expect(request.body, '{"text":"hi"}');
    expect(request.followRedirects, isFalse);
  });

  test('raw responses are returned as bytes', () async {
    final h =
        Harness((request, _) => http.Response('1\n00:00 --> 00:01\nhi', 200));
    final response = await h.send('GET', expectEnvelope: false);
    expect(utf8.decode(response.body), startsWith('1\n'));
    expect(response.data, isNull);
  });

  test('a GET is retried after a 500, with backoff', () async {
    final h = Harness((request, index) =>
        index < 2 ? error(500, 'Something went wrong') : ok());
    final response = await h.send('GET');
    expect(response.attempts, 3);
    expect(h.sleeps, [seconds(0.375), seconds(0.75)]);
    expect(h.authCalls, 3);
  });

  test('a GET gives up after maxRetries', () async {
    final h = Harness((request, _) => error(500, 'Something went wrong'));
    await expectLater(
      h.send('GET'),
      throwsA(isA<ServerException>()
          .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isFalse)),
    );
    expect(Harness.requests, hasLength(3));
  });

  test('a POST that got a 500 is not retried: it may have run', () async {
    final h = Harness((request, _) => error(500, 'Something went wrong'));
    await expectLater(
      h.send('POST', body: utf8.encode('{}')),
      throwsA(isA<ServerException>()
          .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isNull)
          .having((e) => e.sentAt, 'sentAt', DateTime.utc(2026, 11, 9))),
    );
    expect(Harness.requests, hasLength(1));
  });

  test('a POST that got an ingress 504 may have run and is not retried',
      () async {
    final h =
        Harness((request, _) => http.Response('upstream request timeout', 504));
    await expectLater(
      h.send('POST', body: utf8.encode('{}')),
      throwsA(isA<GatewayException>()
          .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isTrue)
          .having((e) => e.fromProxy, 'fromProxy', isTrue)),
    );
    expect(Harness.requests, hasLength(1));
  });

  test('a POST is retried after a refunded 503', () async {
    final h = Harness((request, index) => index == 0
        ? error(
            503,
            'Speech generation is temporarily unavailable. '
            'Please try again.')
        : ok());
    final response = await h.send('POST', body: utf8.encode('{}'));
    expect(response.attempts, 2);
    expect(Harness.requests.last.body, '{}');
  });

  test('a throttle 429 is retried after Retry-After and blocks the bucket',
      () async {
    final h = Harness((request, index) => index == 0
        ? error(
            429, 'ThrottlerException: Too Many Requests', {'retry-after': '12'})
        : ok());
    final response = await h.send('POST', body: utf8.encode('{}'));
    expect(response.attempts, 2);
    expect(h.sleeps, [seconds(12.5)]);
  });

  test('after a throttle, other calls on that bucket wait it out', () async {
    final h = Harness(
      (request, index) => index == 0
          ? error(429, 'ThrottlerException: Too Many Requests',
              {'retry-after': '40'})
          : ok(),
      maxRetries: 0,
    );
    await expectLater(
      h.send('GET', bucket: 'b'),
      throwsA(isA<RateLimitException>()
          .having((e) => e.retryAfter, 'retryAfter', seconds(40))),
    );
    h.clock += seconds(10);
    await h.send('GET', bucket: 'b');
    expect(h.sleeps, [seconds(30)]);
    await h.send('GET', bucket: 'other');
    expect(h.sleeps, [seconds(30)]);
  });

  test('a Retry-After over the cap is not waited for', () async {
    final h = Harness((request, _) => error(
        429, 'ThrottlerException: Too Many Requests', {'retry-after': '61'}));
    await expectLater(h.send('GET'), throwsA(isA<RateLimitException>()));
    expect(Harness.requests, hasLength(1));
  });

  test('a spending limit is never retried', () async {
    final h =
        Harness((request, _) => error(429, 'Monthly spending limit exhausted'));
    await expectLater(h.send('GET'), throwsA(isA<SpendingLimitException>()));
    expect(Harness.requests, hasLength(1));
  });

  test('preflight waits for the window when nothing remains', () async {
    for (final preflight in [true, false]) {
      final h = Harness(
        (request, _) => http.Response.bytes(success(null), 200, headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '20',
        }),
        preflight: preflight,
      );
      await h.send('GET', bucket: 'b');
      await h.send('GET', bucket: 'b');
      expect(h.sleeps, preflight ? [seconds(20)] : isEmpty);
    }
  });

  group('the invariant holds for every error status', () {
    // Every status, with and without an envelope and Retry-After.
    for (var status = 400; status < 600; status++) {
      test('$status', () async {
        for (final isJson in [true, false]) {
          for (final retryAfter in [true, false]) {
            final rule = errorRules.classify(
              status,
              isJson: isJson,
              message: isJson ? 'something' : null,
              hasRetryAfter: retryAfter,
            );
            Harness.requests.clear();
            final h = Harness((request, _) => http.Response.bytes(
                  isJson ? envelope(status, 'something') : utf8.encode('x'),
                  status,
                  headers: {if (retryAfter) 'retry-after': '1'},
                ));
            Object? thrown;
            try {
              await h.send('POST', body: utf8.encode('{}'));
            } on APIStatusException catch (e) {
              thrown = e;
            }
            final error = thrown! as APIStatusException;
            expect(error.rule, rule.id);
            if (error.mayHaveExecuted != false) {
              expect(Harness.requests, hasLength(1), reason: rule.id);
            }
          }
        }
      });
    }
  });

  test('the invariant holds for every documented error', () async {
    final catalog =
        maps(loadSpecMap('fixtures/errors/catalog.json')['entries']);
    for (final entry in catalog) {
      if (entry['method'] != 'POST') continue;
      Harness.requests.clear();
      final status = entry['status']! as int;
      final h = Harness((request, _) => http.Response.bytes(
            envelope(status, entry['error_message']! as String),
            status,
            headers: {
              if (status == 429 &&
                  entry['error_message'] != 'Monthly spending limit exhausted')
                'retry-after': '1',
            },
          ));
      try {
        await h.send('POST', body: utf8.encode('{}'));
        fail('expected an exception');
      } on APIStatusException catch (e) {
        if (e.mayHaveExecuted != false) {
          expect(Harness.requests, hasLength(1), reason: '${entry['example']}');
        }
      }
    }
  });

  group('no response', () {
    test('a POST whose connection failed after sending is not retried',
        () async {
      final h = Harness((request, _) =>
          throw http.ClientException('Connection reset by peer'));
      await expectLater(
        h.send('POST', body: utf8.encode('{}')),
        throwsA(isA<APIConnectionException>()
            .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isTrue)
            .having((e) => e.message, 'message', contains('reset'))
            .having((e) => e.cause, 'cause', isA<http.ClientException>())),
      );
      expect(Harness.requests, hasLength(1));
    });

    test('a GET whose connection failed is retried', () async {
      final h = Harness((request, index) =>
          index == 0 ? throw http.ClientException('reset') : ok());
      expect((await h.send('GET')).attempts, 2);
    });

    test('a POST that timed out may have run and is not retried', () async {
      final h = Harness((request, _) => Completer<http.Response>().future);
      await expectLater(
        h.send('POST',
            body: utf8.encode('{}'), timeout: const Duration(milliseconds: 20)),
        throwsA(isA<APITimeoutException>()
            .having((e) => e.kind, 'kind', TimeoutKind.total)
            .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isTrue)),
      );
      expect(Harness.requests, hasLength(1));
    });

    test('a GET that timed out is retried', () async {
      final h = Harness((request, index) =>
          index == 0 ? Completer<http.Response>().future : ok());
      final response =
          await h.send('GET', timeout: const Duration(milliseconds: 20));
      expect(response.attempts, 2);
    });

    test('bugs are not disguised as network errors', () async {
      final h = Harness((request, _) => throw StateError('bug'));
      await expectLater(h.send('GET'), throwsStateError);
    });
  });

  group('malformed success', () {
    test('a GET is retried once', () async {
      final h = Harness((request, _) => http.Response('<html>', 200));
      await expectLater(
        h.send('GET'),
        throwsA(isA<ProtocolException>()
            .having((e) => e.statusCode, 'statusCode', 200)
            .having((e) => e.rawBody, 'rawBody', '<html>')),
      );
      expect(Harness.requests, hasLength(2));
    });

    test('a POST is not retried and may have run', () async {
      final h = Harness((request, _) => http.Response(
          '{"data": 1, "success": false}', 200,
          headers: {'x-request-id': 'r-5'}));
      await expectLater(
        h.send('POST', body: utf8.encode('{}')),
        throwsA(isA<ProtocolException>()
            .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isTrue)
            .having((e) => e.requestId, 'requestId', 'r-5')
            .having((e) => e.message, 'message', contains('r-5'))),
      );
      expect(Harness.requests, hasLength(1));
    });
  });

  test('a redirect is not followed', () async {
    final h = Harness((request, _) =>
        http.Response('', 302, headers: {'location': 'https://elsewhere'}));
    await expectLater(
      h.send('POST', body: utf8.encode('{}')),
      throwsA(isA<ProtocolException>()
          .having((e) => e.statusCode, 'statusCode', 302)
          .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isNull)),
    );
    expect(Harness.requests, hasLength(1));
  });

  test('URLs: base path, WebSocket scheme', () {
    final h = Harness((request, _) => ok());
    expect(h.transport.resolve('/v1/x').toString(),
        'https://api.example.com/base/v1/x');
    expect(h.transport.websocketUri('/v1/stream', {'a': '1'}).toString(),
        'wss://api.example.com/base/v1/stream?a=1');
    final plain = HttpTransport(
      baseUrl: Uri.parse('http://localhost:8080'),
      authHeaders: () => const {},
      client: h.client,
      ownsClient: false,
    );
    expect(plain.websocketUri('/v1/stream').toString(),
        'ws://localhost:8080/v1/stream');
  });

  test('messages name EchoNova, or the host of a proxy', () {
    HttpTransport at(String url) => HttpTransport(
          baseUrl: Uri.parse(url),
          authHeaders: () => const {},
          client: MockClient((_) async => http.Response('', 500)),
          ownsClient: true,
        );
    expect(at('https://api.echonova.ai').serverName, 'EchoNova');
    expect(at('https://API.EchoNova.ai/').serverName, 'EchoNova');
    expect(
        at('https://api.example.com/echonova').serverName, 'api.example.com');
    expect(at('http://localhost:8080').serverName, 'localhost:8080');
  });

  group('real sockets (dart:io)', () {
    test('a refused connection is a connect failure: a POST is retried',
        () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final port = server.port;
      await server.close();
      final client = CountingClient(platform.createDefaultHttpClient(
          connectTimeout: const Duration(seconds: 5)));
      final sleeps = <Duration>[];
      final transport = HttpTransport(
        baseUrl: Uri.parse('http://127.0.0.1:$port'),
        authHeaders: () => const {},
        client: client,
        ownsClient: true,
        random: () => 0.5,
        sleep: (d) async => sleeps.add(d),
      );
      await expectLater(
        transport.send(ApiRequest(
          method: 'POST',
          path: '/v1/text-to-speech',
          body: utf8.encode('{}'),
        )),
        throwsA(isA<APIConnectionException>()
            .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isFalse)
            // It names the server it tried, not EchoNova: here, a proxy.
            .having((e) => e.message, 'message',
                startsWith('Could not connect to 127.0.0.1:$port'))),
      );
      expect(client.sends, 3);
      expect(sleeps, [seconds(0.375), seconds(0.75)]);
      transport.close();
    });

    test('a timeout aborts the request', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final closed = Completer<void>();
      server.listen((request) async {
        // Never answer; notice when the client gives up.
        final socket = await request.response.detachSocket(writeHeaders: false);
        socket.listen(
          (_) {},
          onError: (_) {},
          onDone: () {
            closed.complete();
            unawaited(socket.close());
          },
        );
      });
      final transport = HttpTransport(
        baseUrl: Uri.parse('http://127.0.0.1:${server.port}'),
        authHeaders: () => const {},
        client: platform.createDefaultHttpClient(
            connectTimeout: const Duration(seconds: 5)),
        ownsClient: true,
        maxRetries: 0,
      );
      await expectLater(
        transport.send(const ApiRequest(
          method: 'GET',
          path: '/v1/text-to-speech/voices',
          timeout: Duration(milliseconds: 200),
        )),
        throwsA(isA<APITimeoutException>()),
      );
      await closed.future.timeout(const Duration(seconds: 5));
      transport.close();
      await server.close(force: true);
    });
  });
}
