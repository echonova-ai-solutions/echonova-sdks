/// Per-call options and raw responses.
library;

import 'dart:typed_data';

import 'core/classifier.dart' show executedFlag;
import 'core/envelope.dart';
import 'core/rate_limit.dart';
import 'core/rules.dart' show Executed;
import 'errors.dart';
import 'transport/http_transport.dart';

/// Overrides for one API call.
///
/// ```dart
/// await client.textToSpeech.jobs.get(
///   jobId,
///   options: const RequestOptions(timeout: Duration(seconds: 5), maxRetries: 0),
/// );
/// ```
final class RequestOptions {
  /// Creates options. Unset values keep the client's settings.
  const RequestOptions({
    this.timeout,
    this.maxRetries,
    this.deadline,
    this.headers = const {},
    this.idempotencyKey,
    this.waitTimeout,
  });

  /// The time limit for each attempt of this call.
  final Duration? timeout;

  /// Retries for this call. A request that may already have run is never
  /// retried, whatever this says, unless it carries an [idempotencyKey].
  final int? maxRetries;

  /// The total time for this call: every attempt, retry delay and
  /// rate-limit wait included.
  final Duration? deadline;

  /// Extra headers for this call. They can't replace the credentials.
  final Map<String, String> headers;

  /// The `Idempotency-Key` for `textToSpeech.generate`,
  /// `speechToText.transcribe` or `soundCleaning.clean`, which accept one.
  ///
  /// Those calls always send a key, so the SDK can retry them safely: by
  /// default a new random one per call, the same on every retry. Pass your
  /// own to retry safely across processes or restarts: repeating a key
  /// within 24 hours returns the first result and is not charged again. A
  /// new request needs a new key. Other calls throw [ArgumentError] when it
  /// is set.
  final String? idempotencyKey;

  /// How long `textToSpeech.generate`, `speechToText.transcribe` and
  /// `soundCleaning.clean` wait for their job: after the API answers that
  /// it is still processing (`202`, after 220 s), and while it answers that
  /// the first request with the call's key is still running (a `409`; the
  /// request is sent again every 5 s). Both waits share it.
  ///
  /// Default: 20 minutes, as for `jobs.wait`, and never past the call's
  /// total [deadline] (or the client's). Past it, the call throws
  /// [JobWaitTimeoutException] while waiting after a `202` (the job keeps
  /// running, and waiting for it with `jobs.wait` is safe), or
  /// [RequestInProgressException] while the request is still running.
  final Duration? waitTimeout;

  @override
  String toString() => 'RequestOptions(timeout: $timeout, '
      'maxRetries: $maxRetries, deadline: $deadline, '
      'headers: ${headers.keys.toList()}, idempotencyKey: $idempotencyKey, '
      'waitTimeout: $waitTimeout)';
}

/// An HTTP response with its metadata. Call [parse] for the value the
/// method normally returns.
///
/// Every API method has a `…WithResponse` twin that returns this:
///
/// ```dart
/// final raw = await client.textToSpeech.jobs.getWithResponse(jobId);
/// print('${raw.statusCode} ${raw.requestId} ${raw.rateLimit}');
/// final job = raw.parse();
/// ```
final class RawResponse<T> {
  RawResponse._(this._response, this._parse);

  final ApiResponse _response;
  final T Function(ApiResponse) _parse;
  T? _parsed;
  var _isParsed = false;

  /// The HTTP status.
  int get statusCode => _response.statusCode;

  /// The response headers, with lower-case names.
  Map<String, String> get headers => _response.headers;

  /// The `X-Request-Id` EchoNova assigned. Quote it to support.
  String? get requestId => _response.requestId;

  /// The rate-limit headers, when the response had them.
  RateLimitInfo? get rateLimit => _response.rateLimit;

  /// The response body, as received.
  Uint8List get body => _response.body;

  /// How many attempts the call took (1 when there was no retry).
  int get attempts => _response.attempts;

  /// The parsed result. Throws [ProtocolException] when the body is not
  /// what the API documents.
  T parse() {
    if (_isParsed) return _parsed as T;
    try {
      final value = _parse(_response);
      _parsed = value;
      _isParsed = true;
      return value;
    } on MalformedEnvelope catch (error) {
      throw _protocolError(error.message, error);
    } on FormatException catch (error) {
      throw _protocolError(error.message, error);
    }
  }

  ProtocolException _protocolError(String reason, Object cause) {
    final requestId = this.requestId;
    final text = 'EchoNova sent an unreadable response: $reason';
    return ProtocolException(
      message: requestId == null ? text : '$text (request_id: $requestId)',
      statusCode: statusCode,
      errorMessage: reason,
      requestId: requestId,
      headers: headers,
      rawBody: _response.secret ? null : parseErrorBody(body).rawBody,
      rule: 'malformed_success',
      mayHaveExecuted: executedFlag(Executed.yes, _response.method),
      idempotencyKey: _response.idempotencyKey,
      cause: cause,
    );
  }

  @override
  String toString() =>
      'RawResponse(statusCode: $statusCode, requestId: $requestId)';
}

/// Wraps [response]; [parse] runs on the first [RawResponse.parse].
/// Internal.
RawResponse<T> newRawResponse<T>(
  ApiResponse response,
  T Function(ApiResponse) parse,
) =>
    RawResponse._(response, parse);
