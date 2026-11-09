/// Transport rules shared by every stream session (sans-IO).
///
/// * [encodeJson] checks the 64 KiB frame limit locally, so an oversized
///   frame throws [UsageException] instead of the server closing the socket.
/// * [Liveness] decides when to send an app-level ping and when to give up
///   on a silent connection.
/// * [AttemptLimiter] caps connection attempts per session object.
/// * [HandshakeRetry] decides whether a failed handshake is retried.
library;

import 'dart:collection';
import 'dart:convert';

import '../core/retry.dart';
import '../core/rules.dart';
import '../errors.dart';

/// The largest JSON frame the streams accept.
const int maxJsonFrameBytes = 65536;

/// The app-level ping frame.
const String pingFrame = '{"type":"ping"}';

/// What [Liveness.poll] asks for.
enum LinkAction {
  /// Send a ping.
  ping,

  /// No pong arrived in time: the connection is lost.
  lostPong,

  /// Nothing arrived for too long: the connection is lost.
  lostSilence,
}

/// Serializes a JSON frame. Throws [UsageException] when it is over the
/// 64 KiB frame limit; nothing is sent then.
String encodeJson(Map<String, Object?> payload) {
  final text = jsonEncode(payload);
  final size = utf8.encode(text).length;
  if (size > maxJsonFrameBytes) {
    final kind = payload['type'] ?? 'frame';
    throw UsageException(
      'the $kind frame is $size bytes; stream frames are limited to '
      '$maxJsonFrameBytes bytes. Nothing was sent.',
    );
  }
  return text;
}

/// Parses an inbound text frame. Anything that isn't a JSON object comes
/// back without a `type`.
Map<String, Object?> decodeEvent(String text) {
  final Object? value;
  try {
    value = jsonDecode(text);
  } on FormatException {
    return {
      'raw_text': text.length > 4096 ? text.substring(0, 4096) : text,
    };
  }
  if (value is Map<String, Object?>) return value;
  return {'raw_value': value};
}

/// Keepalive and liveness timers for one socket.
///
/// The SDK sends `{"type":"ping"}` when it hasn't sent a data frame for
/// [keepalive], so an open socket never reaches the stream's idle timeout.
/// The connection counts as lost when a ping gets no `pong` within
/// [pongTimeout], or nothing at all arrives for [silenceTimeout].
/// `keepalive: null` turns all of this off.
final class Liveness {
  /// Creates the timers, starting at [now].
  Liveness(
    Duration now, {
    required this.keepalive,
    required this.pongTimeout,
    required this.silenceTimeout,
  })  : lastSent = now,
        lastReceived = now;

  /// See [Liveness].
  final Duration? keepalive;

  /// See [Liveness].
  final Duration pongTimeout;

  /// See [Liveness].
  final Duration silenceTimeout;

  /// When a frame was last sent.
  Duration lastSent;

  /// When a frame was last received.
  Duration lastReceived;

  /// When the unanswered ping was sent.
  Duration? pingSentAt;

  /// A data frame was sent.
  void sent(Duration now) => lastSent = now;

  /// A ping was sent.
  void pingSent(Duration now) {
    lastSent = now;
    pingSentAt ??= now;
  }

  /// A frame arrived.
  void received(Duration now) => lastReceived = now;

  /// A pong arrived.
  void pong(Duration now) {
    lastReceived = now;
    pingSentAt = null;
  }

  /// What to do now, if anything.
  LinkAction? poll(Duration now) {
    final interval = keepalive;
    if (interval == null) return null;
    final ping = pingSentAt;
    if (ping != null && now - ping >= pongTimeout) return LinkAction.lostPong;
    if (now - lastReceived >= silenceTimeout) return LinkAction.lostSilence;
    if (ping == null && now - lastSent >= interval) return LinkAction.ping;
    return null;
  }

  /// When [poll] next needs to run, or `null` when keepalive is off.
  Duration? nextDeadline() {
    final interval = keepalive;
    if (interval == null) return null;
    final silence = lastReceived + silenceTimeout;
    final ping = pingSentAt;
    final other = ping != null ? ping + pongTimeout : lastSent + interval;
    return silence < other ? silence : other;
  }

  /// Why the connection counts as lost.
  String describe(LinkAction action) => action == LinkAction.lostPong
      ? 'no pong within ${_seconds(pongTimeout)} s of a ping'
      : 'nothing received for ${_seconds(silenceTimeout)} s';
}

String _seconds(Duration duration) {
  final seconds = duration.inMicroseconds / Duration.microsecondsPerSecond;
  return seconds == seconds.roundToDouble()
      ? '${seconds.round()}'
      : seconds.toStringAsFixed(3).replaceFirst(RegExp(r'0+$'), '');
}

/// At most [maxAttempts] connection attempts per [window], per session
/// object. This protects the API key's connection budget when something
/// keeps failing.
final class AttemptLimiter {
  /// Creates a limiter.
  AttemptLimiter({
    this.maxAttempts = 6,
    this.window = const Duration(seconds: 60),
  });

  /// See [AttemptLimiter].
  final int maxAttempts;

  /// See [AttemptLimiter].
  final Duration window;

  final Queue<Duration> _attempts = Queue();

  /// How long to wait before the next attempt is allowed.
  Duration waitTime(Duration now) {
    while (_attempts.isNotEmpty && now - _attempts.first >= window) {
      _attempts.removeFirst();
    }
    if (_attempts.length < maxAttempts) return Duration.zero;
    return _attempts.first + window - now;
  }

  /// An attempt is being made.
  void record(Duration now) => _attempts.add(now);

  /// The exception when the limit is reached.
  APIConnectionException error() => APIConnectionException(
        'not connecting: this session already made $maxAttempts connection '
        'attempts in the last ${_seconds(window)} s',
        retryDisabledReason: 'attempt_limit',
      );
}

/// Retry decisions for one connect call.
///
/// Status errors follow the shared retry table's WS column. `Too many
/// concurrent streams` is retried only with `waitForSlot`, or automatically
/// for up to `slotWaitAfterLoss` when reconnecting after a dropped
/// connection, in case the dropped connection still counts against the
/// limit for a while.
final class HandshakeRetry {
  /// Creates the decisions for a connect call that starts at [now].
  HandshakeRetry(
    this.policy, {
    required Duration now,
    required Duration? waitForSlot,
    required bool afterAbnormal,
    required Duration slotWaitAfterLoss,
    this.rules = errorRules,
  }) : started = now {
    final budgets = [
      if (waitForSlot != null && waitForSlot > Duration.zero) waitForSlot,
      if (afterAbnormal && slotWaitAfterLoss > Duration.zero) slotWaitAfterLoss,
    ];
    slotBudget =
        budgets.isEmpty ? null : budgets.reduce((a, b) => a > b ? a : b);
  }

  /// The retry table.
  final RetryPolicy policy;

  /// The rules the handshake errors were classified with.
  final RuleSet rules;

  /// When the connect call started.
  final Duration started;

  /// How long `Too many concurrent streams` may be retried, if at all.
  late final Duration? slotBudget;

  /// Retries made so far.
  int retries = 0;

  bool _waitingForSlot = false;

  /// Whether a wait (for the attempt limiter) fits in the slot-wait budget.
  bool mayWait(Duration now, Duration delay) {
    final budget = slotBudget;
    return _waitingForSlot && budget != null && now + delay - started <= budget;
  }

  /// The delay before the next attempt, or throws [error] when the handshake
  /// rejection is final.
  Duration onStatus(APIStatusException error, Duration now) {
    final id = error.rule;
    final rule = id == null
        ? null
        : rules.rules.where((rule) => rule.id == id).firstOrNull;
    if (rule == null) return onNetwork(error);
    final budget = slotBudget;
    final decision = policy.decideStatus(
      'WS',
      rule,
      retriesDone: retries,
      retryAfter: error.retryAfter,
      waitForSlot: budget != null,
    );
    if (rule.id == 'concurrent_streams' && budget != null) {
      if (decision.reason == RetryReason.retry ||
          decision.reason == RetryReason.maxRetries) {
        final delay = policy.backoff(retries + 1 < 6 ? retries + 1 : 6);
        if (now + delay - started <= budget) {
          retries += 1;
          _waitingForSlot = true;
          return delay;
        }
      }
      throw error;
    }
    _waitingForSlot = false;
    if (decision.retry) {
      retries += 1;
      return decision.delay;
    }
    throw error;
  }

  /// The delay before the next attempt after a network failure, or throws
  /// [error] when the retries are used up.
  Duration onNetwork(EchoNovaException error) {
    _waitingForSlot = false;
    final decision = policy.decideTransport(
      'WS',
      FailurePhase.connect,
      retriesDone: retries,
    );
    if (decision.retry) {
      retries += 1;
      return decision.delay;
    }
    throw error;
  }
}
