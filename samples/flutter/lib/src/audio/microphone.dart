/// Microphone capture as a PCM16LE mono stream.
library;

import 'dart:typed_data';

import 'package:record/record.dart';

/// Captures the microphone as PCM16LE mono.
abstract interface class Microphone {
  /// Asks for microphone access when needed. Returns whether it was given.
  Future<bool> requestPermission();

  /// Starts capturing at [sampleRate] Hz. The stream ends at [stop].
  Future<Stream<Uint8List>> start({required int sampleRate});

  /// Stops capturing and ends the stream.
  Future<void> stop();

  /// Releases the microphone.
  Future<void> dispose();
}

/// A [Microphone] on the `record` plugin, which streams PCM16 on Android,
/// iOS and the web (where it resamples to the rate asked for).
final class RecordMicrophone implements Microphone {
  final AudioRecorder _recorder = AudioRecorder();

  @override
  Future<bool> requestPermission() => _recorder.hasPermission();

  @override
  Future<Stream<Uint8List>> start({required int sampleRate}) async {
    if (!await _recorder.isEncoderSupported(AudioEncoder.pcm16bits)) {
      throw UnsupportedError('This device cannot record PCM16 audio.');
    }
    return _recorder.startStream(
      RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: sampleRate,
        numChannels: 1,
      ),
    );
  }

  @override
  Future<void> stop() => _recorder.stop();

  @override
  Future<void> dispose() => _recorder.dispose();
}
