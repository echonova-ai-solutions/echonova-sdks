/// The recorded API traffic in `spec/fixtures/rest` and `spec/fixtures/ws`,
/// and what every SDK must do with it (`spec/fixtures/expected.json`).
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

import 'spec.dart';

/// One recorded fixture: its name (such as `tts/sync_ok`) and its file.
typedef Fixture = ({String name, File file});

/// The fixtures below `spec/fixtures/[kind]` (`rest` or `ws`), sorted by
/// name. Every file there must end in [extension].
List<Fixture> recordedFixtures(String kind, String extension) {
  final root = Directory('${specDir.path}/fixtures/$kind');
  final base = root.uri.pathSegments.where((s) => s.isNotEmpty).length;
  final fixtures = <Fixture>[];
  for (final entity in root.listSync(recursive: true)) {
    if (entity is! File) continue;
    final relative = entity.uri.pathSegments.skip(base).join('/');
    if (!relative.endsWith(extension)) {
      throw StateError('spec/fixtures/$kind/$relative is not a '
          '$extension fixture');
    }
    fixtures.add((
      name: relative.substring(0, relative.length - extension.length),
      file: entity,
    ));
  }
  return fixtures..sort((a, b) => a.name.compareTo(b.name));
}

/// What `spec/fixtures/expected.json` says about the fixtures of [kind], by
/// fixture name.
Map<String, Map<String, Object?>> fixtureExpectations(String kind) {
  final all = loadSpecMap('fixtures/expected.json');
  return {
    for (final MapEntry(:key, :value) in (all[kind]! as Map).entries)
      '$key': (value! as Map).cast<String, Object?>(),
  };
}

/// Tests that every fixture of [kind] has an expectation and every
/// expectation a fixture.
void fixtureCoverageTests(
  String kind,
  List<Fixture> fixtures,
  Map<String, Map<String, Object?>> expectations,
) {
  final names = {for (final fixture in fixtures) fixture.name};
  test('$kind: every recorded fixture has an expectation', () {
    expect(names, isNotEmpty);
    expect(names.difference(expectations.keys.toSet()), isEmpty,
        reason: 'add these to spec/fixtures/expected.json');
  });
  test('$kind: every expectation has a recorded fixture', () {
    expect(expectations.keys.toSet().difference(names), isEmpty,
        reason: 'no such fixture in spec/fixtures/$kind');
  });
}

/// A JSON object read from a fixture.
Map<String, Object?> jsonMap(Object? value) =>
    (value! as Map).cast<String, Object?>();

/// A REST fixture's JSON.
Map<String, Object?> readRestFixture(File file) =>
    jsonMap(jsonDecode(file.readAsStringSync()));

/// One line of a stream transcript.
final class TranscriptLine {
  /// Creates a line.
  TranscriptLine(this.index, this.dir, this.kind, this.data);

  /// Its position in the transcript.
  final int index;

  /// `out` (client to server) or `in`.
  final String dir;

  /// `connect`, `open`, `json`, `text`, `binary`, `close`, `abort` or
  /// `handshake_rejected`.
  final String kind;

  /// The event's data.
  final Map<String, Object?> data;

  /// Whether the client sent it.
  bool get isOut => dir == 'out';

  /// The `type` of a JSON frame.
  String? get type => kind == 'json' ? data['type'] as String? : null;

  /// The byte count of a binary frame.
  int get bytes => data['bytes']! as int;

  /// A copy at another position, for a reordered transcript.
  TranscriptLine at(int newIndex) => TranscriptLine(newIndex, dir, kind, data);

  @override
  String toString() => '#$index $dir ${type ?? kind}';
}

/// The lines of a stream transcript (`.jsonl`).
List<TranscriptLine> readTranscript(File file) {
  final lines = <TranscriptLine>[];
  for (final text in file.readAsLinesSync()) {
    if (text.trim().isEmpty) continue;
    final line = jsonMap(jsonDecode(text));
    lines.add(TranscriptLine(
      lines.length,
      line['dir']! as String,
      line['kind']! as String,
      jsonMap(line['data']),
    ));
  }
  return lines;
}
