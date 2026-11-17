/// A scripted stand-in for the EchoNova stream endpoints, for tests.
///
/// It plays the message flows of both streams on localhost, plus edge-case
/// scenarios the SDK must tolerate (silent closes, unanswered cancels, errors
/// mid-stream), whether or not a given server ever produces them. It is not a
/// model of the real service. Every knob is a plain field; set it before the
/// client connects.
///
/// Text to Speech scripting uses markers inside the synthesis text:
/// `[slow]` many frames with pauses, `[nostart]` never answers,
/// `[upstream_pre]` fails before audio the first time that text is seen,
/// `[upstream_pre_always]` always does, `[upstream_mid]` fails after one
/// frame, `[drop]` kills the connection after one frame, `[close:CODE]`
/// closes with CODE right away.
library;

import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

const Set<String> _ttsFields = {
  'type',
  'requestId',
  'text',
  'voiceId',
  'speed',
  'cfg',
  'numSteps',
  'tashkeel',
  'normalize',
};
const int _maxFrame = 65536;
const String _guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

final Random _random = Random();

String _hex(int length) => [
      for (var i = 0; i < length; i++) _random.nextInt(16).toRadixString(16),
    ].join();

/// A handshake answered with an HTTP error instead of 101.
final class Rejection {
  Rejection(this.status, this.message, {this.retryAfter, this.jsonBody = true});

  final int status;
  final String message;
  final String? retryAfter;
  final bool jsonBody;
}

/// One connection attempt.
final class Attempt {
  Attempt(this.path, this.query, this.headers, this.rejected);

  final String path;
  final Map<String, String> query;
  final Map<String, String> headers;
  final int? rejected;
}

final class TtsScript {
  int sampleRate = 22050;
  int frames = 3;
  int frameBytes = 960;
  Duration frameInterval = Duration.zero;
  Duration startDelay = Duration.zero;
  Duration? idleTimeout;
  Duration? maxDuration;
  bool answerPings = true;

  /// Report `creditsConsumed` on `cancelled` for a synthesis whose audio
  /// started (the share sent, at least 1).
  bool cancelCredits = true;
}

/// Something to do to one STT connection once it has received [afterBytes]
/// of audio: `abort` (1006), `restart` (1001), `upstream` (error +
/// session.ended + 1011), or `abort_on_cut` ([afterBytes] is then the
/// 1-based segment number whose end_segment triggers it).
final class SttAction {
  SttAction(this.kind, {this.afterBytes = 0});

  final String kind;
  final int afterBytes;
}

final class SttScript {
  int maxSessionSeconds = 1500;
  Duration startedDelay = Duration.zero;
  Duration? enforceMaxDuration;
  Duration? idleTimeout;
  bool upstreamUnreachable = false;
  double autoCutSeconds = 15;
  Set<int> segmentErrors = {};

  /// (n, insufficient_balance | spending_limit | upstream_error)
  (int, String)? failAfterSegments;
  final Queue<SttAction> actions = Queue();
  bool answerPings = true;
  Duration drainDelay = Duration.zero;

  /// Send `session.saved` after `session.ended`.
  bool sendSaved = true;

  /// Override the saved status (default: `saved`, or `empty` with no
  /// transcript).
  String? savedStatus;
}

final class TtsConnRecord {
  final List<Object> received = []; // parsed JSON frames, or bytes
  final List<String> charged = [];
  final List<Map<String, Object?>> sent = [];
  int? closeCode;
}

final class SttConnRecord {
  Map<String, String> query = {};
  final BytesBuilder audio = BytesBuilder();
  final List<Map<String, Object?>> received = [];
  String sessionId = '';
  String jobId = '';
  int? closeCode;
}

/// The scripted server.
final class MockServer {
  MockServer._(this._server) {
    _server.listen(_handle);
  }

  static Future<MockServer> start() async =>
      MockServer._(await HttpServer.bind(InternetAddress.loopbackIPv4, 0));

  final HttpServer _server;
  final Queue<Rejection> rejections = Queue();
  final List<Attempt> attempts = [];
  final TtsScript tts = TtsScript();
  final SttScript stt = SttScript();
  final List<TtsConnRecord> ttsConns = [];
  final List<SttConnRecord> sttConns = [];
  final Set<String> seenTexts = {};
  final Set<Socket> _live = {};
  final Set<WebSocket> _sockets = {};

  /// Holds the upgrade response of the next connection for this long.
  Duration upgradeDelay = Duration.zero;

  Uri get url => Uri.parse('ws://127.0.0.1:${_server.port}');

  Future<void> stop() async {
    for (final socket in _live.toList()) {
      socket.destroy();
    }
    await _server.close(force: true);
  }

  /// Drops every open connection (1006 on the client).
  void abortAll() {
    for (final socket in _live.toList()) {
      socket.destroy();
    }
  }

  /// Closes every open stream with [code].
  Future<void> closeAll(int code, String reason) async {
    for (final ws in _sockets.toList()) {
      try {
        await ws.close(code, reason);
      } on Object {
        // already closed
      }
    }
  }

  Future<void> _handle(HttpRequest request) async {
    final headers = <String, String>{};
    request.headers.forEach((name, values) => headers[name] = values.join(','));
    final rejection = rejections.isEmpty ? null : rejections.removeFirst();
    attempts.add(Attempt(
      request.uri.path,
      request.uri.queryParameters,
      headers,
      rejection?.status,
    ));
    final response = request.response;
    if (rejection != null) {
      response
        ..statusCode = rejection.status
        ..persistentConnection = false
        ..headers.set('x-request-id', 'req-${_hex(8)}');
      if (rejection.retryAfter != null) {
        response.headers.set('retry-after', rejection.retryAfter!);
      }
      if (rejection.jsonBody) {
        response.headers.contentType = ContentType.json;
        response.write(jsonEncode({
          'data': null,
          'success': false,
          'statusCode': rejection.status,
          'errorMessage': rejection.message,
        }));
      } else {
        response.headers.contentType = ContentType.html;
        response.write(rejection.message);
      }
      await response.close();
      return;
    }
    final key = request.headers.value('sec-websocket-key');
    if (key == null) {
      response.statusCode = 400;
      await response.close();
      return;
    }
    if (upgradeDelay > Duration.zero) await Future<void>.delayed(upgradeDelay);
    final accept = base64.encode(sha1.convert(utf8.encode('$key$_guid')).bytes);
    response
      ..statusCode = HttpStatus.switchingProtocols
      ..headers.set(HttpHeaders.connectionHeader, 'Upgrade')
      ..headers.set(HttpHeaders.upgradeHeader, 'websocket')
      ..headers.set('sec-websocket-accept', accept)
      ..headers.set('x-request-id', 'req-${_hex(8)}');
    response.headers.contentLength = 0;
    final socket = await response.detachSocket();
    _live.add(socket);
    final ws = WebSocket.fromUpgradedSocket(
      socket,
      serverSide: true,
      compression: CompressionOptions.compressionOff,
    );
    _sockets.add(ws);
    try {
      final path = request.uri.path;
      if (path.endsWith('/text-to-speech/stream')) {
        await _TtsConn(this, ws, socket).run();
      } else if (path.endsWith('/speech-to-text/stream')) {
        await _SttConn(this, ws, socket, request.uri.queryParameters).run();
      } else {
        await ws.close(1008, 'unknown path');
      }
    } finally {
      _live.remove(socket);
      _sockets.remove(ws);
    }
  }
}

void _sendJson(
  WebSocket ws,
  Map<String, Object?> payload, [
  List<Map<String, Object?>>? log,
]) {
  if (ws.closeCode != null) return;
  log?.add(payload);
  _add(ws, jsonEncode(payload));
}

/// Sends a frame unless the socket is already closing.
void _add(WebSocket ws, Object data) {
  try {
    ws.add(data);
  } on StateError {
    // closing
  }
}

/// A restartable one-shot timer.
final class _Timer {
  _Timer(this.delay, this.callback) {
    reset();
  }

  final Duration? delay;
  final void Function() callback;
  Timer? _timer;

  void reset() {
    _timer?.cancel();
    final wait = delay;
    if (wait != null) _timer = Timer(wait, callback);
  }

  void cancel() => _timer?.cancel();
}

final class _Running {
  _Running(this.rid, this.text);

  final String rid;
  final String text;
  bool cancelled = false;
  int framesSent = 0;
  int totalFrames = 0;
}

final class _TtsConn {
  _TtsConn(this.server, this.ws, this.socket) {
    server.ttsConns.add(record);
  }

  final MockServer server;
  final WebSocket ws;
  final Socket socket;
  final TtsConnRecord record = TtsConnRecord();
  _Running? running;
  bool closing = false;

  TtsScript get script => server.tts;

  void send(Map<String, Object?> payload) =>
      _sendJson(ws, payload, record.sent);

  Future<void> run() async {
    final idle = _Timer(script.idleTimeout, () => _close(4008, 'idle_timeout'));
    final limit =
        _Timer(script.maxDuration, () => _close(4008, 'max_duration'));
    try {
      await for (final message in ws) {
        if (closing) continue;
        idle.reset(); // the idle timer counts frames from the client
        if (message is! String) {
          record.received.add(message as Object);
          send({
            'type': 'error',
            'code': 'frame_too_large',
            'message': 'binary frame',
          });
          await _close(1008, 'frame_too_large');
          continue;
        }
        final Map<String, Object?> frame;
        try {
          frame = jsonDecode(message) as Map<String, Object?>;
          if (frame['type'] is! String) throw const FormatException();
        } on Object {
          send({
            'type': 'error',
            'code': 'invalid_message',
            'message': 'bad frame',
          });
          await _close(1008, 'invalid_message');
          continue;
        }
        record.received.add(frame);
        switch (frame['type']) {
          case 'ping':
            if (script.answerPings) send({'type': 'pong'});
          case 'cancel':
            _cancelRunning();
          case 'synthesize':
            await _synthesize(frame);
          default:
            send({
              'type': 'error',
              'code': 'invalid_message',
              'message': 'unknown type',
            });
            await _close(1008, 'invalid_message');
        }
      }
    } on Object {
      // connection dropped
    } finally {
      idle.cancel();
      limit.cancel();
      running?.cancelled = true;
      record.closeCode = ws.closeCode;
    }
  }

  Future<void> _close(int code, String reason) async {
    closing = true;
    running?.cancelled = true;
    running = null;
    try {
      await ws.close(code, reason);
    } on Object {
      // already closed
    }
  }

  int _share(_Running run) {
    final chars = run.text.trim().length;
    final total = max(1, run.totalFrames);
    return max(1, (chars * run.framesSent / total).round());
  }

  void _cancelRunning() {
    final run = running;
    if (run == null) return; // a cancel with nothing running gets no reply
    running = null;
    run.cancelled = true;
    final audioStarted = run.framesSent > 0;
    send({
      'type': 'cancelled',
      'requestId': run.rid,
      if (audioStarted && script.cancelCredits) 'creditsConsumed': _share(run),
    });
    if (!audioStarted) record.charged.remove(run.rid); // refunded
  }

  Future<void> _synthesize(Map<String, Object?> frame) async {
    final rid = frame['requestId'] is String
        ? frame['requestId']! as String
        : 'srv-${_hex(8)}';
    final text = frame['text'];
    final problems = [
      for (final key in frame.keys)
        if (!_ttsFields.contains(key)) key,
    ]..sort();
    if (text is! String || text.trim().isEmpty || text.trim().length > 500) {
      problems.add('text must be 1 to 500 characters');
    }
    if (frame['voiceId'] is! String) problems.add('voiceId is required');
    if (problems.isNotEmpty) {
      // A rejected request leaves the running one going.
      send({
        'type': 'error',
        'code': 'validation_failed',
        'message': problems.join(', '),
        'requestId': rid,
      });
      return;
    }
    final spoken = text! as String;
    _cancelRunning();
    if (frame['voiceId'] == 'missing') {
      send({
        'type': 'error',
        'code': 'voice_not_found',
        'message': 'Voice not found',
        'requestId': rid,
      });
      return;
    }
    if (spoken.contains('[close:')) {
      final code = int.parse(spoken.split('[close:')[1].split(']')[0]);
      await _close(code, 'scripted');
      return;
    }
    record.charged.add(rid);
    final run = _Running(rid, spoken);
    running = run;
    unawaited(_stream(run));
  }

  Future<void> _stream(_Running run) async {
    final rid = run.rid;
    final text = run.text;
    final firstTime = server.seenTexts.add(text);
    if (text.contains('[nostart]')) return;
    if ((text.contains('[upstream_pre]') && firstTime) ||
        text.contains('[upstream_pre_always]')) {
      record.charged.remove(rid); // refunded
      send({
        'type': 'error',
        'code': 'upstream_error',
        'message': 'could not synthesize this text',
        'requestId': rid,
      });
      _finished(run);
      return;
    }
    if (script.startDelay > Duration.zero) {
      await Future<void>.delayed(script.startDelay);
      if (run.cancelled) return;
    }
    send({
      'type': 'start',
      'requestId': rid,
      'sampleRate': script.sampleRate,
      'encoding': 'pcm_s16le',
      'channels': 1,
    });
    final slow = text.contains('[slow]');
    final frames = slow ? 40 : script.frames;
    run.totalFrames = frames;
    for (var i = 0; i < frames; i++) {
      if (run.cancelled || ws.closeCode != null) return;
      _add(
          ws, Uint8List(script.frameBytes)..fillRange(0, script.frameBytes, i));
      run.framesSent += 1;
      if (i == 0 && text.contains('[upstream_mid]')) {
        send({
          'type': 'error',
          'code': 'upstream_error',
          'message': 'stopped during this synthesis',
          'requestId': rid,
          'creditsConsumed': _share(run),
        });
        _finished(run);
        return;
      }
      if (i == 0 && text.contains('[drop]')) {
        socket.destroy();
        return;
      }
      final interval =
          slow ? const Duration(milliseconds: 50) : script.frameInterval;
      if (interval > Duration.zero) {
        await Future<void>.delayed(interval);
      } else {
        await Future<void>.delayed(Duration.zero);
      }
    }
    if (run.cancelled) return;
    final seconds = frames * script.frameBytes / (script.sampleRate * 2);
    send({
      'type': 'done',
      'requestId': rid,
      'durationSeconds': seconds,
      'characters': text.trim().length,
      'creditsConsumed': text.trim().length,
    });
    _finished(run);
  }

  void _finished(_Running run) {
    if (identical(running, run)) running = null;
  }
}

final class _SttConn {
  _SttConn(this.server, this.ws, this.socket, Map<String, String> query) {
    record
      ..query = Map.of(query)
      ..sessionId = _hex(32)
      ..jobId = _hex(24);
    server.sttConns.add(record);
    action = script.actions.isEmpty ? null : script.actions.removeFirst();
    sampleRate = int.tryParse(query['sample_rate'] ?? '') ?? 16000;
  }

  final MockServer server;
  final WebSocket ws;
  final Socket socket;
  final SttConnRecord record = SttConnRecord();
  SttAction? action;
  late final int sampleRate;
  final BytesBuilder segment = BytesBuilder();
  int segments = 0;
  int transcripts = 0;
  int cuts = 0;
  double totalSeconds = 0;
  double credits = 0;
  bool terminologyActive = false;
  bool done = false;

  SttScript get script => server.stt;

  void send(Map<String, Object?> payload) => _sendJson(ws, payload);

  Future<void> run() async {
    if (script.upstreamUnreachable) {
      send({
        'type': 'error',
        'code': 'upstream_error',
        'message': 'speech service unavailable',
      });
      await _end('upstream_error', 1011, saved: false);
      return;
    }
    final idle = _Timer(script.idleTimeout, () => unawaited(_idle()));
    final limit = _Timer(
      script.enforceMaxDuration,
      () => unawaited(_maxDuration()),
    );
    final started = Timer(script.startedDelay, () {
      send({
        'type': 'session.started',
        'sessionId': record.sessionId,
        // Without a language the server uses (and confirms) auto.
        'language': record.query['language'] ?? 'auto',
        'sampleRate': sampleRate,
        'maxSessionSeconds': script.maxSessionSeconds,
        'jobId': record.jobId,
      });
    });
    try {
      await for (final message in ws) {
        idle.reset();
        if (done) continue;
        if (message is! String) {
          await _audio(message as List<int>);
          continue;
        }
        final frame = jsonDecode(message) as Map<String, Object?>;
        record.received.add(frame);
        switch (frame['type']) {
          case 'ping':
            if (script.answerPings) send({'type': 'pong'});
          case 'end_segment':
            final scripted = action;
            if (scripted != null &&
                scripted.kind == 'abort_on_cut' &&
                cuts + 1 >= scripted.afterBytes) {
              done = true;
              socket.destroy(); // cut, but no result ever comes
              continue;
            }
            cuts += 1;
            await _cut();
          case 'terminology':
            _terminology(frame['terminology']);
          case 'stop':
            if (script.drainDelay > Duration.zero) {
              await Future<void>.delayed(script.drainDelay);
            }
            await _cut();
            await _end('stopped', 1000);
          default:
            send({
              'type': 'error',
              'code': 'invalid_message',
              'message': 'unknown type',
            });
            done = true;
            await ws.close(1008, 'invalid_message');
        }
      }
    } on Object {
      // connection dropped
    } finally {
      started.cancel();
      idle.cancel();
      limit.cancel();
      record.closeCode = ws.closeCode;
    }
  }

  Future<void> _audio(List<int> data) async {
    if (data.length > _maxFrame) {
      send({
        'type': 'error',
        'code': 'frame_too_large',
        'message': 'frame too large',
      });
      done = true;
      await ws.close(1008, 'frame_too_large');
      return;
    }
    record.audio.add(data);
    segment.add(data);
    final scripted = action;
    if (scripted != null &&
        scripted.kind != 'abort_on_cut' &&
        record.audio.length >= scripted.afterBytes) {
      action = null;
      switch (scripted.kind) {
        case 'abort':
          done = true;
          socket.destroy();
          return;
        case 'restart':
          done = true;
          await ws.close(1001, 'server_restarting');
          return;
        case 'upstream':
          send({
            'type': 'error',
            'code': 'upstream_error',
            'message': 'upstream failed',
          });
          await _end('upstream_error', 1011);
          return;
      }
    }
    if (segment.length >= script.autoCutSeconds * sampleRate * 2) {
      await _cut();
    }
  }

  Future<void> _cut() async {
    final audio = segment.takeBytes();
    if (audio.length < 0.05 * sampleRate * 2) return; // too short: nothing
    segments += 1;
    final seconds = audio.length / (sampleRate * 2);
    if (script.segmentErrors.contains(segments)) {
      send({
        'type': 'error',
        'code': 'upstream_error',
        'message': 'segment failed',
      });
    } else {
      final cost = (seconds * 200 / 60 * 1000).round() / 1000;
      totalSeconds += seconds;
      credits += cost;
      transcripts += 1;
      send({
        'type': 'transcript',
        'segmentId': _hex(24),
        'text': 'segment $segments',
        'language': record.query['language'] ?? 'ar',
        'durationSeconds': seconds,
        'creditsConsumed': cost,
        'isFinal': true,
        if (terminologyActive)
          'terminology': {
            'raw': 'x',
            'corrected': 'x',
            'edits': <Object>[],
            'mapperStatus': 'applied',
          },
      });
    }
    final fail = script.failAfterSegments;
    if (fail != null && segments >= fail.$1) {
      final code = switch (fail.$2) {
        'insufficient_balance' => 4002,
        'spending_limit' => 4029,
        _ => 1011,
      };
      send({
        'type': 'error',
        'code': fail.$2,
        'message': fail.$2.replaceAll('_', ' '),
      });
      await _end(fail.$2, code);
    }
  }

  void _terminology(Object? value) {
    if (value != null &&
        !(value is Map<String, Object?> && value['keywords'] is List)) {
      send({
        'type': 'error',
        'code': 'validation_failed',
        'message': 'keywords must be a list',
      });
      return;
    }
    terminologyActive = value != null;
    send({'type': 'terminology.set', 'active': terminologyActive});
  }

  Future<void> _end(String reason, int code, {bool saved = true}) async {
    done = true;
    send({
      'type': 'session.ended',
      'reason': reason,
      'totalSeconds': (totalSeconds * 1000).round() / 1000,
      'creditsConsumed': (credits * 1000).round() / 1000,
    });
    if (saved && script.sendSaved) {
      send({
        'type': 'session.saved',
        'jobId': record.jobId,
        'status': script.savedStatus ?? (transcripts > 0 ? 'saved' : 'empty'),
      });
    }
    try {
      await ws.close(code, reason);
    } on Object {
      // already closed
    }
  }

  Future<void> _idle() async {
    await _cut();
    await _end('idle_timeout', 4008);
  }

  Future<void> _maxDuration() async {
    segment.clear(); // the open segment gets no transcript
    await _end('max_duration', 4008);
  }
}
