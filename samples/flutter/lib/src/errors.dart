/// Turns the SDK's exceptions into messages for the user.
library;

import 'package:echonova/echonova.dart';
import 'package:flutter/foundation.dart';

import 'proxy_auth.dart';

/// A short message for [error], with the request ID when there is one (quote
/// it to support).
String describeError(Object error) {
  final message = switch (error) {
    ProxyAuthException(:final message) => message,
    AuthenticationException() =>
      "The proxy did not accept the app's credentials (401). Check the "
          'sign-in hook in lib/src/proxy_auth.dart and PROXY_DEMO_TOKEN.',
    BillingException(:final errorMessage) =>
      "The workspace can't pay for this: ${errorMessage ?? 'no credits left'}.",
    ConcurrencyLimitException() =>
      'Too many streams are open at once. Close another session and try '
          'again.',
    RateLimitException(:final retryAfter) =>
      retryAfter == null
          ? 'Too many requests. Wait a moment and try again.'
          : 'Too many requests. Try again in ${retryAfter.inSeconds} s.',
    APIStatusException(:final statusCode, :final errorMessage) =>
      '${errorMessage ?? 'The request failed'}'
          '${statusCode == null ? '' : ' (HTTP $statusCode)'}.',
    // On the web the browser hides why a stream handshake failed; the
    // proxy's log has the reason.
    APIConnectionException() when kIsWeb =>
      'Could not reach the proxy. If it is running, check that '
          "PROXY_ALLOWED_ORIGINS lists this page's origin, and look at its "
          'log.',
    APIConnectionException() =>
      'Could not reach the proxy. Is it running, and is ECHONOVA_PROXY_URL '
          'right?',
    // Every other SDK error, such as a stream that closed unexpectedly.
    EchoNovaException(:final message) => message,
    _ => '$error',
  };
  final requestId = switch (error) {
    APIStatusException(:final requestId?) => requestId,
    _ => null,
  };
  return requestId == null ? message : '$message Request ID: $requestId.';
}
