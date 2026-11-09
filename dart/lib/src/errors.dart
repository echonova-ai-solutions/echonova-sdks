/// Exceptions thrown by the EchoNova SDK.
///
/// Exceptions are grouped by what went wrong, not by transport. For example,
/// [InsufficientBalanceException] covers a REST 402, a WebSocket handshake 402
/// and a stream closed with code 4002. The class tree matches
/// `spec/error-rules.json` and is the same in every EchoNova SDK; the Dart
/// names end in `Exception` instead of `Error`.
///
/// [EchoNovaException] is `sealed`, so a `switch` over it is exhaustive:
///
/// ```dart
/// try {
///   await callEchoNova();
/// } on EchoNovaException catch (error) {
///   switch (error) {
///     case RateLimitException(:final retryAfter):
///       print('Slow down; retry after $retryAfter');
///     case APIStatusException(:final statusCode, :final requestId):
///       print('EchoNova answered $statusCode (request $requestId)');
///     case APIConnectionException(:final mayHaveExecuted):
///       print('No response; the request may have run: $mayHaveExecuted');
///     default:
///       rethrow;
///   }
/// }
/// ```
///
/// The other classes are `base`: they can be extended (to add context in
/// your own code) but not implemented, so new fields can be added to them
/// without breaking your code.
library;

/// How a request reached EchoNova.
enum TransportKind {
  /// A REST call.
  http,

  /// A WebSocket stream (its handshake, an error event or a close frame).
  websocket,
}

/// Which timeout expired, for [APITimeoutException].
enum TimeoutKind {
  /// Connecting (DNS, TCP, TLS) or opening a stream took too long.
  connect,

  /// Sending the request body took too long.
  write,

  /// Waiting for the response took too long.
  read,

  /// Waiting for a free connection took too long.
  pool,

  /// The whole attempt took too long.
  total,

  /// A stream did not confirm its session in time.
  sessionStart,

  /// A stream did not finish after `stop` in time.
  stopDrain,
}

/// Which check failed, for [WebhookVerificationException].
enum WebhookFailure {
  /// A required webhook header is missing.
  headers,

  /// The timestamp is not a number, or is outside the tolerance.
  timestamp,

  /// The signature doesn't match any of the secrets.
  signature,

  /// The body is not the JSON the event requires.
  payload,
}

/// Base class of every exception thrown by this SDK.
sealed class EchoNovaException implements Exception {
  /// Creates an exception with a human-readable [message].
  EchoNovaException(this.message, {this.cause});

  /// A human-readable description.
  final String message;

  /// The lower-level error that caused this one, when there was one.
  final Object? cause;

  String get _name;

  @override
  String toString() => '$_name: $message';
}

// --- Local misuse: nothing was sent ------------------------------------------

/// The SDK was called incorrectly. Nothing was sent to EchoNova.
base class UsageException extends EchoNovaException {
  /// Creates a usage exception.
  UsageException(super.message, {super.cause});

  @override
  String get _name => 'UsageException';
}

/// A stream session was used after it ended.
base class SessionEndedException extends UsageException {
  /// Creates a session-ended exception.
  SessionEndedException(super.message, {super.cause});

  @override
  String get _name => 'SessionEndedException';
}

/// The runtime can't do this safely, such as sending an API key from a
/// browser.
base class UnsupportedEnvironmentException extends EchoNovaException {
  /// Creates an unsupported-environment exception.
  UnsupportedEnvironmentException(super.message, {super.cause});

  @override
  String get _name => 'UnsupportedEnvironmentException';
}

// --- No HTTP response --------------------------------------------------------

/// No response was received from EchoNova.
///
/// [mayHaveExecuted] matters for POST requests. `true` means the request was
/// fully sent, so it may have run and been charged: list recent jobs before
/// sending it again. `false` means it definitely did not run. `null` means
/// unknown.
base class APIConnectionException extends EchoNovaException {
  /// Creates a connection exception.
  APIConnectionException(
    super.message, {
    this.mayHaveExecuted = false,
    this.sentAt,
    this.retryDisabledReason,
    super.cause,
  });

  /// Whether the request may have run (POST only; always `false` otherwise).
  final bool? mayHaveExecuted;

  /// When the last attempt was sent, to find jobs it may have created.
  final DateTime? sentAt;

  /// Why the SDK did not retry when the failure itself was retryable, such
  /// as `body_not_replayable`.
  final String? retryDisabledReason;

  @override
  String get _name => 'APIConnectionException';
}

/// A timeout expired. [kind] says which one.
base class APITimeoutException extends APIConnectionException {
  /// Creates a timeout exception.
  APITimeoutException(
    super.message, {
    required this.kind,
    super.mayHaveExecuted,
    super.sentAt,
    super.retryDisabledReason,
    super.cause,
  });

  /// Which timeout expired.
  final TimeoutKind kind;

  @override
  String get _name => 'APITimeoutException';
}

/// A stream's connection dropped without a close frame (1006, pong timeout
/// or reset).
base class StreamConnectionLostException extends APIConnectionException {
  /// Creates a connection-lost exception.
  StreamConnectionLostException(
    super.message, {
    super.mayHaveExecuted,
    super.sentAt,
    super.retryDisabledReason,
    super.cause,
  });

  @override
  String get _name => 'StreamConnectionLostException';
}

// --- The server answered -----------------------------------------------------

/// EchoNova answered with an error: a REST status, a WebSocket handshake
/// rejection, or an error event or close on a stream.
///
/// [errorMessage] is the server's text, unmodified. It is never split on
/// commas, because single messages can contain them.
base class APIStatusException extends EchoNovaException {
  /// Creates a status exception. When [message] is omitted, it is built from
  /// the status, codes, server message and request ID.
  APIStatusException({
    String? message,
    this.statusCode,
    this.errorMessage,
    this.errorCode,
    this.requestId,
    this.docsUrl,
    Map<String, String>? headers,
    this.rawBody,
    this.transport = TransportKind.http,
    this.retryAfter,
    this.mayHaveExecuted = false,
    this.rule,
    this.closeCode,
    this.sessionId,
    this.sentAt,
    this.fromProxy = false,
    super.cause,
  })  : headers = Map.unmodifiable(headers ?? const <String, String>{}),
        super(
          message ??
              _describe(
                statusCode,
                errorCode,
                closeCode,
                errorMessage,
                requestId,
              ),
        );

  /// The HTTP status (REST, or the WebSocket handshake), when there was one.
  final int? statusCode;

  /// The server's error message, unmodified.
  final String? errorMessage;

  /// A machine-readable code: a stream error's `code`, or a REST
  /// `errorCode` when the API sends one.
  final String? errorCode;

  /// The `X-Request-Id` EchoNova assigned. Quote it to support.
  final String? requestId;

  /// A link to the documentation for this error.
  final String? docsUrl;

  /// The response headers.
  final Map<String, String> headers;

  /// The start of the response body (at most 4 KiB), as text.
  final String? rawBody;

  /// Whether this came from a REST call or a stream.
  final TransportKind transport;

  /// How long the server asked to wait before trying again.
  final Duration? retryAfter;

  /// Whether the request may have run (POST only; always `false` otherwise).
  /// `null` means unknown.
  final bool? mayHaveExecuted;

  /// The id of the classification rule in `error-rules.json`.
  final String? rule;

  /// The WebSocket close code, for errors that closed a stream.
  final int? closeCode;

  /// The stream session, for stream errors.
  final String? sessionId;

  /// When the failed attempt was sent.
  final DateTime? sentAt;

  /// The response came from the hosting proxy, not from the API.
  final bool fromProxy;

  @override
  String get _name => 'APIStatusException';
}

String _describe(
  int? statusCode,
  String? errorCode,
  int? closeCode,
  String? errorMessage,
  String? requestId,
) {
  final text = [
    if (statusCode != null) '$statusCode',
    if (closeCode != null) 'close $closeCode',
    if (errorCode != null && errorCode.isNotEmpty) '[$errorCode]',
    if (errorMessage != null && errorMessage.isNotEmpty)
      errorMessage
    else
      'no error message',
  ].join(' ');
  return requestId != null && requestId.isNotEmpty
      ? '$text (request_id: $requestId)'
      : text;
}

/// The request was rejected as invalid (400, 405, 409, 413, 415, 422, or a
/// stream `validation_failed`).
base class InvalidRequestException extends APIStatusException {
  /// Creates the exception. See [APIStatusException.new].
  InvalidRequestException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'InvalidRequestException';
}

/// 401: the API key is missing, wrong, disabled or deleted.
base class AuthenticationException extends APIStatusException {
  /// Creates the exception. See [APIStatusException.new].
  AuthenticationException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'AuthenticationException';
}

/// 403: no active subscription, or the key lacks access to this service.
base class PermissionDeniedException extends APIStatusException {
  /// Creates the exception. See [APIStatusException.new].
  PermissionDeniedException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'PermissionDeniedException';
}

/// The feature is not enabled for this account (for example
/// `Streaming is not enabled`).
base class FeatureNotEnabledException extends PermissionDeniedException {
  /// Creates the exception. See [APIStatusException.new].
  FeatureNotEnabledException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'FeatureNotEnabledException';
}

/// 404: the resource doesn't exist or belongs to another workspace.
base class NotFoundException extends APIStatusException {
  /// Creates the exception. See [APIStatusException.new].
  NotFoundException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'NotFoundException';
}

/// The voice ID is unknown, inactive or not available to this workspace.
base class VoiceNotFoundException extends NotFoundException {
  /// Creates the exception. See [APIStatusException.new].
  VoiceNotFoundException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'VoiceNotFoundException';
}

/// The job ID is unknown or belongs to another workspace.
base class JobNotFoundException extends NotFoundException {
  /// Creates the exception. See [APIStatusException.new].
  JobNotFoundException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'JobNotFoundException';
}

/// 408: the server stopped waiting for the request body. The request did not
/// run.
base class RequestTimeoutException extends APIStatusException {
  /// Creates the exception. See [APIStatusException.new].
  RequestTimeoutException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'RequestTimeoutException';
}

/// The account can't pay for this request. Retrying won't help.
///
/// Sealed: it is either an [InsufficientBalanceException] or a
/// [SpendingLimitException].
sealed class BillingException extends APIStatusException {
  /// Creates the exception. See [APIStatusException.new].
  BillingException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });
}

/// 402 or stream close 4002: not enough credits.
base class InsufficientBalanceException extends BillingException {
  /// Creates the exception. See [APIStatusException.new].
  InsufficientBalanceException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'InsufficientBalanceException';
}

/// 429 `Monthly spending limit exhausted` or stream close 4029: the key
/// reached its Credit Limit.
base class SpendingLimitException extends BillingException {
  /// Creates the exception. See [APIStatusException.new].
  SpendingLimitException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'SpendingLimitException';
}

/// 429: too many requests. [retryAfter] holds the time to wait, when the
/// server sent it.
///
/// This is deliberately not the parent of [SpendingLimitException]: a rate
/// limit clears by waiting, a spending limit doesn't.
base class RateLimitException extends APIStatusException {
  /// Creates the exception. See [APIStatusException.new].
  RateLimitException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'RateLimitException';
}

/// 429 `Too many concurrent streams`: the workspace has no free stream slot.
base class ConcurrencyLimitException extends APIStatusException {
  /// Creates the exception. See [APIStatusException.new].
  ConcurrencyLimitException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'ConcurrencyLimitException';
}

/// 5xx: EchoNova failed to handle the request.
base class ServerException extends APIStatusException {
  /// Creates the exception. See [APIStatusException.new].
  ServerException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'ServerException';
}

/// 503: a service is temporarily unavailable.
base class ServiceUnavailableException extends ServerException {
  /// Creates the exception. See [APIStatusException.new].
  ServiceUnavailableException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'ServiceUnavailableException';
}

/// 502 or 504. [fromProxy] is `true` when the response came from the hosting
/// proxy, not the API.
base class GatewayException extends ServerException {
  /// Creates the exception. See [APIStatusException.new].
  GatewayException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'GatewayException';
}

/// A speech service failed during a stream (`upstream_error` or close 1011).
base class UpstreamException extends ServerException {
  /// Creates the exception. See [APIStatusException.new].
  UpstreamException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'UpstreamException';
}

/// The server sent something that breaks the documented contract, or closed
/// a stream with 1008 or 1009.
base class ProtocolException extends APIStatusException {
  /// Creates the exception. See [APIStatusException.new].
  ProtocolException({
    super.message,
    super.statusCode,
    super.errorMessage,
    super.errorCode,
    super.requestId,
    super.docsUrl,
    super.headers,
    super.rawBody,
    super.transport,
    super.retryAfter,
    super.mayHaveExecuted,
    super.rule,
    super.closeCode,
    super.sessionId,
    super.sentAt,
    super.fromProxy,
    super.cause,
  });

  @override
  String get _name => 'ProtocolException';
}

// --- Streams -----------------------------------------------------------------

/// A stream closed in a way that is not covered by a more specific exception.
base class StreamClosedException extends EchoNovaException {
  /// Creates a stream-closed exception.
  StreamClosedException(
    super.message, {
    this.closeCode,
    this.reason,
    this.sessionId,
    super.cause,
  });

  /// The WebSocket close code.
  final int? closeCode;

  /// The close reason the server sent.
  final String? reason;

  /// The stream session, when one had started.
  final String? sessionId;

  @override
  String get _name => 'StreamClosedException';
}

/// Close 1001: the server is restarting. Reconnect.
base class ServerRestartingException extends StreamClosedException {
  /// Creates the exception.
  ServerRestartingException(
    super.message, {
    super.closeCode,
    super.reason,
    super.sessionId,
    super.cause,
  });

  @override
  String get _name => 'ServerRestartingException';
}

/// Close 4008: the session hit its idle timeout or maximum length.
base class SessionExpiredException extends StreamClosedException {
  /// Creates the exception.
  SessionExpiredException(
    super.message, {
    super.closeCode,
    super.reason,
    super.sessionId,
    super.cause,
  });

  @override
  String get _name => 'SessionExpiredException';
}

// --- Jobs, downloads, webhooks -----------------------------------------------

/// A job finished with status `failed`. [job] holds the failed job.
base class JobFailedException extends EchoNovaException {
  /// Creates the exception.
  JobFailedException(super.message, {required this.job, super.cause});

  /// The failed job.
  final Object? job;

  @override
  String get _name => 'JobFailedException';
}

/// `wait()` gave up before the job finished. Calling `wait()` again is safe.
base class JobWaitTimeoutException extends EchoNovaException {
  /// Creates the exception.
  JobWaitTimeoutException(
    super.message, {
    required this.jobId,
    this.lastJob,
    super.cause,
  });

  /// The job that was being waited for.
  final String jobId;

  /// The job as last seen, if it was fetched at least once.
  final Object? lastJob;

  @override
  String get _name => 'JobWaitTimeoutException';
}

/// A signed download link expired. Get the job again for a fresh link.
base class DownloadExpiredException extends EchoNovaException {
  /// Creates the exception.
  DownloadExpiredException(super.message, {this.url, super.cause});

  /// The link, without its query string (which carries the signature).
  final String? url;

  @override
  String get _name => 'DownloadExpiredException';
}

/// A webhook request failed verification. [reason] says which check failed.
base class WebhookVerificationException extends EchoNovaException {
  /// Creates the exception.
  WebhookVerificationException(
    super.message, {
    required this.reason,
    super.cause,
  });

  /// Which check failed.
  final WebhookFailure reason;

  @override
  String get _name => 'WebhookVerificationException';
}
