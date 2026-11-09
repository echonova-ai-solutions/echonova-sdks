// The client: proxy mode through the resources, raw responses, withOptions,
// close, and the members the streaming layer uses.
import 'package:echonova/echonova.dart';
import 'package:echonova/src/client.dart' show transportOf;
import 'package:echonova/src/runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

import '../support/rest.dart';

void main() {
  group('proxy mode', () {
    test(
        'calls go to the proxy with the app credentials, refreshed for '
        'each attempt', () async {
      var token = 0;
      final h = makeClient(
        (_, index) =>
            index == 0 ? failure(503, 'Database unavailable') : ok(jobJson()),
        proxy: true,
        auth: () async => {'Authorization': 'Bearer app-session-${++token}'},
      );
      // A GET is retried after a 503.
      await h.client.textToSpeech.jobs.get(jobId);
      expect(h.api.requests.map((r) => r.url.toString()), [
        'https://api.example.com/echonova/v1/text-to-speech/jobs/$jobId',
        'https://api.example.com/echonova/v1/text-to-speech/jobs/$jobId',
      ]);
      expect(h.api.requests.map((r) => r.headers['authorization']),
          ['Bearer app-session-1', 'Bearer app-session-2']);
      expect(h.client.isProxy, isTrue);
    });

    test('uploads and agent sessions go through the proxy too', () async {
      final h = makeClient(
        (request, _) => request.url.path.contains('agents')
            ? ok({
                'id': 's',
                'agentId': 'a',
                'status': 'active',
                'token': 'room-token',
              })
            : ok({'jobId': jobId, 'status': 'processing'}),
        proxy: true,
      );
      await h.client.speechToText.jobs
          .create(AudioFile.fromBytes(mp3, 'a.mp3'), language: 'ar');
      expect(h.api.last.url.path, '/echonova/v1/speech-to-text');
      expect(h.api.last.headers['authorization'], 'Bearer app-session');
      await h.client.agents.sessions.start('a');
      expect(h.api.last.url.path, '/echonova/v1/agents/a/sessions');
    });

    test('the environment key is never sent to a proxy', () async {
      final h = makeClient((_, __) => ok(jobJson()),
          proxy: true, auth: () => const {});
      await h.client.textToSpeech.jobs.get(jobId);
      expect(h.api.last.headers['authorization'], isNull);
    });
  });

  group('raw responses', () {
    test('status, headers, request ID, rate limit and parse', () async {
      final h = makeClient((_, __) => ok(jobJson(),
          headers: {
            'x-ratelimit-limit': '100',
            'x-ratelimit-remaining': '42',
            'x-ratelimit-reset': '30',
          },
          requestId: 'req-raw'));
      final raw = await h.client.speechToText.jobs.getWithResponse(jobId);
      expect(raw.statusCode, 200);
      expect(raw.requestId, 'req-raw');
      expect(raw.headers['x-request-id'], 'req-raw');
      expect(raw.rateLimit!.remaining, 42);
      expect(raw.rateLimit!.reset, const Duration(seconds: 30));
      expect(raw.attempts, 1);
      final job = raw.parse();
      expect(job.id, jobId);
      expect(job.requestId, 'req-raw');
      expect(
          raw.toString(), 'RawResponse(statusCode: 200, requestId: req-raw)');
    });

    test('every method has a WithResponse twin', () async {
      final h = makeClient((request, _) {
        if (request.url.path.endsWith('/export')) {
          return request.url.queryParameters['format'] == 'json'
              ? textResponse('{"id": "x", "text": "hi"}')
              : textResponse('hi');
        }
        if (request.url.path.contains('/agents/')) {
          return ok({
            'id': 's',
            'agentId': 'a',
            'status': 'active',
            'token': 't',
          });
        }
        if (request.url.path.contains('/widgets/')) {
          return ok({'ticket': 'wtk_x'});
        }
        if (request.method == 'DELETE') return ok({'deleted': true});
        if (request.url.path.endsWith('/voices')) {
          return ok({'items': <Object>[], 'total': 0});
        }
        if (request.url.path.endsWith('/jobs')) {
          return ok({'items': <Object>[], 'total': 0});
        }
        return ok({
          ...jobJson(),
          'jobId': jobId,
        });
      });
      final c = h.client;
      final file = AudioFile.fromBytes(mp3, 'a.mp3');
      final raws = <RawResponse<Object?>>[
        await c.textToSpeech.generateWithResponse('x', voiceId: 'v'),
        await c.textToSpeech.voices.listWithResponse(),
        await c.textToSpeech.jobs.createWithResponse('x', voiceId: 'v'),
        await c.textToSpeech.jobs.getWithResponse(jobId),
        await c.textToSpeech.jobs.listWithResponse(),
        await c.textToSpeech.jobs.deleteWithResponse(jobId),
        await c.speechToText.transcribeWithResponse(file, language: 'ar'),
        await c.speechToText.jobs.createWithResponse(file, language: 'ar'),
        await c.speechToText.jobs.getWithResponse(jobId),
        await c.speechToText.jobs.listWithResponse(),
        await c.speechToText.jobs.deleteWithResponse(jobId),
        await c.speechToText.jobs
            .exportWithResponse(jobId, format: ExportFormat.txt),
        await c.speechToText.jobs.exportJsonWithResponse(jobId),
        await c.soundCleaning.cleanWithResponse(file),
        await c.soundCleaning.jobs.getWithResponse(jobId),
        await c.soundCleaning.jobs.listWithResponse(),
        await c.soundCleaning.jobs.deleteWithResponse(jobId),
        await c.widgets.createTicketWithResponse('wdg_1'),
        await c.agents.sessions.startWithResponse('a'),
        await c.agents.sessions.getWithResponse('a', 's'),
        await c.agents.sessions.endWithResponse('a', 's'),
      ];
      expect(raws, hasLength(21));
      for (final raw in raws) {
        expect(raw.statusCode, 200);
        expect(raw.parse(), isNotNull);
      }
    });

    test('a malformed body is not retried in raw mode; parse throws', () async {
      final h = makeClient((_, __) => ok({'status': 'completed'}));
      final raw = await h.client.textToSpeech.jobs.getWithResponse(jobId);
      expect(h.api.requests, hasLength(1));
      expect(
        raw.parse,
        throwsA(isA<ProtocolException>()
            .having((e) => e.rule, 'rule', 'malformed_success')
            .having((e) => e.requestId, 'requestId', 'req-1')),
      );
    });

    test('an error status still throws', () async {
      final h = makeClient((_, __) => failure(404, 'Job not found'));
      await expectLater(h.client.textToSpeech.jobs.getWithResponse(jobId),
          throwsA(isA<JobNotFoundException>()));
    });
  });

  group('withOptions and close', () {
    test('a copy has its own options and shares the connections', () async {
      final h = makeClient((_, __) => ok(jobJson()));
      final copy = h.client.withOptions(
        timeout: const Duration(seconds: 5),
        deadline: const Duration(seconds: 30),
        maxRetries: 0,
        defaultHeaders: {'X-Copy': '1'},
        rateLimitPreflight: false,
      );
      expect(copy.timeout, const Duration(seconds: 5));
      expect(copy.deadline, const Duration(seconds: 30));
      expect(copy.maxRetries, 0);
      expect(copy.rateLimitPreflight, isFalse);
      expect(h.client.maxRetries, 2);
      await copy.textToSpeech.jobs.get(jobId);
      expect(h.api.last.headers['x-copy'], '1');
      expect(h.api.last.headers['authorization'], 'Bearer $testKey');
      expect(() => h.client.withOptions(maxRetries: -1), throwsArgumentError);
    });

    test('close leaves caller-owned clients open; copies close nothing', () {
      var closed = 0;
      final inner = _ClosingClient(() => closed++);
      final client = EchoNova(
          apiKey: testKey, httpClient: inner, downloadHttpClient: inner);
      client.withOptions(maxRetries: 1).close();
      client.close();
      expect(closed, 0);
    });

    test('rate limits are kept per operation', () async {
      final h = makeClient((_, __) => ok(jobJson(), headers: {
            'x-ratelimit-remaining': '12',
            'x-ratelimit-limit': '100'
          }));
      await h.client.soundCleaning.jobs.get(jobId);
      expect(h.client.rateLimits['soundCleaning.jobs.get']!.remaining, 12);
      expect(h.client.rateLimits['soundCleaning.jobs.get']!.limit, 100);
    });

    test('invalid client options', () {
      expect(() => EchoNova(apiKey: testKey, deadline: Duration.zero),
          throwsArgumentError);
      expect(
          () => EchoNova.proxy(
              baseUrl: Uri.parse('wss://x.example.com'), auth: () => {}),
          throwsArgumentError);
    });
  });

  group('for the streaming layer', () {
    test('the WebSocket base follows the base URL', () {
      final direct = EchoNova(
          apiKey: testKey, httpClient: MockClient((_) async => ok(null)));
      expect(direct.wsBaseUri.toString(), 'wss://api.echonova.ai');
      final local = EchoNova(
          apiKey: testKey,
          baseUrl: Uri.parse('http://localhost:8080/'),
          httpClient: MockClient((_) async => ok(null)));
      expect(local.wsBaseUri.toString(), 'ws://localhost:8080');
      final proxy = EchoNova.proxy(
          baseUrl: Uri.parse('https://api.example.com/echonova/'),
          auth: () => {},
          httpClient: MockClient((_) async => ok(null)));
      expect(proxy.wsBaseUri.toString(), 'wss://api.example.com/echonova');
      expect(
          transportOf(proxy).websocketUri(
              '/v1/speech-to-text/stream', {'language': 'ar'}).toString(),
          'wss://api.example.com/echonova/v1/speech-to-text/stream'
          '?language=ar');
    });

    test('stream headers: default headers, then the key', () async {
      final client = EchoNova(
        apiKey: testKey,
        defaultHeaders: {'X-App': 'demo'},
        httpClient: MockClient((_) async => ok(null)),
      );
      expect(await client.streamHeaders(),
          {'X-App': 'demo', 'Authorization': 'Bearer $testKey'});
    });

    test('stream headers in proxy mode call the auth hook each time', () async {
      var calls = 0;
      final client = EchoNova.proxy(
        baseUrl: Uri.parse('https://api.example.com'),
        auth: () async => {'Authorization': 'Bearer s-${++calls}'},
        defaultHeaders: {'X-App': 'demo'},
        httpClient: MockClient((_) async => ok(null)),
      );
      expect(await client.streamHeaders(),
          {'X-App': 'demo', 'Authorization': 'Bearer s-1'});
      expect((await client.streamHeaders())['Authorization'], 'Bearer s-2');
    });

    test('user agent, retry settings and runtime', () {
      final client = EchoNova(
          apiKey: testKey,
          maxRetries: 4,
          httpClient: MockClient((_) async => ok(null)));
      expect(client.userAgent, startsWith('echonova-dart/$packageVersion ('));
      expect(client.retryPolicy.maxRetries, 4);
      expect(client.retryPolicy.maxRetryAfter, const Duration(seconds: 60));
      expect(client.runtime, isA<ClientRuntime>());
      expect(client.textToSpeech.client, same(client));
      expect(client.speechToText.client, same(client));
    });
  });
}

final class _ClosingClient extends http.BaseClient {
  _ClosingClient(this.onClose);

  final void Function() onClose;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      throw UnimplementedError();

  @override
  void close() => onClose();
}
