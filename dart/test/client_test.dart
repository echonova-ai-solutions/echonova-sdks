import 'dart:convert';
import 'dart:io';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/client.dart' show redactApiKey, transportOf;
import 'package:echonova/src/transport/http_transport.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

import 'support/spec.dart';

const key = 'ek_REDACTED_example_key_1234c21d';

void main() {
  test('direct mode sends the API key as a bearer token', () async {
    late http.Request seen;
    final client = EchoNova(
      apiKey: '  $key \n',
      httpClient: MockClient((request) async {
        seen = request;
        return http.Response.bytes(success({'voices': <Object>[]}), 200);
      }),
      defaultHeaders: const {'X-App': 'demo'},
    );
    final response = await transportOf(client).send(
      const ApiRequest(method: 'GET', path: '/v1/text-to-speech/voices'),
    );
    expect(response.data, {'voices': <Object>[]});
    expect(seen.url.toString(),
        'https://api.echonova.ai/v1/text-to-speech/voices');
    expect(seen.headers['authorization'], 'Bearer $key');
    expect(seen.headers['x-app'], 'demo');
    expect(client.isProxy, isFalse);
    expect(client.maxRetries, 2);
  });

  test('the API key never appears in toString', () {
    final client = EchoNova(
      apiKey: key,
      baseUrl: Uri.parse('https://user:secret@api.echonova.ai/?token=abc'),
      httpClient: MockClient((_) async => http.Response('', 200)),
    );
    final text = client.toString();
    expect(
        text, 'EchoNova(baseUrl: https://api.echonova.ai/, apiKey: ek_…c21d)');
    expect(text, isNot(contains('REDACTED_example')));
    expect(text, isNot(contains('secret')));
    expect(text, isNot(contains('token')));
  });

  test('short keys are fully hidden', () {
    expect(redactApiKey('ek_short'), 'ek_…');
    expect(redactApiKey('abcdefghijklmnopqrstuvwxyz'), '…wxyz');
    expect(redactApiKey(key), 'ek_…c21d');
  });

  test('a missing key is a usage error, before any request', () {
    final fromEnvironment = Platform.environment['ECHONOVA_API_KEY'];
    if (fromEnvironment != null && fromEnvironment.isNotEmpty) {
      markTestSkipped('ECHONOVA_API_KEY is set');
      return;
    }
    expect(EchoNova.new, throwsA(isA<UsageException>()));
    expect(() => EchoNova(apiKey: '   '), throwsA(isA<UsageException>()));
  });

  test('invalid options are rejected', () {
    expect(
      () => EchoNova(apiKey: key, baseUrl: Uri.parse('/relative')),
      throwsArgumentError,
    );
    expect(
      () => EchoNova(apiKey: key, baseUrl: Uri.parse('ftp://example.com')),
      throwsArgumentError,
    );
    expect(() => EchoNova(apiKey: key, maxRetries: -1), throwsArgumentError);
    expect(
      () => EchoNova(apiKey: key, timeout: Duration.zero),
      throwsArgumentError,
    );
  });

  test('proxy mode calls auth before every attempt and appends paths',
      () async {
    final seen = <http.Request>[];
    var token = 0;
    final client = EchoNova.proxy(
      baseUrl: Uri.parse('https://api.example.com/echonova'),
      auth: () async => {'Authorization': 'Bearer app-session-${++token}'},
      httpClient: MockClient((request) async {
        seen.add(request);
        return seen.length == 1
            ? http.Response.bytes(envelope(500, 'Something went wrong'), 500)
            : http.Response.bytes(success(null), 200);
      }),
    );
    // A GET, so the 500 is retried (without waiting long: backoff < 1 s).
    await transportOf(client).send(
      const ApiRequest(method: 'GET', path: '/v1/text-to-speech/jobs/a%2Fb'),
    );
    expect(seen.map((r) => r.headers['authorization']),
        ['Bearer app-session-1', 'Bearer app-session-2']);
    expect(seen.first.url.toString(),
        'https://api.example.com/echonova/v1/text-to-speech/jobs/a%2Fb');
    expect(client.isProxy, isTrue);
    expect(client.toString(),
        'EchoNova.proxy(baseUrl: https://api.example.com/echonova)');
  });

  test('errors from proxy-mode auth are passed through', () async {
    final client = EchoNova.proxy(
      baseUrl: Uri.parse('https://api.example.com'),
      auth: () => throw StateError('signed out'),
      httpClient: MockClient((_) async => http.Response('', 200)),
    );
    await expectLater(
      transportOf(client).send(
        const ApiRequest(method: 'GET', path: '/v1/text-to-speech/voices'),
      ),
      throwsStateError,
    );
  });

  test('rate limits are exposed per operation', () async {
    final client = EchoNova(
      apiKey: key,
      httpClient: MockClient((_) async => http.Response.bytes(
            success(null),
            200,
            headers: {
              'x-ratelimit-remaining': '41',
              'x-ratelimit-limit': '100'
            },
          )),
    );
    await transportOf(client).send(const ApiRequest(
      method: 'GET',
      path: '/v1/text-to-speech/voices',
      bucket: 'textToSpeech.voices.list',
    ));
    expect(client.rateLimits['textToSpeech.voices.list']!.remaining, 41);
  });

  test('close leaves a caller-owned HTTP client open', () async {
    var closed = false;
    final inner = _ClosingClient(() => closed = true);
    EchoNova(apiKey: key, httpClient: inner).close();
    expect(closed, isFalse);
  });

  test('the package version matches pubspec.yaml', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final version =
        RegExp(r'^version:\s*(\S+)', multiLine: true).firstMatch(pubspec)![1];
    expect(packageVersion, version);
  });

  test('the error body never echoes request headers', () async {
    final client = EchoNova(
      apiKey: key,
      httpClient: MockClient(
          (_) async => http.Response.bytes(envelope(401, 'Unauthorized'), 401)),
    );
    try {
      await transportOf(client).send(
        const ApiRequest(method: 'GET', path: '/v1/text-to-speech/voices'),
      );
      fail('expected AuthenticationException');
    } on AuthenticationException catch (error) {
      expect(error.toString(), isNot(contains(key)));
      expect(jsonEncode(error.headers), isNot(contains(key)));
    }
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
