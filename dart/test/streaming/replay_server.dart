/// Plays one recorded stream transcript (`spec/fixtures/ws/*.jsonl`) back to
/// the SDK, as the server.
///
/// The server walks the transcript in order. It sends each recorded inbound
/// frame (audio as zero-filled PCM of the recorded size) and, at each
/// recorded client frame, waits until the SDK sends a matching one. The
/// recorded request IDs (`r1`, `r2`, ...) are mapped to the SDK's own IDs in
/// the order the SDK sends them.
///
/// Before a client frame that follows inbound frames, the server sends a
/// barrier: `{"type": "replay.barrier", "seq": <line>}`. The SDK keeps it as
/// an event of an unknown type; once the test sees it, the SDK has handled
/// everything recorded before it, and the test can make the next call.
library;

import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import '../support/fixtures.dart';

/// The `type` of a barrier frame.
const String barrierType = 'replay.barrier';

const String _guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/// Whether the server sends a barrier before client line [index]: some
/// inbound frame came after the previous client frame.
bool barrierBefore(List<TranscriptLine> script, int index) {
  for (var i = index - 1; i >= 0; i--) {
    final line = script[i];
    if (line.isOut) return false;
    if (line.kind != 'open') return true;
  }
  return false;
}

/// Where the replay departs from the recording.
final class ReplayRules {
  const ReplayRules({this.skip = const {}, this.ignore = const {}});

  /// Client lines the SDK doesn't send: the server goes on once the test
  /// calls [ReplayServer.proceed] for them.
  final Set<int> skip;

  /// Client frames (by JSON type) the recorded server never saw, and which
  /// the replay ignores. An ignored `ping` is answered with a `pong`, as the
  /// real server does.
  final Set<String> ignore;
}

/// The handshake the SDK sent.
final class Handshake {
  Handshake(this.path, this.query, this.headers);

  final String path;
  final Map<String, String> query;
  final Map<String, String> headers;
}

final class _Closed {
  _Closed(this.code, this.reason);

  final int? code;
  final String? reason;
}

/// The server for one transcript.
final class ReplayServer {
  ReplayServer._(this._server, this.script, this.rules, this.apiKey) {
    _server.listen(_handle);
  }

  /// Starts a server for [script]; [apiKey] is the key the SDK must send
  /// when the recording had one.
  static Future<ReplayServer> start(
    List<TranscriptLine> script,
    ReplayRules rules, {
    required String apiKey,
  }) async =>
      ReplayServer._(
        await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
        script,
        rules,
        apiKey,
      );

  final HttpServer _server;

  /// The transcript.
  final List<TranscriptLine> script;

  /// Where the replay departs from it.
  final ReplayRules rules;

  /// The key the SDK must send.
  final String apiKey;

  /// Everything that didn't match the recording.
  final List<String> problems = [];

  /// Client frames the replay ignored ([ReplayRules.ignore]), decoded.
  final List<Map<String, Object?>> ignored = [];

  /// The recorded request IDs, mapped to the SDK's.
  final Map<String, String> requestIds = {};

  /// Bytes of audio sent for each recorded request ID.
  final Map<String, int> audioSent = {};

  /// Bytes of audio sent for each recorded request ID before the SDK asked
  /// for it to stop (a `cancel`, or a newer `synthesize`).
  final Map<String, int> audioBeforeStop = {};

  /// Every handshake.
  final List<Handshake> handshakes = [];

  final Completer<void> _finished = Completer();
  final Map<int, Completer<void>> _proceed = {};
  final Queue<Object> _incoming = Queue();
  Completer<void>? _arrived;
  final Set<String> _finishedIds = {};
  String? _active;
  WebSocket? _ws;
  Socket? _socket;
  bool _clientClosed = false;
  int _position = 0;

  /// The server's URL.
  Uri get url => Uri.parse('ws://127.0.0.1:${_server.port}');

  /// Completes once the whole transcript has been played (or a problem
  /// stopped it).
  Future<void> get finished => _finished.future;

  /// Where the replay is, for failure messages.
  String get position => _position < script.length
      ? 'at ${script[_position]}'
      : 'past the end of the transcript';

  /// The test did what client line [index] needs (or confirmed that the SDK
  /// sends nothing for it).
  void proceed(int index) =>
      _proceed.putIfAbsent(index, Completer.new).complete();

  /// Stops the server.
  Future<void> stop() async {
    _socket?.destroy();
    await _server.close(force: true);
  }

  void _problem(String text) {
    problems.add('$position: $text');
    _socket?.destroy();
    if (!_finished.isCompleted) _finished.complete();
  }

  Future<void> _handle(HttpRequest request) async {
    final headers = <String, String>{};
    request.headers.forEach((name, values) => headers[name] = values.join(','));
    handshakes
        .add(Handshake(request.uri.path, request.uri.queryParameters, headers));
    final response = request.response;
    if (handshakes.length > 1) {
      _problem('a second connection attempt');
      response.statusCode = 400;
      await response.close();
      return;
    }
    final connect = script[0];
    final reply = script[1];
    if (connect.kind != 'connect' || !connect.isOut) {
      _problem('the transcript does not start with a connect');
      return;
    }
    _checkHandshake(connect.data, request.uri, headers);
    if (reply.kind == 'handshake_rejected') {
      _position = 1;
      response.statusCode = reply.data['status']! as int;
      response.persistentConnection = false;
      final recorded = reply.data['headers'] as Map? ?? const {};
      for (final MapEntry(:key, :value) in recorded.entries) {
        response.headers.set('$key', '$value');
      }
      final body = reply.data['body'];
      if (body is String) {
        response.write(body);
      } else if (body != null) {
        response.write(jsonEncode(body));
      }
      await response.close();
      _position = 2;
      if (script.length > 2) _problem('lines after a rejected handshake');
      if (!_finished.isCompleted) _finished.complete();
      return;
    }
    if (reply.kind != 'open') {
      _problem('expected open or handshake_rejected');
      return;
    }
    final key = request.headers.value('sec-websocket-key');
    if (key == null) {
      _problem('not a WebSocket upgrade');
      response.statusCode = 400;
      await response.close();
      return;
    }
    final accept = base64.encode(sha1.convert(utf8.encode('$key$_guid')).bytes);
    response
      ..statusCode = HttpStatus.switchingProtocols
      ..headers.set(HttpHeaders.connectionHeader, 'Upgrade')
      ..headers.set(HttpHeaders.upgradeHeader, 'websocket')
      ..headers.set('sec-websocket-accept', accept)
      ..headers.set('x-request-id', '00000000-0000-4000-8000-000000000001');
    response.headers.contentLength = 0;
    _socket = await response.detachSocket();
    _ws = WebSocket.fromUpgradedSocket(
      _socket!,
      serverSide: true,
      compression: CompressionOptions.compressionOff,
    );
    _ws!.listen(
      (Object? message) => _receive(message!),
      onError: (Object _) => _receive(_Closed(_ws!.closeCode, null)),
      onDone: () => _receive(_Closed(_ws!.closeCode, _ws!.closeReason)),
      cancelOnError: true,
    );
    try {
      await _play();
    } on Object catch (error) {
      _problem('replay failed: $error');
    }
    if (!_finished.isCompleted) _finished.complete();
  }

  void _checkHandshake(
    Map<String, Object?> recorded,
    Uri actual,
    Map<String, String> headers,
  ) {
    final target = Uri.parse(recorded['path']! as String);
    if (actual.path != target.path) {
      problems.add('handshake path ${actual.path}, recorded ${target.path}');
    }
    for (final MapEntry(:key, :value) in target.queryParameters.entries) {
      if (actual.queryParameters[key] != value) {
        problems.add('handshake query $key=${actual.queryParameters[key]}, '
            'recorded $value');
      }
    }
    final authorization = headers['authorization'];
    switch (recorded['authorization']) {
      case 'set':
        if (authorization != 'Bearer $apiKey') {
          problems.add('handshake without the API key');
        }
      case 'none':
        if (authorization != null) problems.add('handshake with credentials');
      default:
        problems.add('unknown authorization ${recorded['authorization']}');
    }
  }

  void _receive(Object message) {
    _incoming.add(message);
    _arrived?.complete();
    _arrived = null;
  }

  Future<Object> _nextFrame() async {
    while (_incoming.isEmpty) {
      await (_arrived ??= Completer()).future;
    }
    return _incoming.removeFirst();
  }

  Future<void> _play() async {
    for (var i = 2; i < script.length; i++) {
      if (_finished.isCompleted) return; // a problem stopped it
      _position = i;
      final line = script[i];
      if (!line.isOut) {
        await _send(line);
        continue;
      }
      if (barrierBefore(script, i)) {
        _sendJson({'type': barrierType, 'seq': i});
      }
      if (line.kind == 'abort') {
        // The recorder dropped its own connection; the SDK sees the same
        // thing (1006) when the server drops it.
        await _proceed.putIfAbsent(i, Completer.new).future;
        _socket?.destroy();
        continue;
      }
      if (rules.skip.contains(i)) {
        await _proceed.putIfAbsent(i, Completer.new).future;
        continue;
      }
      if (!await _expect(line)) return;
    }
    _position = script.length;
  }

  /// Waits for the client frame [line] recorded, ignoring the frames
  /// [ReplayRules.ignore] lists. Returns `false` after a mismatch.
  Future<bool> _expect(TranscriptLine line) async {
    while (true) {
      if (_clientClosed) {
        _problem('the SDK closed the stream early');
        return false;
      }
      final frame = await _nextFrame();
      if (frame is _Closed) _clientClosed = true;
      if (frame is String && line.kind != 'text') {
        final Object? decoded;
        try {
          decoded = jsonDecode(frame);
        } on FormatException {
          _problem('the SDK sent text that is not JSON: $frame');
          return false;
        }
        final json = decoded is Map ? decoded.cast<String, Object?>() : null;
        final type = json?['type'];
        if (json != null && type is String && type != line.type) {
          if (rules.ignore.contains(type)) {
            ignored.add(json);
            if (type == 'ping') _sendJson({'type': 'pong'});
            continue;
          }
        }
        if (line.kind != 'json' || json == null) {
          _problem('the SDK sent $frame');
          return false;
        }
        return _matchJson(line, json);
      }
      switch ((line.kind, frame)) {
        case ('text', final String text):
          if (text != line.data['text']) {
            _problem('the SDK sent text $text');
            return false;
          }
        case ('binary', final List<int> bytes):
          if (bytes.length != line.bytes) {
            _problem('the SDK sent ${bytes.length} bytes of audio, '
                'recorded ${line.bytes}');
            return false;
          }
        case ('close', _Closed(:final code)):
          if (code != line.data['code']) {
            _problem('the SDK closed with $code, recorded '
                '${line.data['code']}');
            return false;
          }
        default:
          _problem('the SDK sent ${_describe(frame)}');
          return false;
      }
      return true;
    }
  }

  bool _matchJson(TranscriptLine line, Map<String, Object?> frame) {
    final expected = Map.of(line.data);
    final rid = expected.remove('requestId');
    final actual = Map.of(frame);
    final actualRid = actual.remove('requestId');
    if (rid is String) {
      final mapped = requestIds[rid];
      if (mapped == null) {
        if (actualRid is! String || requestIds.containsValue(actualRid)) {
          _problem('the SDK sent request ID $actualRid for $rid');
          return false;
        }
        requestIds[rid] = actualRid;
      } else if (mapped != actualRid) {
        _problem('the SDK sent request ID $actualRid, $rid is $mapped');
        return false;
      }
    } else if (actualRid != null) {
      _problem('the SDK sent a request ID the recording has not');
      return false;
    }
    if (!_jsonEquals(actual, expected)) {
      _problem('the SDK sent ${jsonEncode(frame)}');
      return false;
    }
    if (line.type == 'synthesize' || line.type == 'cancel') {
      // Whatever was running is asked to stop.
      for (final MapEntry(key: id, value: _) in requestIds.entries) {
        if (id != rid && !_finishedIds.contains(id)) {
          audioBeforeStop.putIfAbsent(id, () => audioSent[id] ?? 0);
        }
      }
    }
    return true;
  }

  Future<void> _send(TranscriptLine line) async {
    switch (line.kind) {
      case 'json':
        final event = Map.of(line.data);
        final rid = event['requestId'];
        if (rid is String) {
          final mapped = requestIds[rid];
          if (mapped == null) {
            _problem('inbound $rid before the SDK sent it');
            return;
          }
          event['requestId'] = mapped;
          switch (event['type']) {
            case 'start':
              _active = rid;
            case 'done' || 'cancelled' || 'error':
              _finishedIds.add(rid);
              if (_active == rid) _active = null;
          }
        }
        _sendJson(event);
      case 'text':
        _add(line.data['text']! as String);
      case 'binary':
        final active = _active;
        if (active != null) {
          audioSent[active] = (audioSent[active] ?? 0) + line.bytes;
        }
        _add(Uint8List(line.bytes));
      case 'close':
        final code = line.data['code']! as int;
        // 1006 is the drop itself; after the client's close the server's
        // reply goes out by itself.
        if (code == 1006 || _clientClosed) return;
        try {
          await _ws?.close(code, line.data['reason'] as String? ?? '');
        } on Object {
          // already closed
        }
      default:
        _problem('cannot replay an inbound ${line.kind}');
    }
  }

  void _sendJson(Map<String, Object?> payload) => _add(jsonEncode(payload));

  void _add(Object data) {
    final ws = _ws;
    if (ws == null || ws.closeCode != null) return;
    try {
      ws.add(data);
    } on StateError {
      // closing
    }
  }
}

String _describe(Object frame) => switch (frame) {
      final String text => 'text $text',
      final List<int> bytes => '${bytes.length} bytes of audio',
      _Closed(:final code) => 'a close ($code)',
      _ => 'something else',
    };

bool _jsonEquals(Object? a, Object? b) {
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final MapEntry(:key, :value) in a.entries) {
      if (!b.containsKey(key) || !_jsonEquals(value, b[key])) return false;
    }
    return true;
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!_jsonEquals(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b; // 9 == 9.0 for JSON numbers
}
