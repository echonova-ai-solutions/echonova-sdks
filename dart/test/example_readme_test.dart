// pub.dev shows example/README.md on the package's Example tab, so the README
// embeds the landing example. This keeps the copy identical to the file.
@TestOn('vm')
library;

import 'dart:io';

import 'package:test/test.dart';

void main() {
  test('example/README.md embeds example/echonova_example.dart unchanged', () {
    final readme = File('example/README.md').readAsStringSync();
    final example = File('example/echonova_example.dart').readAsStringSync();
    expect(readme.contains('```dart\n$example```'), isTrue,
        reason: 'copy example/echonova_example.dart into the first dart '
            'block of example/README.md');
  });
}
