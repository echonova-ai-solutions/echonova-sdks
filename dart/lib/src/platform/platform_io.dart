/// `dart:io` implementation of the platform helpers.
library;

import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

/// Whether this is a web platform (browser or web worker).
const bool isWeb = false;

/// Reads an environment variable.
String? environmentVariable(String name) => Platform.environment[name];

/// The platform part of the `User-Agent` header, such as
/// `dart/3.5.0; linux`.
String? userAgentPlatform() {
  final version = Platform.version.split(' ').first;
  return 'dart/$version; ${Platform.operatingSystem}';
}

/// The HTTP client the SDK uses when none is given: redirects off, and a
/// connect timeout so a connect failure is told apart from a lost response.
http.Client createDefaultHttpClient({required Duration connectTimeout}) =>
    IOClient(HttpClient()..connectionTimeout = connectTimeout);

/// The error number for "connection refused" on this operating system.
final int _connectionRefused = Platform.isWindows
    ? 10061
    : Platform.isMacOS || Platform.isIOS
        ? 61
        : 111;

/// Whether [error] proves that no byte of the request was sent: the host
/// name didn't resolve, the connection was refused, connecting timed out, or
/// the TLS handshake failed. Anything else might have happened after the
/// request was sent, so it is treated as a lost response.
bool isConnectFailure(Object error) {
  if (error is HandshakeException) return true;
  if (error is! SocketException) return false;
  final message = error.message.toLowerCase();
  final osMessage = error.osError?.message.toLowerCase() ?? '';
  return message.contains('failed host lookup') ||
      message.contains('connection refused') ||
      osMessage.contains('connection refused') ||
      error.osError?.errorCode == _connectionRefused ||
      isConnectTimeout(error);
}

/// Whether [error] is the connect timeout of `HttpClient`.
bool isConnectTimeout(Object error) =>
    error is SocketException &&
    error.message.startsWith('HTTP connection timed out');

/// Whether [error] is a network failure (rather than a bug).
bool isNetworkError(Object error) => error is IOException;
