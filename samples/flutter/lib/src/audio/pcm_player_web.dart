/// Browser playback with Web Audio: each chunk becomes an `AudioBuffer`,
/// scheduled to start exactly when the one before it ends.
library;

import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

import 'pcm.dart';
import 'pcm_player.dart';

/// The player for the web.
PcmPlayer createPlatformPcmPlayer() => WebPcmPlayer();

/// Plays PCM16 through an `AudioContext`.
///
/// Each chunk is scheduled on the audio clock right after the previous one,
/// so chunks play without gaps however they arrive. The first chunk starts
/// [_lead] after it arrives, which absorbs network jitter.
final class WebPcmPlayer implements PcmPlayer {
  static const double _lead = 0.05; // seconds

  final Pcm16Joiner _joiner = Pcm16Joiner();
  final Set<web.AudioBufferSourceNode> _playing = {};
  web.AudioContext? _context;
  int _sampleRate = 0;
  double _nextStart = 0;
  Completer<void>? _drained;

  @override
  void unlock() {
    // Created or resumed inside the click handler: browsers block audio
    // that a page starts on its own.
    final context = _context ??= web.AudioContext();
    if (context.state == 'suspended') unawaited(context.resume().toDart);
  }

  @override
  void start(int sampleRate) {
    _stopSources();
    _sampleRate = sampleRate;
    _nextStart = 0;
    _joiner.reset();
  }

  @override
  void feed(Uint8List pcm) {
    final context = _context;
    if (context == null || _sampleRate == 0) return;
    final samples = pcm16ToFloat32(_joiner.add(pcm));
    if (samples.isEmpty) return;
    // The buffer keeps the audio's own sample rate; the browser resamples it
    // to the output device's.
    final buffer = context.createBuffer(1, samples.length, _sampleRate)
      ..copyToChannel(samples.toJS, 0);
    final source = context.createBufferSource()..buffer = buffer;
    source.connect(context.destination);
    final earliest = context.currentTime + _lead;
    if (_nextStart < earliest) _nextStart = earliest;
    source.onended = ((web.Event _) => _ended(source)).toJS;
    source.start(_nextStart);
    _nextStart += buffer.duration;
    _playing.add(source);
  }

  @override
  Future<void> drained() {
    // A context the browser keeps suspended (autoplay blocked) plays
    // nothing, so nothing would ever end.
    if (_playing.isEmpty || _context?.state != 'running') {
      return Future.value();
    }
    return (_drained ??= Completer<void>()).future;
  }

  @override
  Future<void> stop() async {
    _sampleRate = 0;
    _stopSources();
  }

  @override
  Future<void> dispose() async {
    await stop();
    final context = _context;
    _context = null;
    if (context != null) await context.close().toDart;
  }

  void _stopSources() {
    for (final source in _playing.toList()) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    _playing.clear();
    _completeDrained();
  }

  void _ended(web.AudioBufferSourceNode source) {
    source.disconnect();
    _playing.remove(source);
    if (_playing.isEmpty) _completeDrained();
  }

  void _completeDrained() {
    final drained = _drained;
    _drained = null;
    drained?.complete();
  }
}
