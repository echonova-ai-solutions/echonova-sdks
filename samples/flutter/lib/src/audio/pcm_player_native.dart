/// Android and iOS playback with `flutter_pcm_sound`, which plays raw PCM16
/// as it is fed.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_pcm_sound/flutter_pcm_sound.dart';

import 'pcm.dart';
import 'pcm_player.dart';

/// The player for Android and iOS.
PcmPlayer createPlatformPcmPlayer() => NativePcmPlayer();

/// Feeds each chunk to `flutter_pcm_sound` as it arrives. The plugin queues
/// it after the audio before it, so playback starts with the first chunk.
///
/// The audio device is set up for each utterance (at its sample rate) and
/// released when it stops, so the app holds no audio resources while idle.
final class NativePcmPlayer implements PcmPlayer {
  /// Creates the player.
  NativePcmPlayer() {
    unawaited(FlutterPcmSound.setLogLevel(LogLevel.error));
    FlutterPcmSound.setFeedCallback(null); // fed as audio arrives instead
  }

  // The output device's own buffer, added to the estimate in [drained].
  static const Duration _outputLatency = Duration(milliseconds: 150);

  final Pcm16Joiner _joiner = Pcm16Joiner();
  final PlaybackClock _clock = PlaybackClock();
  // The plugin's calls are asynchronous: this runs them in order.
  Future<void> _work = Future.value();
  int _utterance = 0;
  int _sampleRate = 0;
  bool _setUp = false;

  @override
  void unlock() {}

  @override
  void start(int sampleRate) {
    final utterance = ++_utterance;
    _sampleRate = sampleRate;
    _joiner.reset();
    _clock.reset();
    _run(() async {
      if (_setUp) await FlutterPcmSound.release();
      if (utterance != _utterance) return;
      await FlutterPcmSound.setup(sampleRate: sampleRate, channelCount: 1);
      _setUp = true;
    });
  }

  @override
  void feed(Uint8List pcm) {
    if (_sampleRate == 0) return;
    final utterance = _utterance;
    // A copy: the plugin sends the whole buffer behind the data it is given.
    final samples = Uint8List.fromList(_joiner.add(pcm));
    if (samples.isEmpty) return;
    _clock.add(pcm16Duration(samples.length, _sampleRate));
    _run(() async {
      if (utterance != _utterance || !_setUp) return;
      await FlutterPcmSound.feed(
        PcmArrayInt16(bytes: samples.buffer.asByteData()),
      );
    });
  }

  @override
  Future<void> drained() => _clock.drained(latency: _outputLatency);

  @override
  Future<void> stop() {
    _utterance++;
    _sampleRate = 0;
    _clock.reset();
    _run(() async {
      if (!_setUp) return;
      _setUp = false;
      await FlutterPcmSound.release();
    });
    return _work;
  }

  @override
  Future<void> dispose() => stop();

  void _run(Future<void> Function() step) {
    _work = _work.then((_) => step()).catchError((Object error) {
      debugPrint('Audio playback failed: $error');
    });
  }
}
