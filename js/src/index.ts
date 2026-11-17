/**
 * Official JavaScript and TypeScript SDK for the EchoNova speech API: Text to
 * Speech, Speech to Text, Sound Cleaning, agent sessions and webhooks.
 *
 * @module @echonova/ai
 */

export { EchoNova, EchoNova as default, DEFAULT_BASE_URL } from './client.js';
export type {
  AuthContext,
  AuthHook,
  ClientOptions,
  FetchLike,
  OnRequestHook,
  OnResponseHook,
  RequestDetails,
  StreamClientOptions,
} from './client.js';
export type { HeaderValues } from './core/http.js';
export type { HeadersLike } from './core/envelope.js';
export type { Logger, LogLevel } from './core/logger.js';
export type { RateLimitInfo } from './core/ratelimit.js';
export type { RetryPolicy } from './core/retry.js';

export { APIPromise } from './core/api-promise.js';
export type { WithResponse } from './core/api-promise.js';
export { Page, PagePromise } from './core/pagination.js';
export { toFile } from './core/files.js';
export type { FileContent, FileUpload, Uploadable } from './core/files.js';
export type { DownloadOptions } from './core/download.js';
export type { WaitOptions } from './core/polling.js';
export type { JobRef } from './resources/resource.js';
export type { TextToSpeech, TtsJobs, Voices } from './resources/text-to-speech.js';
export type { SpeechToText, SttJobs } from './resources/speech-to-text.js';
export type { SoundCleaning, CleanJobs } from './resources/sound-cleaning.js';
export type { Widgets } from './resources/widgets.js';
export type { Agents, AgentSessions } from './resources/agents.js';

export type {
  AgentChannel,
  AgentSession,
  AgentSessionStatus,
  APIResult,
  CleanJob,
  CleanJobOptions,
  CleanMetrics,
  DeleteResult,
  JobInitiated,
  JobStatus,
  Language,
  StartedAgentSession,
  SttJob,
  SttJobStream,
  SttResult,
  SttSegment,
  SttSpeaker,
  TerminologyEdit,
  TerminologyNearMiss,
  TerminologyResult,
  TerminologyWarning,
  TranscriptExport,
  TranscriptExportSegment,
  TranscriptExportSpeaker,
  TtsJob,
  TtsJobStream,
  TtsResult,
  Voice,
  VoiceList,
  WidgetTicket,
} from './types/models.js';
export type {
  CleanParams,
  CreateTicketParams,
  ExportFormat,
  ExportParams,
  Keyword,
  ListParams,
  RequestOptions,
  SpeechParams,
  StartSessionParams,
  SyncRequestOptions,
  Terminology,
  TranscribeParams,
  WidgetUser,
} from './types/params.js';

export {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AuthenticationError,
  BillingError,
  ConcurrencyLimitError,
  DownloadExpiredError,
  EchoNovaError,
  FeatureNotEnabledError,
  GatewayError,
  InsufficientBalanceError,
  InvalidRequestError,
  JobFailedError,
  JobNotFoundError,
  JobWaitTimeoutError,
  NotFoundError,
  PermissionDeniedError,
  ProtocolError,
  RateLimitError,
  RequestInProgressError,
  RequestTimeoutError,
  ServerError,
  ServerRestartingError,
  ServiceUnavailableError,
  SessionEndedError,
  SessionExpiredError,
  SpendingLimitError,
  StreamClosedError,
  StreamConnectionLostError,
  UnsupportedEnvironmentError,
  UpstreamError,
  UsageError,
  VoiceNotFoundError,
  WebhookVerificationError,
} from './errors.js';
export type {
  APIConnectionErrorInit,
  APIStatusErrorInit,
  APITimeoutErrorInit,
  StreamClosedErrorInit,
  TimeoutKind,
  Transport,
  WebhookFailure,
} from './errors.js';

export { DEFAULT_TOLERANCE_SECONDS, verifyWebhook } from './webhooks.js';
export type {
  JobCompleted,
  JobFailed,
  SpendingExhausted,
  SpendingWarning,
  UnknownEvent,
  VerifyWebhookOptions,
  WebhookEvent,
  WebhookPayload,
} from './webhooks.js';

export { VERSION } from './version.js';

// Streaming types. The streaming code itself loads lazily (client.textToSpeech.connect() and friends);
// its helpers (Audio, pcmToWav, connectTts, ...) are importable from '@echonova/ai/streaming'.
export type {
  Audio,
  AudioDropped,
  AudioSource,
  ChargeState,
  ConnectSttOptions,
  ConnectTtsOptions,
  Reconnected,
  ReconnectPolicy,
  SegmentMark,
  SessionEnded,
  SessionSaved,
  SessionSavedStatus,
  SessionSummary,
  SpeakOptions,
  StreamErrorEvent,
  StreamTerminology,
  SttEvent,
  SttSession,
  Synthesis,
  SynthesisMetrics,
  SynthesisOptions,
  SynthesisOutcome,
  SynthesisResult,
  SynthesisState,
  TerminologySet,
  TranscribeEvent,
  TranscribeStreamOptions,
  Transcript,
  TtsSession,
  UnknownStreamEvent,
} from './streaming/index.js';
