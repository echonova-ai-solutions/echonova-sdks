/// Decide whether a failed attempt may be retried, and after how long.
///
/// Pure logic over the shared retry table in `spec/error-rules.json`. The
/// table never retries a POST that may already have run, because the API has
/// no idempotency key and would charge again.
library;

import 'dart:math' as math;

import 'envelope.dart' show durationFromSeconds;
import 'rules.dart';

/// A failure without an HTTP status, by when it happened.
enum FailurePhase {
  /// DNS, TCP or TLS failed: no byte was sent (R1).
  connect('connect'),

  /// The body was not fully written (R2). Only some HTTP clients can tell.
  sendIncomplete('send_incomplete'),

  /// The request was sent but no response arrived (R3).
  noResponse('no_response'),

  /// A 2xx response whose body is not a valid envelope (R4).
  malformedSuccess('malformed_success');

  const FailurePhase(this.key);

  /// The phase's name in `error-rules.json`.
  final String key;
}

/// Why a [RetryDecision] was made.
enum RetryReason {
  /// The attempt will be retried.
  retry,

  /// The retry table doesn't retry this.
  notRetryable,

  /// Retried only with `waitForSlot`, which was not set.
  notOptedIn,

  /// The retry budget is used up.
  maxRetries,

  /// The request body can't be sent again.
  bodyNotReplayable,

  /// The server asked to wait longer than the SDK will.
  retryAfterTooLong,

  /// The rule needs a `Retry-After` header and there was none.
  missingRetryAfter,
}

/// Whether to retry, and after how long.
final class RetryDecision {
  /// Creates a decision.
  const RetryDecision({
    required this.retry,
    required this.delay,
    required this.row,
    required this.mayHaveExecuted,
    required this.reason,
  });

  /// Whether to send the request again.
  final bool retry;

  /// How long to wait first.
  final Duration delay;

  /// The retry-table row that decided.
  final String row;

  /// Whether a POST may already have run.
  final Executed mayHaveExecuted;

  /// Why.
  final RetryReason reason;

  @override
  String toString() => 'RetryDecision(retry: $retry, delay: $delay, row: $row, '
      'mayHaveExecuted: ${mayHaveExecuted.name}, reason: ${reason.name})';
}

/// Applies the retry table.
final class RetryPolicy {
  /// Creates a policy. [random] returns numbers in `[0, 1)` and is used for
  /// jitter; inject it for deterministic tests.
  RetryPolicy({
    int? maxRetries,
    Duration? maxRetryAfter,
    this.rules = errorRules,
    double Function()? random,
  })  : maxRetries = maxRetries ?? rules.defaults.maxRetries,
        maxRetryAfter = maxRetryAfter ??
            durationFromSeconds(rules.defaults.maxRetryAfterSeconds),
        _random = random ?? math.Random().nextDouble;

  /// The rules this policy applies.
  final RuleSet rules;

  /// Retries per request.
  final int maxRetries;

  /// A longer REST `Retry-After` is not waited for.
  final Duration maxRetryAfter;

  final double Function() _random;

  /// The delay before retry number [retryNumber] (1-based), with jitter.
  Duration backoff(int retryNumber) {
    final d = rules.defaults;
    final base = math.min(
      d.backoffMaxSeconds,
      d.backoffInitialSeconds *
          math.pow(d.backoffMultiplier, retryNumber - 1).toDouble(),
    );
    final (low, high) = d.backoffJitter;
    return durationFromSeconds(base * (low + (high - low) * _random()));
  }

  Duration _retryAfterDelay(Duration retryAfter) {
    final (low, high) = rules.defaults.retryAfterJitterSeconds;
    return retryAfter + durationFromSeconds(low + (high - low) * _random());
  }

  /// Decides for an HTTP error status. [method] is GET, DELETE or POST, or
  /// `WS` for a WebSocket handshake.
  RetryDecision decideStatus(
    String method,
    ErrorRule rule, {
    required int retriesDone,
    required Duration? retryAfter,
    bool bodyReplayable = true,
    bool waitForSlot = false,
  }) {
    final isHandshake = method.toUpperCase() == 'WS';
    return _decide(
      rule.retry.forMethod(method),
      rule.retry.delay,
      row: rule.row,
      executed: rule.mayHaveExecuted,
      retriesDone: retriesDone,
      retryAfter: retryAfter,
      bodyReplayable: bodyReplayable,
      optedIn: waitForSlot,
      maxRetryAfter: isHandshake
          ? durationFromSeconds(rules.defaults.wsMaxRetryAfterSeconds)
          : maxRetryAfter,
    );
  }

  /// Decides for a failure without an HTTP status (connect error, timeout,
  /// malformed body).
  RetryDecision decideTransport(
    String method,
    FailurePhase phase, {
    required int retriesDone,
    bool bodyReplayable = true,
  }) {
    final row = rules.transport[phase.key];
    if (row == null) {
      throw StateError('error-rules.json has no transport row ${phase.key}');
    }
    return _decide(
      row.retry.forMethod(method),
      row.retry.delay,
      row: row.row,
      executed: row.mayHaveExecuted,
      retriesDone: retriesDone,
      retryAfter: null,
      bodyReplayable: bodyReplayable,
      optedIn: false,
      maxRetryAfter: maxRetryAfter,
    );
  }

  RetryDecision _decide(
    RetryFlag flag,
    RetryDelay delayKind, {
    required String row,
    required Executed executed,
    required int retriesDone,
    required Duration? retryAfter,
    required bool bodyReplayable,
    required bool optedIn,
    required Duration maxRetryAfter,
  }) {
    RetryDecision no(RetryReason reason) => RetryDecision(
          retry: false,
          delay: Duration.zero,
          row: row,
          mayHaveExecuted: executed,
          reason: reason,
        );

    if (flag == RetryFlag.no || delayKind == RetryDelay.none) {
      return no(RetryReason.notRetryable);
    }
    if (flag == RetryFlag.optIn && !optedIn) {
      return no(RetryReason.notOptedIn);
    }
    if (flag == RetryFlag.once && retriesDone >= 1) {
      return no(RetryReason.maxRetries);
    }
    if (retriesDone >= maxRetries) return no(RetryReason.maxRetries);
    if (!bodyReplayable) return no(RetryReason.bodyNotReplayable);

    final Duration delay;
    final usesRetryAfter = delayKind == RetryDelay.retryAfter ||
        delayKind == RetryDelay.retryAfterOrBackoff;
    if (usesRetryAfter && retryAfter != null) {
      if (retryAfter > maxRetryAfter) {
        return no(RetryReason.retryAfterTooLong);
      }
      delay = _retryAfterDelay(retryAfter);
    } else if (delayKind == RetryDelay.retryAfter) {
      return no(RetryReason.missingRetryAfter);
    } else {
      delay = backoff(retriesDone + 1);
    }
    return RetryDecision(
      retry: true,
      delay: delay,
      row: row,
      mayHaveExecuted: executed,
      reason: RetryReason.retry,
    );
  }
}
