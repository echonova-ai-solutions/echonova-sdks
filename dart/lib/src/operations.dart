/// Every REST operation the SDK calls, with its default timeout.
///
/// [Operation.name] is the SDK method (as in `spec/mapping.json`). It also
/// names the operation's rate-limit bucket: the API counts requests per key
/// per endpoint.
library;

import 'errors.dart';
import 'transport/http_transport.dart' show TimeoutProfile;

/// One REST endpoint.
final class Operation {
  /// Creates an operation.
  const Operation(
    this.name,
    this.method,
    this.path, {
    this.profile = TimeoutProfile.standard,
    this.envelope = true,
    this.secretResponse = false,
    this.acceptsIdempotencyKey = false,
  });

  /// The SDK method, such as `textToSpeech.jobs.get`.
  final String name;

  /// The HTTP method.
  final String method;

  /// The path template, such as `/v1/text-to-speech/jobs/{jobId}`.
  final String path;

  /// The default per-attempt deadline.
  final TimeoutProfile profile;

  /// `false` when a 2xx body is the raw file (transcript export).
  final bool envelope;

  /// The 2xx body carries a secret (a room token or a widget ticket): it is
  /// never copied into an exception.
  final bool secretResponse;

  /// The operation accepts an `Idempotency-Key` (`"idempotency_key": true`
  /// in `spec/mapping.json`): every call sends one, retries use the
  /// `POST_IDEMPOTENT` column, and a `202 Processing` answer is waited out
  /// by polling the job (ADR 0014).
  final bool acceptsIdempotencyKey;

  /// [path] with each `{name}` replaced by its percent-encoded value.
  /// Throws [UsageException] for an empty value.
  String expand([Map<String, String> params = const {}]) {
    var result = path;
    for (final MapEntry(:key, :value) in params.entries) {
      final trimmed = value.trim();
      if (trimmed.isEmpty) {
        throw UsageException('$key must not be empty');
      }
      result = result.replaceAll('{$key}', Uri.encodeComponent(trimmed));
    }
    return result;
  }

  @override
  String toString() => '$name ($method $path)';
}

/// `textToSpeech.generate`.
const ttsGenerate = Operation(
  'textToSpeech.generate',
  'POST',
  '/v1/text-to-speech/sync',
  profile: TimeoutProfile.textToSpeechSync,
  acceptsIdempotencyKey: true,
);

/// `textToSpeech.jobs.create`.
const ttsJobsCreate =
    Operation('textToSpeech.jobs.create', 'POST', '/v1/text-to-speech');

/// `textToSpeech.voices.list`.
const ttsVoicesList =
    Operation('textToSpeech.voices.list', 'GET', '/v1/text-to-speech/voices');

/// `textToSpeech.jobs.list`.
const ttsJobsList =
    Operation('textToSpeech.jobs.list', 'GET', '/v1/text-to-speech/jobs');

/// `textToSpeech.jobs.get`.
const ttsJobsGet = Operation(
    'textToSpeech.jobs.get', 'GET', '/v1/text-to-speech/jobs/{jobId}');

/// `textToSpeech.jobs.delete`.
const ttsJobsDelete = Operation(
    'textToSpeech.jobs.delete', 'DELETE', '/v1/text-to-speech/jobs/{jobId}');

/// `speechToText.transcribe`.
const sttTranscribe = Operation(
  'speechToText.transcribe',
  'POST',
  '/v1/speech-to-text/sync',
  profile: TimeoutProfile.longRunning,
  acceptsIdempotencyKey: true,
);

/// `speechToText.jobs.create`.
const sttJobsCreate = Operation(
  'speechToText.jobs.create',
  'POST',
  '/v1/speech-to-text',
  profile: TimeoutProfile.upload,
);

/// `speechToText.jobs.list`.
const sttJobsList =
    Operation('speechToText.jobs.list', 'GET', '/v1/speech-to-text/jobs');

/// `speechToText.jobs.get`.
const sttJobsGet = Operation(
    'speechToText.jobs.get', 'GET', '/v1/speech-to-text/jobs/{jobId}');

/// `speechToText.jobs.delete`.
const sttJobsDelete = Operation(
    'speechToText.jobs.delete', 'DELETE', '/v1/speech-to-text/jobs/{jobId}');

/// `speechToText.jobs.export`.
const sttJobsExport = Operation(
  'speechToText.jobs.export',
  'GET',
  '/v1/speech-to-text/jobs/{jobId}/export',
  profile: TimeoutProfile.export,
  envelope: false,
);

/// `soundCleaning.clean`.
const cleanClean = Operation(
  'soundCleaning.clean',
  'POST',
  '/v1/sound-cleaning',
  profile: TimeoutProfile.longRunning,
  acceptsIdempotencyKey: true,
);

/// `soundCleaning.jobs.list`.
const cleanJobsList =
    Operation('soundCleaning.jobs.list', 'GET', '/v1/sound-cleaning/jobs');

/// `soundCleaning.jobs.get`.
const cleanJobsGet = Operation(
    'soundCleaning.jobs.get', 'GET', '/v1/sound-cleaning/jobs/{jobId}');

/// `soundCleaning.jobs.delete`.
const cleanJobsDelete = Operation(
    'soundCleaning.jobs.delete', 'DELETE', '/v1/sound-cleaning/jobs/{jobId}');

/// `widgets.createTicket`.
const widgetsCreateTicket = Operation(
  'widgets.createTicket',
  'POST',
  '/v1/widgets/{publicId}/tickets',
  secretResponse: true,
);

/// `agents.sessions.start`. A POST, so it is never sent again once it may
/// have reached the server: a retried start opens a second session.
const agentSessionsStart = Operation(
  'agents.sessions.start',
  'POST',
  '/v1/agents/{agentId}/sessions',
  secretResponse: true,
);

/// `agents.sessions.get`.
const agentSessionsGet = Operation(
    'agents.sessions.get', 'GET', '/v1/agents/{agentId}/sessions/{sessionId}');

/// `agents.sessions.end`.
const agentSessionsEnd = Operation('agents.sessions.end', 'POST',
    '/v1/agents/{agentId}/sessions/{sessionId}/end');

/// Every operation, in the order of the API reference.
const List<Operation> allOperations = [
  ttsJobsCreate,
  ttsGenerate,
  ttsVoicesList,
  ttsJobsList,
  ttsJobsGet,
  ttsJobsDelete,
  sttJobsCreate,
  sttTranscribe,
  sttJobsList,
  sttJobsGet,
  sttJobsDelete,
  sttJobsExport,
  cleanClean,
  cleanJobsList,
  cleanJobsGet,
  cleanJobsDelete,
  widgetsCreateTicket,
  agentSessionsStart,
  agentSessionsGet,
  agentSessionsEnd,
];
