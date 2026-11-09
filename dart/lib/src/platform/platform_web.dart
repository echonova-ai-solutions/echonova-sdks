/// Web implementation of the platform helpers.
library;

import 'package:http/http.dart' as http;

/// Whether this is a web platform (browser or web worker).
const bool isWeb = true;

/// Reads an environment variable. Browsers have none.
String? environmentVariable(String name) => null;

/// The platform part of the `User-Agent` header. Browsers don't let pages
/// set `User-Agent`, so there is none.
String? userAgentPlatform() => null;

/// The HTTP client the SDK uses when none is given.
http.Client createDefaultHttpClient({required Duration connectTimeout}) =>
    http.Client();

/// Whether [error] proves that no byte of the request was sent. Browsers
/// report every network failure the same way, so this is never known.
bool isConnectFailure(Object error) => false;

/// Whether [error] is a timeout while connecting.
bool isConnectTimeout(Object error) => false;

/// Whether [error] is a network failure (rather than a bug).
bool isNetworkError(Object error) => false;
