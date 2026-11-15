/// The part of the EchoNova SDK this app uses.
///
/// The controllers talk to these small interfaces, so tests can replace the
/// SDK with fakes. [EchoNovaSpeechService] implements them by calling the
/// SDK directly: read it to see every SDK call the app makes.
library;

import 'dart:typed_data';

import 'package:echonova_ai/echonova_ai.dart';

/// Voices, and the Text to Speech and Speech to Text streams.
abstract interface class SpeechService {
  /// Every voice you can use. The list changes rarely.
  Future<List<Voice>> listVoices();

  /// Opens a Text to Speech stream. [voiceId] is its default voice.
  Future<TtsConnection> connectTts({required String voiceId});

  /// Opens a Speech to Text session for PCM16LE mono audio at [sampleRate].
  Future<SttConnection> connectStt({
    required int sampleRate,
    required String language,
  });

  /// Closes the HTTP connections.
  void close();
}

/// An open Text to Speech stream: many syntheses, one at a time.
abstract interface class TtsConnection {
  /// The error that ended the stream for good, if one did.
  EchoNovaException? get failure;

  /// Speaks [text] now, replacing whatever is running.
  SynthesisHandle synthesize(String text, {String? voiceId});

  /// Closes the stream.
  Future<void> close();
}

/// One synthesis.
abstract interface class SynthesisHandle {
  /// PCM16LE mono chunks at [sampleRate]. Cancelling the subscription
  /// cancels the synthesis.
  Stream<Uint8List> get audio;

  /// The audio's sample rate, known before the first chunk.
  int? get sampleRate;

  /// From sending the request to the first audio.
  Duration? get ttfb;

  /// How it ended, and what it cost.
  Future<SynthesisResult> get result;
}

/// One Speech to Text session.
abstract interface class SttConnection {
  /// The session's ID.
  String? get sessionId;

  /// Transcripts and the other session events.
  Stream<SttEvent> get events;

  /// Totals, once the session has ended.
  SessionSummary? get summary;

  /// Sends PCM16LE mono audio.
  Future<void> sendAudio(List<int> audio);

  /// Transcribes the audio sent since the last cut now.
  Future<SegmentMark> endSegment();

  /// Transcribes what is left, then ends the session.
  Future<SessionSummary> stop();

  /// Ends the session at once, discarding audio not yet transcribed.
  Future<void> close();
}

/// [SpeechService] on the EchoNova SDK.
final class EchoNovaSpeechService implements SpeechService {
  /// Uses [client], and closes it in [close].
  EchoNovaSpeechService(this.client);

  /// The SDK client, in proxy mode.
  final EchoNova client;

  @override
  Future<List<Voice>> listVoices() async =>
      (await client.textToSpeech.voices.list()).toList();

  @override
  Future<TtsConnection> connectTts({required String voiceId}) async =>
      _Tts(await client.textToSpeech.connect(voiceId: voiceId));

  @override
  Future<SttConnection> connectStt({
    required int sampleRate,
    required String language,
  }) async => _Stt(
    await client.speechToText.connect(
      sampleRate: sampleRate,
      language: language,
    ),
  );

  @override
  void close() => client.close();
}

final class _Tts implements TtsConnection {
  _Tts(this._session);

  final TtsSession _session;

  @override
  EchoNovaException? get failure => _session.failure;

  @override
  SynthesisHandle synthesize(String text, {String? voiceId}) =>
      _Synthesis(_session.synthesize(text, voiceId: voiceId));

  @override
  Future<void> close() => _session.close();
}

final class _Synthesis implements SynthesisHandle {
  _Synthesis(this._synthesis);

  final Synthesis _synthesis;

  @override
  Stream<Uint8List> get audio => _synthesis.audio;

  @override
  int? get sampleRate => _synthesis.sampleRate;

  @override
  Duration? get ttfb => _synthesis.ttfb;

  @override
  Future<SynthesisResult> get result => _synthesis.result;
}

final class _Stt implements SttConnection {
  _Stt(this._session);

  final SttSession _session;

  @override
  String? get sessionId => _session.sessionId;

  @override
  Stream<SttEvent> get events => _session.events;

  @override
  SessionSummary? get summary => _session.summary;

  @override
  Future<void> sendAudio(List<int> audio) => _session.sendAudio(audio);

  @override
  Future<SegmentMark> endSegment() => _session.endSegment();

  @override
  Future<SessionSummary> stop() => _session.stop();

  @override
  Future<void> close() => _session.close();
}
