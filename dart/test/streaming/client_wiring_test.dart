// The client opens streams with its own URL, credentials, default headers and
// the proxy stream query.
@TestOn('vm')
library;

import 'package:echonova/echonova.dart';
import 'package:test/test.dart';

import 'helpers.dart';
import 'mock_server.dart';

Uri _httpBase(MockServer server) => server.url.replace(scheme: 'http');

void main() {
  late MockServer server;

  setUp(() async {
    server = await startServer();
  });

  test('textToSpeech.connect uses the key, default headers and User-Agent',
      () async {
    final client = EchoNova(
      apiKey: 'ek_test',
      baseUrl: _httpBase(server),
      defaultHeaders: {'X-Trace': 't-1'},
    );
    addTearDown(client.close);
    final tts = await client.textToSpeech.connect(voiceId: 'v1', speed: 1.2);
    final result = await tts.synthesize('Hello').result;
    await tts.close();
    expect(result.outcome, SynthesisOutcome.completed);
    final headers = server.attempts.first.headers;
    expect(headers['authorization'], 'Bearer ek_test');
    expect(headers['x-trace'], 't-1');
    expect(headers['user-agent'], startsWith('echonova-dart/'));
    expect(server.attempts.first.path, '/v1/text-to-speech/stream');
  });

  test('textToSpeech.speak returns Audio', () async {
    final client = EchoNova(apiKey: 'ek_test', baseUrl: _httpBase(server));
    addTearDown(client.close);
    final audio = await client.textToSpeech.speak('Hello', voiceId: 'v1');
    expect(audio.sampleRate, server.tts.sampleRate);
    expect(audio.pcm, isNotEmpty);
  });

  test('proxy mode sends the auth hook headers and the stream query', () async {
    final client = EchoNova.proxy(
      baseUrl: _httpBase(server),
      auth: () async => {'Authorization': 'Bearer app-session'},
      streamQuery: () async => {'access_token': 'short-lived'},
    );
    addTearDown(client.close);
    final tts = await client.textToSpeech.connect(voiceId: 'v1');
    await tts.close();
    expect(
        server.attempts.first.headers['authorization'], 'Bearer app-session');
    expect(server.attempts.first.query['access_token'], 'short-lived');
  });

  test('speechToText.connect and transcribeStream', () async {
    final client = EchoNova(apiKey: 'ek_test', baseUrl: _httpBase(server));
    addTearDown(client.close);
    final stt = await client.speechToText.connect(
      sampleRate: 16000,
      language: 'ar',
      terminology: const Terminology([Keyword('EchoNova')]),
    );
    expect(stt.sessionId, isNotNull);
    await stt.stop();
    expect(server.sttConns.first.query, containsPair('sample_rate', '16000'));
    expect(server.sttConns.first.query, containsPair('language', 'ar'));

    final events = await client.speechToText
        .transcribeStream(Stream.value(pcm(1)),
            sampleRate: 16000, language: 'en')
        .toList();
    expect(events.whereType<Transcript>(), isNotEmpty);
  });
}
