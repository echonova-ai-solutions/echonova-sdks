/// Connection settings shared by every stream session.
library;

import 'dart:async';
import 'dart:math' as math;

import '../core/retry.dart';
import '../errors.dart';

/// The Text to Speech stream's path.
const String ttsStreamPath = '/v1/text-to-speech/stream';

/// The Speech to Text stream's path.
const String sttStreamPath = '/v1/speech-to-text/stream';

/// The EchoNova streaming endpoint.
final Uri defaultWsBaseUri = Uri.parse('wss://api.echonova.ai');

/// Returns monotonic time: it never jumps when the wall clock changes.
typedef StreamClock = Duration Function();

/// Returns headers or query parameters for the next connection attempt.
typedef StreamParameters = FutureOr<Map<String, String>> Function();

final Stopwatch _monotonic = Stopwatch()..start();

Duration _monotonicNow() => _monotonic.elapsed;

Map<String, String> _noHeaders() => const {};

Future<void> _delay(Duration duration) => Future<void>.delayed(duration);

/// How `transcribeStream` reconnects after a dropped connection.
final class ReconnectPolicy {
  /// Creates a policy. [maxAttempts] counts reconnects in a row without a
  /// transcript in between.
  const ReconnectPolicy({
    this.maxAttempts = 3,
    this.initialDelay = const Duration(milliseconds: 500),
    this.maxDelay = const Duration(seconds: 8),
  });

  /// Reconnects in a row, without a transcript in between, before giving up.
  final int maxAttempts;

  /// The wait before the first reconnect. It doubles for each later one.
  final Duration initialDelay;

  /// The longest wait between reconnects.
  final Duration maxDelay;

  /// The wait before reconnect number [attempt] (1-based).
  Duration delay(int attempt) {
    final factor = math.pow(2, math.max(0, attempt - 1)).toInt();
    final wait = initialDelay * factor;
    return wait > maxDelay ? maxDelay : wait;
  }
}

/// Settings for opening stream sessions. The client builds one from its own
/// configuration.
///
/// [headers] is called before every connection attempt and returns the
/// headers to send, including `Authorization`. In a browser no headers can be
/// sent on a WebSocket: streams go through your own proxy there, which
/// authenticates by cookies or by the query parameters [query] returns
/// (also called before every attempt).
final class StreamOptions {
  /// Creates stream settings. Every argument has a default that matches the
  /// API's limits.
  StreamOptions({
    Uri? wsBaseUri,
    StreamParameters? headers,
    this.query,
    this.userAgent,
    this.openTimeout = const Duration(seconds: 10),
    this.closeTimeout = const Duration(seconds: 5),
    this.keepalive = const Duration(seconds: 30),
    this.pongTimeout = const Duration(seconds: 15),
    this.silenceTimeout = const Duration(seconds: 60),
    RetryPolicy? retryPolicy,
    this.waitForSlot,
    this.reconnectSlotWait = const Duration(seconds: 90),
    this.maxConnectAttempts = 6,
    this.connectWindow = const Duration(seconds: 60),
    this.sessionStartTimeout = const Duration(seconds: 10),
    this.synthesisStartTimeout = const Duration(seconds: 30),
    this.cancelAckTimeout = const Duration(seconds: 5),
    this.rotateAfter = const Duration(minutes: 28),
    this.rolloverMargin = const Duration(seconds: 30),
    StreamClock? clock,
    Future<void> Function(Duration)? sleep,
  })  : wsBaseUri = wsBaseUri ?? defaultWsBaseUri,
        headers = headers ?? _noHeaders,
        retryPolicy = retryPolicy ?? RetryPolicy(),
        clock = clock ?? _monotonicNow,
        sleep = sleep ?? _delay;

  /// Where streams connect: `wss://api.echonova.ai`, or your proxy. An
  /// `https` URL is turned into `wss`, and `http` into `ws`. Stream paths
  /// are appended to its path.
  final Uri wsBaseUri;

  /// The headers for each connection attempt. Not called in a browser,
  /// which can't send them.
  final StreamParameters headers;

  /// Query parameters added to each connection attempt, such as a
  /// short-lived token for your proxy (browsers can't send headers).
  final StreamParameters? query;

  /// Replaces the `User-Agent` header (not sent by browsers).
  final String? userAgent;

  /// How long opening a connection may take.
  final Duration openTimeout;

  /// How long a clean close may take before the connection is dropped.
  final Duration closeTimeout;

  /// Send a `ping` frame after this long without sending anything, so an
  /// open stream never reaches the server's idle timeout. `null` turns
  /// keepalive and the liveness checks off.
  final Duration? keepalive;

  /// No `pong` within this long after a `ping` means the connection is lost.
  final Duration pongTimeout;

  /// Nothing received for this long means the connection is lost.
  final Duration silenceTimeout;

  /// Decides which failed handshakes are retried, and the backoff.
  final RetryPolicy retryPolicy;

  /// Keep retrying `Too many concurrent streams` for up to this long. By
  /// default it isn't retried.
  final Duration? waitForSlot;

  /// The same, automatically, when reconnecting after a dropped connection:
  /// the old connection can count against the limit for a while.
  final Duration reconnectSlotWait;

  /// At most this many connection attempts per [connectWindow], per session
  /// object, to protect the key's connection budget.
  final int maxConnectAttempts;

  /// See [maxConnectAttempts].
  final Duration connectWindow;

  /// Speech to Text: how long to wait for `session.started` (and
  /// `terminology.set`).
  final Duration sessionStartTimeout;

  /// Text to Speech: how long to wait for `start` after sending a request.
  final Duration synthesisStartTimeout;

  /// Text to Speech: a cancel the server hasn't confirmed within this long
  /// is treated as done.
  final Duration cancelAckTimeout;

  /// Text to Speech: reopen an idle socket after this long, before the
  /// server's 30-minute session limit.
  final Duration rotateAfter;

  /// `transcribeStream`: hand over to a new session this long before the
  /// session limit.
  final Duration rolloverMargin;

  /// Monotonic time, for deadlines.
  final StreamClock clock;

  /// Waits for a duration (handshake backoff, reconnect delays).
  final Future<void> Function(Duration) sleep;

  /// The WebSocket URL for a stream [path], with [query] parameters.
  ///
  /// Throws [UsageException] when [wsBaseUri] is not a `wss`, `ws`,
  /// `https` or `http` URL with a host.
  Uri url(String path, [Map<String, String> query = const {}]) {
    final base = wsBaseUri;
    final scheme = switch (base.scheme) {
      'https' || 'wss' => 'wss',
      'http' || 'ws' => 'ws',
      _ => null,
    };
    if (scheme == null || base.host.isEmpty) {
      throw UsageException(
        'wsBaseUri must be a wss:// (or https://) URL, got $base',
      );
    }
    var basePath = base.path;
    while (basePath.endsWith('/')) {
      basePath = basePath.substring(0, basePath.length - 1);
    }
    if (basePath.endsWith('/v1') && path.startsWith('/v1/')) {
      basePath = basePath.substring(0, basePath.length - 3);
    }
    return Uri(
      scheme: scheme,
      userInfo: base.userInfo.isEmpty ? null : base.userInfo,
      host: base.host,
      port: base.hasPort ? base.port : null,
      path: '$basePath$path',
      queryParameters: query.isEmpty ? null : query,
    );
  }
}
