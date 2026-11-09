/// The REST transport: sends a request over `package:http`, applies the retry
/// table, the rate-limit tracker and the error classifier.
///
/// A POST that may already have run is never sent again: the API has no
/// idempotency key, so a retry could be charged twice.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../core/classifier.dart';
import '../core/envelope.dart';
import '../core/rate_limit.dart';
import '../core/retry.dart';
import '../core/rules.dart';
import '../errors.dart';
import '../platform/platform.dart' as platform;
import '../version.dart';

/// Per-attempt time limits for each kind of operation, when neither the
/// client nor the call sets a timeout. Each is the connect, write and read
/// timeouts of the SDK's timeout table added together, because
/// `package:http` has a single deadline per request.
enum TimeoutProfile {
  /// GET and DELETE calls, and creating a Text to Speech job.
  standard(Duration(seconds: 50)),

  /// Exporting a transcript.
  export(Duration(seconds: 80)),

  /// Synchronous Text to Speech.
  textToSpeechSync(Duration(seconds: 140)),

  /// Uploading audio for an async Speech to Text job.
  upload(Duration(seconds: 190)),

  /// Synchronous Speech to Text and Sound Cleaning, which can run for
  /// minutes.
  longRunning(Duration(seconds: 670));

  const TimeoutProfile(this.duration);

  /// The per-attempt deadline.
  final Duration duration;
}

/// How long connecting may take before it counts as a connect failure.
const Duration connectTimeout = Duration(seconds: 10);

/// One REST call, as built by a resource method.
final class ApiRequest {
  /// Creates a request. [path] starts with `/v1/` and is appended to the
  /// client's base URL; path parameters must already be percent-encoded.
  const ApiRequest({
    required this.method,
    required this.path,
    this.query = const {},
    this.body,
    this.contentType,
    this.headers = const {},
    this.bucket,
    this.timeoutProfile = TimeoutProfile.standard,
    this.timeout,
    this.maxRetries,
    this.expectEnvelope = true,
  });

  /// The HTTP method.
  final String method;

  /// The path below the base URL, such as `/v1/text-to-speech/jobs`.
  final String path;

  /// Query parameters.
  final Map<String, String> query;

  /// The request body. Bytes can always be sent again.
  final List<int>? body;

  /// The body's media type.
  final String? contentType;

  /// Extra headers for this call.
  final Map<String, String> headers;

  /// The rate-limit bucket: the API counts requests per key per endpoint.
  /// Resources pass the operation's SDK name (`textToSpeech.jobs.get`), so
  /// calls for different job IDs share one bucket. Defaults to the method
  /// and path.
  final String? bucket;

  /// The default deadline of this kind of call.
  final TimeoutProfile timeoutProfile;

  /// Overrides every other timeout for this call.
  final Duration? timeout;

  /// Overrides the client's retry budget for this call.
  final int? maxRetries;

  /// Whether a 2xx body is an EchoNova envelope (most endpoints) or raw
  /// content (transcript exports).
  final bool expectEnvelope;
}

/// A successful REST response.
final class ApiResponse {
  /// Creates a response.
  const ApiResponse({
    required this.statusCode,
    required this.headers,
    required this.body,
    required this.data,
    required this.rateLimit,
    required this.attempts,
  });

  /// The HTTP status.
  final int statusCode;

  /// The response headers.
  final Map<String, String> headers;

  /// The raw body.
  final Uint8List body;

  /// The envelope's `data`, or `null` for raw responses.
  final Object? data;

  /// The rate-limit headers, when present.
  final RateLimitInfo? rateLimit;

  /// How many attempts it took (1 when there was no retry).
  final int attempts;

  /// The `X-Request-Id` EchoNova assigned.
  String? get requestId => header(headers, 'x-request-id');
}

/// Returns the headers that authenticate a request: the API key, or the
/// app's own credentials in proxy mode.
typedef AuthHeaders = FutureOr<Map<String, String>> Function();

/// Sends REST calls with retries, rate limiting and error mapping.
final class HttpTransport {
  /// Creates a transport. [client] is closed by [close] only when
  /// [ownsClient] is true. [random], [sleep] and [now] are for tests.
  HttpTransport({
    required this.baseUrl,
    required AuthHeaders authHeaders,
    required http.Client client,
    required bool ownsClient,
    Map<String, String> defaultHeaders = const {},
    this.timeout,
    this.maxRetries = 2,
    this.rateLimitPreflight = true,
    RateLimitTracker? rateLimits,
    RuleSet rules = errorRules,
    double Function()? random,
    Future<void> Function(Duration)? sleep,
    DateTime Function()? now,
  })  : _authHeaders = authHeaders,
        _client = client,
        _ownsClient = ownsClient,
        _defaultHeaders = Map.unmodifiable(defaultHeaders),
        rateLimits = rateLimits ?? RateLimitTracker(),
        _rules = rules,
        _random = random,
        _policy =
            RetryPolicy(maxRetries: maxRetries, rules: rules, random: random),
        _sleep = sleep ?? _delay,
        _now = now ?? _utcNow;

  /// Where requests go. Paths are appended to its path.
  final Uri baseUrl;

  /// Overrides every per-call default deadline when set.
  final Duration? timeout;

  /// Retries per call.
  final int maxRetries;

  /// Whether to wait for a rate-limit window to reset when the last
  /// response said no requests remain, instead of sending and being
  /// throttled.
  final bool rateLimitPreflight;

  /// The rate limits seen so far, by bucket.
  final RateLimitTracker rateLimits;

  final AuthHeaders _authHeaders;
  final http.Client _client;
  final bool _ownsClient;
  final Map<String, String> _defaultHeaders;
  final RuleSet _rules;
  final double Function()? _random;
  final RetryPolicy _policy;
  final Future<void> Function(Duration) _sleep;
  final DateTime Function() _now;

  static Future<void> _delay(Duration duration) => Future.delayed(duration);

  static DateTime _utcNow() => DateTime.now().toUtc();

  static final String? _userAgent = () {
    final platformPart = platform.userAgentPlatform();
    return platformPart == null
        ? null
        : 'echonova-dart/$packageVersion ($platformPart)';
  }();

  /// The URL for [path] (which starts with `/`) below [baseUrl].
  Uri resolve(String path, [Map<String, String> query = const {}]) {
    final basePath = baseUrl.path.endsWith('/')
        ? baseUrl.path.substring(0, baseUrl.path.length - 1)
        : baseUrl.path;
    return baseUrl.replace(
      path: '$basePath$path',
      queryParameters: query.isEmpty ? null : query,
    );
  }

  /// The WebSocket URL for a stream [path]: `wss` for `https`, `ws` for
  /// `http`.
  Uri websocketUri(String path, [Map<String, String> query = const {}]) {
    final uri = resolve(path, query);
    return uri.replace(scheme: uri.scheme == 'http' ? 'ws' : 'wss');
  }

  /// The headers every request carries: `User-Agent` (where the platform
  /// allows it), the default headers, then the authentication headers.
  Future<Map<String, String>> commonHeaders() async => {
        if (_userAgent case final userAgent?) 'User-Agent': userAgent,
        ..._defaultHeaders,
        ...await _authHeaders(),
      };

  /// Sends [request], retrying as the retry table allows. Returns the
  /// response, or throws an [EchoNovaException].
  Future<ApiResponse> send(ApiRequest request) async {
    final method = request.method.toUpperCase();
    final policy = request.maxRetries == null
        ? _policy
        : RetryPolicy(
            maxRetries: request.maxRetries,
            rules: _rules,
            random: _random,
          );
    final bucket = request.bucket ?? '$method ${request.path}';
    final deadline =
        request.timeout ?? timeout ?? request.timeoutProfile.duration;
    final uri = resolve(request.path, request.query);
    var retries = 0;

    Future<void> retryAfter(RetryDecision decision) async {
      retries++;
      await _sleep(decision.delay);
    }

    while (true) {
      final wait = rateLimits.waitTime(bucket, preflight: rateLimitPreflight);
      if (wait > Duration.zero) await _sleep(wait);

      final headers = {
        ...await commonHeaders(),
        ...request.headers,
        if (request.contentType case final contentType?)
          'Content-Type': contentType,
      };
      final sentAt = _now();
      final _Attempt attempt;
      try {
        attempt = await _attempt(method, uri, headers, request.body, deadline);
      } on _TransportFailure catch (failure) {
        final decision = policy.decideTransport(
          method,
          failure.phase,
          retriesDone: retries,
        );
        if (_mayRetry(method, decision)) {
          await retryAfter(decision);
          continue;
        }
        throw failure.toException(
          mayHaveExecuted: executedFlag(decision.mayHaveExecuted, method),
          sentAt: sentAt,
          deadline: deadline,
        );
      }

      final rateLimit = rateLimits.observe(bucket, attempt.headers);
      final status = attempt.statusCode;
      if (status >= 200 && status < 300) {
        if (!request.expectEnvelope) {
          return attempt.toResponse(null, rateLimit, retries + 1);
        }
        try {
          final data = unwrapSuccess(attempt.body);
          return attempt.toResponse(data, rateLimit, retries + 1);
        } on MalformedEnvelope catch (malformed) {
          final decision = policy.decideTransport(
            method,
            FailurePhase.malformedSuccess,
            retriesDone: retries,
          );
          if (_mayRetry(method, decision)) {
            await retryAfter(decision);
            continue;
          }
          throw attempt.protocolException(
            'EchoNova sent an unreadable response: ${malformed.message}',
            mayHaveExecuted: executedFlag(decision.mayHaveExecuted, method),
            sentAt: sentAt,
            cause: malformed,
          );
        }
      }
      if (status < 400 || status > 599) {
        // Redirects are not followed, and the API doesn't send them.
        throw attempt.protocolException(
          'unexpected HTTP status $status',
          mayHaveExecuted: executedFlag(Executed.unknown, method),
          sentAt: sentAt,
        );
      }

      final error = buildStatusError(
        status,
        attempt.headers,
        attempt.body,
        method: method,
        sentAt: sentAt,
        reasonPhrase: attempt.reasonPhrase,
        rules: _rules,
      );
      final rule = _rules.ruleById(error.rule!)!;
      final serverRetryAfter = error.retryAfter;
      if (rule.blocksBucket && serverRetryAfter != null) {
        rateLimits.block(bucket, serverRetryAfter);
      }
      final decision = policy.decideStatus(
        method,
        rule,
        retriesDone: retries,
        retryAfter: serverRetryAfter,
      );
      if (_mayRetry(method, decision)) {
        await retryAfter(decision);
        continue;
      }
      throw error;
    }
  }

  /// The safety invariant, checked on top of the retry table: a POST (or any
  /// method that isn't idempotent) that may have run is never sent again.
  static bool _mayRetry(String method, RetryDecision decision) {
    if (!decision.retry) return false;
    const idempotent = {'GET', 'HEAD', 'DELETE', 'OPTIONS'};
    return idempotent.contains(method) ||
        decision.mayHaveExecuted == Executed.no;
  }

  Future<_Attempt> _attempt(
    String method,
    Uri uri,
    Map<String, String> headers,
    List<int>? body,
    Duration deadline,
  ) async {
    final abort = Completer<void>();
    final request = http.AbortableRequest(
      method,
      uri,
      abortTrigger: abort.future,
    )
      ..followRedirects = false
      ..headers.addAll(headers);
    if (body != null) request.bodyBytes = body;

    final expired = Completer<_Attempt>();
    final timer = Timer(deadline, () {
      if (!abort.isCompleted) abort.complete();
      expired.completeError(const _TransportFailure.timeout());
    });
    try {
      return await Future.any([_exchange(request), expired.future]);
    } finally {
      timer.cancel();
    }
  }

  Future<_Attempt> _exchange(http.BaseRequest request) async {
    final http.StreamedResponse response;
    try {
      response = await _client.send(request);
    } on Object catch (error) {
      if (!_isNetworkError(error)) rethrow;
      if (platform.isConnectFailure(error)) {
        throw _TransportFailure.connect(
          error,
          timedOut: platform.isConnectTimeout(error),
        );
      }
      throw _TransportFailure.noResponse(error);
    }
    try {
      final body = await response.stream.toBytes();
      return _Attempt(
        statusCode: response.statusCode,
        headers: response.headers,
        body: body,
        reasonPhrase: response.reasonPhrase,
      );
    } on Object catch (error) {
      if (!_isNetworkError(error)) rethrow;
      // The server answered, so the request ran; only the body was lost.
      throw _TransportFailure.noResponse(error);
    }
  }

  static bool _isNetworkError(Object error) =>
      error is http.ClientException ||
      error is TimeoutException ||
      platform.isNetworkError(error);

  /// Closes the HTTP client, if the SDK created it.
  void close() {
    if (_ownsClient) _client.close();
  }
}

final class _Attempt {
  const _Attempt({
    required this.statusCode,
    required this.headers,
    required this.body,
    required this.reasonPhrase,
  });

  final int statusCode;
  final Map<String, String> headers;
  final Uint8List body;
  final String? reasonPhrase;

  ApiResponse toResponse(
          Object? data, RateLimitInfo? rateLimit, int attempts) =>
      ApiResponse(
        statusCode: statusCode,
        headers: headers,
        body: body,
        data: data,
        rateLimit: rateLimit,
        attempts: attempts,
      );

  ProtocolException protocolException(
    String message, {
    required bool? mayHaveExecuted,
    required DateTime sentAt,
    Object? cause,
  }) {
    final requestId = header(headers, 'x-request-id');
    return ProtocolException(
      message:
          requestId == null ? message : '$message (request_id: $requestId)',
      statusCode: statusCode,
      requestId: requestId,
      headers: headers,
      rawBody: parseErrorBody(body).rawBody,
      mayHaveExecuted: mayHaveExecuted,
      sentAt: sentAt,
      cause: cause,
    );
  }
}

/// A failure without an HTTP status. Internal.
final class _TransportFailure implements Exception {
  const _TransportFailure.connect(Object this.cause, {required this.timedOut})
      : phase = FailurePhase.connect;

  const _TransportFailure.noResponse(Object this.cause)
      : phase = FailurePhase.noResponse,
        timedOut = false;

  const _TransportFailure.timeout()
      : phase = FailurePhase.noResponse,
        cause = null,
        timedOut = true;

  final FailurePhase phase;
  final Object? cause;
  final bool timedOut;

  APIConnectionException toException({
    required bool? mayHaveExecuted,
    required DateTime sentAt,
    required Duration deadline,
  }) {
    final reason = switch (cause) {
      final http.ClientException error => error.message,
      null => null,
      final Object error => '$error',
    };
    final suffix = reason == null ? '' : ': $reason';
    if (phase == FailurePhase.connect) {
      return timedOut
          ? APITimeoutException(
              'Timed out connecting to EchoNova$suffix',
              kind: TimeoutKind.connect,
              mayHaveExecuted: mayHaveExecuted,
              sentAt: sentAt,
              cause: cause,
            )
          : APIConnectionException(
              'Could not connect to EchoNova$suffix',
              mayHaveExecuted: mayHaveExecuted,
              sentAt: sentAt,
              cause: cause,
            );
    }
    return timedOut
        ? APITimeoutException(
            'No response from EchoNova within $deadline',
            kind: TimeoutKind.total,
            mayHaveExecuted: mayHaveExecuted,
            sentAt: sentAt,
            cause: cause,
          )
        : APIConnectionException(
            'The connection to EchoNova failed before a response arrived'
            '$suffix',
            mayHaveExecuted: mayHaveExecuted,
            sentAt: sentAt,
            cause: cause,
          );
  }
}
