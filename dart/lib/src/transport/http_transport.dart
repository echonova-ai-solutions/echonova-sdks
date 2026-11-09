/// The REST transport: sends a request over `package:http`, applies the retry
/// table, the rate-limit tracker and the error classifier.
///
/// A POST that may already have run is never sent again: the API has no
/// idempotency key, so a retry could be charged twice.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show MediaType;

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
  /// GET and DELETE calls, creating a Text to Speech job, widget tickets
  /// and agent sessions.
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

/// The slowest upload rate the default upload deadlines allow for, in bytes
/// per second. The API itself stops waiting for a body after 300 s.
const int minimumUploadRate = 512 * 1024;

/// The longest extra time an upload gets for its size.
const Duration maximumUploadAllowance = Duration(seconds: 300);

/// Extra time an upload of [length] bytes gets on top of its operation's
/// default deadline: `package:http` can only limit a whole attempt, and a
/// large file takes a while to send.
Duration uploadAllowance(int length) {
  final seconds = (length / minimumUploadRate).ceil();
  final allowance = Duration(seconds: seconds);
  return allowance > maximumUploadAllowance
      ? maximumUploadAllowance
      : allowance;
}

/// Downloads must send their headers within this time.
const Duration downloadHeadersTimeout = Duration(seconds: 80);

/// A download fails when no bytes arrive for this long.
const Duration downloadReadTimeout = Duration(seconds: 60);

/// The file part of a multipart request.
abstract interface class MultipartUpload {
  /// The file name sent with the part.
  String get filename;

  /// The part's media type, such as `audio/mpeg`.
  String get contentType;

  /// The number of bytes [open] produces.
  int get length;

  /// Whether [open] can be called (again). False once a one-shot stream has
  /// been read.
  bool get isReplayable;

  /// The bytes, for one attempt.
  Stream<List<int>> open();
}

/// One REST call, as built by a resource method.
final class ApiRequest {
  /// Creates a request. [path] starts with `/v1/` and is appended to the
  /// client's base URL; path parameters must already be percent-encoded.
  ///
  /// A multipart request has [upload] (and optionally [form] fields) instead
  /// of [body].
  const ApiRequest({
    required this.method,
    required this.path,
    this.query = const {},
    this.body,
    this.contentType,
    this.form,
    this.upload,
    this.headers = const {},
    this.bucket,
    this.timeoutProfile = TimeoutProfile.standard,
    this.timeout,
    this.maxRetries,
    this.deadline,
    this.expectEnvelope = true,
    this.secretResponse = false,
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

  /// The text fields of a multipart request, sent before the file.
  final Map<String, String>? form;

  /// The file of a multipart request (the `file` part).
  final MultipartUpload? upload;

  /// Extra headers for this call.
  final Map<String, String> headers;

  /// The rate-limit bucket: the API counts requests per key per endpoint.
  /// Resources pass the operation's SDK name (`textToSpeech.jobs.get`), so
  /// calls for different job IDs share one bucket. Defaults to the method
  /// and path.
  final String? bucket;

  /// The default deadline of this kind of call.
  final TimeoutProfile timeoutProfile;

  /// Overrides every other per-attempt timeout for this call.
  final Duration? timeout;

  /// Overrides the client's retry budget for this call.
  final int? maxRetries;

  /// Overrides the client's total deadline for this call: every attempt,
  /// retry delay and rate-limit wait included.
  final Duration? deadline;

  /// Whether a 2xx body is an EchoNova envelope (most endpoints) or raw
  /// content (transcript exports).
  final bool expectEnvelope;

  /// Whether a 2xx body carries a secret (a room token): it is then never
  /// copied into an exception's `rawBody`.
  final bool secretResponse;
}

/// A successful REST response.
final class ApiResponse {
  /// Creates a response. Unless [data] is given, it is read from [body]
  /// (when [expectEnvelope] is true) on first use.
  ApiResponse({
    required this.statusCode,
    required this.headers,
    required this.body,
    required this.rateLimit,
    required this.attempts,
    this.method = 'GET',
    this.expectEnvelope = true,
    this.alreadyDeleted = false,
    this.secret = false,
    Object? data,
  })  : _data = data,
        _hasData = data != null || !expectEnvelope;

  /// The HTTP status.
  final int statusCode;

  /// The response headers.
  final Map<String, String> headers;

  /// The raw body.
  final Uint8List body;

  /// The rate-limit headers, when present.
  final RateLimitInfo? rateLimit;

  /// How many attempts it took (1 when there was no retry).
  final int attempts;

  /// The request's HTTP method.
  final String method;

  /// Whether [body] is an EchoNova envelope.
  final bool expectEnvelope;

  /// A DELETE retried after a lost response found the job already gone:
  /// the earlier attempt deleted it.
  final bool alreadyDeleted;

  /// Whether [body] carries a secret and must not be copied into errors.
  final bool secret;

  Object? _data;
  bool _hasData;

  /// The envelope's `data`, or `null` for raw responses. Throws
  /// [MalformedEnvelope] when the body is not a success envelope.
  Object? get data {
    if (!_hasData) {
      _data = unwrapSuccess(body);
      _hasData = true;
    }
    return _data;
  }

  /// The `X-Request-Id` EchoNova assigned.
  String? get requestId => header(headers, 'x-request-id');
}

/// Where a download goes, written one chunk at a time.
abstract interface class DownloadSink {
  /// Drops what an earlier, failed attempt wrote.
  Future<void> reset();

  /// Appends [chunk].
  Future<void> add(List<int> chunk);
}

/// Returns the headers that authenticate a request: the API key, or the
/// app's own credentials in proxy mode.
typedef AuthHeaders = FutureOr<Map<String, String>> Function();

/// [url] without credentials, query or fragment: safe to show in messages.
String safeUrl(Uri url) {
  if (!url.hasScheme || !url.hasAuthority) return url.path;
  final port = url.hasPort ? ':${url.port}' : '';
  return '${url.scheme}://${url.host}$port${url.path}';
}

/// Sends REST calls with retries, rate limiting and error mapping.
final class HttpTransport {
  /// Creates a transport. [client] is closed by [close] only when
  /// [ownsClient] is true. [random], [sleep], [now] and [clock] are for
  /// tests.
  HttpTransport({
    required this.baseUrl,
    required AuthHeaders authHeaders,
    required http.Client client,
    required bool ownsClient,
    Map<String, String> defaultHeaders = const {},
    this.timeout,
    this.deadline,
    this.maxRetries = 2,
    this.rateLimitPreflight = true,
    RateLimitTracker? rateLimits,
    RuleSet rules = errorRules,
    double Function()? random,
    Future<void> Function(Duration)? sleep,
    DateTime Function()? now,
    Duration Function()? clock,
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
        _now = now ?? _utcNow,
        _clock = clock ?? _monotonic();

  /// Where requests go. Paths are appended to its path.
  final Uri baseUrl;

  /// Overrides every per-call default deadline when set.
  final Duration? timeout;

  /// The total time for one call, retries and waits included, when set.
  final Duration? deadline;

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
  final Duration Function() _clock;

  static Future<void> _delay(Duration duration) => Future.delayed(duration);

  static DateTime _utcNow() => DateTime.now().toUtc();

  static Duration Function() _monotonic() {
    final stopwatch = Stopwatch()..start();
    return () => stopwatch.elapsed;
  }

  static final String? _userAgent = () {
    final platformPart = platform.userAgentPlatform();
    return platformPart == null
        ? null
        : 'echonova-dart/$packageVersion ($platformPart)';
  }();

  /// The `User-Agent` the SDK sends, or `null` where the platform doesn't
  /// allow setting it (browsers).
  static String? get userAgent => _userAgent;

  /// The default headers sent with every API request.
  Map<String, String> get defaultHeaders => _defaultHeaders;

  /// The authentication headers: the API key, or the proxy `auth` hook's
  /// headers. Called before every attempt.
  Future<Map<String, String>> authHeaders() async => {...await _authHeaders()};

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
  /// response with its envelope unwrapped, or throws an
  /// [EchoNovaException].
  Future<ApiResponse> send(ApiRequest request) => perform(request, (response) {
        response.data; // Unwraps the envelope, so a malformed one is retried.
        return response;
      });

  /// Sends [request], retrying as the retry table allows, and returns
  /// [finish] of the successful response.
  ///
  /// When [finish] throws [MalformedEnvelope] or [FormatException], the body
  /// broke the API contract: a GET is retried once, and anything else
  /// becomes a [ProtocolException].
  Future<R> perform<R>(
    ApiRequest request,
    R Function(ApiResponse response) finish,
  ) async {
    final method = request.method.toUpperCase();
    final policy = request.maxRetries == null
        ? _policy
        : RetryPolicy(
            maxRetries: request.maxRetries,
            rules: _rules,
            random: _random,
          );
    final bucket = request.bucket ?? '$method ${request.path}';
    final attemptLimit = _attemptLimit(request);
    final total = request.deadline ?? deadline;
    final deadlineAt = total == null ? null : _clock() + total;
    final uri = resolve(request.path, request.query);
    final upload = request.upload;
    var retries = 0;
    DateTime? firstSentAt;
    var noResponseSeen = false;

    bool fits(Duration delay) =>
        deadlineAt == null || _clock() + delay < deadlineAt;

    Future<void> retryAfter(RetryDecision decision) async {
      retries++;
      await _sleep(decision.delay);
    }

    while (true) {
      final wait = rateLimits.waitTime(bucket, preflight: rateLimitPreflight);
      if (wait > Duration.zero) {
        if (wait > policy.maxRetryAfter || !fits(wait)) {
          final seconds = (wait.inMilliseconds / 1000).ceil();
          throw RateLimitException(
            message: 'The rate limit for $bucket clears in $seconds s, '
                'longer than this call may wait; '
                '${firstSentAt == null ? 'nothing was sent' : 'the request '
                    'was not sent again'}.',
            retryAfter: wait,
            sentAt: firstSentAt,
          );
        }
        await _sleep(wait);
      }

      var limit = attemptLimit;
      if (deadlineAt != null) {
        final remaining = deadlineAt - _clock();
        if (remaining <= Duration.zero) {
          throw APITimeoutException(
            'The deadline expired before the request was sent',
            kind: TimeoutKind.total,
            sentAt: firstSentAt,
          );
        }
        if (remaining < limit) limit = remaining;
      }

      final headers = {
        ...await commonHeaders(),
        'Accept': request.expectEnvelope ? 'application/json' : '*/*',
        ...request.headers,
        if (upload == null)
          if (request.contentType case final contentType?)
            'Content-Type': contentType,
      };
      final sentAt = _now();
      firstSentAt ??= sentAt;
      final _Attempt attempt;
      try {
        attempt = await _attempt(
          (abort) => _build(method, uri, headers, request, abort),
          limit,
        );
      } on _TransportFailure catch (failure) {
        if (failure.phase == FailurePhase.noResponse) noResponseSeen = true;
        final decision = policy.decideTransport(
          method,
          failure.phase,
          retriesDone: retries,
          bodyReplayable: upload?.isReplayable ?? true,
        );
        if (_mayRetry(method, decision) && fits(decision.delay)) {
          await retryAfter(decision);
          continue;
        }
        throw failure.toException(
          mayHaveExecuted: executedFlag(decision.mayHaveExecuted, method),
          sentAt: firstSentAt,
          deadline: limit,
          retryDisabledReason: decision.reason == RetryReason.bodyNotReplayable
              ? 'body_not_replayable'
              : null,
        );
      }

      final rateLimit = rateLimits.observe(bucket, attempt.headers);
      final status = attempt.statusCode;
      if (status >= 200 && status < 300) {
        final response = attempt.toResponse(
          method: method,
          expectEnvelope: request.expectEnvelope,
          rateLimit: rateLimit,
          attempts: retries + 1,
          secret: request.secretResponse,
        );
        String reason;
        Object cause;
        try {
          return finish(response);
        } on MalformedEnvelope catch (malformed) {
          reason = malformed.message;
          cause = malformed;
        } on FormatException catch (malformed) {
          reason = malformed.message;
          cause = malformed;
        }
        final decision = policy.decideTransport(
          method,
          FailurePhase.malformedSuccess,
          retriesDone: retries,
        );
        if (_mayRetry(method, decision) && fits(decision.delay)) {
          await retryAfter(decision);
          continue;
        }
        throw attempt.protocolException(
          'EchoNova sent an unreadable response: $reason',
          mayHaveExecuted: executedFlag(decision.mayHaveExecuted, method),
          sentAt: firstSentAt,
          cause: cause,
          keepBody: !request.secretResponse,
        );
      }
      if (status < 400 || status > 599) {
        // Redirects are not followed, and the API doesn't send them.
        throw attempt.protocolException(
          'unexpected HTTP status $status',
          mayHaveExecuted: executedFlag(Executed.unknown, method),
          sentAt: firstSentAt,
        );
      }

      final error = buildStatusError(
        status,
        attempt.headers,
        attempt.body,
        method: method,
        sentAt: firstSentAt,
        reasonPhrase: attempt.reasonPhrase,
        rules: _rules,
      );
      final rule = _rules.ruleById(error.rule!)!;
      if (method == 'DELETE' &&
          noResponseSeen &&
          rule.error == 'JobNotFoundError') {
        // An earlier attempt whose response was lost deleted the job.
        return finish(attempt.toResponse(
          method: method,
          expectEnvelope: request.expectEnvelope,
          rateLimit: rateLimit,
          attempts: retries + 1,
          data: const {'deleted': true},
          alreadyDeleted: true,
        ));
      }
      final serverRetryAfter = error.retryAfter;
      if (rule.blocksBucket && serverRetryAfter != null) {
        rateLimits.block(bucket, serverRetryAfter);
      }
      final decision = policy.decideStatus(
        method,
        rule,
        retriesDone: retries,
        retryAfter: serverRetryAfter,
        bodyReplayable: upload?.isReplayable ?? true,
      );
      if (_mayRetry(method, decision) && fits(decision.delay)) {
        await retryAfter(decision);
        continue;
      }
      throw error;
    }
  }

  Duration _attemptLimit(ApiRequest request) {
    final fixed = request.timeout ?? timeout;
    if (fixed != null) return fixed;
    final base = request.timeoutProfile.duration;
    final upload = request.upload;
    return upload == null ? base : base + uploadAllowance(upload.length);
  }

  /// The safety invariant, checked on top of the retry table: a POST (or any
  /// method that isn't idempotent) that may have run is never sent again.
  static bool _mayRetry(String method, RetryDecision decision) {
    if (!decision.retry) return false;
    const idempotent = {'GET', 'HEAD', 'DELETE', 'OPTIONS'};
    return idempotent.contains(method) ||
        decision.mayHaveExecuted == Executed.no;
  }

  static http.BaseRequest _build(
    String method,
    Uri uri,
    Map<String, String> headers,
    ApiRequest request,
    Future<void> abort,
  ) {
    final upload = request.upload;
    if (upload != null) {
      return http.AbortableMultipartRequest(method, uri, abortTrigger: abort)
        ..followRedirects = false
        ..headers.addAll(headers)
        ..fields.addAll(request.form ?? const {})
        ..files.add(http.MultipartFile(
          'file',
          upload.open(),
          upload.length,
          filename: upload.filename,
          contentType: MediaType.parse(upload.contentType),
        ));
    }
    final plain = http.AbortableRequest(method, uri, abortTrigger: abort)
      ..followRedirects = false
      ..headers.addAll(headers);
    if (request.body case final body?) plain.bodyBytes = body;
    return plain;
  }

  Future<_Attempt> _attempt(
    http.BaseRequest Function(Future<void> abort) build,
    Duration deadline,
  ) async {
    final abort = Completer<void>();
    final request = build(abort.future);
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
    final response = await _open(_client, request);
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

  static Future<http.StreamedResponse> _open(
    http.Client client,
    http.BaseRequest request,
  ) async {
    try {
      return await client.send(request);
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
  }

  static bool _isNetworkError(Object error) =>
      error is http.ClientException ||
      error is TimeoutException ||
      platform.isNetworkError(error);

  /// Downloads [url] into [sink] with [client], sending no credentials.
  ///
  /// Signed links point at third-party storage, so neither the API key nor
  /// the default headers go there. Transient failures are retried; a 403
  /// means the link expired and throws [DownloadExpiredException].
  Future<void> download(
    Uri url,
    DownloadSink sink, {
    required http.Client client,
  }) async {
    final shown = safeUrl(url);
    var retries = 0;
    while (true) {
      await sink.reset();
      final ({int status, Map<String, String> headers, String? reason}) got;
      try {
        got = await _downloadAttempt(client, url, sink);
      } on _TransportFailure catch (failure) {
        final decision =
            _policy.decideTransport('GET', failure.phase, retriesDone: retries);
        if (decision.retry) {
          retries++;
          await _sleep(decision.delay);
          continue;
        }
        throw failure.toDownloadException(shown);
      }
      final status = got.status;
      if (status >= 200 && status < 300) return;
      if (status == 403) {
        throw DownloadExpiredException(
          'The download link was refused (HTTP 403); it has probably '
          'expired. Get the job again for a fresh link: $shown',
          url: shown,
        );
      }
      final (:rule, :retryAfter) =
          classifyResponse(status, got.headers, const [], rules: _rules);
      final decision = _policy.decideStatus(
        'GET',
        rule,
        retriesDone: retries,
        retryAfter: retryAfter,
      );
      if (decision.retry) {
        retries++;
        await _sleep(decision.delay);
        continue;
      }
      // The storage body is not kept: it can echo details of the link.
      throw buildStatusError(
        status,
        got.headers,
        const [],
        method: 'GET',
        reasonPhrase: 'Download of $shown failed: '
            '${got.reason ?? 'HTTP $status'}',
        rules: _rules,
      );
    }
  }

  Future<({int status, Map<String, String> headers, String? reason})>
      _downloadAttempt(http.Client client, Uri url, DownloadSink sink) async {
    final abort = Completer<void>();
    final request =
        http.AbortableRequest('GET', url, abortTrigger: abort.future)
          ..followRedirects = true
          ..maxRedirects = 5;
    if (_userAgent case final userAgent?) {
      request.headers['User-Agent'] = userAgent;
    }
    void cancel() {
      if (!abort.isCompleted) abort.complete();
    }

    final expired = Completer<http.StreamedResponse>();
    final timer = Timer(downloadHeadersTimeout, () {
      cancel();
      expired.completeError(const _TransportFailure.timeout());
    });
    final http.StreamedResponse response;
    try {
      response = await Future.any([_open(client, request), expired.future]);
    } finally {
      timer.cancel();
    }
    final status = response.statusCode;
    final ok = status >= 200 && status < 300;
    try {
      final chunks = response.stream.timeout(
        downloadReadTimeout,
        onTimeout: (events) {
          cancel();
          events.addError(const _TransportFailure.timeout());
          events.close();
        },
      );
      await for (final chunk in chunks) {
        if (ok) await sink.add(chunk);
      }
    } on _TransportFailure {
      rethrow;
    } on Object catch (error) {
      if (!_isNetworkError(error)) rethrow;
      throw _TransportFailure.noResponse(error);
    }
    return (
      status: status,
      headers: response.headers,
      reason: response.reasonPhrase
    );
  }

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

  ApiResponse toResponse({
    required String method,
    required bool expectEnvelope,
    required RateLimitInfo? rateLimit,
    required int attempts,
    Object? data,
    bool alreadyDeleted = false,
    bool secret = false,
  }) =>
      ApiResponse(
        statusCode: statusCode,
        headers: headers,
        body: body,
        rateLimit: rateLimit,
        attempts: attempts,
        method: method,
        expectEnvelope: expectEnvelope,
        alreadyDeleted: alreadyDeleted,
        secret: secret,
        data: data,
      );

  ProtocolException protocolException(
    String message, {
    required bool? mayHaveExecuted,
    required DateTime? sentAt,
    Object? cause,
    bool keepBody = true,
  }) {
    final requestId = header(headers, 'x-request-id');
    return ProtocolException(
      message:
          requestId == null ? message : '$message (request_id: $requestId)',
      statusCode: statusCode,
      requestId: requestId,
      headers: headers,
      rawBody: keepBody ? parseErrorBody(body).rawBody : null,
      mayHaveExecuted: mayHaveExecuted,
      rule: 'malformed_success',
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

  String get _suffix {
    final reason = switch (cause) {
      final http.ClientException error => error.message,
      null => null,
      final Object error => '$error',
    };
    return reason == null ? '' : ': $reason';
  }

  APIConnectionException toException({
    required bool? mayHaveExecuted,
    required DateTime? sentAt,
    required Duration deadline,
    String? retryDisabledReason,
  }) {
    final suffix = _suffix;
    final ran = mayHaveExecuted ?? false
        ? '. It may have run and been charged: check recent jobs before '
            'sending it again'
        : '';
    if (phase == FailurePhase.connect) {
      return timedOut
          ? APITimeoutException(
              'Timed out connecting to EchoNova$suffix',
              kind: TimeoutKind.connect,
              mayHaveExecuted: mayHaveExecuted,
              sentAt: sentAt,
              retryDisabledReason: retryDisabledReason,
              cause: cause,
            )
          : APIConnectionException(
              'Could not connect to EchoNova$suffix',
              mayHaveExecuted: mayHaveExecuted,
              sentAt: sentAt,
              retryDisabledReason: retryDisabledReason,
              cause: cause,
            );
    }
    return timedOut
        ? APITimeoutException(
            'No response from EchoNova within ${_seconds(deadline)}$ran',
            kind: TimeoutKind.total,
            mayHaveExecuted: mayHaveExecuted,
            sentAt: sentAt,
            retryDisabledReason: retryDisabledReason,
            cause: cause,
          )
        : APIConnectionException(
            'The connection to EchoNova failed before a response arrived'
            '$suffix$ran',
            mayHaveExecuted: mayHaveExecuted,
            sentAt: sentAt,
            retryDisabledReason: retryDisabledReason,
            cause: cause,
          );
  }

  APIConnectionException toDownloadException(String shown) {
    if (timedOut) {
      return APITimeoutException(
        'The download of $shown timed out',
        kind: TimeoutKind.read,
        cause: cause,
      );
    }
    return APIConnectionException(
      'The download of $shown failed${phase == FailurePhase.connect ? ' to '
          'connect' : ''}$_suffix',
      cause: cause,
    );
  }

  static String _seconds(Duration duration) {
    final seconds = duration.inMilliseconds / 1000;
    return seconds == seconds.roundToDouble()
        ? '${seconds.round()} s'
        : '${seconds.toStringAsFixed(3)} s';
  }
}
