/// Turn an HTTP error response (REST or WebSocket handshake) into an SDK
/// exception.
library;

import '../errors.dart';
import 'envelope.dart';
import 'rules.dart';

/// `mayHaveExecuted` for an error: only a POST can have run and been
/// charged. `null` means unknown.
bool? executedFlag(Executed value, String method) {
  if (method.toUpperCase() != 'POST') return false;
  return switch (value) {
    Executed.no => false,
    Executed.yes => true,
    Executed.unknown => null,
  };
}

/// The rule that matches an error response, and its `Retry-After`.
({ErrorRule rule, Duration? retryAfter}) classifyResponse(
  int status,
  Map<String, String> headers,
  List<int> body, {
  RuleSet rules = errorRules,
}) =>
    _classify(status, headers, parseErrorBody(body), rules);

({ErrorRule rule, Duration? retryAfter}) _classify(
  int status,
  Map<String, String> headers,
  ErrorBody parsed,
  RuleSet rules,
) {
  final retryAfter = parseRetryAfter(header(headers, 'retry-after'));
  final rule = rules.classify(
    status,
    isJson: parsed.isJson,
    message: parsed.isJson ? parsed.errorMessage : null,
    hasRetryAfter: retryAfter != null,
  );
  return (rule: rule, retryAfter: retryAfter);
}

/// Builds the exception for an error response.
///
/// [method] is the HTTP method, or `WS` for a WebSocket handshake. Only a
/// POST can report `mayHaveExecuted: true` or `null`. [idempotencyKey] is
/// the key the call sent, if any; [retryDisabledReason] says why a request
/// that could have been sent again wasn't.
APIStatusException buildStatusError(
  int status,
  Map<String, String> headers,
  List<int> body, {
  required String method,
  TransportKind transport = TransportKind.http,
  DateTime? sentAt,
  String? reasonPhrase,
  String? idempotencyKey,
  String? retryDisabledReason,
  RuleSet rules = errorRules,
}) {
  final parsed = parseErrorBody(body);
  final (:rule, :retryAfter) = _classify(status, headers, parsed, rules);
  final create = statusExceptionFactories[rule.error];
  if (create == null) {
    throw StateError(
      'error rule ${rule.id} maps to ${rule.error}, '
      'which is not a concrete APIStatusException',
    );
  }
  final serverMessage = parsed.errorMessage;
  return create(
    statusCode: status,
    errorMessage: serverMessage != null && serverMessage.isNotEmpty
        ? serverMessage
        : reasonPhrase,
    errorCode: parsed.errorCode,
    requestId: header(headers, 'x-request-id'),
    docsUrl: parsed.docsUrl,
    headers: Map.of(headers),
    rawBody: parsed.rawBody,
    transport: transport,
    retryAfter: retryAfter,
    mayHaveExecuted: executedFlag(rule.mayHaveExecuted, method),
    rule: rule.id,
    sentAt: sentAt,
    fromProxy: rule.fromProxy,
    retryDisabledReason: retryDisabledReason,
    idempotencyKey: idempotencyKey,
  );
}

/// The constructor of an [APIStatusException] class.
typedef StatusExceptionFactory = APIStatusException Function({
  String? message,
  int? statusCode,
  String? errorMessage,
  String? errorCode,
  String? requestId,
  String? docsUrl,
  Map<String, String>? headers,
  String? rawBody,
  TransportKind transport,
  Duration? retryAfter,
  bool? mayHaveExecuted,
  String? rule,
  int? closeCode,
  String? sessionId,
  DateTime? sentAt,
  bool fromProxy,
  String? retryDisabledReason,
  String? idempotencyKey,
  Object? cause,
});

/// The concrete [APIStatusException] classes, by their name in the shared
/// taxonomy (`spec/error-rules.json`).
const Map<String, StatusExceptionFactory> statusExceptionFactories = {
  'APIStatusError': APIStatusException.new,
  'InvalidRequestError': InvalidRequestException.new,
  'AuthenticationError': AuthenticationException.new,
  'PermissionDeniedError': PermissionDeniedException.new,
  'FeatureNotEnabledError': FeatureNotEnabledException.new,
  'NotFoundError': NotFoundException.new,
  'VoiceNotFoundError': VoiceNotFoundException.new,
  'JobNotFoundError': JobNotFoundException.new,
  'RequestTimeoutError': RequestTimeoutException.new,
  'InsufficientBalanceError': InsufficientBalanceException.new,
  'SpendingLimitError': SpendingLimitException.new,
  'RateLimitError': RateLimitException.new,
  'ConcurrencyLimitError': ConcurrencyLimitException.new,
  'RequestInProgressError': RequestInProgressException.new,
  'ServerError': ServerException.new,
  'ServiceUnavailableError': ServiceUnavailableException.new,
  'GatewayError': GatewayException.new,
  'UpstreamError': UpstreamException.new,
  'ProtocolError': ProtocolException.new,
};
