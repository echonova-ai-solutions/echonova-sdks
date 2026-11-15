/// Official Dart and Flutter SDK for the EchoNova speech API: Text to
/// Speech, Speech to Text and Sound Cleaning, plus website widget tickets
/// and agent sessions.
///
/// * Server-side Dart: `EchoNova(apiKey: ...)`.
/// * Flutter apps: `EchoNova.proxy(baseUrl: ..., auth: ...)`, through your
///   own backend, so the API key never ships in the app.
/// * Webhooks: `verifyWebhook`.
///
/// Every error is an `EchoNovaException`; `switch` over it to handle each
/// kind.
library;

export 'src/client.dart' show EchoNova, defaultBaseUrl;
export 'src/core/rate_limit.dart' show RateLimitInfo;
export 'src/errors.dart';
export 'src/files.dart' show AudioFile, audioExtensionTypes;
export 'src/models/agents.dart';
export 'src/models/base.dart' show ApiObject, ApiResult;
export 'src/models/enums.dart';
export 'src/models/sound_cleaning.dart';
export 'src/models/speech_to_text.dart';
export 'src/models/text_to_speech.dart';
export 'src/pagination.dart' show Page;
export 'src/params.dart';
export 'src/resources/agents.dart' show AgentSessions, Agents, Widgets;
export 'src/resources/sound_cleaning.dart' show CleanJobs, SoundCleaning;
export 'src/resources/speech_to_text.dart' show SpeechToText, SttJobs;
export 'src/resources/text_to_speech.dart' show TextToSpeech, TtsJobs, Voices;
export 'src/response.dart' show RawResponse, RequestOptions;
export 'src/streaming/streaming.dart'
    hide connectStt, connectTts, speak, transcribeStream, StreamOptions;
export 'src/version.dart' show packageVersion;
export 'src/webhooks.dart';
