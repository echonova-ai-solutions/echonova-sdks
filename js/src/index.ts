/**
 * Official JavaScript and TypeScript SDK for the EchoNova speech API.
 *
 * Pre-release: this version contains the client configuration, errors, retry
 * rules and webhook verification. The service namespaces and streaming follow.
 */

export { EchoNova, EchoNova as default, DEFAULT_BASE_URL } from './client.js';
export type { AuthContext, AuthHook, ClientOptions, FetchLike } from './client.js';
export type { HeaderValues } from './core/http.js';
export type { HeadersLike } from './core/envelope.js';
export type { Logger, LogLevel } from './core/logger.js';
export type { RateLimitInfo } from './core/ratelimit.js';

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
