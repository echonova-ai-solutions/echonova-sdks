/// Web implementation of file access: browsers have no file system, so
/// paths are not supported. Use bytes or streams instead.
library;

import 'dart:typed_data';

import '../errors.dart';
import '../transport/http_transport.dart' show DownloadSink;

/// Whether this platform has a file system.
const bool hasFileSystem = false;

Never _unsupported() => throw UnsupportedEnvironmentException(
      'There is no file system on the web. Use AudioFile.fromBytes or '
      'AudioFile.fromStream, and client.download for bytes.',
    );

/// The last segment of [path].
String baseName(String path) {
  final normalized = path.replaceAll(r'\', '/');
  return normalized.substring(normalized.lastIndexOf('/') + 1);
}

/// Not available on the web.
Future<int> fileLength(String path) async => _unsupported();

/// Not available on the web.
Stream<List<int>> readFile(String path) => _unsupported();

/// Not available on the web.
Future<Uint8List> readHead(String path, int count) async => _unsupported();

/// Not available on the web.
final class FileDownloadSink implements DownloadSink {
  /// Not available on the web.
  static Future<FileDownloadSink> open(
          String path, String fallbackName) async =>
      _unsupported();

  /// Where the file ends up.
  String get target => _unsupported();

  @override
  Future<void> reset() async => _unsupported();

  @override
  Future<void> add(List<int> chunk) async => _unsupported();

  /// Not available on the web.
  Future<String> commit() async => _unsupported();

  /// Not available on the web.
  Future<void> discard() async {}
}
