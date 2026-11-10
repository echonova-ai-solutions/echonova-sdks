// Fakes for the SDK surface (SpeechService), the player and the microphone.
// Nothing here touches the network or an audio device.

import 'dart:async';
import 'dart:typed_data';

import 'package:echonova/echonova.dart';
import 'package:echonova_sample/src/audio/microphone.dart';
import 'package:echonova_sample/src/audio/pcm_player.dart';
import 'package:echonova_sample/src/speech_service.dart';

final List<Voice> testVoices = [
  Voice.fromJson({
    'id': 'voice_sara',
    'name': 'ar_sara',
    'displayName': 'Sara',
    'language': 'ar',
    'gender': 'Female',
  }),
  Voice.fromJson({
    'id': 'voice_adam',
    'name': 'en_adam',
    'displayName': 'Adam',
    'language': 'en',
    'gender': 'Male',
  }),
];

class FakeSpeechService implements SpeechService {
  List<Voice> voices = testVoices;
  Object? voicesError;
  Object? connectError;

  /// While set, connections wait for it.
  Completer<void>? connectGate;

  final List<FakeTtsConnection> ttsConnections = [];
  final List<FakeSttConnection> sttConnections = [];
  final List<({int sampleRate, String language})> sttRequests = [];
  bool closed = false;

  FakeTtsConnection get tts => ttsConnections.last;
  FakeSttConnection get stt => sttConnections.last;

  @override
  Future<List<Voice>> listVoices() async {
    if (voicesError case final error?) throw error;
    return voices;
  }

  @override
  Future<TtsConnection> connectTts({required String voiceId}) async {
    await connectGate?.future;
    if (connectError case final error?) throw error;
    final connection = FakeTtsConnection(voiceId);
    ttsConnections.add(connection);
    return connection;
  }

  @override
  Future<SttConnection> connectStt({
    required int sampleRate,
    required String language,
  }) async {
    sttRequests.add((sampleRate: sampleRate, language: language));
    await connectGate?.future;
    if (connectError case final error?) throw error;
    final connection = FakeSttConnection();
    sttConnections.add(connection);
    return connection;
  }

  @override
  void close() => closed = true;
}

class FakeTtsConnection implements TtsConnection {
  FakeTtsConnection(this.voiceId);

  final String voiceId;
  final List<FakeSynthesis> syntheses = [];
  bool closed = false;

  @override
  EchoNovaException? failure;

  FakeSynthesis get last => syntheses.last;

  @override
  SynthesisHandle synthesize(String text, {String? voiceId}) {
    final synthesis = FakeSynthesis(text, voiceId ?? this.voiceId);
    syntheses.add(synthesis);
    return synthesis;
  }

  @override
  Future<void> close() async => closed = true;
}

class FakeSynthesis implements SynthesisHandle {
  FakeSynthesis(this.text, this.voiceId) {
    _audio = StreamController<Uint8List>(
      onCancel: () {
        cancelled = true;
        _end(SynthesisOutcome.cancelled, credits: 1);
      },
    );
    // Like the SDK's: an error here is reported through audio too.
    result = _result.future..ignore();
  }

  final String text;
  final String voiceId;
  late final StreamController<Uint8List> _audio;
  final Completer<SynthesisResult> _result = Completer();
  bool cancelled = false;

  @override
  int? sampleRate;

  @override
  Stream<Uint8List> get audio => _audio.stream;

  @override
  Duration? get ttfb => const Duration(milliseconds: 120);

  @override
  late final Future<SynthesisResult> result;

  /// Sends audio, after a `start` at [rate].
  void emit(List<int> pcm, {int rate = 24000}) {
    sampleRate = rate;
    _audio.add(Uint8List.fromList(pcm));
  }

  void finish({double credits = 5}) {
    unawaited(_audio.close());
    _end(SynthesisOutcome.completed, credits: credits, seconds: 1.5);
  }

  void fail(EchoNovaException error) {
    _audio.addError(error);
    unawaited(_audio.close());
    if (!_result.isCompleted) _result.completeError(error);
  }

  void _end(SynthesisOutcome outcome, {double? credits, double? seconds}) {
    if (_result.isCompleted) return;
    _result.complete(
      SynthesisResult(
        requestId: 'req_$text',
        outcome: outcome,
        charged: true,
        creditsConsumed: credits,
        durationSeconds: seconds,
        sampleRate: sampleRate,
      ),
    );
  }
}

class FakeSttConnection implements SttConnection {
  final StreamController<SttEvent> _events = StreamController();
  final BytesBuilder sent = BytesBuilder();
  int segmentsEnded = 0;
  int transcriptsSent = 0;
  bool stopped = false;
  bool closed = false;
  Object? stopError;

  SessionSummary stopSummary = const SessionSummary(
    reason: 'stopped',
    totalSeconds: 2.5,
    creditsConsumed: 1.25,
    sessionId: 'sess_1',
    jobId: 'job_1',
    savedStatus: SessionSaveStatus.saved,
  );

  @override
  SessionSummary? summary;

  @override
  String? get sessionId => 'sess_1';

  @override
  Stream<SttEvent> get events => _events.stream;

  void transcript(String text) => _events.add(
    Transcript(
      segmentId: 'seg_$transcriptsSent',
      text: text,
      durationSeconds: 1.2,
      creditsConsumed: 0.5,
      index: transcriptsSent++,
    ),
  );

  void segmentError(String message) => _events.add(
    StreamErrorEvent(
      code: 'upstream_error',
      message: message,
      error: UpstreamException(errorMessage: message),
    ),
  );

  /// The session fails: the events end with [error], and stop() throws it.
  void fail(EchoNovaException error) {
    stopError = error;
    _events.addError(error);
    unawaited(_events.close());
  }

  @override
  Future<void> sendAudio(List<int> audio) async {
    if (closed || stopped) throw SessionEndedException('the session ended');
    sent.add(audio);
  }

  @override
  Future<SegmentMark> endSegment() async {
    segmentsEnded++;
    return SegmentMark(
      index: segmentsEnded - 1,
      audioOffset: Duration.zero,
      duration: Duration.zero,
      expectResult: true,
    );
  }

  @override
  Future<SessionSummary> stop() async {
    stopped = true;
    if (stopError case final error?) throw error;
    summary = stopSummary;
    if (!_events.isClosed) {
      _events.add(
        SessionEnded(
          reason: stopSummary.reason,
          totalSeconds: stopSummary.totalSeconds,
          creditsConsumed: stopSummary.creditsConsumed,
        ),
      );
      unawaited(_events.close());
    }
    return stopSummary;
  }

  @override
  Future<void> close() async {
    closed = true;
    if (!_events.isClosed) unawaited(_events.close());
  }
}

class FakeMicrophone implements Microphone {
  bool allow = true;
  int? sampleRate;
  int stops = 0;
  bool disposed = false;
  StreamController<Uint8List>? _stream;

  bool get recording => _stream != null;

  @override
  Future<bool> requestPermission() async => allow;

  @override
  Future<Stream<Uint8List>> start({required int sampleRate}) async {
    this.sampleRate = sampleRate;
    final stream = _stream = StreamController<Uint8List>();
    return stream.stream;
  }

  void emit(List<int> pcm) => _stream!.add(Uint8List.fromList(pcm));

  @override
  Future<void> stop() async {
    stops++;
    final stream = _stream;
    _stream = null;
    if (stream != null) unawaited(stream.close());
  }

  @override
  Future<void> dispose() async {
    disposed = true;
    await stop();
  }
}

class FakePcmPlayer implements PcmPlayer {
  final List<String> log = [];
  int fedBytes = 0;

  /// When set, drained() waits for [finishPlaying] or [stop].
  bool holdDrain = false;
  Completer<void>? _playing;

  @override
  void unlock() => log.add('unlock');

  @override
  void start(int sampleRate) => log.add('start $sampleRate');

  @override
  void feed(Uint8List pcm) {
    fedBytes += pcm.length;
    log.add('feed ${pcm.length}');
  }

  @override
  Future<void> drained() =>
      holdDrain ? (_playing ??= Completer()).future : Future.value();

  void finishPlaying() {
    _playing?.complete();
    _playing = null;
  }

  @override
  Future<void> stop() async {
    log.add('stop');
    finishPlaying();
  }

  @override
  Future<void> dispose() async => log.add('dispose');
}

/// PCM16LE: [samples] copies of [value].
List<int> pcm(int samples, {int value = 0}) {
  final data = ByteData(samples * 2);
  for (var i = 0; i < samples; i++) {
    data.setInt16(i * 2, value, Endian.little);
  }
  return data.buffer.asUint8List();
}
