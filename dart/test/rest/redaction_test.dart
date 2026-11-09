// Secrets never show: the API key, room tokens, widget tickets and the
// signatures of download links stay out of toString and errors.
import 'dart:convert';

import 'package:echonova/echonova.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

import '../support/rest.dart';

const roomToken = 'eyJhbGciOiJIUzI1NiJ9.room-token-secret';

Map<String, Object?> startedSession() => {
      'id': 'session-1',
      'agentId': 'agent-1',
      'channel': 'voice',
      'status': 'active',
      'startedAt': '2026-11-07T10:00:00.000Z',
      'endedAt': null,
      'token': roomToken,
      'wsUrl': 'wss://rooms.example.com',
      'greeting': null,
    };

/// Everything an exception shows.
String describe(Object error) {
  final parts = [error.toString()];
  if (error is APIStatusException) {
    parts
      ..add(jsonEncode(error.headers))
      ..add(error.rawBody ?? '')
      ..add(error.errorMessage ?? '');
  }
  if (error is EchoNovaException) parts.add(error.message);
  return parts.join('\n');
}

void main() {
  test('the client never shows the key', () {
    final h = makeClient((_, __) => ok(null));
    expect(h.client.toString(), isNot(contains(testKey)));
    expect(h.client.toString(), contains('ek_…c21d'));
    expect(h.client.withOptions(maxRetries: 0).toString(),
        isNot(contains(testKey)));
  });

  test('errors never show the key', () async {
    for (final response in [
      failure(401, 'Invalid API key'),
      failure(400, 'text must be shorter than or equal to 500 characters'),
      http.Response('<html>502</html>', 502),
    ]) {
      final h = makeClient((_, __) => response, maxRetries: 0);
      try {
        await h.client.textToSpeech.generate('hi', voiceId: 'v1');
        fail('expected an error');
      } on EchoNovaException catch (error) {
        expect(describe(error), isNot(contains(testKey)));
        expect(describe(error), isNot(contains('REDACTED_unit_test')));
      }
    }
    final lost =
        makeClient((_, __) => throw http.ClientException('Connection reset'));
    try {
      await lost.client.textToSpeech.jobs.create('hi', voiceId: 'v1');
    } on EchoNovaException catch (error) {
      expect(describe(error), isNot(contains(testKey)));
    }
  });

  test('the room token never shows', () async {
    final h = makeClient((_, __) => ok(startedSession()));
    final started = await h.client.agents.sessions.start('agent-1');
    expect(started.token, roomToken);
    expect(started.toString(), isNot(contains('room-token')));
    final raw = await h.client.agents.sessions.startWithResponse('agent-1');
    expect(raw.toString(), isNot(contains('room-token')));
    expect(raw.parse().toString(), isNot(contains('room-token')));
  });

  test('a session start that failed to parse never shows the token', () async {
    final body = startedSession()..remove('id');
    final h = makeClient((_, __) => ok(body));
    try {
      await h.client.agents.sessions.start('agent-1');
      fail('expected a ProtocolException');
    } on ProtocolException catch (error) {
      expect(describe(error), isNot(contains('room-token')));
      expect(error.rawBody, isNull);
    }
    expect(h.api.requests, hasLength(1));
    final raw = await h.client.agents.sessions.startWithResponse('agent-1');
    try {
      raw.parse();
      fail('expected a ProtocolException');
    } on ProtocolException catch (error) {
      expect(describe(error), isNot(contains('room-token')));
      expect(error.rawBody, isNull);
    }
  });

  test('a malformed ticket response is not kept either', () async {
    final h = makeClient((_, __) => ok({'ticket': null, 'note': 'wtk_x'}));
    try {
      await h.client.widgets.createTicket('wdg_1');
      fail('expected a ProtocolException');
    } on ProtocolException catch (error) {
      expect(error.rawBody, isNull);
    }
  });

  test('download errors never show the link signature', () async {
    for (final response in [
      http.Response('expired', 403),
      http.Response('gone', 404),
      http.Response('busy', 500),
    ]) {
      final h = makeClient((_, __) => ok(null),
          download: (_, __) => response, maxRetries: 0);
      try {
        await h.client.download(signedUrl);
        fail('expected an error');
      } on EchoNovaException catch (error) {
        expect(describe(error), isNot(contains('sig=')));
        expect(describe(error), isNot(contains('sv=2024')));
      }
    }
  });

  test('options and files show no header values or content', () {
    const options =
        RequestOptions(headers: {'Authorization': 'Bearer secret-value'});
    expect(options.toString(), isNot(contains('secret-value')));
    final file = AudioFile.fromBytes(mp3, 'a.mp3');
    expect(file.toString(), 'AudioFile(a.mp3, audio/mpeg, 42 bytes)');
  });
}
