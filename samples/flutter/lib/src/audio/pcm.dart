/// PCM16LE helpers shared by the players and the microphone code.
library;

import 'dart:math' as math;
import 'dart:typed_data';

/// Bytes per PCM16 mono sample.
const int bytesPerSample = 2;

/// The play time of [bytes] of PCM16 mono audio at [sampleRate].
Duration pcm16Duration(int bytes, int sampleRate) =>
    Duration(microseconds: bytes ~/ bytesPerSample * 1000000 ~/ sampleRate);

/// Re-joins PCM16 data split at odd byte offsets, so that every chunk it
/// returns holds whole samples.
final class Pcm16Joiner {
  int? _carry;

  /// Returns the whole samples available after [chunk] (possibly a view of
  /// it).
  Uint8List add(Uint8List chunk) {
    final carry = _carry;
    final bytes = carry == null
        ? chunk
        : (Uint8List(chunk.length + 1)
            ..[0] = carry
            ..setRange(1, chunk.length + 1, chunk));
    final whole = bytes.length - bytes.length % bytesPerSample;
    _carry = whole < bytes.length ? bytes.last : null;
    return whole == bytes.length
        ? bytes
        : Uint8List.sublistView(bytes, 0, whole);
  }

  /// Drops a pending half sample.
  void reset() => _carry = null;
}

/// Converts PCM16LE samples to floats in [-1, 1).
Float32List pcm16ToFloat32(Uint8List pcm) {
  final data = ByteData.sublistView(pcm);
  final out = Float32List(pcm.length ~/ bytesPerSample);
  for (var i = 0; i < out.length; i++) {
    out[i] = data.getInt16(i * bytesPerSample, Endian.little) / 32768;
  }
  return out;
}

/// The loudness of PCM16LE [pcm], as RMS in [0, 1].
double pcm16Rms(Uint8List pcm) {
  final count = pcm.length ~/ bytesPerSample;
  if (count == 0) return 0;
  final data = ByteData.sublistView(pcm);
  var sum = 0.0;
  for (var i = 0; i < count; i++) {
    final sample = data.getInt16(i * bytesPerSample, Endian.little) / 32768;
    sum += sample * sample;
  }
  return math.sqrt(sum / count);
}
