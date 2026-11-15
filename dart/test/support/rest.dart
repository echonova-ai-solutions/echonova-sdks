/// Helpers for the REST tests: a fake clock, a recording mock HTTP client,
/// envelopes, multipart parsing, and examples built from the OpenAPI
/// schemas.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:echonova_ai/src/client.dart' show clientWithRuntime;
import 'package:echonova_ai/src/runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'spec.dart';

/// An API key for tests. It starts with `ek_REDACTED` so the publish check
/// knows it is not real.
const testKey = 'ek_REDACTED_unit_test_key_0000000000c21d';

/// The 24-hex job ID the tests use.
const jobId = '6a1b2c3d4e5f60718293a4b5';

/// A signed storage link; the query is the signature.
const signedUrl =
    'https://storage.example.com/tts/out.wav?sv=2024&sig=REDACTED-signature';

/// A minimal WAV header.
final Uint8List wav = Uint8List.fromList([
  ...'RIFF'.codeUnits,
  0x24,
  0,
  0,
  0,
  ...'WAVEfmt '.codeUnits,
  ...List.filled(32, 0)
]);

/// A minimal MP3 (ID3) header.
final Uint8List mp3 = Uint8List.fromList(
    [...'ID3'.codeUnits, 4, 0, 0, 0, 0, 0, 0, ...List.filled(32, 0)]);

/// A monotonic clock that moves only when the SDK sleeps.
final class FakeTime {
  /// Creates a fake clock. [random] is what every jitter draw returns.
  FakeTime({this.random = 0.5});

  /// Monotonic time.
  Duration monotonic = const Duration(seconds: 1000);

  /// Every sleep, in order.
  final sleeps = <Duration>[];

  /// The wall clock at monotonic time 1000 s.
  final start = DateTime.utc(2026, 11, 9, 12);

  /// What `random()` returns.
  double random;

  /// The wall clock now.
  DateTime now() => start.add(monotonic - const Duration(seconds: 1000));

  /// The runtime to give a client.
  ClientRuntime runtime() => ClientRuntime(
        clock: () => monotonic,
        now: now,
        sleep: (duration) async {
          sleeps.add(duration);
          monotonic += duration;
        },
        random: () => random,
      );
}

/// Answers a request; [index] counts from 0.
typedef Handler = FutureOr<http.Response> Function(
  http.Request request,
  int index,
);

/// Routes requests to a handler and keeps them.
final class Recorder {
  /// Creates a recorder.
  Recorder(this.handler);

  /// Answers each request.
  final Handler handler;

  /// Every request so far.
  final requests = <http.Request>[];

  /// The client to give the SDK.
  late final MockClient client = MockClient((request) async {
    final index = requests.length;
    requests.add(request);
    return handler(request, index);
  });

  /// The last request.
  http.Request get last => requests.last;
}

/// A client with a fake clock whose requests go to [handler], and whose
/// downloads go to [download] (or [handler]).
({EchoNova client, Recorder api, Recorder downloads, FakeTime time}) makeClient(
  Handler handler, {
  Handler? download,
  FakeTime? time,
  int maxRetries = 2,
  Duration? deadline,
  Duration? timeout,
  Map<String, String>? defaultHeaders,
  bool rateLimitPreflight = true,
  bool proxy = false,
  FutureOr<Map<String, String>> Function()? auth,
}) {
  final api = Recorder(handler);
  final downloads = Recorder(download ?? handler);
  final fake = time ?? FakeTime();
  final base = proxy
      ? EchoNova.proxy(
          baseUrl: Uri.parse('https://api.example.com/echonova'),
          auth: auth ?? () => {'Authorization': 'Bearer app-session'},
          httpClient: api.client,
          downloadHttpClient: downloads.client,
          maxRetries: maxRetries,
          deadline: deadline,
          timeout: timeout,
          defaultHeaders: defaultHeaders,
          rateLimitPreflight: rateLimitPreflight,
        )
      : EchoNova(
          apiKey: testKey,
          baseUrl: Uri.parse('https://api.echonova.ai'),
          httpClient: api.client,
          downloadHttpClient: downloads.client,
          maxRetries: maxRetries,
          deadline: deadline,
          timeout: timeout,
          defaultHeaders: defaultHeaders,
          rateLimitPreflight: rateLimitPreflight,
        );
  return (
    client: clientWithRuntime(base, fake.runtime()),
    api: api,
    downloads: downloads,
    time: fake,
  );
}

/// A success envelope around [data].
http.Response ok(
  Object? data, {
  Map<String, String> headers = const {},
  String requestId = 'req-1',
}) =>
    http.Response.bytes(success(data), 200, headers: {
      'content-type': 'application/json',
      'x-request-id': requestId,
      ...headers,
    });

/// A raw (not enveloped) response, like a transcript export.
http.Response textResponse(String body, {String requestId = 'req-export'}) =>
    http.Response.bytes(utf8.encode(body), 200, headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-request-id': requestId,
    });

/// An error envelope.
http.Response failure(
  int status,
  String? message, {
  Map<String, String> headers = const {},
}) =>
    http.Response.bytes(envelope(status, message), status, headers: {
      'content-type': 'application/json',
      'x-request-id': 'req-err',
      ...headers,
    });

/// A job as the API returns it.
Map<String, Object?> jobJson({
  String id = jobId,
  String status = 'completed',
  String? createdAt,
  String? text,
  String? audioUrl,
  String? outputUrl,
  String? error,
}) =>
    {
      'id': id,
      'status': status,
      'createdAt': createdAt ?? '2026-11-09T12:00:00.000Z',
      if (text != null) 'text': text,
      if (audioUrl != null) 'audioUrl': audioUrl,
      if (outputUrl != null) 'outputUrl': outputUrl,
      if (error != null) 'error': error,
    };

/// One part of a multipart body.
typedef Part = ({String? filename, String? contentType, Uint8List value});

/// The parts of a multipart request, by name.
Map<String, Part> multipartParts(http.Request request) {
  final type = request.headers['content-type']!;
  expectMultipart(type);
  final boundary = type.split('boundary=')[1];
  final body = request.bodyBytes;
  final delimiter = utf8.encode('--$boundary');
  final parts = <Map<String, Object>>[];
  final positions = <int>[];
  for (var i = 0; i + delimiter.length <= body.length; i++) {
    var match = true;
    for (var j = 0; j < delimiter.length; j++) {
      if (body[i + j] != delimiter[j]) {
        match = false;
        break;
      }
    }
    if (match) positions.add(i);
  }
  for (var k = 0; k + 1 < positions.length; k++) {
    // Skip the delimiter and its CRLF; drop the CRLF before the next one.
    final start = positions[k] + delimiter.length + 2;
    final end = positions[k + 1] - 2;
    final chunk = body.sublist(start, end);
    final split = _indexOf(chunk, const [13, 10, 13, 10]);
    final head = utf8.decode(chunk.sublist(0, split));
    final value = Uint8List.fromList(chunk.sublist(split + 4));
    parts.add({'head': head, 'value': value});
  }
  final result = <String, Part>{};
  for (final part in parts) {
    final headers = <String, String>{};
    for (final line in (part['head']! as String).split('\r\n')) {
      final colon = line.indexOf(':');
      headers[line.substring(0, colon).trim().toLowerCase()] =
          line.substring(colon + 1).trim();
    }
    final disposition = headers['content-disposition']!;
    final name = RegExp(r'name="([^"]*)"').firstMatch(disposition)![1]!;
    final filename = RegExp(r'filename="([^"]*)"').firstMatch(disposition)?[1];
    result[name] = (
      filename: filename,
      contentType: headers['content-type'],
      value: part['value']! as Uint8List,
    );
  }
  return result;
}

/// Throws unless [contentType] is multipart.
void expectMultipart(String contentType) {
  if (!contentType.startsWith('multipart/form-data; boundary=')) {
    throw StateError('not multipart: $contentType');
  }
}

int _indexOf(List<int> haystack, List<int> needle) {
  for (var i = 0; i + needle.length <= haystack.length; i++) {
    var match = true;
    for (var j = 0; j < needle.length; j++) {
      if (haystack[i + j] != needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/// The text fields of a multipart request.
Map<String, String> formFields(http.Request request) => {
      for (final MapEntry(:key, :value) in multipartParts(request).entries)
        if (value.filename == null) key: utf8.decode(value.value),
    };

// --- Examples synthesised from openapi.json ---------------------------------

/// The vendored OpenAPI document.
final Map<String, Object?> openapi = loadSpecMap('openapi.json');

Map<String, Object?> _map(Object? value) => (value! as Map).cast();

/// [schema] with `$ref`s followed.
Map<String, Object?> resolveSchema(Map<String, Object?> schema) {
  var current = schema;
  while (true) {
    final ref = current[r'$ref'];
    if (ref is! String) return current;
    final name = ref.split('/').last;
    current = _map(_map(_map(openapi['components'])['schemas'])[name]);
  }
}

/// An example value for [schema]: its `example` when given, otherwise built
/// from its parts.
Object? exampleFor(Map<String, Object?> schema) {
  final resolved = resolveSchema(schema);
  if (resolved['allOf'] case final List<Object?> parts) {
    final merged = <String, Object?>{};
    for (final part in parts) {
      final value = exampleFor(_map(part));
      if (value is Map<String, Object?>) {
        merged.addAll(value);
      } else {
        return value;
      }
    }
    if (resolved['properties'] case final Map<Object?, Object?> props) {
      merged.addAll(_map(exampleFor(
          {'type': 'object', 'properties': props.cast<String, Object?>()})));
    }
    return merged;
  }
  if (resolved.containsKey('properties') || resolved['type'] == 'object') {
    if (!resolved.containsKey('properties') &&
        resolved.containsKey('example')) {
      return resolved['example'];
    }
    final props = _map(resolved['properties'] ?? <String, Object?>{});
    return <String, Object?>{
      for (final MapEntry(:key, :value) in props.entries)
        key: _timestampHint(key, _map(value)) ?? exampleFor(_map(value)),
    };
  }
  if (resolved['type'] == 'array') {
    return [exampleFor(_map(resolved['items'] ?? <String, Object?>{}))];
  }
  if (resolved['example'] case final Object example) return example;
  if (resolved['enum'] case final List<Object?> values) return values.first;
  return switch (resolved['type']) {
    'string' => 'text',
    'number' => 1.5,
    'integer' => 1,
    'boolean' => true,
    _ => null,
  };
}

/// A timestamp for a `...At` string property the spec gives no example
/// for (such as `endedAt`, whose example is null).
String? _timestampHint(String name, Map<String, Object?> schema) {
  final resolved = resolveSchema(schema);
  if (!name.endsWith('At') || resolved['type'] != 'string') return null;
  return resolved['example'] == null ? '2026-11-07T10:30:00.000Z' : null;
}

/// The properties of an object schema, following refs and allOf.
Map<String, Map<String, Object?>> schemaProperties(
    Map<String, Object?> schema) {
  final resolved = resolveSchema(schema);
  final props = <String, Map<String, Object?>>{};
  for (final part in (resolved['allOf'] as List<Object?>?) ?? const []) {
    props.addAll(schemaProperties(_map(part)));
  }
  final own = resolved['properties'];
  if (own is Map) {
    for (final MapEntry(:key, :value) in own.entries) {
      props['$key'] = _map(value);
    }
  }
  return props;
}

/// The schema of `data` in an operation's 200 response.
Map<String, Object?> dataSchema(String path, String method) {
  final operation = _map(_map(_map(openapi['paths'])[path])[method]);
  final response = _map(_map(operation['responses'])['200']);
  final schema =
      _map(_map(_map(response['content'])['application/json'])['schema']);
  return schemaProperties(schema)['data']!;
}

/// A success response for an operation, with its documented example.
Object? exampleData(String path, String method) =>
    exampleFor(dataSchema(path, method));
