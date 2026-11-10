/// The WebSocket driver: handshake with retries, one reader, keepalive.
library;

import 'dart:async';
import 'dart:typed_data';

import '../errors.dart';
import '../transport/ws.dart' as ws;
import 'async_util.dart';
import 'link.dart';
import 'options.dart';
import 'stream_errors.dart';

/// Opens a connection to [url], retrying the handshake as the retry table
/// allows.
///
/// [abandoned] is checked before every wait and attempt; when it returns
/// `true` the connect gives up with [SessionEndedException].
Future<ws.WebSocketConnection> openStream(
  StreamOptions options,
  Uri url, {
  required AttemptLimiter limiter,
  Duration? waitForSlot,
  bool afterAbnormal = false,
  bool Function()? abandoned,
}) async {
  final clock = options.clock;
  final retry = HandshakeRetry(
    options.retryPolicy,
    now: clock(),
    waitForSlot: waitForSlot ?? options.waitForSlot,
    afterAbnormal: afterAbnormal,
    slotWaitAfterLoss: options.reconnectSlotWait,
  );
  void checkAbandoned() {
    if (abandoned?.call() ?? false) {
      throw SessionEndedException('the stream session was closed');
    }
  }

  var first = true;
  while (true) {
    final wait = limiter.waitTime(clock());
    if (wait > Duration.zero) {
      if (first || !retry.mayWait(clock(), wait)) throw limiter.error();
      await options.sleep(wait);
      checkAbandoned();
    }
    first = false;
    limiter.record(clock());
    // A browser can't send headers on a WebSocket: don't ask for them.
    final headers = ws.sendsHeaders
        ? _withUserAgent(await options.headers(), options.userAgent)
        : const <String, String>{};
    final query = await options.query?.call() ?? const <String, String>{};
    final target = query.isEmpty
        ? url
        : url.replace(queryParameters: {...url.queryParameters, ...query});
    checkAbandoned();
    final Duration delay;
    try {
      return await ws.openWebSocket(
        target,
        headers: headers,
        openTimeout: options.openTimeout,
      );
    } on APIStatusException catch (error) {
      delay = retry.onStatus(error, clock());
    } on APIConnectionException catch (error) {
      delay = retry.onNetwork(error);
    }
    streamLog('stream handshake failed; retrying in $delay', level: 500);
    await options.sleep(delay);
    checkAbandoned();
  }
}

Map<String, String> _withUserAgent(
  Map<String, String> headers,
  String? userAgent,
) {
  if (userAgent == null) return headers;
  return {
    for (final MapEntry(:key, :value) in headers.entries)
      if (key.toLowerCase() != 'user-agent') key: value,
    'User-Agent': userAgent,
  };
}

/// A send was attempted on a socket that is closed or closing.
final class LinkClosed implements Exception {
  /// Creates the exception.
  const LinkClosed();

  @override
  String toString() => 'LinkClosed';
}

/// One open socket: a single reader that never blocks, ordered writes,
/// keepalive and liveness. The callbacks run on the reader and must not
/// block.
final class Link {
  /// Starts reading the connection.
  Link(
    this._connection,
    StreamOptions options, {
    required void Function(String text) onText,
    required void Function(Uint8List data) onBinary,
    required void Function(CloseInfo info) onClosed,
  })  : _clock = options.clock,
        _closeTimeout = options.closeTimeout,
        _onText = onText,
        _onBinary = onBinary,
        _onClosed = onClosed,
        openedAt = options.clock() {
    liveness = Liveness(
      openedAt,
      keepalive: options.keepalive,
      pongTimeout: options.pongTimeout,
      silenceTimeout: options.silenceTimeout,
    );
    _subscription = _connection.messages.listen(
      _onMessage,
      onError: (Object error) {
        _lostReason ??= 'the connection failed: $error';
      },
      onDone: _finish,
    );
    _scheduleKeeper();
  }

  final ws.WebSocketConnection _connection;
  final StreamClock _clock;
  final Duration _closeTimeout;
  final void Function(String text) _onText;
  final void Function(Uint8List data) _onBinary;
  final void Function(CloseInfo info) _onClosed;
  late final StreamSubscription<Object> _subscription;
  final Completer<void> _done = Completer<void>();
  Timer? _keeper;
  bool _localClose = false;
  String? _lostReason;

  /// When the socket opened.
  final Duration openedAt;

  /// The keepalive and liveness timers.
  late final Liveness liveness;

  /// Whether the socket has closed.
  bool closed = false;

  /// How the socket closed, once it has.
  CloseInfo? closeInfo;

  /// Completes once the socket has closed and `onClosed` has run.
  Future<void> get done => _done.future;

  /// The `X-Request-Id` of the handshake.
  String? get handshakeRequestId => _connection.handshakeRequestId;

  /// How long the socket has been open.
  Duration age(Duration now) => now - openedAt;

  /// Whether a frame can be written now.
  bool get writable => !closed && !_localClose;

  /// A `pong` arrived.
  void pong() {
    liveness.pong(_clock());
    _scheduleKeeper();
  }

  /// Writes a text frame now, without waiting for the network. Returns
  /// `false` when the socket is closed or closing.
  bool writeText(String text) {
    if (!writable) return false;
    _connection.sendText(text);
    liveness.sent(_clock());
    return true;
  }

  /// Completes once the send buffer has room again (backpressure).
  Future<void> flush() => _connection.flush();

  /// Sends a text frame and waits for the send buffer. Throws [LinkClosed]
  /// when the socket is closed or closing.
  Future<void> sendText(String text) async {
    if (!writeText(text)) throw const LinkClosed();
    await _connection.flush();
  }

  /// Sends a JSON frame (checked against the frame limit first).
  Future<void> sendJson(Map<String, Object?> payload) =>
      sendText(encodeJson(payload));

  /// Sends a binary frame and waits for the send buffer. Throws
  /// [LinkClosed] when the socket is closed or closing.
  Future<void> sendBytes(Uint8List data) async {
    if (!writable) throw const LinkClosed();
    _connection.sendBytes(data);
    liveness.sent(_clock());
    await _connection.flush();
  }

  /// Closes cleanly (the SDK's own close: not an error), and waits until the
  /// reader has finished.
  Future<void> close([int code = 1000, String reason = '']) async {
    if (!closed && !_localClose) {
      _localClose = true;
      final finished = await _connection
          .close(code, reason)
          .then((_) => true, onError: (Object _) => false)
          .timeout(_closeTimeout + const Duration(seconds: 1),
              onTimeout: () => false);
      if (!finished) abort(null);
    }
    await done;
  }

  /// Drops the connection now, without a closing handshake. [lostReason]
  /// says why the SDK gave up on it (`null` for the SDK's own close).
  void abort(String? lostReason) {
    if (lostReason != null) _lostReason ??= lostReason;
    if (lostReason == null) _localClose = true;
    _connection.abort();
    if (!closed) {
      unawaited(_subscription.cancel());
      _finish();
    }
  }

  void _onMessage(Object message) {
    if (closed) return;
    liveness.received(_clock());
    try {
      if (message is String) {
        _onText(message);
      } else if (message is Uint8List) {
        _onBinary(message);
      }
    } on Object catch (error, stack) {
      // A bug in a callback: don't leave the socket half-alive.
      streamLog('stream reader failed', level: 1000, error: '$error\n$stack');
      abort('internal error in the stream reader');
    }
  }

  void _finish() {
    if (closed) return;
    closed = true;
    _keeper?.cancel();
    final info = CloseInfo(
      _connection.closeCode ?? 1006,
      reason: _connection.closeReason ?? '',
      local: _localClose,
      lostReason: _lostReason,
    );
    closeInfo = info;
    try {
      _onClosed(info);
    } finally {
      _done.complete();
    }
  }

  void _scheduleKeeper() {
    _keeper?.cancel();
    if (closed) return;
    final deadline = liveness.nextDeadline();
    if (deadline == null) return;
    var wait = deadline - _clock() + const Duration(milliseconds: 1);
    if (wait < Duration.zero) wait = Duration.zero;
    _keeper = Timer(wait, _onKeeper);
  }

  void _onKeeper() {
    if (closed) return;
    final now = _clock();
    switch (liveness.poll(now)) {
      case LinkAction.ping:
        liveness.pingSent(now);
        writeText(pingFrame);
      case final LinkAction lost:
        final reason = liveness.describe(lost);
        streamLog('stream connection lost: $reason', level: 900);
        abort(reason);
        return;
      case null:
        break;
    }
    _scheduleKeeper();
  }
}
