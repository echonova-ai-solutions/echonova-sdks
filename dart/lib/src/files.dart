/// Audio uploads: name, media type and replay across retries.
///
/// The media type comes from an explicit value, then the SDK's own
/// extension map, then the file's first bytes. The SDK always sends a
/// specific `audio/*` type and never `application/octet-stream`: the API
/// rejects generic types.
///
/// Bytes and paths can be sent again when an attempt fails before the
/// request ran. A stream can be sent only once: after its first byte has
/// been read, a failed upload is not retried.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:http_parser/http_parser.dart' show MediaType;

import 'errors.dart';
import 'platform/files.dart' as files;
import 'transport/http_transport.dart' show MultipartUpload;

/// File extensions the SDK knows, with the media type it sends for each.
const Map<String, String> audioExtensionTypes = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.amr': 'audio/amr',
};

const _genericTypes = {'application/octet-stream', 'binary/octet-stream', ''};

/// How many leading bytes [sniffAudioType] looks at.
const int sniffLength = 16;

/// Recognises common audio containers from their first bytes, or returns
/// `null`.
String? sniffAudioType(List<int> head) {
  bool startsWith(List<int> prefix, [int at = 0]) {
    if (head.length < at + prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) {
      if (head[at + i] != prefix[i]) return false;
    }
    return true;
  }

  if (startsWith('RIFF'.codeUnits) && startsWith('WAVE'.codeUnits, 8)) {
    return 'audio/wav';
  }
  if (startsWith('fLaC'.codeUnits)) return 'audio/flac';
  if (startsWith('OggS'.codeUnits)) return 'audio/ogg';
  if (startsWith('ID3'.codeUnits)) return 'audio/mpeg';
  if (startsWith('#!AMR\n'.codeUnits)) return 'audio/amr';
  if (startsWith('ftyp'.codeUnits, 4)) return 'audio/mp4';
  if (startsWith(const [0x1a, 0x45, 0xdf, 0xa3])) return 'audio/webm';
  if (head.length >= 2 && head[0] == 0xff && head[1] & 0xe0 == 0xe0) {
    // ADTS AAC has layer 0; MPEG audio doesn't.
    final layer = (head[1] >> 1) & 0x03;
    return layer == 0 ? 'audio/aac' : 'audio/mpeg';
  }
  return null;
}

/// The media type for [filename]'s extension, or `null`.
String? audioTypeForName(String filename) {
  final dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return audioExtensionTypes[filename.substring(dot).toLowerCase()];
}

String? _checkExplicit(String? contentType) {
  if (contentType == null) return null;
  final type = contentType.trim();
  final essence = type.split(';').first.trim().toLowerCase();
  if (_genericTypes.contains(essence)) {
    throw UsageException(
      'The content type "$contentType" is too generic: the API needs the '
      'audio type, such as "audio/mpeg".',
    );
  }
  try {
    MediaType.parse(type);
  } on FormatException catch (error) {
    throw UsageException(
      'The content type "$contentType" is not a valid media type',
      cause: error,
    );
  }
  return type;
}

Never _unknownType(String filename) => throw UsageException(
      'Can\'t tell the audio format of "$filename". Use a known extension '
      '(${audioExtensionTypes.keys.join(', ')}) or pass contentType, such '
      'as "audio/mpeg".',
    );

String _defaultName(String filename, String contentType) {
  if (filename.trim().isNotEmpty) return filename;
  final essence = contentType.split(';').first.trim().toLowerCase();
  for (final MapEntry(:key, :value) in audioExtensionTypes.entries) {
    if (value == essence) return 'audio$key';
  }
  return 'audio';
}

/// An audio file to upload: bytes, a stream, or (except on the web) a
/// path.
///
/// ```dart
/// AudioFile.fromBytes(bytes, 'call.mp3');
/// AudioFile.fromPath('meeting.wav');                    // not on the web
/// AudioFile.fromStream(stream, length, 'recording.ogg');
/// AudioFile.fromBytes(bytes, 'clip', contentType: 'audio/webm');
/// ```
///
/// The media type is [contentType] when you give one, otherwise it comes
/// from the file name's extension, otherwise from the first bytes. When
/// none of these tells, the upload fails with a [UsageException] before
/// anything is sent.
final class AudioFile {
  AudioFile._(this.filename, this._contentType, this._source);

  /// Audio in memory. It can be sent again when a retry is needed.
  ///
  /// Throws [UsageException] when the media type can't be told.
  factory AudioFile.fromBytes(
    Uint8List bytes,
    String filename, {
    String? contentType,
  }) {
    final type = _checkExplicit(contentType) ??
        audioTypeForName(filename) ??
        sniffAudioType(bytes.length > sniffLength
            ? Uint8List.sublistView(bytes, 0, sniffLength)
            : bytes) ??
        _unknownType(filename);
    return AudioFile._(
      _defaultName(filename, type),
      type,
      _BytesSource(bytes),
    );
  }

  /// Audio from a stream of [length] bytes.
  ///
  /// A stream can be read only once, so a failed upload is retried only if
  /// the stream had not been read yet (for example after a connection
  /// failure). When the type can't be told from [contentType] or
  /// [filename], the first bytes are read to recognise it.
  factory AudioFile.fromStream(
    Stream<List<int>> stream,
    int length,
    String filename, {
    String? contentType,
  }) {
    if (length < 0) {
      throw ArgumentError.value(length, 'length', 'must not be negative');
    }
    final type = _checkExplicit(contentType) ?? audioTypeForName(filename);
    return AudioFile._(
      type == null ? filename : _defaultName(filename, type),
      type,
      _StreamSource(stream, length),
    );
  }

  /// The file at [path]. It is read again for each attempt, so it can be
  /// retried. Not available on the web: there it throws
  /// [UnsupportedEnvironmentException] when uploaded.
  ///
  /// [filename] defaults to the last segment of [path]. A `dart:io` `File`
  /// works too: `AudioFile.fromPath(file.path)`.
  factory AudioFile.fromPath(
    String path, {
    String? filename,
    String? contentType,
  }) {
    final name = filename ?? files.baseName(path);
    final type = _checkExplicit(contentType) ?? audioTypeForName(name);
    return AudioFile._(name, type, _PathSource(path));
  }

  /// The file name sent with the upload.
  final String filename;

  String? _contentType;
  final _Source _source;

  /// The media type sent with the upload. `null` until the first upload
  /// when it has to be recognised from the file's first bytes.
  String? get contentType => _contentType;

  /// The size in bytes, when known before the upload (bytes and streams).
  int? get length => _source.knownLength;

  /// Whether the file can (still) be sent: false once a stream has been
  /// read.
  bool get isReplayable => _source.isReplayable;

  Future<MultipartUpload> _prepare() async {
    var type = _contentType;
    if (type == null) {
      final head = await _source.head(sniffLength);
      type = sniffAudioType(head) ?? _unknownType(filename);
      _contentType = type;
    }
    final length = await _source.length();
    return _Upload(this, _defaultName(filename, type), type, length);
  }

  @override
  String toString() => 'AudioFile($filename, ${_contentType ?? 'type not '
      'known yet'}${length == null ? '' : ', $length bytes'})';
}

/// Resolves [file]'s media type and size for an upload. Internal.
Future<MultipartUpload> prepareUpload(AudioFile file) => file._prepare();

final class _Upload implements MultipartUpload {
  _Upload(this._file, this.filename, this.contentType, this.length);

  final AudioFile _file;

  @override
  final String filename;

  @override
  final String contentType;

  @override
  final int length;

  @override
  bool get isReplayable => _file._source.isReplayable;

  @override
  Stream<List<int>> open() {
    if (!isReplayable) {
      throw UsageException(
        'The stream of "$filename" was already read: a stream can be '
        'uploaded only once.',
      );
    }
    return _file._source.open();
  }
}

sealed class _Source {
  int? get knownLength;

  bool get isReplayable;

  Future<int> length();

  Future<List<int>> head(int count);

  Stream<List<int>> open();
}

final class _BytesSource extends _Source {
  _BytesSource(this._bytes);

  final Uint8List _bytes;

  @override
  int get knownLength => _bytes.length;

  @override
  bool get isReplayable => true;

  @override
  Future<int> length() async => _bytes.length;

  @override
  Future<List<int>> head(int count) async =>
      _bytes.length > count ? Uint8List.sublistView(_bytes, 0, count) : _bytes;

  @override
  Stream<List<int>> open() => Stream.value(_bytes);
}

final class _PathSource extends _Source {
  _PathSource(this._path);

  final String _path;

  @override
  int? get knownLength => null;

  @override
  bool get isReplayable => true;

  @override
  Future<int> length() => files.fileLength(_path);

  @override
  Future<List<int>> head(int count) async {
    await files.fileLength(_path); // A clear error when the file is missing.
    return files.readHead(_path, count);
  }

  @override
  Stream<List<int>> open() => files.readFile(_path);
}

/// A single-subscription stream. Reading its head for sniffing keeps those
/// bytes and puts them back in front when it is uploaded.
final class _StreamSource extends _Source {
  _StreamSource(this._stream, this._length);

  final Stream<List<int>> _stream;
  final int _length;
  _Peek? _peek;
  var _consumed = false;

  @override
  int get knownLength => _length;

  @override
  bool get isReplayable => !_consumed;

  @override
  Future<int> length() async => _length;

  @override
  Future<List<int>> head(int count) {
    final peek = _peek ??= _Peek(_stream);
    return peek.head(count);
  }

  @override
  Stream<List<int>> open() {
    final source = _peek?.rest() ?? _stream;
    // Marked as read only once the upload starts reading it: a connection
    // that fails before sending leaves it replayable.
    late final StreamController<List<int>> controller;
    StreamSubscription<List<int>>? subscription;
    controller = StreamController<List<int>>(
      onListen: () {
        _consumed = true;
        subscription = source.listen(
          controller.add,
          onError: controller.addError,
          onDone: controller.close,
        );
      },
      onPause: () => subscription?.pause(),
      onResume: () => subscription?.resume(),
      onCancel: () => subscription?.cancel(),
    );
    return controller.stream;
  }
}

/// Reads the first bytes of a stream, then replays them in front of the
/// rest.
final class _Peek {
  _Peek(Stream<List<int>> source) {
    _subscription = source.listen(
      _onData,
      onError: _onError,
      onDone: _onDone,
    );
  }

  late final StreamSubscription<List<int>> _subscription;
  final _buffered = <List<int>>[];
  final _errors = <(Object, StackTrace)>[];
  var _bufferedLength = 0;
  var _done = false;
  StreamController<List<int>>? _rest;
  Completer<void>? _waiting;
  int _wanted = 0;

  void _onData(List<int> chunk) {
    final rest = _rest;
    if (rest != null) {
      rest.add(chunk);
      return;
    }
    _buffered.add(chunk);
    _bufferedLength += chunk.length;
    if (_bufferedLength >= _wanted) _wake();
  }

  void _onError(Object error, StackTrace stackTrace) {
    final rest = _rest;
    if (rest != null) {
      rest.addError(error, stackTrace);
      return;
    }
    _errors.add((error, stackTrace));
    _wake();
  }

  void _onDone() {
    _done = true;
    if (_rest != null) {
      unawaited(_rest!.close());
      return;
    }
    _wake();
  }

  void _wake() {
    final waiting = _waiting;
    if (waiting == null) return;
    _waiting = null;
    _subscription.pause();
    waiting.complete();
  }

  Future<List<int>> head(int count) async {
    if (_bufferedLength < count && _errors.isEmpty && !_done) {
      _wanted = count;
      final waiting = _waiting = Completer<void>();
      await waiting.future;
    } else if (!_subscription.isPaused) {
      _subscription.pause();
    }
    final bytes = <int>[for (final chunk in _buffered) ...chunk];
    return bytes.length > count ? bytes.sublist(0, count) : bytes;
  }

  Stream<List<int>> rest() {
    _rest = StreamController<List<int>>(
      onListen: _flush,
      onPause: _subscription.pause,
      onResume: _subscription.resume,
      onCancel: _subscription.cancel,
    );
    return _rest!.stream;
  }

  void _flush() {
    _buffered.forEach(_rest!.add);
    _buffered.clear();
    for (final (error, stackTrace) in _errors) {
      _rest!.addError(error, stackTrace);
    }
    _errors.clear();
    if (_done) {
      unawaited(_rest!.close());
    } else {
      _subscription.resume();
    }
  }
}
