/// Small async helpers for the stream sessions.
library;

import 'dart:async';
import 'dart:developer' as developer;

/// Wakes everyone waiting for "something changed".
final class Signal {
  Completer<void> _next = Completer<void>();

  /// Completes the next time [notify] is called.
  Future<void> get next => _next.future;

  /// Wakes the waiters.
  void notify() {
    final current = _next;
    _next = Completer<void>();
    current.complete();
  }

  /// Waits for the next [notify], for at most [timeout] (forever when
  /// `null`). Returns whether it was notified.
  Future<bool> wait([Duration? timeout]) {
    if (timeout == null) return next.then((_) => true);
    if (timeout <= Duration.zero) return Future.value(false);
    return next.then((_) => true).timeout(timeout, onTimeout: () => false);
  }
}

/// Runs async actions one at a time, in order.
final class Mutex {
  Future<void> _tail = Future<void>.value();

  /// Runs [action] once every earlier action has finished.
  Future<T> run<T>(Future<T> Function() action) {
    final result = _tail.then((_) => action());
    _tail = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }
}

/// Waits for [future] for at most [timeout]. Returns whether it completed.
Future<bool> waitAtMost(Future<void> future, Duration timeout) => future
    .then((_) => true, onError: (Object _) => true)
    .timeout(timeout, onTimeout: () => false);

/// Logs a streaming message (visible in DevTools and to `dart:developer`
/// listeners).
void streamLog(String message, {int level = 800, Object? error}) =>
    developer.log(
      message,
      name: 'echonova.streaming',
      level: level,
      error: error,
    );
