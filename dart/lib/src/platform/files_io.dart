/// `dart:io` implementation of file access: uploads from a path, and
/// downloads written to a temporary file that is renamed into place.
library;

import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import '../errors.dart';
import '../transport/http_transport.dart' show DownloadSink;

/// Whether this platform has a file system.
const bool hasFileSystem = true;

/// The last segment of [path].
String baseName(String path) {
  final normalized = path.replaceAll(r'\', '/');
  return normalized.substring(normalized.lastIndexOf('/') + 1);
}

/// The size of the file at [path]. Throws [UsageException] when there is
/// no such file.
Future<int> fileLength(String path) async {
  final file = File(path);
  if (!file.existsSync()) throw UsageException('No such file: $path');
  return file.length();
}

/// The bytes of the file at [path], for one upload attempt.
Stream<List<int>> readFile(String path) => File(path).openRead();

/// The first [count] bytes of the file at [path] (fewer when it is
/// shorter).
Future<Uint8List> readHead(String path, int count) async {
  final handle = await File(path).open();
  try {
    return await handle.read(count);
  } finally {
    await handle.close();
  }
}

/// A download written to a temporary file next to its target, then renamed
/// into place, so a failed download never leaves a partial file behind.
final class FileDownloadSink implements DownloadSink {
  FileDownloadSink._(this.target, this._temp, this._handle);

  /// Opens a sink for [path]. When [path] is a directory, the file is named
  /// [fallbackName] inside it.
  static Future<FileDownloadSink> open(String path, String fallbackName) async {
    var target = path;
    if (FileSystemEntity.isDirectorySync(path)) {
      final separator = path.endsWith('/') || path.endsWith(r'\') ? '' : '/';
      target = '$path$separator$fallbackName';
    }
    final directory = File(target).parent.path;
    final random = math.Random();
    for (var tries = 0;; tries++) {
      final suffix = random.nextInt(1 << 32).toRadixString(36);
      final temp = File('$directory/.${baseName(target)}.$suffix.part');
      try {
        await temp.create(exclusive: true);
      } on FileSystemException {
        // Taken by a concurrent download, or the folder is missing.
        if (tries >= 5) rethrow;
        continue;
      }
      final handle = await temp.open(mode: FileMode.write);
      return FileDownloadSink._(target, temp, handle);
    }
  }

  /// Where the file ends up.
  final String target;

  final File _temp;
  final RandomAccessFile _handle;

  @override
  Future<void> reset() async {
    await _handle.truncate(0);
    await _handle.setPosition(0);
  }

  @override
  Future<void> add(List<int> chunk) async {
    await _handle.writeFrom(chunk);
  }

  /// Finishes the download: the file appears at [target].
  Future<String> commit() async {
    await _handle.close();
    await _temp.rename(target);
    return target;
  }

  /// Abandons the download and removes the temporary file.
  Future<void> discard() async {
    try {
      await _handle.close();
    } on FileSystemException {
      // Already closed.
    }
    try {
      await _temp.delete();
    } on FileSystemException {
      // Already gone.
    }
  }
}
