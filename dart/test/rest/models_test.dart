// Response models: every documented field is modelled and parses the
// examples synthesised from openapi.json; parsing is lenient.
import 'package:echonova/echonova.dart';
import 'package:echonova/src/models/base.dart';
import 'package:test/test.dart';

import '../support/rest.dart';

/// A model field: its API name, how to read it, and the shape of a nested
/// object (or of each item of a nested list).
final class Field<T> {
  const Field(this.api, this.read, [this.nested]);

  final String api;
  final Object? Function(T model) read;
  final Shape<Object>? nested;
}

/// How to parse a model, and its fields.
final class Shape<T extends Object> {
  const Shape(this.name, this.fromJson, this.fields);

  final String name;
  final T Function(Map<String, Object?> json) fromJson;
  final List<Field<T>> fields;

  /// Checks that every property of [schema] is modelled, and that the
  /// example parses into non-null fields, recursively.
  void verify(Map<String, Object?> schema, {String where = ''}) {
    final props = schemaProperties(schema);
    expect({for (final f in fields) f.api}, props.keys.toSet(),
        reason: '$name$where models every documented field');
    final example = exampleFor(schema)! as Map<String, Object?>;
    final model = fromJson(example);
    if (model is ApiObject) expect(model.raw, example);
    for (final field in fields) {
      if (example[field.api] != null) {
        expect(field.read(model), isNotNull,
            reason: '$name.${field.api} parses ${example[field.api]}');
      }
      final nested = field.nested;
      if (nested != null) {
        var sub = resolveSchema(props[field.api]!);
        if (sub['type'] == 'array') {
          sub = (sub['items']! as Map).cast();
        }
        nested.verify(sub, where: '$where.${field.api}');
      }
    }
  }
}

Shape<Object> erase<T extends Object>(Shape<T> shape) => Shape<Object>(
      shape.name,
      shape.fromJson,
      [
        for (final field in shape.fields)
          Field<Object>(field.api, (m) => field.read(m as T), field.nested),
      ],
    );

final jobInitiated =
    Shape<JobInitiated>('JobInitiated', JobInitiated.fromJson, [
  Field('jobId', (m) => m.jobId),
  Field('status', (m) => m.status),
]);

final deleteResult =
    Shape<DeleteResult>('DeleteResult', DeleteResult.fromJson, [
  Field('deleted', (m) => m.deleted),
]);

final ttsResult = Shape<TtsResult>('TtsResult', TtsResult.fromJson, [
  Field('jobId', (m) => m.jobId),
  Field('status', (m) => m.status),
  Field('audioUrl', (m) => m.audioUrl),
  Field('durationSeconds', (m) => m.durationSeconds),
  Field('creditsConsumed', (m) => m.creditsConsumed),
]);

final voice = Shape<Voice>('Voice', Voice.fromJson, [
  Field('id', (m) => m.id),
  Field('name', (m) => m.name),
  Field('displayName', (m) => m.displayName),
  Field('language', (m) => m.language),
  Field('gender', (m) => m.gender),
  Field('previewUrl', (m) => m.previewUrl),
]);

final voiceList = Shape<VoiceList>('VoiceList', VoiceList.fromJson, [
  Field('items', (m) => m.items, erase(voice)),
  Field('total', (m) => m.total),
]);

final ttsJobStream =
    Shape<TtsJobStream>('TtsJobStream', TtsJobStream.fromJson, [
  Field('sessionId', (m) => m.sessionId),
  Field('requestId', (m) => m.synthesisRequestId),
  Field('cancelled', (m) => m.cancelled),
  Field('audioDropped', (m) => m.audioDropped),
]);

final ttsJob = Shape<TtsJob>('TtsJob', TtsJob.fromJson, [
  Field('id', (m) => m.id),
  Field('status', (m) => m.status),
  Field('text', (m) => m.text),
  Field('voiceId', (m) => m.voiceId),
  Field('audioUrl', (m) => m.audioUrl),
  Field('durationSeconds', (m) => m.durationSeconds),
  Field('creditsConsumed', (m) => m.creditsConsumed),
  Field('error', (m) => m.error),
  Field('stream', (m) => m.stream, erase(ttsJobStream)),
  Field('createdAt', (m) => m.createdAt),
]);

final segment = Shape<SttSegment>('SttSegment', SttSegment.fromJson, [
  Field('start', (m) => m.start),
  Field('end', (m) => m.end),
  Field('text', (m) => m.text),
  Field('speaker', (m) => m.speaker),
]);

final speaker = Shape<SttSpeaker>('SttSpeaker', SttSpeaker.fromJson, [
  Field('id', (m) => m.id),
  Field('talkTime', (m) => m.talkTime),
]);

final edit =
    Shape<TerminologyEdit>('TerminologyEdit', TerminologyEdit.fromJson, [
  Field('start', (m) => m.start),
  Field('end', (m) => m.end),
  Field('original', (m) => m.original),
  Field('replacement', (m) => m.replacement),
  Field('stage', (m) => m.stage),
  Field('score', (m) => m.score),
]);

final nearMiss = Shape<TerminologyNearMiss>(
    'TerminologyNearMiss', TerminologyNearMiss.fromJson, [
  Field('start', (m) => m.start),
  Field('end', (m) => m.end),
  Field('original', (m) => m.original),
  Field('candidate', (m) => m.candidate),
  Field('score', (m) => m.score),
]);

final warning = Shape<TerminologyWarning>(
    'TerminologyWarning', TerminologyWarning.fromJson, [
  Field('code', (m) => m.code),
  Field('detail', (m) => m.detail),
]);

final terminologyResult =
    Shape<TerminologyResult>('TerminologyResult', TerminologyResult.fromJson, [
  Field('raw', (m) => m.rawText),
  Field('corrected', (m) => m.corrected),
  Field('edits', (m) => m.edits, erase(edit)),
  Field('nearMisses', (m) => m.nearMisses, erase(nearMiss)),
  Field('warnings', (m) => m.warnings, erase(warning)),
  Field('mapperStatus', (m) => m.mapperStatus),
  Field('mapperVersion', (m) => m.mapperVersion),
]);

final sttResult = Shape<SttResult>('SttResult', SttResult.fromJson, [
  Field('jobId', (m) => m.jobId),
  Field('status', (m) => m.status),
  Field('transcription', (m) => m.transcription),
  Field('durationSeconds', (m) => m.durationSeconds),
  Field('language', (m) => m.language),
  Field('numbersAsDigits', (m) => m.numbersAsDigits),
  Field('identifySpeakers', (m) => m.identifySpeakers),
  Field('segments', (m) => m.segments, erase(segment)),
  Field('speakers', (m) => m.speakers, erase(speaker)),
  Field('terminology', (m) => m.terminology, erase(terminologyResult)),
  Field('creditsConsumed', (m) => m.creditsConsumed),
]);

final sttJobStream =
    Shape<SttJobStream>('SttJobStream', SttJobStream.fromJson, [
  Field('sessionId', (m) => m.sessionId),
]);

final sttJob = Shape<SttJob>('SttJob', SttJob.fromJson, [
  Field('id', (m) => m.id),
  Field('status', (m) => m.status),
  Field('transcription', (m) => m.transcription),
  Field('durationSeconds', (m) => m.durationSeconds),
  Field('language', (m) => m.language),
  Field('numbersAsDigits', (m) => m.numbersAsDigits),
  Field('identifySpeakers', (m) => m.identifySpeakers),
  Field('segments', (m) => m.segments, erase(segment)),
  Field('speakers', (m) => m.speakers, erase(speaker)),
  Field('terminology', (m) => m.terminology, erase(terminologyResult)),
  Field('stream', (m) => m.stream, erase(sttJobStream)),
  Field('audioUrl', (m) => m.audioUrl),
  Field('creditsConsumed', (m) => m.creditsConsumed),
  Field('error', (m) => m.error),
  Field('createdAt', (m) => m.createdAt),
]);

final cleanOptions =
    Shape<CleanJobOptions>('CleanJobOptions', CleanJobOptions.fromJson, [
  Field('cutoffFreq', (m) => m.cutoffFreq),
  Field('qFactor', (m) => m.qFactor),
  Field('targetLufs', (m) => m.targetLufs),
  Field('truePeakDbfs', (m) => m.truePeakDbfs),
  Field('compThreshDb', (m) => m.compThreshDb),
  Field('compRatio', (m) => m.compRatio),
  Field('compAttackMs', (m) => m.compAttackMs),
  Field('compReleaseMs', (m) => m.compReleaseMs),
]);

final cleanMetrics =
    Shape<CleanMetrics>('CleanMetrics', CleanMetrics.fromJson, [
  Field('sampleRate', (m) => m.sampleRate),
  Field('bitDepth', (m) => m.bitDepth),
  Field('integratedLufs', (m) => m.integratedLufs),
  Field('truePeakDbfs', (m) => m.truePeakDbfs),
]);

final cleanJob = Shape<CleanJob>('CleanJob', CleanJob.fromJson, [
  Field('id', (m) => m.id),
  Field('status', (m) => m.status),
  Field('fileName', (m) => m.fileName),
  Field('outputUrl', (m) => m.outputUrl),
  Field('durationSeconds', (m) => m.durationSeconds),
  Field('creditsConsumed', (m) => m.creditsConsumed),
  Field('options', (m) => m.options, erase(cleanOptions)),
  Field('metrics', (m) => m.metrics, erase(cleanMetrics)),
  Field('error', (m) => m.error),
  Field('createdAt', (m) => m.createdAt),
]);

final widgetTicket =
    Shape<WidgetTicket>('WidgetTicket', WidgetTicket.fromJson, [
  Field('ticket', (m) => m.ticket),
  Field('expiresAt', (m) => m.expiresAt),
]);

final agentSession =
    Shape<AgentSession>('AgentSession', AgentSession.fromJson, [
  Field('id', (m) => m.id),
  Field('agentId', (m) => m.agentId),
  Field('channel', (m) => m.channel),
  Field('status', (m) => m.status),
  Field('startedAt', (m) => m.startedAt),
  Field('endedAt', (m) => m.endedAt),
]);

final startedAgentSession = Shape<StartedAgentSession>(
    'StartedAgentSession', StartedAgentSession.fromJson, [
  Field('id', (m) => m.id),
  Field('agentId', (m) => m.agentId),
  Field('channel', (m) => m.channel),
  Field('status', (m) => m.status),
  Field('startedAt', (m) => m.startedAt),
  Field('endedAt', (m) => m.endedAt),
  Field('token', (m) => m.token),
  Field('wsUrl', (m) => m.wsUrl),
  Field('greeting', (m) => m.greeting),
]);

/// Each 200 response's `data`, and the model the SDK parses it into.
final responses = <(String, String, Shape<Object>)>[
  ('/v1/text-to-speech', 'post', erase(jobInitiated)),
  ('/v1/text-to-speech/sync', 'post', erase(ttsResult)),
  ('/v1/text-to-speech/voices', 'get', erase(voiceList)),
  ('/v1/text-to-speech/jobs/{jobId}', 'get', erase(ttsJob)),
  ('/v1/text-to-speech/jobs/{jobId}', 'delete', erase(deleteResult)),
  ('/v1/speech-to-text', 'post', erase(jobInitiated)),
  ('/v1/speech-to-text/sync', 'post', erase(sttResult)),
  ('/v1/speech-to-text/jobs/{jobId}', 'get', erase(sttJob)),
  ('/v1/speech-to-text/jobs/{jobId}', 'delete', erase(deleteResult)),
  ('/v1/sound-cleaning', 'post', erase(cleanJob)),
  ('/v1/sound-cleaning/jobs/{jobId}', 'get', erase(cleanJob)),
  ('/v1/sound-cleaning/jobs/{jobId}', 'delete', erase(deleteResult)),
  ('/v1/widgets/{publicId}/tickets', 'post', erase(widgetTicket)),
  ('/v1/agents/{agentId}/sessions', 'post', erase(startedAgentSession)),
  ('/v1/agents/{agentId}/sessions/{sessionId}', 'get', erase(agentSession)),
  (
    '/v1/agents/{agentId}/sessions/{sessionId}/end',
    'post',
    erase(agentSession)
  ),
];

final lists = <(String, Shape<Object>)>[
  ('/v1/text-to-speech/jobs', erase(ttsJob)),
  ('/v1/speech-to-text/jobs', erase(sttJob)),
  ('/v1/sound-cleaning/jobs', erase(cleanJob)),
];

void main() {
  group('every documented field is modelled and parsed', () {
    for (final (path, method, shape) in responses) {
      test('${method.toUpperCase()} $path → ${shape.name}', () {
        shape.verify(dataSchema(path, method));
      });
    }
    for (final (path, shape) in lists) {
      test('GET $path items → ${shape.name}', () {
        final schema = dataSchema(path, 'get');
        final props = schemaProperties(schema);
        expect(props.keys.toSet(), {'items', 'total'});
        shape.verify((props['items']!['items']! as Map).cast());
      });
    }
  });

  test('results carry the request ID', () {
    final example =
        exampleFor(dataSchema('/v1/text-to-speech/jobs/{jobId}', 'get'))!
            as Map<String, Object?>;
    final job = TtsJob.fromJson(example, requestId: 'req-9');
    expect(job.requestId, 'req-9');
    expect(job.toJson(), example);
    final voices = VoiceList.fromJson(
      exampleFor(dataSchema('/v1/text-to-speech/voices', 'get'))!
          as Map<String, Object?>,
      requestId: 'req-v',
    );
    expect(voices.requestId, 'req-v');
    expect(voices.first.requestId, 'req-v');
    expect(voices, hasLength(1));
    expect(voices[0].id, isNotEmpty);
  });

  test('values from the examples', () {
    final job = TtsJob.fromJson(
        exampleFor(dataSchema('/v1/text-to-speech/jobs/{jobId}', 'get'))!
            as Map<String, Object?>);
    expect(job.createdAt, DateTime.utc(2026, 9, 15, 10, 21, 4, 512));
    expect(job.creditsConsumed, 41);
    expect(job.status, JobStatus.completed);
    expect(job.stream!.synthesisRequestId, 'reply-1');
    expect(job.stream!.cancelled, isTrue);

    final stt = SttResult.fromJson(
        exampleFor(dataSchema('/v1/speech-to-text/sync', 'post'))!
            as Map<String, Object?>);
    expect(stt.terminology!.rawText, isNotNull);
    expect(stt.terminology!.edits!.first.replacement, 'Emirates NBD');
    expect(stt.terminology!.edits!.first.start, 32);
    expect(stt.segments!.first.speaker, 'spk0');
    expect(stt.id, stt.jobId);

    final sttJob = SttJob.fromJson(
        exampleFor(dataSchema('/v1/speech-to-text/jobs/{jobId}', 'get'))!
            as Map<String, Object?>);
    expect(sttJob.audioUrl, startsWith('https://'));
    expect(sttJob.stream!.sessionId, isNotEmpty);

    final started = StartedAgentSession.fromJson(
        exampleFor(dataSchema('/v1/agents/{agentId}/sessions', 'post'))!
            as Map<String, Object?>);
    expect(started.channel, AgentChannel.voice);
    expect(started.status, AgentSessionStatus.active);
    expect(started.endedAt, DateTime.utc(2026, 11, 7, 10, 30));
    expect(started.startedAt, DateTime.utc(2026, 11, 7, 10));
    expect(started, isA<AgentSession>());
  });

  test('the JSON transcript export matches the documented example', () {
    final content = (((((openapi['paths']!
            as Map)['/v1/speech-to-text/jobs/{jobId}/export'] as Map)['get']
        as Map)['responses'] as Map)['200'] as Map)['content'] as Map;
    final example = ((content['application/json'] as Map)['example'] as Map)
        .cast<String, Object?>();
    final export = TranscriptExport.fromJson(example);
    expect(export.speakers!.first.label, 'Speaker 1');
    expect(export.segments![1].speakerLabel, 'Speaker 2');
    expect(export.text, isNotEmpty);
    expect(export.durationSeconds, 312.4);
    expect(example.keys.toSet(), {
      'id',
      'fileName',
      'durationSeconds',
      'language',
      'text',
      'speakers',
      'segments',
    });
    expect(
        (example['speakers']! as List)
            .cast<Map<Object?, Object?>>()
            .first
            .keys
            .toSet(),
        {'id', 'label', 'talkTime'});
    expect(
        (example['segments']! as List)
            .cast<Map<Object?, Object?>>()
            .first
            .keys
            .toSet(),
        {'start', 'end', 'speaker', 'speakerLabel', 'text'});
  });

  group('lenient parsing', () {
    test('missing fields are null and unknown fields are kept', () {
      final job = SttJob.fromJson({
        'id': 'j1',
        'status': 'processing',
        'newField': {'x': 1}
      });
      expect(job.transcription, isNull);
      expect(job.segments, isNull);
      expect(job.stream, isNull);
      expect(job.raw['newField'], {'x': 1});
    });

    test('unknown enum values are kept', () {
      final job = TtsJob.fromJson({'id': 'j', 'status': 'queued'});
      expect(job.status.value, 'queued');
      expect(job.status.isKnown, isFalse);
      expect(job.status.isTerminal, isFalse);
      expect(job.status, JobStatus('queued'));
      expect(identical(JobStatus('failed'), JobStatus.failed), isTrue);
      final session = AgentSession.fromJson(
          {'id': 's', 'status': 'paused', 'channel': 'video'});
      expect(session.status.value, 'paused');
      expect(session.status.isOver, isTrue);
      expect(session.channel!.value, 'video');
      expect(session.channel!.isKnown, isFalse);
      expect(AgentSessionStatus('out_of_credits'),
          AgentSessionStatus.outOfCredits);
    });

    test('a missing ID or status is a FormatException', () {
      expect(() => TtsJob.fromJson({'status': 'completed'}),
          throwsFormatException);
      expect(() => SttJob.fromJson({'id': 'x'}), throwsFormatException);
      expect(() => CleanJob.fromJson({}), throwsFormatException);
      expect(() => Voice.fromJson({'name': 'x'}), throwsFormatException);
      expect(
          () => StartedAgentSession.fromJson({'id': 's', 'status': 'active'}),
          throwsFormatException);
    });

    test('numbers', () {
      expect(readDouble(3), 3.0);
      expect(readDouble('4.25'), 4.25);
      expect(readDouble(' 7 '), 7.0);
      expect(readDouble('x'), isNull);
      expect(readDouble(true), isNull);
      expect(readInt(41), 41);
      expect(readInt(41.0), 41);
      expect(readInt('26'), 26);
      expect(readInt('26.0'), 26);
      expect(readInt(1.5), isNull); // never silently rounded
      expect(readInt(double.nan), isNull);
      expect(readBool(true), isTrue);
      expect(readBool('false'), isFalse);
      expect(readBool(1), isTrue);
      expect(readBool('yes'), isNull);
    });

    test('timestamps', () {
      expect(readDateTime('2026-09-15T10:21:04.512Z'),
          DateTime.utc(2026, 9, 15, 10, 21, 4, 512));
      expect(readDateTime('2026-09-15T10:21:04Z'),
          DateTime.utc(2026, 9, 15, 10, 21, 4));
      expect(readDateTime('2026-09-15T10:21:04.1+02:00'),
          DateTime.utc(2026, 9, 15, 8, 21, 4, 100));
      expect(readDateTime('2026-09-15T10:21:04-0130'),
          DateTime.utc(2026, 9, 15, 11, 51, 4));
      expect(readDateTime('2026-09-15T10:21:04.123456789Z'),
          DateTime.utc(2026, 9, 15, 10, 21, 4, 123, 456));
      expect(
          readDateTime('2026-09-15 10:21'), DateTime.utc(2026, 9, 15, 10, 21));
      expect(readDateTime('2026-09-15'), DateTime.utc(2026, 9, 15));
      expect(readDateTime('2026-09-15T10:21:04'),
          DateTime.utc(2026, 9, 15, 10, 21, 4));
      expect(readDateTime('yesterday'), isNull);
      expect(readDateTime('2026-13-45T00:00:00Z'), isNull);
      expect(readDateTime('2026-02-30'), isNull);
      expect(readDateTime(12), isNull);
    });

    test('unparseable values stay in raw', () {
      final job = TtsJob.fromJson({
        'id': 'j',
        'status': 'completed',
        'createdAt': 'soon',
        'creditsConsumed': 'n/a',
      });
      expect(job.createdAt, isNull);
      expect(job.creditsConsumed, isNull);
      expect(job.raw['createdAt'], 'soon');
    });

    test('lists skip entries that are not objects', () {
      final result = SttResult.fromJson({
        'jobId': 'j',
        'status': 'completed',
        'segments': [
          {'start': 1, 'end': 2, 'text': 'hi', 'speaker': null},
          'junk',
        ],
      });
      expect(result.segments, hasLength(1));
      expect(result.segments!.first.speaker, isNull);
    });

    test('raw is read-only', () {
      final job = TtsJob.fromJson({'id': 'j', 'status': 'completed'});
      expect(() => job.raw['id'] = 'x', throwsUnsupportedError);
    });
  });

  test('toString shows no secrets, links or content', () {
    final started = StartedAgentSession.fromJson({
      'id': 'session-1',
      'agentId': 'agent-1',
      'channel': 'voice',
      'status': 'active',
      'startedAt': '2026-11-07T10:00:00.000Z',
      'endedAt': null,
      'token': 'room-token-secret-value',
      'wsUrl': 'wss://rooms.example.com',
      'greeting': null,
    });
    expect(started.token, 'room-token-secret-value');
    expect(started.toString(), isNot(contains('room-token')));
    expect(started.toString(), contains('session-1'));
    final ticket = WidgetTicket.fromJson(
        {'ticket': 'wtk_secret_ticket', 'expiresAt': '2026-10-19T09:30:00Z'});
    expect(ticket.toString(), isNot(contains('wtk_secret_ticket')));
    final job = TtsJob.fromJson({
      'id': 'j',
      'status': 'completed',
      'text': 'private words',
      'audioUrl': signedUrl,
    });
    expect(job.toString(), isNot(contains('private words')));
    expect(job.toString(), isNot(contains('sig=')));
  });
}
