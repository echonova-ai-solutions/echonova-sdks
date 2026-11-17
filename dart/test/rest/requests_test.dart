// Request shapes: method, path, query, JSON bodies and multipart parts with
// their content types.
import 'dart:convert';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:test/test.dart';

import '../support/rest.dart';

Map<String, Object?> jsonBody(String body) =>
    (jsonDecode(body) as Map).cast<String, Object?>();

void main() {
  test('generate sends only the options that were set', () async {
    final h = makeClient((_, __) => ok({
          'jobId': jobId,
          'status': 'completed',
          'audioUrl': signedUrl,
          'creditsConsumed': 41,
        }));
    final result =
        await h.client.textToSpeech.generate('  مرحبا  ', voiceId: 'v1');
    final request = h.api.last;
    expect(request.method, 'POST');
    expect(request.url.toString(),
        'https://api.echonova.ai/v1/text-to-speech/sync');
    expect(request.headers['content-type'], 'application/json');
    expect(request.headers['accept'], 'application/json');
    expect(request.headers['user-agent'], startsWith('echonova-dart/'));
    expect(jsonBody(request.body), {'text': '  مرحبا  ', 'voiceId': 'v1'});
    expect(utf8.decode(request.bodyBytes), contains('مرحبا'));
    expect(result.jobId, jobId);
    expect(result.creditsConsumed, 41);
    expect(result.requestId, 'req-1');

    await h.client.textToSpeech.jobs.create('hi',
        voiceId: 'v1', speed: 1.5, numSteps: 16, normalize: false);
    expect(h.api.last.url.path, '/v1/text-to-speech');
    expect(jsonBody(h.api.last.body), {
      'text': 'hi',
      'voiceId': 'v1',
      'speed': 1.5,
      'numSteps': 16,
      'normalize': false,
    });
  });

  test(
      'Speech to Text uploads: snake_case fields, terminology as a JSON '
      'string, and the audio type', () async {
    final h =
        makeClient((_, __) => ok({'jobId': jobId, 'status': 'processing'}));
    await h.client.speechToText.jobs.create(
      AudioFile.fromBytes(mp3, 'call.mp3'),
      language: 'ar',
      numbersAsDigits: false,
      identifySpeakers: true,
      terminology: const Terminology([
        Keyword('KYC'),
        Keyword('Emirates NBD',
            variants: ['امريتس ان بي دي'],
            contextWords: ['bank'],
            needsContext: true),
      ]),
    );
    final request = h.api.last;
    expect(request.method, 'POST');
    expect(request.url.path, '/v1/speech-to-text');
    final parts = multipartParts(request);
    expect(parts.keys.toList(), [
      'language',
      'numbers_as_digits',
      'identify_speakers',
      'terminology',
      'file',
    ]);
    final fields = formFields(request);
    expect(fields['language'], 'ar');
    expect(fields['numbers_as_digits'], 'false');
    expect(fields['identify_speakers'], 'true');
    expect(jsonDecode(fields['terminology']!), {
      'keywords': [
        'KYC',
        {
          'term': 'Emirates NBD',
          'variants': ['امريتس ان بي دي'],
          'context_words': ['bank'],
          'needs_context': true,
        },
      ],
    });
    final file = parts['file']!;
    expect(file.filename, 'call.mp3');
    expect(file.contentType, 'audio/mpeg');
    expect(file.value, mp3);
  });

  test('only the language is sent when no option is set', () async {
    final h = makeClient((_, __) =>
        ok({'jobId': jobId, 'status': 'completed', 'transcription': 'hi'}));
    final result = await h.client.speechToText
        .transcribe(AudioFile.fromBytes(wav, 'a.wav'), language: 'en');
    expect(h.api.last.url.path, '/v1/speech-to-text/sync');
    expect(formFields(h.api.last), {'language': 'en'});
    expect(multipartParts(h.api.last)['file']!.contentType, 'audio/wav');
    expect(result.transcription, 'hi');
  });

  test('without a language none is sent, and the API uses auto', () async {
    final h = makeClient((_, __) => ok({
          'jobId': jobId,
          'status': 'completed',
          'transcription': 'hi',
          'language': 'auto',
        }));
    final result = await h.client.speechToText
        .transcribe(AudioFile.fromBytes(wav, 'a.wav'));
    expect(multipartParts(h.api.last).keys, ['file']);
    expect(result.language, 'auto');

    await h.client.speechToText.jobs.create(AudioFile.fromBytes(wav, 'a.wav'));
    expect(h.api.last.url.path, '/v1/speech-to-text');
    expect(multipartParts(h.api.last).keys, ['file']);

    await h.client.speechToText
        .transcribe(AudioFile.fromBytes(wav, 'a.wav'), language: 'auto');
    expect(formFields(h.api.last), {'language': 'auto'});
    await h.client.speechToText.jobs.create(AudioFile.fromBytes(wav, 'a.wav'),
        language: 'auto', numbersAsDigits: true);
    expect(formFields(h.api.last),
        {'language': 'auto', 'numbers_as_digits': 'true'});
  });

  test('a raw terminology JSON is sent as given', () async {
    final h =
        makeClient((_, __) => ok({'jobId': jobId, 'status': 'processing'}));
    await h.client.speechToText.jobs.create(
      AudioFile.fromBytes(wav, 'a.wav'),
      language: 'ar',
      terminology: const Terminology.fromJson({
        'keywords': [
          {'term': 'X', 'future_option': 1},
        ],
      }),
    );
    expect(jsonDecode(formFields(h.api.last)['terminology']!), {
      'keywords': [
        {'term': 'X', 'future_option': 1},
      ],
    });
  });

  test('Sound Cleaning fields are camelCase and only the ones set', () async {
    final h = makeClient((_, __) => ok({
          'id': jobId,
          'status': 'completed',
          'fileName': 'noisy.wav',
          'outputUrl': signedUrl,
          'creditsConsumed': 207,
          'metrics': {'sampleRate': 48000, 'bitDepth': 24},
        }));
    final job = await h.client.soundCleaning.clean(
      AudioFile.fromBytes(wav, 'noisy.wav'),
      targetLufs: -16,
      qFactor: 0.707,
      sampleRate: 48000,
      bitDepth: 24,
    );
    expect(h.api.last.url.path, '/v1/sound-cleaning');
    expect(formFields(h.api.last), {
      'qFactor': '0.707',
      'targetLufs': '-16',
      'sampleRate': '48000',
      'bitDepth': '24',
    });
    final file = multipartParts(h.api.last)['file']!;
    expect(file.contentType, 'audio/wav');
    expect(file.filename, 'noisy.wav');
    expect(job.metrics!.sampleRate, 48000);
    expect(job.creditsConsumed, 207);
  });

  test('job IDs are percent-encoded into the path', () async {
    final h = makeClient((_, __) => ok({'id': 'a/b', 'status': 'completed'}));
    await h.client.textToSpeech.jobs.get(' a/b ');
    expect(h.api.last.url.toString(),
        'https://api.echonova.ai/v1/text-to-speech/jobs/a%2Fb');
    expect(() => h.client.textToSpeech.jobs.get('  '),
        throwsA(isA<UsageException>()));
    expect(h.api.requests, hasLength(1));
  });

  test('list sends offset and limit only when set', () async {
    final h = makeClient((_, __) => ok({'items': <Object>[], 'total': 0}));
    await h.client.speechToText.jobs.list();
    expect(h.api.last.url.query, isEmpty);
    await h.client.speechToText.jobs.list(offset: 40, limit: 20);
    expect(h.api.last.url.queryParameters, {'offset': '40', 'limit': '20'});
    expect(
        () => h.client.speechToText.jobs.list(limit: 0), throwsArgumentError);
  });

  test('export returns the file as text, exportJson parses it', () async {
    final h = makeClient((request, _) {
      final format = request.url.queryParameters['format'];
      return format == 'json'
          ? textResponse(jsonEncode({
              'id': jobId,
              'text': 'مرحبا',
              'speakers': [
                {'id': 'spk0', 'label': 'المتحدث 1', 'talkTime': 1.5},
              ],
              'segments': <Object>[],
            }))
          : textResponse('مرحبا بكم');
    });
    final text = await h.client.speechToText.jobs
        .export(jobId, format: ExportFormat.txt);
    expect(text, 'مرحبا بكم');
    expect(h.api.last.url.path, '/v1/speech-to-text/jobs/$jobId/export');
    expect(h.api.last.url.queryParameters, {'format': 'txt'});
    expect(h.api.last.headers['accept'], '*/*');

    final export =
        await h.client.speechToText.jobs.exportJson(jobId, lang: 'ar');
    expect(h.api.last.url.queryParameters, {'format': 'json', 'lang': 'ar'});
    expect(export.speakers!.single.label, 'المتحدث 1');
    expect(export.requestId, 'req-export');
  });

  test('widget tickets send the visitor, channel and lifetime', () async {
    final h = makeClient((_, __) =>
        ok({'ticket': 'wtk_example', 'expiresAt': '2026-10-19T09:30:00.000Z'}));
    final ticket = await h.client.widgets.createTicket(
      'wdg_a1B2',
      user: const WidgetUser(id: 'user_8431'),
      ttlSeconds: 120,
    );
    expect(h.api.last.url.path, '/v1/widgets/wdg_a1B2/tickets');
    expect(jsonBody(h.api.last.body), {
      'user': {'id': 'user_8431'},
      'ttlSeconds': 120,
    });
    expect(ticket.ticket, 'wtk_example');
    expect(ticket.expiresAt, DateTime.utc(2026, 10, 19, 9, 30));

    await h.client.widgets.createTicket('wdg_a1B2');
    expect(jsonBody(h.api.last.body), isEmpty);
    expect(() => h.client.widgets.createTicket(' '),
        throwsA(isA<UsageException>()));
  });

  test('agent sessions: start, get and end', () async {
    final session = {
      'id': 'session-1',
      'agentId': 'agent-1',
      'channel': 'chat',
      'status': 'active',
      'startedAt': '2026-11-07T10:00:00.000Z',
      'endedAt': null,
    };
    final h = makeClient((request, _) {
      if (request.url.path.endsWith('/sessions')) {
        return ok({
          ...session,
          'token': 'room-token',
          'wsUrl': 'wss://rooms.example.com',
          'greeting': 'Hello!',
        });
      }
      if (request.url.path.endsWith('/end')) {
        return ok({
          ...session,
          'status': 'ended',
          'endedAt': '2026-11-07T10:05:00.000Z',
        });
      }
      return ok(session);
    });
    final started = await h.client.agents.sessions
        .start('agent-1', channel: AgentChannel.chat);
    expect(h.api.last.method, 'POST');
    expect(h.api.last.url.path, '/v1/agents/agent-1/sessions');
    expect(jsonBody(h.api.last.body), {'channel': 'chat'});
    expect(started.token, 'room-token');
    expect(started.greeting, 'Hello!');
    expect(started.channel, AgentChannel.chat);

    await h.client.agents.sessions.start('agent-1');
    expect(jsonBody(h.api.last.body), isEmpty);

    final got = await h.client.agents.sessions.get('agent-1', started.id);
    expect(h.api.last.method, 'GET');
    expect(h.api.last.url.path, '/v1/agents/agent-1/sessions/session-1');
    expect(got.status, AgentSessionStatus.active);

    final ended = await h.client.agents.sessions.end('agent-1', started.id);
    expect(h.api.last.method, 'POST');
    expect(h.api.last.url.path, '/v1/agents/agent-1/sessions/session-1/end');
    expect(ended.status, AgentSessionStatus.ended);
    expect(ended.endedAt, DateTime.utc(2026, 11, 7, 10, 5));
  });

  test('deletes return the result', () async {
    final h = makeClient((_, __) => ok({'deleted': true}));
    final deleted = await h.client.soundCleaning.jobs.delete(jobId);
    expect(h.api.last.method, 'DELETE');
    expect(h.api.last.url.path, '/v1/sound-cleaning/jobs/$jobId');
    expect(deleted.deleted, isTrue);
    expect(deleted.alreadyDeleted, isFalse);
  });
}
