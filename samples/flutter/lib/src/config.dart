/// Build-time configuration: where your proxy is, and the demo credential the
/// app signs in to it with.
///
/// ```sh
/// flutter run \
///   --dart-define=ECHONOVA_PROXY_URL=https://api.example.com/echonova \
///   --dart-define=PROXY_DEMO_TOKEN=change-me
/// ```
///
/// Neither value is an EchoNova API key. The key stays on the proxy.
library;

import 'package:flutter/foundation.dart';

const String _proxyUrl = String.fromEnvironment('ECHONOVA_PROXY_URL');
const String _demoToken = String.fromEnvironment('PROXY_DEMO_TOKEN');

/// A configuration the app refuses to run with.
final class ConfigException implements Exception {
  /// Creates the exception.
  const ConfigException(this.message);

  /// What is wrong, and how to fix it.
  final String message;

  @override
  String toString() => 'ConfigException: $message';
}

/// Where the app finds your proxy, and how it signs in to it.
final class AppConfig {
  const AppConfig._(this.proxyUrl, this.demoToken);

  /// Reads `--dart-define=ECHONOVA_PROXY_URL` and
  /// `--dart-define=PROXY_DEMO_TOKEN`.
  ///
  /// Throws [ConfigException] for a configuration that can't work or would
  /// be unsafe.
  factory AppConfig.fromEnvironment() => AppConfig.parse(
    proxyUrl: _proxyUrl,
    demoToken: _demoToken,
    isWeb: kIsWeb,
    platform: defaultTargetPlatform,
    isRelease: kReleaseMode,
  );

  /// Checks the values. With no [proxyUrl], uses a reference proxy running
  /// on this computer (see [localProxyUrl]).
  @visibleForTesting
  factory AppConfig.parse({
    required String proxyUrl,
    required String demoToken,
    required bool isWeb,
    required TargetPlatform platform,
    bool isRelease = false,
  }) {
    final text = proxyUrl.trim();
    final url = text.isEmpty
        ? localProxyUrl(isWeb: isWeb, platform: platform)
        : Uri.tryParse(text);
    if (url == null ||
        !url.isAbsolute ||
        !(url.scheme == 'https' || url.scheme == 'http') ||
        url.host.isEmpty) {
      throw ConfigException(
        'ECHONOVA_PROXY_URL must be an absolute http or https URL, such as '
        'https://api.example.com/echonova (got "$text").',
      );
    }
    if (url.host.toLowerCase() == 'api.echonova.ai') {
      throw const ConfigException(
        'ECHONOVA_PROXY_URL points at the EchoNova API. The app must call '
        'your own proxy, which holds the API key and forwards the calls.',
      );
    }
    if (isRelease && url.scheme == 'http' && !_isLocal(url.host)) {
      throw const ConfigException(
        'Release builds must reach the proxy over https.',
      );
    }
    final token = demoToken.trim();
    if (token.startsWith('ek_')) {
      throw const ConfigException(
        'PROXY_DEMO_TOKEN looks like an EchoNova API key (ek_...). Never put '
        'the API key in an app: anyone can extract it. It belongs in the '
        "proxy's ECHONOVA_API_KEY.",
      );
    }
    return AppConfig._(url, token);
  }

  /// The proxy's base URL. The SDK appends API paths to it, such as
  /// `/v1/text-to-speech/voices`.
  final Uri proxyUrl;

  /// DEMO ONLY: the reference proxy's `PROXY_DEMO_TOKEN`. Empty when not set.
  /// See `proxy_auth.dart`.
  final String demoToken;
}

/// A reference proxy running on this computer, as each platform reaches it
/// with the proxy's default `HOST=127.0.0.1` and `PORT=8080`.
Uri localProxyUrl({required bool isWeb, required TargetPlatform platform}) {
  final host = switch (platform) {
    // In a browser, the same site as a page served from localhost.
    _ when isWeb => 'localhost',
    // The Android emulator reaches the computer it runs on at 10.0.2.2.
    TargetPlatform.android => '10.0.2.2',
    // The iOS simulator shares the computer's network.
    _ => '127.0.0.1',
  };
  return Uri.parse('http://$host:8080/echonova');
}

bool _isLocal(String host) =>
    host == 'localhost' || host == '127.0.0.1' || host == '::1';
