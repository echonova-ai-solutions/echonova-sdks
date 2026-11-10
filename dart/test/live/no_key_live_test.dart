/// Live scenario A: calls with a made-up key are rejected with 401, over REST
/// and on both stream handshakes, and the SDK reads the status, the error
/// body and the request ID.
///
/// Free (nothing runs without a valid key), so it needs no key, only
/// ECHONOVA_LIVE=1. See live_support.dart.
@Tags(['live'])
@TestOn('vm')
library;

import 'package:echonova/echonova.dart';
import 'package:test/test.dart';

import 'live_support.dart';

void main() {
  group('A. a made-up key', () {
    late EchoNova client;

    setUp(() => client = EchoNova(apiKey: madeUpKey));
    tearDown(() => client.close());

    test('1. a REST call throws AuthenticationException (401)', () async {
      final error = await thrown<AuthenticationException>(
        () => client.textToSpeech.voices.list(),
      );
      expectUnauthorized(error, TransportKind.http);
      log('REST 401: request ${error.requestId}');
    }, timeout: quick);

    test(
        '2a. the Text to Speech stream handshake throws '
        'AuthenticationException (401)', () async {
      final error = await thrown<AuthenticationException>(
        () => client.textToSpeech.connect(voiceId: 'any-voice'),
      );
      expectUnauthorized(error, TransportKind.websocket);
      log('TTS stream handshake 401: request ${error.requestId}');
    }, timeout: quick);

    test(
        '2b. the Speech to Text stream handshake throws '
        'AuthenticationException (401)', () async {
      final error = await thrown<AuthenticationException>(
        () => client.speechToText.connect(sampleRate: 16000, language: 'en'),
      );
      expectUnauthorized(error, TransportKind.websocket);
      log('STT stream handshake 401: request ${error.requestId}');
    }, timeout: quick);
  }, skip: liveSkip());
}

/// A 401 the SDK fully understood: status, request ID, the server's message
/// from the JSON error body, and the transport.
void expectUnauthorized(AuthenticationException error, TransportKind via) {
  expect(error.statusCode, 401);
  expect(error.requestId, isNotNull);
  expect(error.requestId, isNotEmpty);
  expect(error.transport, via);
  expect(error.errorMessage, isNotNull);
  expect(
    error.rawBody?.contains('"success"'),
    isTrue,
    reason: 'the body is the JSON error envelope',
  );
}
