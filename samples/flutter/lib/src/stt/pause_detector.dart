/// Finds pauses in speech, to cut segments where the speaker stops.
library;

import 'dart:typed_data';

import '../audio/pcm.dart';

/// Spots a pause after speech in PCM16LE mono audio.
///
/// A Speech to Text session sends a transcript for each segment of audio.
/// The server cuts a segment every 15 seconds; cutting one at each pause
/// (`endSegment()`) shows what was said as soon as the speaker stops.
///
/// This is a plain loudness gate, enough for a demo in a quiet room. A real
/// app might use a voice activity detector, or a push-to-talk button.
final class PauseDetector {
  /// Detects pauses in audio at [sampleRate] Hz.
  PauseDetector({
    required this.sampleRate,
    this.threshold = 0.01,
    this.minSpeech = const Duration(milliseconds: 300),
    this.minPause = const Duration(milliseconds: 700),
  });

  /// The audio's sample rate.
  final int sampleRate;

  /// The loudness (RMS, 0 to 1) above which audio counts as speech.
  final double threshold;

  /// The speech needed before a pause counts.
  final Duration minSpeech;

  /// The silence that makes a pause.
  final Duration minPause;

  Duration _speech = Duration.zero;
  Duration _silence = Duration.zero;

  /// Adds [chunk]. Returns `true` when it completes a pause after speech:
  /// the moment to cut a segment.
  bool add(Uint8List chunk) {
    final duration = pcm16Duration(chunk.length, sampleRate);
    if (pcm16Rms(chunk) >= threshold) {
      _speech += duration;
      _silence = Duration.zero;
      return false;
    }
    if (_speech < minSpeech) return false;
    _silence += duration;
    if (_silence < minPause) return false;
    _speech = Duration.zero;
    _silence = Duration.zero;
    return true;
  }
}
