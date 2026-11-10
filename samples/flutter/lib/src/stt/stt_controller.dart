/// Speech to Text over the stream: the microphone in, transcripts out.
library;

import 'dart:async';

import 'package:echonova/echonova.dart';
import 'package:flutter/foundation.dart';

import '../audio/microphone.dart';
import '../errors.dart';
import '../speech_service.dart';
import 'pause_detector.dart';

/// What the Speech to Text screen is doing.
enum SttStatus {
  /// Ready.
  idle,

  /// Asking for the microphone and opening the session.
  starting,

  /// Sending the microphone's audio.
  listening,

  /// Waiting for the last transcripts and the session summary.
  stopping,
}

/// The state of the Speech to Text screen.
///
/// [start] opens a session and streams the microphone to it as PCM16 mono at
/// [sampleRate]; transcripts arrive as each segment is cut. [stop] ends the
/// microphone; the session then transcribes the rest and ends with a
/// summary.
final class SttController extends ChangeNotifier {
  /// Creates the controller. [microphone] is disposed with it.
  SttController({required this._speech, required this._microphone});

  /// The rate the microphone records at, and the session expects.
  static const int sampleRate = 16000;

  /// The languages a session can transcribe.
  static const List<String> languages = ['ar', 'en'];

  final SpeechService _speech;
  final Microphone _microphone;

  String _language = languages.first;
  SttStatus _status = SttStatus.idle;
  List<Transcript> _transcripts = const [];
  SessionSummary? _summary;
  String? _error;
  String? _warning;

  SttConnection? _session;
  StreamSubscription<SttEvent>? _events;
  // Counts start() and cancelled starts; work for an older one is dropped.
  int _turn = 0;
  bool _disposed = false;

  /// The language to transcribe.
  String get language => _language;

  /// What the screen is doing.
  SttStatus get status => _status;

  /// The transcripts so far, in order.
  List<Transcript> get transcripts => _transcripts;

  /// The last session's totals.
  SessionSummary? get summary => _summary;

  /// The last error, for the user.
  String? get error => _error;

  /// A problem the session survived, such as one segment failing.
  String? get warning => _warning;

  /// Chooses the language of the next session.
  void selectLanguage(String language) {
    if (_status != SttStatus.idle) return;
    _language = language;
    _changed();
  }

  /// Opens a session and streams the microphone to it until [stop].
  Future<void> start() async {
    if (_disposed || _status != SttStatus.idle) return;
    final turn = ++_turn;
    _status = SttStatus.starting;
    _transcripts = const [];
    _summary = null;
    _error = null;
    _warning = null;
    _changed();
    SttConnection? session;
    try {
      if (!await _microphone.requestPermission()) {
        throw const MicrophoneDeniedException();
      }
      if (turn != _turn) return;
      final opened = await _speech.connectStt(
        sampleRate: sampleRate,
        language: _language,
      );
      if (turn != _turn) {
        await opened.close(); // cancelled while connecting
        return;
      }
      session = _session = opened;
      final eventsDone = Completer<void>();
      _events = opened.events.listen(
        _onEvent,
        // The session ended (or failed) on its own: ending the microphone
        // ends the loop below, and stop() returns the summary (or throws).
        onError: (Object _) => unawaited(_microphone.stop()),
        onDone: () {
          eventsDone.complete();
          unawaited(_microphone.stop());
        },
      );
      final audio = await _microphone.start(sampleRate: sampleRate);
      if (turn != _turn) {
        await _microphone.stop(); // cancelled while starting
        return;
      }
      _status = SttStatus.listening;
      _changed();

      final pauses = PauseDetector(sampleRate: sampleRate);
      await for (final chunk in audio) {
        await opened.sendAudio(chunk);
        // At a pause, transcribe what was said so far.
        if (pauses.add(chunk)) await opened.endSegment();
      }
      // The microphone stopped: transcribe the rest and end the session.
      final summary = await opened.stop();
      // Let the last transcripts through before showing the summary.
      await eventsDone.future.timeout(
        const Duration(seconds: 2),
        onTimeout: () {},
      );
      if (turn != _turn) return;
      _summary = summary;
    } on Object catch (error) {
      if (turn != _turn) return;
      final summary = _summary = session?.summary;
      // A session the server ended itself (at its time limit, say) has a
      // summary: that is not an error.
      if (error is! SessionEndedException || summary == null) {
        _error = describeError(error);
      }
    } finally {
      if (turn == _turn) await _finish();
    }
  }

  /// Stops listening. The session transcribes the audio it has, then ends
  /// with a summary. While starting, it cancels the start instead.
  Future<void> stop() async {
    switch (_status) {
      case SttStatus.listening:
        _status = SttStatus.stopping;
        _changed();
        await _microphone.stop(); // ends the audio stream; start() goes on
      case SttStatus.starting:
        _turn++;
        await _finish();
      case SttStatus.idle || SttStatus.stopping:
        break;
    }
  }

  void _onEvent(SttEvent event) {
    switch (event) {
      case Transcript(:final text) when text.trim().isNotEmpty:
        _transcripts = [..._transcripts, event];
      case StreamErrorEvent(:final message):
        _warning = 'A segment could not be transcribed: $message';
      case Transcript() ||
          TerminologySet() ||
          SessionEnded() ||
          SessionSaved() ||
          UnknownEvent():
        return;
    }
    _changed();
  }

  /// Releases the microphone and the session.
  Future<void> _finish() async {
    final session = _session;
    final events = _events;
    _session = null;
    _events = null;
    _status = SttStatus.idle;
    _changed();
    await _microphone.stop();
    await events?.cancel();
    await session?.close(); // already ended after stop(); else drops it
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _turn++;
    unawaited(_events?.cancel());
    unawaited(_session?.close());
    unawaited(_microphone.dispose());
    super.dispose();
  }
}

/// The user didn't allow the microphone.
final class MicrophoneDeniedException implements Exception {
  /// Creates the exception.
  const MicrophoneDeniedException();

  @override
  String toString() => 'Allow the microphone to transcribe speech.';
}
