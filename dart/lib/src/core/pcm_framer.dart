/// Split raw PCM16LE audio into frames the Speech to Text stream accepts.
///
/// Frames are about `frameMs` of audio, never larger than 65,536 bytes
/// (larger frames close the socket with 1008), and always an even number of
/// bytes, so a 16-bit sample is never split. An odd trailing byte is held
/// until more audio arrives. Input is copied, so callers can reuse their
/// buffers.
library;

import 'dart:math' as math;
import 'dart:typed_data';

/// The largest WebSocket frame the API accepts.
const int maxFrameBytes = 65536;

/// PCM16: two bytes per sample.
const int bytesPerSample = 2;

/// Buffers PCM16LE audio and cuts it into stream frames.
final class PcmFramer {
  /// Creates a framer for mono PCM16LE audio at [sampleRate] Hz.
  PcmFramer(this.sampleRate, {int frameMs = 100})
      : frameBytes = _frameBytes(sampleRate, frameMs);

  static int _frameBytes(int sampleRate, int frameMs) {
    if (sampleRate <= 0) {
      throw ArgumentError.value(
        sampleRate,
        'sampleRate',
        'sampleRate must be a positive number of Hz',
      );
    }
    if (frameMs <= 0) {
      throw ArgumentError.value(frameMs, 'frameMs', 'frameMs must be positive');
    }
    var size = sampleRate * bytesPerSample * frameMs ~/ 1000;
    size -= size % 2;
    return math.max(bytesPerSample, math.min(maxFrameBytes, size));
  }

  /// The sample rate, in Hz.
  final int sampleRate;

  /// The size of a full frame, in bytes (even, at most [maxFrameBytes]).
  final int frameBytes;

  Uint8List _buffer = Uint8List(0);
  int _length = 0;

  int _bytesEmitted = 0;

  /// Bytes returned as frames so far.
  int get bytesEmitted => _bytesEmitted;

  /// Bytes buffered and not yet returned (less than [frameBytes]).
  int get pendingBytes => _length;

  /// Seconds of audio returned as frames so far.
  double get secondsEmitted => bytesEmitted / (sampleRate * bytesPerSample);

  /// Adds audio and returns the complete frames now ready to send.
  List<Uint8List> push(List<int> data) {
    _append(data);
    final frames = <Uint8List>[];
    var offset = 0;
    while (_length - offset >= frameBytes) {
      frames.add(Uint8List.fromList(
        Uint8List.sublistView(_buffer, offset, offset + frameBytes),
      ));
      offset += frameBytes;
    }
    _consume(offset);
    _bytesEmitted += offset;
    return frames;
  }

  /// Returns every buffered whole sample, as at most one frame (before
  /// `endSegment`). An odd byte stays buffered.
  List<Uint8List> flush() {
    final whole = _length - _length % 2;
    if (whole == 0) return <Uint8List>[];
    final frame = Uint8List.fromList(Uint8List.sublistView(_buffer, 0, whole));
    _consume(whole);
    _bytesEmitted += whole;
    return [frame];
  }

  /// Flushes at `stop`. Returns the last frames and how many odd bytes were
  /// dropped (0 or 1).
  ({List<Uint8List> frames, int droppedBytes}) finish() {
    final frames = flush();
    final dropped = _length;
    _length = 0;
    return (frames: frames, droppedBytes: dropped);
  }

  void _append(List<int> data) {
    final needed = _length + data.length;
    if (needed > _buffer.length) {
      final grown = Uint8List(math.max(needed, _buffer.length * 2));
      grown.setRange(0, _length, _buffer);
      _buffer = grown;
    }
    _buffer.setRange(_length, needed, data);
    _length = needed;
  }

  void _consume(int count) {
    if (count == 0) return;
    _buffer.setRange(0, _length - count, _buffer, count);
    _length -= count;
  }
}
