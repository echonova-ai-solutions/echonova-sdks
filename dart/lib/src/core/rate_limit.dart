/// Track EchoNova's per-key, per-endpoint rate limits on the client side.
///
/// The API allows a number of requests per minute for each key on each
/// endpoint. After a throttle 429, every caller on that endpoint waits out
/// `Retry-After` before sending again, instead of each one finding out
/// separately. `X-RateLimit-Reset` and `Retry-After` are read as seconds from
/// now.
library;

import 'envelope.dart';

/// The rate-limit headers of a response.
final class RateLimitInfo {
  /// Creates rate-limit information.
  const RateLimitInfo({this.limit, this.remaining, this.reset});

  /// Requests allowed per window (`X-RateLimit-Limit`).
  final int? limit;

  /// Requests left in the current window (`X-RateLimit-Remaining`).
  final int? remaining;

  /// Time until the window resets, as of when the response arrived
  /// (`X-RateLimit-Reset`).
  final Duration? reset;

  @override
  String toString() =>
      'RateLimitInfo(limit: $limit, remaining: $remaining, reset: $reset)';
}

int? _int(String? value) => value == null ? null : int.tryParse(value.trim());

Duration? _seconds(String? value) {
  final seconds = value == null ? null : double.tryParse(value.trim());
  return seconds == null || seconds.isNaN ? null : durationFromSeconds(seconds);
}

/// Reads the `X-RateLimit-*` headers, or returns `null` when there are none.
RateLimitInfo? parseRateLimit(Map<String, String> headers) {
  final limit = _int(header(headers, 'x-ratelimit-limit'));
  final remaining = _int(header(headers, 'x-ratelimit-remaining'));
  final reset = _seconds(header(headers, 'x-ratelimit-reset'));
  if (limit == null && remaining == null && reset == null) return null;
  return RateLimitInfo(limit: limit, remaining: remaining, reset: reset);
}

final class _Bucket {
  RateLimitInfo? info;
  Duration? windowEndsAt;
  Duration blockedUntil = Duration.zero;
}

/// Per-bucket rate-limit state. A bucket is one API operation: the server
/// counts per key per endpoint.
final class RateLimitTracker {
  /// Creates a tracker. [clock] returns monotonic time; inject it for tests.
  RateLimitTracker({Duration Function()? clock})
      : _clock = clock ?? (Stopwatch()..start()).elapsedFunction;

  final Duration Function() _clock;
  final Map<String, _Bucket> _buckets = {};

  /// Records a response's rate-limit headers for [bucket], and returns them.
  RateLimitInfo? observe(String bucket, Map<String, String> headers) {
    final info = parseRateLimit(headers);
    if (info == null) return null;
    final state = _buckets.putIfAbsent(bucket, _Bucket.new);
    state.info = info;
    final reset = info.reset;
    state.windowEndsAt = reset == null ? null : _clock() + reset;
    return info;
  }

  /// Records a throttle 429: nothing goes to [bucket] for [duration]. A
  /// shorter block never shortens the current one.
  void block(String bucket, Duration duration) {
    final state = _buckets.putIfAbsent(bucket, _Bucket.new);
    final until = _clock() + duration;
    if (until > state.blockedUntil) state.blockedUntil = until;
  }

  /// How long to wait before sending to [bucket] ([Duration.zero] when it's
  /// clear). With [preflight], also waits for the window to reset when the
  /// last response said no requests remain.
  Duration waitTime(String bucket, {bool preflight = true}) {
    final state = _buckets[bucket];
    if (state == null) return Duration.zero;
    final now = _clock();
    var wait = state.blockedUntil - now;
    final windowEndsAt = state.windowEndsAt;
    if (preflight && state.info?.remaining == 0 && windowEndsAt != null) {
      final untilReset = windowEndsAt - now;
      if (untilReset > wait) wait = untilReset;
    }
    return wait.isNegative ? Duration.zero : wait;
  }

  /// The last rate-limit headers seen for [bucket].
  RateLimitInfo? last(String bucket) => _buckets[bucket]?.info;

  /// The last rate-limit headers seen, by bucket.
  Map<String, RateLimitInfo> snapshot() => {
        for (final MapEntry(:key, :value) in _buckets.entries)
          if (value.info case final info?) key: info,
      };
}

extension on Stopwatch {
  Duration Function() get elapsedFunction => () => elapsed;
}
