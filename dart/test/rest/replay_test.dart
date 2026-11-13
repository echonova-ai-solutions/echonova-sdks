/// Replays the REST traffic recorded from the live API
/// (`spec/fixtures/rest`).
///
/// Each fixture's response is served to the SDK method for its operation
/// (`spec/mapping.json`, matched by method and path), called with the
/// recorded arguments. The method must return the response parsed, or throw
/// the error `spec/fixtures/expected.json` names, and send the recorded
/// request.
@TestOn('vm')
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/client.dart' show clientWithRuntime;
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

import '../support/fixtures.dart';
import '../support/rest.dart';
import '../support/spec.dart';

/// Recordings that send what the SDK's API can't, and why. For those, the
/// parts of the request the SDK can't reproduce are left out of the request
/// check (a stand-in value is used where an argument is required); the
/// response handling is checked in full.
const unsendable = {
  // No REST method takes extra form fields or JSON keys: only the Text to
  // Speech stream has `extraBody`.
  'clean/clean_unknown_field': 'the unknown form field foo',
  'tts/sync_unknown_field': 'the unknown JSON field foo',
  'stt/job_export_bad_format': 'format=vtt: ExportFormat has txt, srt, json',
  'stt/sync_missing_language': 'no language: it is a required argument',
  'stt/sync_octet_stream_mp3': 'an application/octet-stream upload: '
      'AudioFile refuses generic types',
  'tts/sync_not_json': 'a text/plain body: the SDK always sends JSON',
};

/// An operation in `spec/mapping.json`.
final class MappedOperation {
  MappedOperation(Map<String, Object?> json)
      : method = json['method']! as String,
        template = json['path']! as String,
        dartName = (json['sdk']! as Map)['dart']! as String,
        params = [for (final p in maps(json['params'])) p] {
    final names = <String>[];
    final pattern = template.splitMapJoin(
      RegExp(r'\{(\w+)\}'),
      onMatch: (match) {
        names.add(match[1]!);
        return '([^/]+)';
      },
      onNonMatch: RegExp.escape,
    );
    _pattern = RegExp('^$pattern\$');
    _pathNames = names;
  }

  final String method;
  final String template;
  final String dartName;
  final List<Map<String, Object?>> params;
  late final RegExp _pattern;
  late final List<String> _pathNames;

  /// The path parameters, when [method] and [path] are this operation's.
  Map<String, String>? match(String method, String path) {
    if (method != this.method) return null;
    final found = _pattern.firstMatch(path);
    if (found == null) return null;
    return {
      for (var i = 0; i < _pathNames.length; i++)
        _pathNames[i]: Uri.decodeComponent(found[i + 1]!),
    };
  }
}

/// The recorded request as the arguments of an SDK method, by their Dart
/// names, and what of it the SDK can't send ([deviations], by
/// `<where>.<API name>`).
final class RecordedArgs {
  RecordedArgs(MappedOperation operation, Map<String, Object?> request) {
    final pathParams =
        operation.match(request['method']! as String, _path(request))!;
    final sources = <String, Map<String, Object?>>{
      'path': pathParams,
      'query': _optionalMap(request['query']),
      'json': _optionalMap(request['json']),
      'form': _optionalMap(request['form']),
    };
    final known = <String, Set<String>>{};
    for (final param in operation.params) {
      final where = param['in']! as String;
      final api = param['api']! as String;
      final dart = param['dart']! as String;
      _params[dart] = (where: where, api: api);
      known.putIfAbsent(where, () => {}).add(api);
      if (where == 'form' && api == 'file') {
        if (request['file'] case final Map<Object?, Object?> file) {
          values[dart] = file.cast<String, Object?>();
        }
      } else if (sources[where]!.containsKey(api)) {
        values[dart] = sources[where]![api];
      }
    }
    for (final MapEntry(key: where, value: source) in sources.entries) {
      for (final api in source.keys) {
        if (!(known[where]?.contains(api) ?? false)) {
          deviations['$where.$api'] =
              'not a parameter of ${operation.dartName}';
        }
      }
    }
    if (request.containsKey('content')) {
      deviations['content'] = 'a raw body';
    }
  }

  final _params = <String, ({String where, String api})>{};

  /// The recorded values, by Dart parameter name.
  final values = <String, Object?>{};

  /// The values the call used.
  final used = <String>{};

  /// What the SDK can't send as recorded, by `<where>.<API name>`.
  final deviations = <String, String>{};

  String _key(String name) {
    final param = _params[name]!;
    return '${param.where}.${param.api}';
  }

  Object? _take(String name) {
    if (!_params.containsKey(name)) {
      throw StateError('mapping.json has no parameter $name');
    }
    used.add(name);
    return values[name];
  }

  /// A required string. When the recording has none, [standIn] is sent
  /// instead and the difference noted.
  String required(String name, {String standIn = 'stand-in'}) {
    final value = _take(name);
    if (value == null) {
      deviations[_key(name)] = 'missing: "$standIn" stands in';
      return standIn;
    }
    return '$value';
  }

  /// An optional string.
  String? string(String name) => switch (_take(name)) {
        null => null,
        final Object value => '$value',
      };

  /// An optional whole number (query and form values are text).
  int? integer(String name) => switch (_take(name)) {
        null => null,
        final int value => value,
        final Object value => int.parse('$value'),
      };

  /// An optional number.
  double? number(String name) => switch (_take(name)) {
        null => null,
        final num value => value.toDouble(),
        final Object value => double.parse('$value'),
      };

  /// An optional flag.
  bool? flag(String name) => switch (_take(name)) {
        null => null,
        final bool value => value,
        final Object value => switch ('$value') {
            'true' => true,
            'false' => false,
            final text => throw FormatException('not a flag: $text'),
          },
      };

  /// The upload: zero-filled audio of the recorded size, name and type. The
  /// type is passed only when the SDK wouldn't pick it from the name.
  AudioFile file(String name) {
    final recorded = jsonMap(_take(name));
    final filename = recorded['filename']! as String;
    final type = recorded['content_type']! as String;
    final bytes = Uint8List(recorded['bytes']! as int);
    final dot = filename.lastIndexOf('.');
    final fromName = dot < 0
        ? null
        : audioExtensionTypes[filename.substring(dot).toLowerCase()];
    if (fromName == type) return AudioFile.fromBytes(bytes, filename);
    try {
      return AudioFile.fromBytes(bytes, filename, contentType: type);
    } on UsageException {
      deviations['file.content_type'] = '$type is refused';
      return AudioFile.fromBytes(bytes, filename);
    }
  }

  /// The terminology form field (JSON text): typed keywords when it is a
  /// keyword list, otherwise the JSON as it is.
  Terminology? terminology(String name) {
    final text = string(name);
    if (text == null) return null;
    final json = jsonMap(jsonDecode(text));
    final keywords = json['keywords'];
    if (json.length == 1 && keywords is List) {
      final typed = <Keyword>[];
      for (final item in keywords) {
        if (item is String) {
          typed.add(Keyword(item));
        } else if (item is Map &&
            item.keys.every({'term', 'variants'}.contains) &&
            item['term'] is String) {
          typed.add(Keyword(
            item['term']! as String,
            variants: (item['variants'] as List?)?.cast<String>(),
          ));
        } else {
          return Terminology.fromJson(json);
        }
      }
      return Terminology(typed);
    }
    return Terminology.fromJson(json);
  }

  /// The export format; [ExportFormat.txt] stands in for one the enum
  /// doesn't have.
  ExportFormat format(String name) {
    final value = required(name);
    for (final format in ExportFormat.values) {
      if (format.name == value) return format;
    }
    deviations[_key(name)] = '$value is not an ExportFormat';
    return ExportFormat.txt;
  }
}

String _path(Map<String, Object?> request) =>
    (request['path']! as String).split('?').first;

Map<String, Object?> _optionalMap(Object? value) =>
    value == null ? const {} : jsonMap(value);

typedef Invoker = Future<Object?> Function(EchoNova client, RecordedArgs a);

/// The SDK call for each operation that has recordings, by its Dart name.
final Map<String, Invoker> invokers = {
  'textToSpeech.generate': (c, a) => c.textToSpeech.generate(
        a.required('text'),
        voiceId: a.required('voiceId'),
        speed: a.number('speed'),
        cfg: a.number('cfg'),
        numSteps: a.integer('numSteps'),
        tashkeel: a.flag('tashkeel'),
        normalize: a.flag('normalize'),
      ),
  'textToSpeech.jobs.create': (c, a) => c.textToSpeech.jobs.create(
        a.required('text'),
        voiceId: a.required('voiceId'),
        speed: a.number('speed'),
        cfg: a.number('cfg'),
        numSteps: a.integer('numSteps'),
        tashkeel: a.flag('tashkeel'),
        normalize: a.flag('normalize'),
      ),
  'textToSpeech.voices.list': (c, a) => c.textToSpeech.voices.list(),
  'textToSpeech.jobs.list': (c, a) => c.textToSpeech.jobs
      .list(offset: a.integer('offset'), limit: a.integer('limit')),
  'textToSpeech.jobs.get': (c, a) =>
      c.textToSpeech.jobs.get(a.required('jobId')),
  'textToSpeech.jobs.delete': (c, a) =>
      c.textToSpeech.jobs.delete(a.required('jobId')),
  'speechToText.transcribe': (c, a) => c.speechToText.transcribe(
        a.file('file'),
        language: a.required('language', standIn: 'ar'),
        numbersAsDigits: a.flag('numbersAsDigits'),
        identifySpeakers: a.flag('identifySpeakers'),
        terminology: a.terminology('terminology'),
      ),
  'speechToText.jobs.create': (c, a) => c.speechToText.jobs.create(
        a.file('file'),
        language: a.required('language', standIn: 'ar'),
        numbersAsDigits: a.flag('numbersAsDigits'),
        identifySpeakers: a.flag('identifySpeakers'),
        terminology: a.terminology('terminology'),
      ),
  'speechToText.jobs.list': (c, a) => c.speechToText.jobs
      .list(offset: a.integer('offset'), limit: a.integer('limit')),
  'speechToText.jobs.get': (c, a) =>
      c.speechToText.jobs.get(a.required('jobId')),
  'speechToText.jobs.delete': (c, a) =>
      c.speechToText.jobs.delete(a.required('jobId')),
  'speechToText.jobs.export': (c, a) {
    final jobId = a.required('jobId');
    final format = a.format('format');
    final lang = a.string('lang');
    return format == ExportFormat.json
        ? c.speechToText.jobs.exportJson(jobId, lang: lang)
        : c.speechToText.jobs.export(jobId, format: format, lang: lang);
  },
  'soundCleaning.clean': (c, a) => c.soundCleaning.clean(
        a.file('file'),
        cutoffFreq: a.number('cutoffFreq'),
        qFactor: a.number('qFactor'),
        targetLufs: a.number('targetLufs'),
        truePeakDbfs: a.number('truePeakDbfs'),
        compThreshDb: a.number('compThreshDb'),
        compRatio: a.number('compRatio'),
        compAttackMs: a.number('compAttackMs'),
        compReleaseMs: a.number('compReleaseMs'),
        sampleRate: a.integer('sampleRate'),
        bitDepth: a.integer('bitDepth'),
      ),
  'soundCleaning.jobs.list': (c, a) => c.soundCleaning.jobs
      .list(offset: a.integer('offset'), limit: a.integer('limit')),
  'soundCleaning.jobs.get': (c, a) =>
      c.soundCleaning.jobs.get(a.required('jobId')),
  'soundCleaning.jobs.delete': (c, a) =>
      c.soundCleaning.jobs.delete(a.required('jobId')),
};

/// The recorded response.
http.Response recordedResponse(Map<String, Object?> response) {
  final List<int> body;
  if (response.containsKey('json')) {
    body = utf8.encode(jsonEncode(response['json']));
  } else if (response['text'] case final String text) {
    body = utf8.encode(text);
  } else if (response['bytes'] case final int size) {
    body = Uint8List(size);
  } else {
    body = const [];
  }
  return http.Response.bytes(
    body,
    response['status']! as int,
    headers: (response['headers']! as Map).cast<String, String>(),
  );
}

/// The typed fields of a parsed result, named as in the API's JSON.
Object? typedView(Object? value) => switch (value) {
      null || String() || num() || bool() || DateTime() => value,
      List<Object?>() => [for (final item in value) typedView(item)],
      Page<Object?>() => {
          'items': typedView(value.items),
          'total': value.total
        },
      JobInitiated() => {'jobId': value.jobId, 'status': value.status.value},
      DeleteResult() => {'deleted': value.deleted},
      TtsResult() => {
          'jobId': value.jobId,
          'status': value.status.value,
          'audioUrl': value.audioUrl,
          'durationSeconds': value.durationSeconds,
          'creditsConsumed': value.creditsConsumed,
        },
      VoiceList() => {'items': typedView(value.items), 'total': value.total},
      Voice() => {
          'id': value.id,
          'name': value.name,
          'displayName': value.displayName,
          'language': value.language,
          'gender': value.gender,
          'previewUrl': value.previewUrl,
        },
      TtsJob() => {
          'id': value.id,
          'status': value.status.value,
          'text': value.text,
          'voiceId': value.voiceId,
          'audioUrl': value.audioUrl,
          'durationSeconds': value.durationSeconds,
          'creditsConsumed': value.creditsConsumed,
          'error': value.error,
          'stream': typedView(value.stream),
          'createdAt': value.createdAt,
        },
      TtsJobStream() => {
          'sessionId': value.sessionId,
          'requestId': value.synthesisRequestId,
          'cancelled': value.cancelled,
          'audioDropped': value.audioDropped,
        },
      SttResult() => {
          'jobId': value.jobId,
          'status': value.status.value,
          'transcription': value.transcription,
          'durationSeconds': value.durationSeconds,
          'language': value.language,
          'numbersAsDigits': value.numbersAsDigits,
          'identifySpeakers': value.identifySpeakers,
          'segments': typedView(value.segments),
          'speakers': typedView(value.speakers),
          'terminology': typedView(value.terminology),
          'creditsConsumed': value.creditsConsumed,
        },
      SttJob() => {
          'id': value.id,
          'status': value.status.value,
          'transcription': value.transcription,
          'durationSeconds': value.durationSeconds,
          'language': value.language,
          'numbersAsDigits': value.numbersAsDigits,
          'identifySpeakers': value.identifySpeakers,
          'segments': typedView(value.segments),
          'speakers': typedView(value.speakers),
          'terminology': typedView(value.terminology),
          'stream': typedView(value.stream),
          'audioUrl': value.audioUrl,
          'creditsConsumed': value.creditsConsumed,
          'error': value.error,
          'createdAt': value.createdAt,
        },
      SttJobStream() => {'sessionId': value.sessionId},
      SttSegment() => {
          'start': value.start,
          'end': value.end,
          'text': value.text,
          'speaker': value.speaker,
        },
      SttSpeaker() => {'id': value.id, 'talkTime': value.talkTime},
      TerminologyResult() => {
          'raw': value.rawText,
          'corrected': value.corrected,
          'edits': typedView(value.edits),
          'nearMisses': typedView(value.nearMisses),
          'warnings': typedView(value.warnings),
          'mapperStatus': value.mapperStatus,
          'mapperVersion': value.mapperVersion,
        },
      TerminologyEdit() => {
          'start': value.start,
          'end': value.end,
          'original': value.original,
          'replacement': value.replacement,
          'stage': value.stage,
          'score': value.score,
        },
      TerminologyNearMiss() => {
          'start': value.start,
          'end': value.end,
          'original': value.original,
          'candidate': value.candidate,
          'score': value.score,
        },
      TerminologyWarning() => {'code': value.code, 'detail': value.detail},
      CleanJob() => {
          'id': value.id,
          'status': value.status.value,
          'fileName': value.fileName,
          'outputUrl': value.outputUrl,
          'durationSeconds': value.durationSeconds,
          'creditsConsumed': value.creditsConsumed,
          'options': typedView(value.options),
          'metrics': typedView(value.metrics),
          'error': value.error,
          'createdAt': value.createdAt,
        },
      CleanJobOptions() => {
          'cutoffFreq': value.cutoffFreq,
          'qFactor': value.qFactor,
          'targetLufs': value.targetLufs,
          'truePeakDbfs': value.truePeakDbfs,
          'compThreshDb': value.compThreshDb,
          'compRatio': value.compRatio,
          'compAttackMs': value.compAttackMs,
          'compReleaseMs': value.compReleaseMs,
        },
      CleanMetrics() => {
          'sampleRate': value.sampleRate,
          'bitDepth': value.bitDepth,
          'integratedLufs': value.integratedLufs,
          'truePeakDbfs': value.truePeakDbfs,
        },
      TranscriptExport() => {
          'id': value.id,
          'fileName': value.fileName,
          'durationSeconds': value.durationSeconds,
          'language': value.language,
          'text': value.text,
          'speakers': typedView(value.speakers),
          'segments': typedView(value.segments),
        },
      TranscriptExportSpeaker() => {
          'id': value.id,
          'label': value.label,
          'talkTime': value.talkTime,
        },
      TranscriptExportSegment() => {
          'start': value.start,
          'end': value.end,
          'speaker': value.speaker,
          'speakerLabel': value.speakerLabel,
          'text': value.text,
        },
      _ => throw StateError('no typed view for $value'),
    };

/// Every typed field equals the recorded JSON (a missing field reads as
/// `null`; timestamps are compared as instants).
void expectTyped(Object? typed, Object? recorded, String path) {
  switch (typed) {
    case Map<String, Object?>():
      expect(recorded, isA<Map<Object?, Object?>>(), reason: path);
      final json = recorded! as Map<Object?, Object?>;
      for (final MapEntry(:key, :value) in typed.entries) {
        expectTyped(value, json[key], '$path.$key');
      }
    case List<Object?>():
      expect(recorded, isA<List<Object?>>(), reason: path);
      final list = recorded! as List<Object?>;
      expect(typed, hasLength(list.length), reason: path);
      for (var i = 0; i < list.length; i++) {
        expectTyped(typed[i], list[i], '$path[$i]');
      }
    case DateTime():
      expect(recorded, isA<String>(), reason: path);
      expect(typed, DateTime.parse(recorded! as String), reason: path);
    default:
      expect(typed, recorded, reason: path);
  }
}

/// Every result object keeps the recorded JSON as it is, and carries the
/// response's request ID.
void expectRaw(Object? result, Object? recorded, String requestId) {
  switch (result) {
    case Page<Object?>():
      expect(result.raw, recorded);
      expect(result.requestId, requestId);
      final items = (recorded! as Map)['items']! as List<Object?>;
      for (var i = 0; i < items.length; i++) {
        expectRaw(result.items[i], items[i], requestId);
      }
    case VoiceList():
      expect(result.toJson(), recorded);
      expect(result.requestId, requestId);
      final items = (recorded! as Map)['items']! as List<Object?>;
      for (var i = 0; i < items.length; i++) {
        expectRaw(result.items[i], items[i], requestId);
      }
    case ApiResult():
      expect(result.toJson(), recorded);
      expect(result.requestId, requestId);
    default:
      fail('not an API result: $result');
  }
}

/// Fields of the API's JSON that the SDK keeps only in `raw`, by path.
List<String> untyped(Object? typed, Object? recorded, [String path = '']) {
  if (typed is Map<String, Object?> && recorded is Map) {
    return [
      for (final MapEntry(:key, :value) in recorded.entries)
        if (!typed.containsKey(key))
          '$path.$key'
        else
          ...untyped(typed[key], value, '$path.$key'),
    ];
  }
  if (typed is List<Object?> && recorded is List) {
    return {
      for (var i = 0; i < recorded.length && i < typed.length; i++)
        ...untyped(typed[i], recorded[i], '$path[]'),
    }.toList();
  }
  return const [];
}

/// The parts of [actual] and [recorded] that should match: every key not
/// in [skip].
void expectSameFields(
  Map<String, Object?> actual,
  Map<String, Object?> recorded,
  Set<String> skip,
  String where,
) {
  Map<String, Object?> kept(Map<String, Object?> map) => {
        for (final MapEntry(:key, :value) in map.entries)
          if (!skip.contains('$where.$key')) key: value,
      };
  expect(kept(actual), kept(recorded), reason: 'request $where');
}

/// The request the SDK sent matches the recording, except what it can't
/// send ([RecordedArgs.deviations]).
void expectRecordedRequest(
  http.Request sent,
  Map<String, Object?> recorded,
  RecordedArgs args,
) {
  final skip = args.deviations.keys.toSet();
  expect(sent.method, recorded['method']);
  expect(sent.url.scheme, 'https');
  expect(sent.url.host, 'api.echonova.ai');
  expect(sent.url.path, _path(recorded));
  expectSameFields(
    sent.url.queryParameters,
    {
      for (final MapEntry(:key, :value)
          in _optionalMap(recorded['query']).entries)
        key: '$value',
    },
    skip,
    'query',
  );
  switch (recorded['authorization']) {
    case 'test key':
      expect(sent.headers['authorization'], 'Bearer $testKey');
    case 'none':
      expect(sent.headers.keys.map((k) => k.toLowerCase()),
          isNot(contains('authorization')));
    default:
      fail('unknown authorization ${recorded['authorization']}');
  }
  final type = sent.headers['content-type'];
  if (recorded['json'] case final Map<Object?, Object?> json) {
    expect(type, 'application/json');
    expectSameFields(jsonMap(jsonDecode(sent.body)), json.cast(), skip, 'json');
  } else if (recorded.containsKey('file')) {
    final parts = multipartParts(sent);
    final file = jsonMap(recorded['file']);
    final upload = parts[file['field']! as String]!;
    expect(upload.filename, file['filename']);
    expect(upload.value, hasLength(file['bytes']));
    if (!skip.contains('file.content_type')) {
      expect(upload.contentType, file['content_type']);
    }
    final fields = formFields(sent);
    final form = _optionalMap(recorded['form']);
    // terminology travels as JSON text; the recorder's spacing differs.
    Map<String, Object?> decoded(Map<String, Object?> map) => {
          for (final MapEntry(:key, :value) in map.entries)
            key: key == 'terminology' ? jsonDecode('$value') : value,
        };
    expectSameFields(decoded(fields), decoded(form), skip, 'form');
  } else if (recorded.containsKey('content')) {
    expect(skip, contains('content'));
  } else {
    expect(sent.bodyBytes, isEmpty, reason: 'no body was recorded');
    expect(type, isNull);
  }
}

void main() {
  final fixtures = recordedFixtures('rest', '.json');
  final expectations = fixtureExpectations('rest');
  final operations = [
    for (final op in jsonMap(loadSpecMap('mapping.json')['operations']).values)
      MappedOperation(jsonMap(op)),
  ];

  fixtureCoverageTests('rest', fixtures, expectations);

  for (final fixture in fixtures) {
    test(fixture.name, () async {
      final record = readRestFixture(fixture.file);
      final expectation = expectations[fixture.name];
      if (expectation == null) fail('no expectation in expected.json');
      expect(expectation.keys.toSet().difference({'ok', 'error'}), isEmpty,
          reason: 'unknown expectation');
      final request = jsonMap(record['request']);
      final response = jsonMap(record['response']);
      final headers = (response['headers']! as Map).cast<String, String>();
      final requestId = headers['x-request-id']!;

      final matches = [
        for (final op in operations)
          if (op.match(request['method']! as String, _path(request)) != null)
            op,
      ];
      expect(matches, hasLength(1),
          reason: 'one operation for ${request['method']} ${request['path']}');
      final operation = matches.single;
      final invoke = invokers[operation.dartName];
      if (invoke == null) fail('no invoker for ${operation.dartName}');

      final api = Recorder((_, __) => recordedResponse(response));
      final base = request['authorization'] == 'none'
          // EchoNova() refuses to run without a key; a proxy client whose
          // auth hook adds nothing sends the same request.
          ? EchoNova.proxy(
              baseUrl: Uri.parse('https://api.echonova.ai'),
              auth: () => const {},
              httpClient: api.client,
              downloadHttpClient: api.client,
            )
          : EchoNova(
              apiKey: testKey,
              baseUrl: Uri.parse('https://api.echonova.ai'),
              httpClient: api.client,
              downloadHttpClient: api.client,
            );
      addTearDown(base.close);
      final client = clientWithRuntime(base, FakeTime().runtime());

      final args = RecordedArgs(operation, request);
      Object? result;
      Object? error;
      try {
        result = await invoke(client, args);
      } on Object catch (caught) {
        error = caught;
      }

      expect(args.values.keys.toSet().difference(args.used), isEmpty,
          reason: 'recorded arguments the call ignored');
      expect(args.deviations.isNotEmpty, unsendable.containsKey(fixture.name),
          reason: 'what the SDK could not send: ${args.deviations}');
      expect(api.requests, hasLength(1), reason: 'one request, no retry');
      expectRecordedRequest(api.last, request, args);

      final body = response['json'];
      if (expectation['ok'] == true) {
        if (error != null) fail('expected a result, got $error');
        expect(response['status'], inInclusiveRange(200, 299));
        if (operation.dartName == 'speechToText.jobs.export') {
          // The export is the file itself, not an envelope.
          if (response['text'] case final String text) {
            expect(result, text);
          } else {
            expectRaw(result, body, requestId);
            expectTyped(typedView(result), body, 'export');
            expect(untyped(typedView(result), body), isEmpty,
                reason: 'recorded fields the SDK keeps only in raw');
          }
          final raw = await client.speechToText.jobs.exportWithResponse(
            args.values['jobId']! as String,
            format:
                ExportFormat.values.byName(args.values['format']! as String),
            lang: args.values['lang'] as String?,
          );
          expect(raw.requestId, requestId);
          expect(raw.statusCode, response['status']);
          final text = raw.parse();
          if (response['text'] case final String recorded) {
            expect(text, recorded);
          } else {
            expect(jsonDecode(text), body); // `export` gives the JSON as text
          }
        } else {
          final data = jsonMap(body)['data'];
          expectRaw(result, data, requestId);
          expectTyped(typedView(result), data, 'data');
          expect(untyped(typedView(result), data), isEmpty,
              reason: 'recorded fields the SDK keeps only in raw');
        }
      } else {
        final name = expectation['error']! as String;
        if (error == null) fail('expected $name, got $result');
        expect(error, isA<APIStatusException>());
        final failure = error as APIStatusException;
        expect(exceptionName(failure), dartName(name));
        expect(failure.statusCode, response['status']);
        final envelope = jsonMap(body);
        expect(failure.errorMessage, envelope['errorMessage']);
        expect(failure.docsUrl, envelope['docs']);
        expect(failure.requestId, requestId);
      }
    });
  }
}
