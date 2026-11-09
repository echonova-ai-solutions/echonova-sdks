/// Helpers shared by the tests: the shared contract in `../spec`, and small
/// builders.
library;

import 'dart:convert';
import 'dart:io';

import 'package:echonova/echonova.dart';

/// The repository's `spec/` folder (the shared contract).
final Directory specDir = () {
  var dir = Directory.current.absolute;
  while (true) {
    final candidate = Directory('${dir.path}/spec');
    if (File('${candidate.path}/error-rules.json').existsSync()) {
      return candidate;
    }
    final parent = dir.parent;
    if (parent.path == dir.path) {
      throw StateError('spec/error-rules.json not found above the package');
    }
    dir = parent;
  }
}();

/// Reads a JSON file below `spec/`.
Object? loadSpec(String relative) =>
    jsonDecode(File('${specDir.path}/$relative').readAsStringSync());

/// Reads a JSON object below `spec/`.
Map<String, Object?> loadSpecMap(String relative) =>
    (loadSpec(relative)! as Map).cast<String, Object?>();

/// The entries of a JSON array, as maps.
List<Map<String, Object?>> maps(Object? list) =>
    [for (final item in list! as List<Object?>) (item! as Map).cast()];

/// An EchoNova error envelope.
List<int> envelope(
  int status,
  String? message, [
  Map<String, Object?> extra = const {},
]) =>
    utf8.encode(
      jsonEncode({
        'data': null,
        'statusCode': status,
        'success': false,
        'errorMessage': message,
        ...extra,
      }),
    );

/// A success envelope around [data].
List<int> success(Object? data) => utf8.encode(
      jsonEncode({
        'data': data,
        'success': true,
        'statusCode': 200,
        'errorMessage': null,
      }),
    );

/// The Dart class name of an exception (works without reflection, and on
/// the web where type names are minified).
String exceptionName(EchoNovaException error) =>
    error.toString().split(':').first;

/// The Dart name of a class in the shared taxonomy (`RateLimitError` →
/// `RateLimitException`).
String dartName(String taxonomyName) =>
    taxonomyName.replaceFirst(RegExp(r'Error$'), 'Exception');
