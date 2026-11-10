/// Low-latency playback of PCM16LE mono audio as it arrives.
library;

import 'dart:async';
import 'dart:typed_data';

import 'pcm_player_native.dart'
    if (dart.library.js_interop) 'pcm_player_web.dart'
    as platform;

/// Plays PCM16LE mono audio chunk by chunk, starting with the first one.
abstract interface class PcmPlayer {
  /// Call this from the button handler, before any `await`: browsers only
  /// let a page start audio in response to a user gesture.
  void unlock();

  /// Starts a new utterance at [sampleRate] Hz, dropping anything still
  /// playing.
  void start(int sampleRate);

  /// Plays [pcm] after what was fed before.
  void feed(Uint8List pcm);

  /// Completes once everything fed so far has played, or at [stop].
  Future<void> drained();

  /// Stops at once and drops the audio not played yet.
  Future<void> stop();

  /// Releases the audio device.
  Future<void> dispose();
}

/// The player for this platform: `flutter_pcm_sound` on Android and iOS,
/// Web Audio in a browser.
PcmPlayer createPcmPlayer() => platform.createPlatformPcmPlayer();

/// Tracks when the audio fed to a player ends, for [PcmPlayer.drained].
///
/// The players play each chunk right after the previous one, or at once when
/// the previous one has already ended. This mirrors that on a clock.
final class PlaybackClock {
  /// Uses [now], a monotonic clock (by default, a [Stopwatch]'s).
  PlaybackClock({Duration Function()? now}) : _now = now ?? _stopwatch();

  final Duration Function() _now;
  Duration _end = Duration.zero;
  Timer? _timer;
  Completer<void>? _drained;

  /// Records [duration] more audio, played from now or after the audio
  /// before it.
  void add(Duration duration) {
    final now = _now();
    _end = (_end > now ? _end : now) + duration;
  }

  /// How much of the audio fed is still to play.
  Duration get remaining {
    final left = _end - _now();
    return left > Duration.zero ? left : Duration.zero;
  }

  /// Completes after [remaining] plus [latency] (the output device's own
  /// buffer), or at [reset].
  Future<void> drained({Duration latency = Duration.zero}) {
    final pending = _drained;
    if (pending != null) return pending.future;
    final wait = remaining;
    if (wait == Duration.zero) return Future.value();
    final completer = _drained = Completer<void>();
    _timer = Timer(wait + latency, _complete);
    return completer.future;
  }

  /// Forgets the audio fed, and completes [drained].
  void reset() {
    _end = Duration.zero;
    _complete();
  }

  void _complete() {
    _timer?.cancel();
    _timer = null;
    final completer = _drained;
    _drained = null;
    if (completer != null && !completer.isCompleted) completer.complete();
  }
}

Duration Function() _stopwatch() {
  final stopwatch = Stopwatch()..start();
  return () => stopwatch.elapsed;
}
