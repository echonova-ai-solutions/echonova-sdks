/// `dart:io` WebSocket transport.
///
/// The upgrade is sent by hand with `HttpClient`, so when EchoNova rejects a
/// handshake (401, 402, 403, 429, 503) the SDK sees the status, headers and
/// JSON body, and maps them to the same exceptions as a REST call.
/// `WebSocket.connect` would hide all three.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import '../core/classifier.dart';
import '../core/envelope.dart';
import '../errors.dart';
import 'ws_connection.dart';

/// The GUID RFC 6455 appends to the key to compute `Sec-WebSocket-Accept`.
const String _webSocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/// At most this much of a rejected handshake's body is read.
const int _maxErrorBodyBytes = 65536;

/// Opens a WebSocket to [uri] (`wss://` or `ws://`), sending [headers] on the
/// upgrade request.
///
/// Throws an [APIStatusException] subclass when the server answers with
/// anything but `101 Switching Protocols`, [APIConnectionException] when the
/// connection fails, and [APITimeoutException] when it takes longer than
/// [openTimeout].
Future<WebSocketConnection> openWebSocket(
  Uri uri, {
  Map<String, String> headers = const {},
  Duration openTimeout = defaultOpenTimeout,
}) =>
    openWebSocketWith(uri, headers: headers, openTimeout: openTimeout);

/// [openWebSocket], with the HTTP client and the key's random source
/// injectable for tests.
Future<WebSocketConnection> openWebSocketWith(
  Uri uri, {
  Map<String, String> headers = const {},
  Duration openTimeout = defaultOpenTimeout,
  HttpClient Function()? createHttpClient,
  Random? random,
}) async {
  final httpUri = uri.replace(
    scheme: switch (uri.scheme) {
      'wss' || 'https' => 'https',
      'ws' || 'http' => 'http',
      _ => throw ArgumentError.value(uri, 'uri', 'not a ws:// or wss:// URL'),
    },
  );
  final client = (createHttpClient ?? HttpClient.new)()
    ..connectionTimeout = openTimeout;
  final rng = random ?? Random.secure();
  final key = base64.encode([for (var i = 0; i < 16; i++) rng.nextInt(256)]);
  final sentAt = DateTime.now().toUtc();

  final HttpClientResponse response;
  try {
    response =
        await _sendUpgrade(client, httpUri, headers, key).timeout(openTimeout);
  } on Object catch (error) {
    client.close(force: true);
    if (error is TimeoutException ||
        (error is SocketException &&
            error.message.startsWith('HTTP connection timed out'))) {
      throw APITimeoutException(
        'Timed out opening the stream (limit $openTimeout)',
        kind: TimeoutKind.connect,
        sentAt: sentAt,
        cause: error,
      );
    }
    if (error is! IOException) rethrow;
    throw APIConnectionException(
      'Could not open the stream: ${_describe(error)}',
      sentAt: sentAt,
      cause: error,
    );
  }

  final responseHeaders = <String, String>{};
  response.headers.forEach((name, values) {
    responseHeaders[name] = values.join(', ');
  });

  if (response.statusCode != HttpStatus.switchingProtocols) {
    List<int> body;
    try {
      body =
          await _readLimited(response, _maxErrorBodyBytes).timeout(openTimeout);
    } on Object {
      body = const []; // classify on the status alone
    } finally {
      client.close(force: true);
    }
    final status = response.statusCode;
    if (status < 400 || status > 599) {
      throw ProtocolException(
        message: 'The server did not upgrade the stream (HTTP $status)',
        statusCode: status,
        requestId: header(responseHeaders, 'x-request-id'),
        headers: responseHeaders,
        rawBody: parseErrorBody(body).rawBody,
        transport: TransportKind.websocket,
        sentAt: sentAt,
      );
    }
    throw buildStatusError(
      status,
      responseHeaders,
      body,
      method: 'WS',
      transport: TransportKind.websocket,
      sentAt: sentAt,
      reasonPhrase: response.reasonPhrase,
    );
  }

  final expectedAccept =
      base64.encode(sha1.convert(ascii.encode('$key$_webSocketGuid')).bytes);
  final connectionTokens = (responseHeaders['connection'] ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase());
  final valid =
      responseHeaders['upgrade']?.trim().toLowerCase() == 'websocket' &&
          connectionTokens.contains('upgrade') &&
          responseHeaders['sec-websocket-accept']?.trim() == expectedAccept;

  final Socket socket;
  try {
    socket = await response.detachSocket();
  } on Object catch (error) {
    client.close(force: true);
    if (error is! IOException) rethrow;
    throw APIConnectionException(
      'The stream closed during the upgrade: ${_describe(error)}',
      sentAt: sentAt,
      cause: error,
    );
  }
  // The detached socket no longer belongs to the client.
  client.close();
  if (!valid) {
    socket.destroy();
    throw ProtocolException(
      message: 'The server switched protocols without a valid WebSocket '
          'handshake',
      statusCode: response.statusCode,
      requestId: header(responseHeaders, 'x-request-id'),
      headers: responseHeaders,
      transport: TransportKind.websocket,
      sentAt: sentAt,
    );
  }
  return _IoWebSocketConnection(socket, Map.unmodifiable(responseHeaders));
}

Future<HttpClientResponse> _sendUpgrade(
  HttpClient client,
  Uri uri,
  Map<String, String> headers,
  String key,
) async {
  final request = await client.openUrl('GET', uri);
  request.followRedirects = false;
  headers.forEach(request.headers.set);
  request.headers
    ..set(HttpHeaders.connectionHeader, 'Upgrade')
    ..set(HttpHeaders.upgradeHeader, 'websocket')
    ..set('Sec-WebSocket-Key', key)
    ..set('Sec-WebSocket-Version', '13')
    ..set(HttpHeaders.cacheControlHeader, 'no-cache');
  return request.close();
}

Future<Uint8List> _readLimited(Stream<List<int>> stream, int limit) async {
  final builder = BytesBuilder(copy: false);
  await for (final chunk in stream) {
    builder.add(chunk);
    if (builder.length >= limit) break;
  }
  return builder.takeBytes();
}

String _describe(Object error) => switch (error) {
      final SocketException e => [e.message, e.osError?.message ?? '']
          .where((part) => part.isNotEmpty)
          .join(': '),
      final HttpException e => e.message,
      final TlsException e => e.message,
      _ => '$error',
    };

final class _IoWebSocketConnection implements WebSocketConnection {
  _IoWebSocketConnection(Socket upgraded, this.handshakeHeaders)
      : _socket = WebSocket.fromUpgradedSocket(
          upgraded,
          serverSide: false,
          compression: CompressionOptions.compressionOff,
        );

  final WebSocket _socket;

  @override
  final Map<String, String> handshakeHeaders;

  @override
  late final Stream<Object> messages = _socket.map(
    (message) => switch (message) {
      final String text => text,
      final Uint8List bytes => bytes,
      final List<int> bytes => Uint8List.fromList(bytes),
      _ => throw StateError('unexpected WebSocket message: $message'),
    },
  );

  @override
  void sendText(String text) => _socket.add(text);

  @override
  void sendBytes(List<int> bytes) => _socket.add(bytes);

  @override
  Future<void> close([int? code, String? reason]) =>
      _socket.close(code, reason);

  @override
  int? get closeCode => _socket.closeCode;

  @override
  String? get closeReason => _socket.closeReason;

  @override
  String? get handshakeRequestId => header(handshakeHeaders, 'x-request-id');
}
