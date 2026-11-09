/// The clocks, sleep and randomness a client uses. Tests replace them so
/// retries, rate-limit waits and polling run instantly and deterministically.
library;

import 'dart:math' as math;

/// Time and randomness for one client and its `withOptions` copies.
final class ClientRuntime {
  /// Creates a runtime. Every argument defaults to the real thing.
  ///
  /// * [clock] returns monotonic time (it never jumps when the wall clock
  ///   changes). Used for deadlines, rate-limit windows and polling.
  /// * [now] returns the wall-clock time in UTC. Used for `sentAt` on
  ///   errors, which `findCandidates` compares with job creation times.
  /// * [sleep] waits for a duration.
  /// * [random] returns numbers in `[0, 1)`, for jitter.
  ClientRuntime({
    Duration Function()? clock,
    DateTime Function()? now,
    Future<void> Function(Duration)? sleep,
    double Function()? random,
  })  : clock = clock ?? _monotonic(),
        now = now ?? _utcNow,
        sleep = sleep ?? _delay,
        random = random ?? math.Random().nextDouble;

  /// Monotonic time.
  final Duration Function() clock;

  /// Wall-clock time, in UTC.
  final DateTime Function() now;

  /// Waits for a duration.
  final Future<void> Function(Duration) sleep;

  /// A number in `[0, 1)`.
  final double Function() random;

  static Duration Function() _monotonic() {
    final stopwatch = Stopwatch()..start();
    return () => stopwatch.elapsed;
  }

  static DateTime _utcNow() => DateTime.now().toUtc();

  static Future<void> _delay(Duration duration) => duration <= Duration.zero
      ? Future<void>.value()
      : Future.delayed(duration);
}
