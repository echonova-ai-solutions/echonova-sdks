/// The public API of the streaming layer: the Text to Speech and Speech to
/// Text WebSocket sessions, their events and results, and the audio
/// helpers.
///
/// `lib/echonova.dart` exports this. The factories (`connectTts`,
/// `connectStt`, `speak`, `transcribeStream`) take a `StreamOptions` the
/// client builds from its own configuration; apps reach them through
/// `client.textToSpeech` and `client.speechToText`.
library;

export '../audio.dart'
    show
        Audio,
        parseWav,
        pcmDuration,
        pcmFrames,
        pcmToWav,
        unknownWavSize,
        wavHeader,
        wavStream;
export 'api.dart' show connectStt, connectTts, speak, transcribeStream;
export 'options.dart'
    show
        ReconnectPolicy,
        StreamClock,
        StreamOptions,
        StreamParameters,
        defaultWsBaseUri,
        sttStreamPath,
        ttsStreamPath;
export 'stream_errors.dart' show chargeStateOf, creditsConsumedOf;
export 'stt_protocol.dart' show SttState;
export 'stt_session.dart' show SttSession;
export 'tts_session.dart' show Synthesis, TtsSession;
export 'types.dart';
