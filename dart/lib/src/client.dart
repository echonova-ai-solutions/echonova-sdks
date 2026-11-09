/// The EchoNova client and its configuration.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:meta/meta.dart';

import 'core/rate_limit.dart';
import 'core/retry.dart';
import 'errors.dart';
import 'platform/files.dart' as files;
import 'platform/platform.dart' as platform;
import 'polling.dart';
import 'resources/agents.dart';
import 'resources/context.dart';
import 'resources/sound_cleaning.dart';
import 'resources/speech_to_text.dart';
import 'resources/text_to_speech.dart';
import 'runtime.dart';
import 'transport/http_transport.dart';

/// The EchoNova API's address.
final Uri defaultBaseUrl = Uri.parse('https://api.echonova.ai');

/// The client for the EchoNova API: Text to Speech, Speech to Text, Sound
/// Cleaning, website widgets and agent sessions.
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
/// Reuse one client for the life of your program: it keeps the connection
/// pool and the rate-limit state. [close] it when you are done.
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
  /// * [deadline], when set, limits the total time of each call: every
  ///   attempt, retry delay and rate-limit wait included.
  /// * [maxRetries] is the number of retries per call (default 2). A POST
  ///   that may already have run is never retried, because it could be
  ///   charged twice.
  /// * [httpClient] lets you configure proxies, certificates or connection
  ///   pooling. You keep ownership: [close] doesn't close it.
  /// * [downloadHttpClient] is used for signed download links, which point
  ///   at storage, not at EchoNova. It must not add credentials. By default
  ///   the SDK creates one.
  /// * [defaultHeaders] are sent with every API request (not downloads).
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
    Duration? deadline,
    int maxRetries = 2,
    http.Client? httpClient,
    http.Client? downloadHttpClient,
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
    _validate(url, maxRetries, timeout, deadline);
    final authorization = {'Authorization': 'Bearer $key'};
    return EchoNova._(
      baseUrl: url,
      apiKey: key,
      authHeaders: () => authorization,
      timeout: timeout,
      deadline: deadline,
      maxRetries: maxRetries,
      defaultHeaders: defaultHeaders ?? const {},
      rateLimitPreflight: rateLimitPreflight,
      shared: _Shared(
        httpClient: httpClient,
        downloadClient: downloadHttpClient,
        runtime: ClientRuntime(),
      ),
      ownsShared: true,
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
    Duration? deadline,
    int maxRetries = 2,
    http.Client? httpClient,
    http.Client? downloadHttpClient,
    Map<String, String>? defaultHeaders,
    bool rateLimitPreflight = true,
  }) {
    _validate(baseUrl, maxRetries, timeout, deadline);
    return EchoNova._(
      baseUrl: baseUrl,
      apiKey: null,
      authHeaders: auth,
      timeout: timeout,
      deadline: deadline,
      maxRetries: maxRetries,
      defaultHeaders: defaultHeaders ?? const {},
      rateLimitPreflight: rateLimitPreflight,
      shared: _Shared(
        httpClient: httpClient,
        downloadClient: downloadHttpClient,
        runtime: ClientRuntime(),
      ),
      ownsShared: true,
    );
  }

  EchoNova._({
    required this.baseUrl,
    required String? apiKey,
    required AuthHeaders authHeaders,
    required this.timeout,
    required this.deadline,
    required this.maxRetries,
    required Map<String, String> defaultHeaders,
    required this.rateLimitPreflight,
    required _Shared shared,
    required bool ownsShared,
  })  : _apiKey = apiKey,
        _authHeaders = authHeaders,
        _shared = shared,
        _ownsShared = ownsShared,
        _transport = HttpTransport(
          baseUrl: baseUrl,
          authHeaders: authHeaders,
          client: shared.httpClient,
          ownsClient: false,
          defaultHeaders: defaultHeaders,
          timeout: timeout,
          deadline: deadline,
          maxRetries: maxRetries,
          rateLimitPreflight: rateLimitPreflight,
          rateLimits: shared.rateLimits,
          random: shared.runtime.random,
          sleep: shared.runtime.sleep,
          now: shared.runtime.now,
          clock: shared.runtime.clock,
        );

  static void _validate(
    Uri baseUrl,
    int maxRetries,
    Duration? timeout,
    Duration? deadline,
  ) {
    if (!baseUrl.isAbsolute ||
        !(baseUrl.scheme == 'https' || baseUrl.scheme == 'http') ||
        baseUrl.host.isEmpty) {
      throw ArgumentError.value(
        safeUrl(baseUrl),
        'baseUrl',
        'must be an absolute http or https URL',
      );
    }
    if (maxRetries < 0) {
      throw ArgumentError.value(maxRetries, 'maxRetries', 'must be >= 0');
    }
    if (timeout != null && timeout <= Duration.zero) {
      throw ArgumentError.value(timeout, 'timeout', 'must be positive');
    }
    if (deadline != null && deadline <= Duration.zero) {
      throw ArgumentError.value(deadline, 'deadline', 'must be positive');
    }
  }

  final String? _apiKey;
  final AuthHeaders _authHeaders;
  final _Shared _shared;
  final bool _ownsShared;
  final HttpTransport _transport;

  late final ClientContext _context = ClientContext(
    client: this,
    transport: _transport,
    runtime: _shared.runtime,
    pollLimiter: _shared.pollLimiter,
  );

  /// Where requests go: the EchoNova API, or your proxy.
  final Uri baseUrl;

  /// The per-attempt time limit for every call, or `null` for the per-call
  /// defaults.
  final Duration? timeout;

  /// The total time limit for each call, or `null` for none.
  final Duration? deadline;

  /// Retries per call.
  final int maxRetries;

  /// Whether calls wait for an exhausted rate-limit window to reset before
  /// sending.
  final bool rateLimitPreflight;

  /// Whether this client calls your backend proxy instead of EchoNova.
  bool get isProxy => _apiKey == null;

  /// Text to Speech: `generate`, voices and jobs.
  late final TextToSpeech textToSpeech = TextToSpeech(_context);

  /// Speech to Text: `transcribe`, jobs and transcript export.
  late final SpeechToText speechToText = SpeechToText(_context);

  /// Sound Cleaning: `clean` and its jobs.
  late final SoundCleaning soundCleaning = SoundCleaning(_context);

  /// Website widgets: tickets for private widgets.
  late final Widgets widgets = Widgets(_context);

  /// Agents: sessions with your agents.
  late final Agents agents = Agents(_context);

  /// The rate limits seen in the most recent response of each operation
  /// (`textToSpeech.jobs.get`, ...).
  Map<String, RateLimitInfo> get rateLimits => _transport.rateLimits.snapshot();

  /// A copy with some options changed. It shares this client's
  /// connections, rate-limit state and polling budget; close this client,
  /// not the copy.
  EchoNova withOptions({
    Duration? timeout,
    Duration? deadline,
    int? maxRetries,
    Map<String, String>? defaultHeaders,
    bool? rateLimitPreflight,
  }) {
    final retries = maxRetries ?? this.maxRetries;
    _validate(baseUrl, retries, timeout, deadline);
    return EchoNova._(
      baseUrl: baseUrl,
      apiKey: _apiKey,
      authHeaders: _authHeaders,
      timeout: timeout ?? this.timeout,
      deadline: deadline ?? this.deadline,
      maxRetries: retries,
      defaultHeaders: defaultHeaders ?? _transport.defaultHeaders,
      rateLimitPreflight: rateLimitPreflight ?? this.rateLimitPreflight,
      shared: _shared,
      ownsShared: false,
    );
  }

  /// Downloads a signed link (`audioUrl`, `outputUrl`) and returns its
  /// bytes.
  ///
  /// It sends neither your API key nor your proxy credentials: the link
  /// points at storage. Transient failures are retried. An expired link
  /// throws [DownloadExpiredException]: get the job again for a fresh one.
  Future<Uint8List> download(String url) async {
    final sink = _MemorySink();
    await _transport.download(
      _downloadUri(url),
      sink,
      client: _shared.downloadClient(),
    );
    return sink.takeBytes();
  }

  /// Downloads a signed link to [path] and returns the file's path. When
  /// [path] is a folder, the file keeps the link's name.
  ///
  /// The file appears only when the download is complete. Not available on
  /// the web (it throws [UnsupportedEnvironmentException]); use [download]
  /// there. Otherwise as for [download].
  Future<String> downloadTo(String url, String path) async {
    final uri = _downloadUri(url);
    final sink = await files.FileDownloadSink.open(path, _fileName(uri));
    try {
      await _transport.download(uri, sink, client: _shared.downloadClient());
      return await sink.commit();
    } on Object {
      await sink.discard();
      rethrow;
    }
  }

  static Uri _downloadUri(String url) {
    if (url.trim().isEmpty) {
      throw UsageException('No download URL: the job has no output yet');
    }
    final Uri uri;
    try {
      uri = Uri.parse(url.trim());
    } on FormatException catch (error) {
      throw UsageException('Not a download URL', cause: error);
    }
    if (!uri.isAbsolute ||
        !(uri.scheme == 'https' || uri.scheme == 'http') ||
        uri.host.isEmpty) {
      throw UsageException(
        'Not a download URL: ${safeUrl(uri)} (expected an http or https '
        'link)',
      );
    }
    return uri;
  }

  static String _fileName(Uri uri) {
    final segments = uri.pathSegments.where((s) => s.isNotEmpty);
    final name = segments.isEmpty ? '' : segments.last;
    if (name.isEmpty ||
        name == '.' ||
        name == '..' ||
        name.contains('/') ||
        name.contains(r'\')) {
      return 'download';
    }
    return name;
  }

  // ---------------------------------------------------------------------------
  // For the streaming layer. Not part of the public API.
  // ---------------------------------------------------------------------------

  /// The WebSocket base for [baseUrl]: `wss` for `https`, `ws` for `http`,
  /// with the same host and path. Stream paths (`/v1/...`) are appended to
  /// it.
  @internal
  Uri get wsBaseUri => _transport.websocketUri('');

  /// The headers for a WebSocket upgrade: the default headers, then the API
  /// key (direct mode) or the proxy `auth` hook's headers. Call it before
  /// every connection attempt, so a proxy token can be refreshed.
  /// `User-Agent` is separate ([userAgent]).
  @internal
  Future<Map<String, String>> streamHeaders() async => {
        ..._transport.defaultHeaders,
        ...await _transport.authHeaders(),
      };

  /// The `User-Agent` the SDK sends, or `null` where the platform doesn't
  /// allow setting it (browsers).
  @internal
  String? get userAgent => HttpTransport.userAgent;

  /// The retry policy for this client's settings ([maxRetries], the shared
  /// retry table and this client's randomness).
  @internal
  RetryPolicy get retryPolicy =>
      RetryPolicy(maxRetries: maxRetries, random: _shared.runtime.random);

  /// The clocks, sleep and randomness this client uses.
  @internal
  ClientRuntime get runtime => _shared.runtime;

  /// Closes the HTTP connections this client opened. Doesn't close an
  /// `httpClient` you passed in. On a `withOptions` copy it does nothing.
  void close() {
    if (_ownsShared) _shared.close();
  }

  @override
  String toString() {
    final key = _apiKey;
    return key == null
        ? 'EchoNova.proxy(baseUrl: ${safeUrl(baseUrl)})'
        : 'EchoNova(baseUrl: ${safeUrl(baseUrl)}, '
            'apiKey: ${redactApiKey(key)})';
  }
}

/// State shared by a client and its `withOptions` copies: connections,
/// rate limits, the polling budget and the runtime.
final class _Shared {
  _Shared({
    required http.Client? httpClient,
    required http.Client? downloadClient,
    required this.runtime,
  })  : httpClient = httpClient ??
            platform.createDefaultHttpClient(connectTimeout: connectTimeout),
        ownsHttpClient = httpClient == null,
        _downloadClient = downloadClient,
        rateLimits = RateLimitTracker(clock: runtime.clock),
        pollLimiter = PollLimiter(clock: runtime.clock);

  final http.Client httpClient;
  final bool ownsHttpClient;
  final ClientRuntime runtime;
  final RateLimitTracker rateLimits;
  final PollLimiter pollLimiter;
  http.Client? _downloadClient;
  var _ownsDownloadClient = false;

  http.Client downloadClient() {
    final existing = _downloadClient;
    if (existing != null) return existing;
    _ownsDownloadClient = true;
    return _downloadClient =
        platform.createDefaultHttpClient(connectTimeout: connectTimeout);
  }

  void close() {
    if (ownsHttpClient) httpClient.close();
    if (_ownsDownloadClient) {
      _downloadClient?.close();
      _downloadClient = null;
      _ownsDownloadClient = false;
    }
  }
}

final class _MemorySink implements DownloadSink {
  var _builder = BytesBuilder(copy: false);

  @override
  Future<void> reset() async {
    _builder = BytesBuilder(copy: false);
  }

  @override
  Future<void> add(List<int> chunk) async {
    _builder.add(chunk);
  }

  Uint8List takeBytes() => _builder.takeBytes();
}

/// The transport of [client]. Internal: for tests and the streaming layer.
HttpTransport transportOf(EchoNova client) => client._transport;

/// A copy of [client] that uses [runtime] for its clocks, sleeps and
/// randomness, with its own rate-limit state and polling budget. It uses
/// the same HTTP clients without owning them: close [client]. Internal: for
/// tests.
EchoNova clientWithRuntime(EchoNova client, ClientRuntime runtime) {
  final shared = client._shared;
  return EchoNova._(
    baseUrl: client.baseUrl,
    apiKey: client._apiKey,
    authHeaders: client._authHeaders,
    timeout: client.timeout,
    deadline: client.deadline,
    maxRetries: client.maxRetries,
    defaultHeaders: client._transport.defaultHeaders,
    rateLimitPreflight: client.rateLimitPreflight,
    shared: _Shared(
      httpClient: shared.httpClient,
      downloadClient: shared._downloadClient,
      runtime: runtime,
    ),
    ownsShared: true,
  );
}

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
