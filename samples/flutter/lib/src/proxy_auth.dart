/// How the app signs in to YOUR proxy, and the EchoNova client built on it.
///
/// The app never holds an EchoNova API key. It sends its own user's
/// credentials to your proxy; the proxy checks them, adds the key and
/// forwards the call to EchoNova.
library;

import 'dart:convert';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'config.dart';

// =============================================================================
//  REPLACE THIS with your app's own sign-in.
//
//  `ProxyAuth.headers()` returns the credentials your proxy's `authenticate`
//  hook checks: typically your user's session or access token, fetched fresh
//  from your auth library (it is called before every request and every
//  stream connection, so it can refresh an expired token). For example:
//
//    final class MyAuth implements ProxyAuth {
//      @override
//      Future<Map<String, String>> headers() async =>
//          {'Authorization': 'Bearer ${await mySignIn.currentAccessToken()}'};
//    }
//
//  DemoTokenAuth below sends the reference proxy's static PROXY_DEMO_TOKEN,
//  which every user shares. It exists only so the sample runs out of the box.
// =============================================================================

/// Supplies the app's own credentials for your proxy.
abstract interface class ProxyAuth {
  /// The headers that identify the signed-in user to your proxy.
  Future<Map<String, String>> headers();
}

/// DEMO ONLY: sends the reference proxy's `PROXY_DEMO_TOKEN` as a bearer
/// token. Replace it with your real sign-in (see above).
final class DemoTokenAuth implements ProxyAuth {
  /// Sends [token], from `--dart-define=PROXY_DEMO_TOKEN`.
  const DemoTokenAuth(this.token);

  /// The demo token.
  final String token;

  @override
  Future<Map<String, String>> headers() async {
    if (token.isEmpty) {
      throw const ProxyAuthException(
        'No credentials for the proxy. Pass --dart-define=PROXY_DEMO_TOKEN=... '
        "(the proxy's PROXY_DEMO_TOKEN), or replace DemoTokenAuth with your "
        'own sign-in in lib/src/proxy_auth.dart.',
      );
    }
    return {'Authorization': 'Bearer $token'};
  }
}

/// The app could not get credentials for the proxy.
final class ProxyAuthException implements Exception {
  /// Creates the exception.
  const ProxyAuthException(this.message);

  /// What went wrong.
  final String message;

  @override
  String toString() => 'ProxyAuthException: $message';
}

/// Short-lived stream tokens, for the web.
///
/// Browsers can't send headers on a WebSocket. So on the web the app first
/// asks the reference proxy for a token (`POST <proxy>/stream-token`, with
/// the usual credentials), and the SDK adds it to the stream URL as
/// `?access_token=...`. The proxy removes it before forwarding the stream.
final class StreamTokens {
  /// Fetches tokens from the proxy at [proxyUrl], signed in with [auth].
  StreamTokens(
    this.proxyUrl,
    this.auth, {
    http.Client Function() httpClient = http.Client.new,
  }) : _newHttpClient = httpClient;

  /// The proxy's base URL.
  final Uri proxyUrl;

  /// The app's credentials.
  final ProxyAuth auth;

  final http.Client Function() _newHttpClient;

  /// The query parameters for one stream connection. The SDK calls this
  /// before every connection attempt.
  Future<Map<String, String>> query() async {
    final base = proxyUrl.path.endsWith('/')
        ? proxyUrl.path.substring(0, proxyUrl.path.length - 1)
        : proxyUrl.path;
    final headers = await auth.headers();
    final client = _newHttpClient();
    final http.Response response;
    try {
      response = await client.post(
        proxyUrl.replace(path: '$base/stream-token'),
        headers: headers,
      );
    } finally {
      client.close();
    }
    final body = response.statusCode == 200 ? _decode(response.body) : null;
    final token = body?['token'];
    if (token is! String || token.isEmpty) {
      throw ProxyAuthException(
        'The proxy refused a stream token (HTTP ${response.statusCode}).',
      );
    }
    return {'access_token': token};
  }

  static Map<String, Object?>? _decode(String body) {
    try {
      return switch (jsonDecode(body)) {
        final Map<String, Object?> map => map,
        _ => null,
      };
    } on FormatException {
      return null;
    }
  }
}

/// Creates the one EchoNova client the app uses, in proxy mode.
///
/// REST calls and (on Android and iOS) stream connections carry
/// [auth]'s headers. On the web, streams carry a stream token instead.
EchoNova createEchoNovaClient(AppConfig config, ProxyAuth auth) {
  final streamTokens = kIsWeb ? StreamTokens(config.proxyUrl, auth) : null;
  return EchoNova.proxy(
    baseUrl: config.proxyUrl,
    auth: auth.headers,
    streamQuery: streamTokens?.query,
  );
}
