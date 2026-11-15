/// Text to Speech over the stream: pick a voice, speak, stop.
library;

import 'dart:async';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:flutter/foundation.dart';

import '../audio/pcm_player.dart';
import '../errors.dart';
import '../speech_service.dart';

/// What the Text to Speech screen is doing.
enum TtsStatus {
  /// Ready.
  idle,

  /// Waiting for the stream or the first audio.
  connecting,

  /// Audio is playing.
  speaking,
}

/// How the last synthesis ended.
final class SpeechReport {
  /// Creates a report.
  const SpeechReport({required this.result, this.ttfb});

  /// The SDK's result: outcome and cost.
  final SynthesisResult result;

  /// From sending the text to the first audio.
  final Duration? ttfb;
}

/// The state of the Text to Speech screen.
///
/// One stream is opened on the first [speak] and reused for every later one,
/// so only the first pays for the connection. Each [speak] replaces what is
/// playing; [stop] cancels it. Audio plays as it arrives.
final class TtsController extends ChangeNotifier {
  /// Creates the controller. [player] is disposed with it.
  TtsController({required this._speech, required this._player});

  /// The most characters one synthesis takes.
  static const int maxTextLength = 500;

  final SpeechService _speech;
  final PcmPlayer _player;

  List<Voice> _voices = const [];
  bool _loadingVoices = false;
  String? _voiceId;
  TtsStatus _status = TtsStatus.idle;
  String? _error;
  SpeechReport? _report;

  Future<TtsConnection>? _connection;
  SynthesisHandle? _synthesis;
  StreamSubscription<Uint8List>? _audio;
  Completer<void>? _audioDone;
  // Counts speak() and stop() calls; work for an older one is dropped.
  int _turn = 0;
  bool _disposed = false;

  /// The voices to choose from.
  List<Voice> get voices => _voices;

  /// Whether the voices are loading.
  bool get loadingVoices => _loadingVoices;

  /// The chosen voice.
  String? get voiceId => _voiceId;

  /// What the screen is doing.
  TtsStatus get status => _status;

  /// The last error, for the user.
  String? get error => _error;

  /// How the last synthesis ended.
  SpeechReport? get report => _report;

  /// Loads the voices and picks the first one, unless one is chosen already.
  Future<void> loadVoices() async {
    if (_loadingVoices) return;
    _loadingVoices = true;
    _error = null;
    _changed();
    try {
      final voices = await _speech.listVoices();
      _voices = voices;
      if (!voices.any((voice) => voice.id == _voiceId)) {
        _voiceId = voices.isEmpty ? null : voices.first.id;
      }
    } on Object catch (error) {
      _error = describeError(error);
    } finally {
      _loadingVoices = false;
      _changed();
    }
  }

  /// Chooses the voice for the next [speak].
  void selectVoice(String voiceId) {
    _voiceId = voiceId;
    _changed();
  }

  /// Speaks [text] with the chosen voice, replacing whatever is playing
  /// (barge-in).
  ///
  /// Call it straight from the button handler: it unlocks audio playback
  /// before its first `await`, as browsers require.
  Future<void> speak(String text) async {
    final voiceId = _voiceId;
    final words = text.trim();
    if (_disposed || voiceId == null || words.isEmpty) return;
    if (words.runes.length > maxTextLength) {
      _error = 'One synthesis takes at most $maxTextLength characters.';
      _changed();
      return;
    }
    _player.unlock();
    final turn = _interrupt();
    unawaited(_player.stop());
    _status = TtsStatus.connecting;
    _error = null;
    _report = null;
    _changed();
    try {
      final tts = await _openConnection(voiceId);
      if (turn != _turn) return;
      final synthesis = _synthesis = tts.synthesize(words, voiceId: voiceId);
      await _play(synthesis, turn);
      if (turn != _turn) return;
      final result = await synthesis.result;
      if (turn != _turn) return;
      _report = SpeechReport(result: result, ttfb: synthesis.ttfb);
    } on Object catch (error) {
      if (turn != _turn) return;
      unawaited(_player.stop());
      _error = describeError(error);
    }
    _synthesis = null;
    _status = TtsStatus.idle;
    _changed();
  }

  /// Stops speaking at once: cancels the synthesis and drops the audio not
  /// played yet. The report then shows what the cancelled synthesis cost.
  Future<void> stop() async {
    final synthesis = _synthesis;
    final turn = _interrupt();
    await _player.stop();
    _status = TtsStatus.idle;
    _changed();
    if (synthesis == null) return;
    try {
      final result = await synthesis.result;
      if (turn != _turn) return;
      _report = SpeechReport(result: result, ttfb: synthesis.ttfb);
      _changed();
    } on Object {
      // It failed before the cancel took effect: nothing more to show.
    }
  }

  /// Plays the synthesis's audio as it arrives, until it has all played.
  Future<void> _play(SynthesisHandle synthesis, int turn) async {
    final done = _audioDone = Completer<void>();
    var started = false;
    late final StreamSubscription<Uint8List> audio;
    audio = _audio = synthesis.audio.listen(
      (pcm) {
        if (!started) {
          final sampleRate = synthesis.sampleRate;
          if (sampleRate == null) {
            unawaited(audio.cancel());
            done.completeError(StateError('The audio has no sample rate.'));
            return;
          }
          started = true;
          _player.start(sampleRate);
          _status = TtsStatus.speaking;
          _changed();
        }
        _player.feed(pcm);
      },
      onError: (Object error, StackTrace stack) {
        if (!done.isCompleted) done.completeError(error, stack);
      },
      onDone: () {
        if (!done.isCompleted) done.complete();
      },
      cancelOnError: true,
    );
    await done.future;
    if (turn != _turn) return;
    _audio = null;
    await _player.drained();
    if (turn != _turn) return;
    await _player.stop(); // releases the audio device until the next one
  }

  /// Opens the stream, or reuses the open one.
  Future<TtsConnection> _openConnection(String voiceId) async {
    final open = _connection;
    if (open != null) {
      final tts = await open;
      if (tts.failure == null) return tts;
      // The stream ended for good (for example out of credits): open anew.
      if (identical(_connection, open)) _connection = null;
      unawaited(tts.close());
    }
    final pending = _connection ??= _speech.connectTts(voiceId: voiceId);
    try {
      return await pending;
    } on Object {
      if (identical(_connection, pending)) _connection = null;
      rethrow;
    }
  }

  /// Ends the current speak() call: cancelling the audio subscription
  /// cancels its synthesis. Returns the new turn.
  int _interrupt() {
    final audio = _audio;
    _audio = null;
    if (audio != null) unawaited(audio.cancel());
    final done = _audioDone;
    _audioDone = null;
    if (done != null && !done.isCompleted) done.complete();
    _synthesis = null;
    return ++_turn;
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _interrupt();
    unawaited(_player.dispose());
    final connection = _connection;
    _connection = null;
    if (connection != null) {
      unawaited(connection.then((tts) => tts.close(), onError: (_) {}));
    }
    super.dispose();
  }
}
