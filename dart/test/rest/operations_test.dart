// Every operation in spec/mapping.json is reachable from the client, with
// every parameter, and goes to the documented method and path. Operations
// the mapping marks `excluded` are not part of this SDK yet.
import 'dart:convert';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:echonova_ai/src/operations.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

import '../support/rest.dart';
import '../support/spec.dart';

/// Path parameter values used for every call.
const pathValues = {
  'jobId': 'job-1',
  'publicId': 'wdg_1',
  'agentId': 'agent-1',
  'sessionId': 'session-1',
};

/// The `Idempotency-Key` passed to the operations that accept one.
const key = RequestOptions(idempotencyKey: 'key-1');

const terminology = Terminology([
  Keyword('KYC'),
  Keyword('Emirates NBD', variants: ['امريتس ان بي دي']),
]);

/// One call per SDK method, passing every parameter the API documents.
final calls = <String, Future<Object?> Function(EchoNova client)>{
  'textToSpeech.jobs.create': (c) => c.textToSpeech.jobs.create(
        'مرحبا',
        voiceId: 'voice-1',
        speed: 1.1,
        cfg: 2.5,
        numSteps: 64,
        tashkeel: true,
        normalize: false,
      ),
  'textToSpeech.generate': (c) => c.textToSpeech.generate(
        'مرحبا',
        voiceId: 'voice-1',
        speed: 1.1,
        cfg: 2.5,
        numSteps: 64,
        tashkeel: true,
        normalize: false,
        options: key,
      ),
  'textToSpeech.voices.list': (c) => c.textToSpeech.voices.list(),
  'textToSpeech.jobs.list': (c) =>
      c.textToSpeech.jobs.list(offset: 5, limit: 10),
  'textToSpeech.jobs.get': (c) => c.textToSpeech.jobs.get('job-1'),
  'textToSpeech.jobs.delete': (c) => c.textToSpeech.jobs.delete('job-1'),
  'speechToText.jobs.create': (c) => c.speechToText.jobs.create(
        AudioFile.fromBytes(mp3, 'call.mp3'),
        language: 'ar',
        numbersAsDigits: false,
        identifySpeakers: true,
        terminology: terminology,
      ),
  'speechToText.transcribe': (c) => c.speechToText.transcribe(
        AudioFile.fromBytes(mp3, 'call.mp3'),
        language: 'ar',
        numbersAsDigits: false,
        identifySpeakers: true,
        terminology: terminology,
        options: key,
      ),
  'speechToText.jobs.list': (c) =>
      c.speechToText.jobs.list(offset: 5, limit: 10),
  'speechToText.jobs.get': (c) => c.speechToText.jobs.get('job-1'),
  'speechToText.jobs.delete': (c) => c.speechToText.jobs.delete('job-1'),
  'speechToText.jobs.export': (c) =>
      c.speechToText.jobs.export('job-1', format: ExportFormat.srt, lang: 'ar'),
  'soundCleaning.clean': (c) => c.soundCleaning.clean(
        AudioFile.fromBytes(wav, 'noisy.wav'),
        cutoffFreq: 90,
        qFactor: 0.707,
        targetLufs: -16,
        truePeakDbfs: -1,
        compThreshDb: -3.8,
        compRatio: 4,
        compAttackMs: 5,
        compReleaseMs: 50,
        sampleRate: 48000,
        bitDepth: 24,
        options: key,
      ),
  'soundCleaning.jobs.list': (c) =>
      c.soundCleaning.jobs.list(offset: 5, limit: 10),
  'soundCleaning.jobs.get': (c) => c.soundCleaning.jobs.get('job-1'),
  'soundCleaning.jobs.delete': (c) => c.soundCleaning.jobs.delete('job-1'),
  'widgets.createTicket': (c) => c.widgets.createTicket(
        'wdg_1',
        user: const WidgetUser(id: 'user_8431', name: 'Sara'),
        channel: AgentChannel.chat,
        ttlSeconds: 300,
      ),
  'agents.sessions.start': (c) =>
      c.agents.sessions.start('agent-1', channel: AgentChannel.chat),
  'agents.sessions.get': (c) => c.agents.sessions.get('agent-1', 'session-1'),
  'agents.sessions.end': (c) => c.agents.sessions.end('agent-1', 'session-1'),
};

http.Response responseFor(String path, String method) {
  if (path.endsWith('/export')) {
    return http.Response.bytes(
      utf8.encode('1\n00:00:00,380 --> 00:00:04,120\n[Speaker 1] مرحبا\n'),
      200,
      headers: {
        'content-type': 'application/x-subrip',
        'x-request-id': 'req-export',
        'x-ratelimit-remaining': '9',
      },
    );
  }
  return ok(
    exampleData(path, method.toLowerCase()),
    headers: {'x-ratelimit-remaining': '9'},
  );
}

void main() {
  final mapping = loadSpecMap('mapping.json');
  final all = (mapping['operations']! as Map).cast<String, Object?>();
  final operations = <String, Object?>{
    for (final MapEntry(:key, :value) in all.entries)
      if (!(value! as Map).containsKey('excluded')) key: value,
  };

  test('the SDK operation table matches mapping.json', () {
    final fromSpec = {
      for (final op in operations.values)
        ((op! as Map)['sdk']! as Map)['dart']: (
          (op as Map)['method'],
          op['path'],
          op['idempotency_key'] ?? false,
        ),
    };
    final fromSdk = {
      for (final op in allOperations)
        op.name: (op.method, op.path, op.acceptsIdempotencyKey),
    };
    expect(fromSdk, fromSpec);
    expect(allOperations, hasLength(20));
    expect(allOperations.where((op) => op.acceptsIdempotencyKey),
        [ttsGenerate, sttTranscribe, cleanClean]);
  });

  test('excluded operations say why, and the SDK has none of them', () {
    final excluded = [
      for (final op in all.values.cast<Map<Object?, Object?>>())
        if (op['excluded'] case final String reason) (op, reason),
    ];
    expect(excluded, hasLength(32));
    for (final (op, reason) in excluded) {
      expect(reason, isNotEmpty);
      expect(
        allOperations.where(
            (sdk) => sdk.method == op['method'] && sdk.path == op['path']),
        isEmpty,
      );
    }
  });

  test('every mapped operation has a call in this test', () {
    final names = {
      for (final op in operations.values) ((op! as Map)['sdk']! as Map)['dart'],
    };
    expect(calls.keys.toSet(), names);
  });

  for (final MapEntry(key: operationId, value: raw) in operations.entries) {
    final op = (raw! as Map).cast<String, Object?>();
    final name = (op['sdk']! as Map)['dart']! as String;
    final method = op['method']! as String;
    final path = op['path']! as String;
    final params = maps(op['params']);

    test('$name ($operationId) sends every parameter', () async {
      final h = makeClient((request, _) => responseFor(path, method));
      final result = await calls[name]!(h.client);
      expect(result, isNotNull);
      expect(h.api.requests, hasLength(1));
      final request = h.api.last;

      var expectedPath = path;
      for (final MapEntry(:key, :value) in pathValues.entries) {
        expectedPath = expectedPath.replaceAll('{$key}', value);
      }
      expect(request.method, method);
      expect(request.url.path, expectedPath);
      expect(request.url.host, 'api.echonova.ai');
      expect(request.headers['authorization'], 'Bearer $testKey');

      final json = params.any((p) => p['in'] == 'json') ||
              (method == 'POST' &&
                  request.headers['content-type'] == 'application/json')
          ? (jsonDecode(request.body) as Map).cast<String, Object?>()
          : const <String, Object?>{};
      final form = params.any((p) => p['in'] == 'form')
          ? multipartParts(request)
          : const <String, Part>{};
      for (final param in params) {
        final api = param['api']! as String;
        switch (param['in']) {
          case 'path':
            expect(request.url.path, contains(pathValues[api]),
                reason: '$api in the path');
          case 'query':
            expect(request.url.queryParameters, contains(api),
                reason: '$api in the query');
          case 'json':
            expect(json, contains(api), reason: '$api in the JSON body');
          case 'form':
            expect(form, contains(api), reason: '$api in the form');
          case 'header':
            expect(request.headers, contains(api), reason: '$api header');
          default:
            fail('unknown location ${param['in']}');
        }
      }
      // The operation's rate-limit bucket is its SDK name.
      expect(h.client.rateLimits.keys, contains(name));
    });
  }
}
