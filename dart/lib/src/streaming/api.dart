/// Entry points for the streaming layer. The client wires these into its
/// resources (`textToSpeech.connect` / `speak`, `speechToText.connect` /
/// `transcribeStream`).
library;

import '../audio.dart';
import '../errors.dart';
import 'options.dart';
import 'stt_session.dart';
import 'tts_protocol.dart';
import 'tts_session.dart';

export 'transcribe.dart' show transcribeStream;

/// Opens a Text to Speech stream for [voiceId]. The options given here apply
/// to every synthesis on it unless a synthesis overrides them.
///
/// Completes once the socket is open. Throws the handshake's exception when
/// EchoNova (or your proxy) rejects it: for example
/// [AuthenticationException], [InsufficientBalanceException] or
/// [ConcurrencyLimitException] (retried for up to [waitForSlot] when set).
Future<TtsSession> connectTts(
  StreamOptions options, {
  required String voiceId,
  double? speed,
  double? cfg,
  int? numSteps,
  bool? tashkeel,
  bool? normalize,
  Duration? waitForSlot,
}) =>
    openTtsSession(
      options,
      voiceId: voiceId,
      defaults: SynthesisOptions(
        speed: speed,
        cfg: cfg,
        numSteps: numSteps,
        tashkeel: tashkeel,
        normalize: normalize,
      ),
      waitForSlot: waitForSlot,
    );

/// Synthesizes [text] over a stream of its own and returns all the audio.
/// For low-latency playback, use [connectTts] and listen to
/// `Synthesis.audio` instead.
Future<Audio> speak(
  StreamOptions options,
  String text, {
  required String voiceId,
  double? speed,
  double? cfg,
  int? numSteps,
  bool? tashkeel,
  bool? normalize,
  Map<String, Object?>? extraBody,
  Duration? waitForSlot,
}) async {
  final tts = await connectTts(
    options,
    voiceId: voiceId,
    waitForSlot: waitForSlot,
  );
  try {
    final synthesis = tts.synthesize(
      text,
      speed: speed,
      cfg: cfg,
      numSteps: numSteps,
      tashkeel: tashkeel,
      normalize: normalize,
      extraBody: extraBody,
    );
    final audio = await synthesis.collect();
    await synthesis.result;
    return audio;
  } finally {
    await tts.close();
  }
}

/// Opens a Speech to Text stream for audio at [sampleRate] Hz (required: a
/// wrong rate gives wrong transcripts without any error) in [language] (`ar`
/// or `en`).
///
/// Completes once the server has started the session (and confirmed
/// [terminology], when given). Throws the handshake's exception when it is
/// rejected, [UpstreamException] when the speech service is unreachable, and
/// [InvalidRequestException] when [terminology] is rejected.
Future<SttSession> connectStt(
  StreamOptions options, {
  required int sampleRate,
  required String language,
  Map<String, Object?>? terminology,
  String encoding = 'pcm_s16le',
  Duration? waitForSlot,
}) =>
    openSttSession(
      options,
      sampleRate: sampleRate,
      language: language,
      terminology: terminology,
      encoding: encoding,
      waitForSlot: waitForSlot,
    );
