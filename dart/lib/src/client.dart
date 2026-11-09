/// The EchoNova client and its configuration.
library;

import 'dart:async';

import 'package:http/http.dart' as http;

import 'core/rate_limit.dart';
import 'errors.dart';
import 'platform/platform.dart' as platform;
import 'transport/http_transport.dart';

/// The EchoNova API's address.
final Uri defaultBaseUrl = Uri.parse('https://api.echonova.ai');

/// The client for the EchoNova API: Text to Speech, Speech to Text and Sound
/// Cleaning.
///
/// There are two ways to create one:
///
/// * [EchoNova.new] calls EchoNova directly with an API key. Use it in
///   server-side Dart only: never ship an API key in an app.
/// * [EchoNova.proxy] calls your own backend, which holds the key and
///   forwards requests to EchoNova. Use it in Flutter apps (mobile, desktop
///   and web).
///
/// ```dart
/// // Server-side Dart
/// final client = EchoNova(apiKey: Platform.environment['ECHONOVA_API_KEY']);
///
/// // Flutter app, through your backend
/// final app = EchoNova.proxy(
///   baseUrl: Uri.parse('https://api.example.com/echonova'),
///   auth: () async => {'Authorization': 'Bearer ${await session.token()}'},
/// );
/// ```
///
/// Reuse one client for the life of your program, and [close] it when you
/// are done.
class EchoNova {
  /// Creates a client that calls EchoNova with an API key.
  ///
  /// * [apiKey] defaults to the `ECHONOVA_API_KEY` environment variable.
  ///   Surrounding whitespace is removed.
  /// * [baseUrl] defaults to `ECHONOVA_BASE_URL`, then to
  ///   [defaultBaseUrl].
  /// * [timeout], when set, limits every attempt of every call. Otherwise
  ///   each kind of call has its own limit (longer for uploads and
  ///   synchronous speech processing).
  /// * [maxRetries] is the number of retries per call (default 2). A POST
  ///   that may already have run is never retried, because it could be
  ///   charged twice.
  /// * [httpClient] lets you configure proxies, certificates or connection
  ///   pooling. You keep ownership: [close] doesn't close it.
  /// * [defaultHeaders] are sent with every request.
  /// * [rateLimitPreflight]: when the last response said no requests remain
  ///   in the rate-limit window, wait for the window to reset instead of
  ///   being throttled (default `true`).
  ///
  /// Throws [UsageException] when there is no API key, and
  /// [UnsupportedEnvironmentException] in a browser unless
  /// [dangerouslyAllowBrowser] is set: anyone can read a key shipped to a
  /// browser. Use [EchoNova.proxy] there instead.
  factory EchoNova({
    String? apiKey,
    Uri? baseUrl,
    Duration? timeout,
    int maxRetries = 2,
    http.Client? httpClient,
    Map<String, String>? defaultHeaders,
    bool rateLimitPreflight = true,
    bool dangerouslyAllowBrowser = false,
  }) {
    final key =
        (apiKey ?? platform.environmentVariable('ECHONOVA_API_KEY'))?.trim();
    if (key == null || key.isEmpty) {
      throw UsageException(
        'No API key. Pass apiKey or set the ECHONOVA_API_KEY environment '
        'variable. In apps, use EchoNova.proxy so the key stays on your '
        'server.',
      );
    }
    if (platform.isWeb && !dangerouslyAllowBrowser) {
      throw UnsupportedEnvironmentException(
        'An API key in a browser can be read by anyone who opens the page. '
        'Use EchoNova.proxy with your own backend instead, or pass '
        'dangerouslyAllowBrowser: true if you accept the risk.',
      );
    }
    final fromEnvironment = platform.environmentVariable('ECHONOVA_BASE_URL');
    final url = baseUrl ??
        (fromEnvironment == null || fromEnvironment.trim().isEmpty
            ? defaultBaseUrl
            : Uri.parse(fromEnvironment.trim()));
    final authorization = {'Authorization': 'Bearer $key'};
    return EchoNova._(
      baseUrl: url,
      apiKey: key,
      authHeaders: () => authorization,
      timeout: timeout,
      maxRetries: maxRetries,
      httpClient: httpClient,
      defaultHeaders: defaultHeaders,
      rateLimitPreflight: rateLimitPreflight,
    );
  }

  /// Creates a client that calls your own backend proxy at [baseUrl], which
  /// adds the API key and forwards requests to EchoNova. Use this in apps.
  ///
  /// The SDK appends API paths to [baseUrl]: with
  /// `https://api.example.com/echonova`, a Text to Speech job is created
  /// with `POST https://api.example.com/echonova/v1/text-to-speech`.
  ///
  /// [auth] returns your app's own credentials, as headers. It is called
  /// before every attempt, so it can refresh a token. On the web you can
  /// also authenticate with cookies by passing an [httpClient] that sends
  /// them.
  ///
  /// The other options are as for [EchoNova.new].
  factory EchoNova.proxy({
    required Uri baseUrl,
    required FutureOr<Map<String, String>> Function() auth,
    Duration? timeout,
    int maxRetries = 2,
    http.Client? httpClient,
    Map<String, String>? defaultHeaders,
    bool rateLimitPreflight = true,
  }) =>
      EchoNova._(
        baseUrl: baseUrl,
        apiKey: null,
        authHeaders: auth,
        timeout: timeout,
        maxRetries: maxRetries,
        httpClient: httpClient,
        defaultHeaders: defaultHeaders,
        rateLimitPreflight: rateLimitPreflight,
      );

  EchoNova._({
    required this.baseUrl,
    required String? apiKey,
    required AuthHeaders authHeaders,
    required this.timeout,
    required this.maxRetries,
    required http.Client? httpClient,
    required Map<String, String>? defaultHeaders,
    required bool rateLimitPreflight,
  }) : _apiKey = apiKey {
    if (!baseUrl.isAbsolute ||
        !(baseUrl.scheme == 'https' || baseUrl.scheme == 'http') ||
        baseUrl.host.isEmpty) {
      throw ArgumentError.value(
        _safeUrl(baseUrl),
        'baseUrl',
        'must be an absolute http or https URL',
      );
    }
    if (maxRetries < 0) {
      throw ArgumentError.value(maxRetries, 'maxRetries', 'must be >= 0');
    }
    final limit = timeout;
    if (limit != null && limit <= Duration.zero) {
      throw ArgumentError.value(limit, 'timeout', 'must be positive');
    }
    _transport = HttpTransport(
      baseUrl: baseUrl,
      authHeaders: authHeaders,
      client: httpClient ??
          platform.createDefaultHttpClient(connectTimeout: connectTimeout),
      ownsClient: httpClient == null,
      defaultHeaders: defaultHeaders ?? const {},
      timeout: timeout,
      maxRetries: maxRetries,
      rateLimitPreflight: rateLimitPreflight,
    );
  }

  final String? _apiKey;
  late final HttpTransport _transport;

  /// Where requests go: the EchoNova API, or your proxy.
  final Uri baseUrl;

  /// The per-attempt time limit for every call, or `null` for the per-call
  /// defaults.
  final Duration? timeout;

  /// Retries per call.
  final int maxRetries;

  /// Whether this client calls your backend proxy instead of EchoNova.
  bool get isProxy => _apiKey == null;

  /// The rate limits seen in the most recent response of each operation.
  Map<String, RateLimitInfo> get rateLimits => _transport.rateLimits.snapshot();

  // ---------------------------------------------------------------------------
  // Resources go here: `textToSpeech`, `speechToText` and `soundCleaning`
  // (names in spec/mapping.json). Each method builds an `ApiRequest` and calls
  // `_transport.send`; streams open with `openWebSocket(
  // _transport.websocketUri(path), headers: await _transport.commonHeaders())`
  // from `transport/ws.dart`. They are added once the API surface (shared
  // with the Python SDK) is final.
  // ---------------------------------------------------------------------------

  /// Closes the HTTP connections this client opened. Doesn't close an
  /// `httpClient` you passed in.
  void close() => _transport.close();

  @override
  String toString() {
    final key = _apiKey;
    return key == null
        ? 'EchoNova.proxy(baseUrl: ${_safeUrl(baseUrl)})'
        : 'EchoNova(baseUrl: ${_safeUrl(baseUrl)}, '
            'apiKey: ${redactApiKey(key)})';
  }
}

/// The transport of [client]. Internal: for resource classes.
HttpTransport transportOf(EchoNova client) => client._transport;

/// Shows an API key as `ek_…c21d`: the prefix and, for long keys, the last
/// four characters.
String redactApiKey(String key) {
  const prefix = 'ek_';
  final hasPrefix = key.startsWith(prefix);
  final rest = hasPrefix ? key.substring(prefix.length) : key;
  final start = hasPrefix ? prefix : '';
  if (rest.length < 16) return '$start…';
  return '$start…${rest.substring(rest.length - 4)}';
}

/// [url] without credentials, query or fragment.
String _safeUrl(Uri url) {
  if (!url.hasScheme || !url.hasAuthority) return url.path;
  final port = url.hasPort ? ':${url.port}' : '';
  return '${url.scheme}://${url.host}$port${url.path}';
}
