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
  _IoWebSocketConnection(this._raw, this.handshakeHeaders)
      : _socket = WebSocket.fromUpgradedSocket(
          _raw,
          serverSide: false,
          compression: CompressionOptions.compressionOff,
        ) {
    // Everything the SDK sends goes through one controller bound to the
    // socket, so the socket's backpressure (it pauses its source while the
    // OS send buffer is full) shows up as pause and resume here.
    _out = StreamController<Object>(
      sync: true,
      onPause: () => _paused = true,
      onResume: () {
        _paused = false;
        _wake();
      },
      onCancel: () {
        _gone = true;
        _wake();
      },
    );
    _bound = _socket.addStream(_out.stream).then<void>(
          (_) {},
          onError: (Object _) {},
        );
  }

  /// The upgraded TCP (or TLS) socket, kept to drop the connection at once.
  final Socket _raw;
  final WebSocket _socket;
  late final StreamController<Object> _out;
  late final Future<void> _bound;
  bool _paused = false;
  bool _gone = false;
  bool _closing = false;
  Completer<void>? _resumed;

  void _wake() {
    final waiter = _resumed;
    _resumed = null;
    waiter?.complete();
  }

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
  void sendText(String text) {
    if (_gone || _closing) return;
    _out.add(text);
  }

  @override
  void sendBytes(List<int> bytes) {
    if (_gone || _closing) return;
    _out.add(bytes);
  }

  @override
  Future<void> flush() async {
    while (_paused && !_gone && !_closing) {
      await (_resumed ??= Completer<void>()).future;
    }
  }

  @override
  Future<void> close([int? code, String? reason]) async {
    if (!_closing) {
      _closing = true;
      _wake();
      // The socket's sink is bound to [_out]; it must be released before the
      // close frame can be sent.
      unawaited(_out.close());
    }
    await _bound;
    try {
      await _socket.close(code, reason);
    } on Object {
      // Already closed or failed; [messages] reports how it ended.
    }
  }

  @override
  void abort() {
    _closing = true;
    _wake();
    _raw.destroy();
  }

  @override
  int? get closeCode {
    final code = _socket.closeCode;
    if (code == null) return null;
    // When the socket fails, or a frame from the server can't be read,
    // dart:io closes with a code of its own (1002 or 1007) and no reason. No
    // close frame came from the server: the connection was lost.
    if (_socket.closeReason == null && !_closing) return abnormalClosure;
    return code;
  }

  @override
  String? get closeReason => _socket.closeReason;

  @override
  String? get handshakeRequestId => header(handshakeHeaders, 'x-request-id');
}
