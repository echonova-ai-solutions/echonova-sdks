@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:echonova_ai/src/transport/ws.dart' as ws;
import 'package:echonova_ai/src/transport/ws_io.dart';
import 'package:test/test.dart';

import 'support/spec.dart';

/// A local server whose upgrade handler is [handler].
Future<HttpServer> serve(void Function(HttpRequest request) handler) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen(handler);
  addTearDown(() => server.close(force: true));
  return server;
}

Uri streamUri(HttpServer server) =>
    Uri.parse('ws://127.0.0.1:${server.port}/v1/text-to-speech/stream');

/// Rejects the upgrade like EchoNova does: a status and a JSON envelope.
void Function(HttpRequest) reject(
  int status,
  String? message, {
  Map<String, String> headers = const {},
  String? rawBody,
}) =>
    (request) {
      final response = request.response..statusCode = status;
      response.headers.set('x-request-id', 'req-ws-$status');
      headers.forEach(response.headers.set);
      if (rawBody != null) {
        response.headers.contentType = ContentType.text;
        response.write(rawBody);
      } else {
        response.headers.contentType = ContentType.json;
        response.add(envelope(status, message));
      }
      unawaited(response.close());
    };

void main() {
  test('a 401 handshake surfaces the status, body and request ID', () async {
    final server = await serve(reject(401, 'Unauthorized'));
    await expectLater(
      openWebSocket(streamUri(server)),
      throwsA(isA<AuthenticationException>()
          .having((e) => e.statusCode, 'statusCode', 401)
          .having((e) => e.errorMessage, 'errorMessage', 'Unauthorized')
          .having((e) => e.requestId, 'requestId', 'req-ws-401')
          .having((e) => e.transport, 'transport', TransportKind.websocket)
          .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isFalse)
          .having((e) => e.rule, 'rule', 'unauthorized')
          .having((e) => e.rawBody, 'rawBody', contains('"success":false'))
          .having((e) => e.sentAt, 'sentAt', isNotNull)),
    );
  });

  test('a throttled handshake carries Retry-After', () async {
    final server = await serve(reject(
      429,
      'ThrottlerException: Too Many Requests',
      headers: {'retry-after': '5'},
    ));
    await expectLater(
      openWebSocket(streamUri(server)),
      throwsA(isA<RateLimitException>()
          .having((e) => e.retryAfter, 'retryAfter', const Duration(seconds: 5))
          .having((e) => e.rule, 'rule', 'throttled')),
    );
  });

  for (final (status, message, check) in [
    (
      429,
      'Too many concurrent streams',
      isA<ConcurrencyLimitException>(),
    ),
    (
      429,
      'Monthly spending limit exhausted',
      isA<SpendingLimitException>(),
    ),
    (
      402,
      'Insufficient subscription balance',
      isA<InsufficientBalanceException>(),
    ),
    (
      403,
      'This API key does not have access to Text-to-Speech services',
      isA<PermissionDeniedException>(),
    ),
    (503, 'Streaming is not enabled', isA<FeatureNotEnabledException>()),
  ]) {
    test('a $status "$message" handshake', () async {
      final server = await serve(reject(status, message));
      await expectLater(openWebSocket(streamUri(server)), throwsA(check));
    });
  }

  test('a non-JSON 503 from the hosting proxy', () async {
    final server =
        await serve(reject(503, null, rawBody: 'no healthy upstream'));
    await expectLater(
      openWebSocket(streamUri(server)),
      throwsA(isA<ServiceUnavailableException>()
          .having((e) => e.fromProxy, 'fromProxy', isTrue)
          .having(
              (e) => e.errorMessage, 'errorMessage', 'no healthy upstream')),
    );
  });

  test('a 200 instead of an upgrade is a protocol error', () async {
    final server = await serve((request) {
      request.response.write('hello');
      unawaited(request.response.close());
    });
    await expectLater(
      openWebSocket(streamUri(server)),
      throwsA(isA<ProtocolException>()
          .having((e) => e.statusCode, 'statusCode', 200)
          .having((e) => e.transport, 'transport', TransportKind.websocket)),
    );
  });

  test('a successful upgrade gives a working connection', () async {
    late HttpHeaders seen;
    final server = await serve((request) async {
      seen = request.headers;
      request.response.headers.set('x-request-id', 'req-ok');
      final socket = await WebSocketTransformer.upgrade(request);
      socket.listen(socket.add, onDone: socket.close);
    });
    final connection = await openWebSocket(
      streamUri(server).replace(queryParameters: {'sample_rate': '16000'}),
      headers: {'Authorization': 'Bearer test-token', 'User-Agent': 'ua/1'},
    );
    expect(seen.value('authorization'), 'Bearer test-token');
    expect(seen.value('user-agent'), 'ua/1');
    expect(seen.value('upgrade'), 'websocket');
    expect(seen.value('sec-websocket-version'), '13');
    expect(base64.decode(seen.value('sec-websocket-key')!), hasLength(16));
    expect(connection.handshakeRequestId, 'req-ok');

    final messages = StreamIterator(connection.messages);
    connection.sendText('{"type":"ping"}');
    expect(await messages.moveNext(), isTrue);
    expect(messages.current, '{"type":"ping"}');
    connection.sendBytes([1, 2, 3, 4]);
    expect(await messages.moveNext(), isTrue);
    expect(messages.current, isA<Uint8List>());
    expect(messages.current, [1, 2, 3, 4]);

    await connection.close(1000, 'bye');
    expect(await messages.moveNext(), isFalse);
    expect(connection.closeCode, 1000);
  });

  test('an upgrade with a wrong accept key is a protocol error', () async {
    final server = await serve((request) async {
      final socket = await request.response.detachSocket(writeHeaders: false);
      socket.write('HTTP/1.1 101 Switching Protocols\r\n'
          'Upgrade: websocket\r\n'
          'Connection: Upgrade\r\n'
          'Sec-WebSocket-Accept: bm90IHRoZSByaWdodCBrZXk=\r\n'
          '\r\n');
      await socket.flush();
      await socket.close();
    });
    await expectLater(
      openWebSocket(streamUri(server)),
      throwsA(isA<ProtocolException>()
          .having((e) => e.statusCode, 'statusCode', 101)),
    );
  });

  test('a server that never answers times out', () async {
    final server = await serve((request) {
      // Hold the request open without answering.
    });
    await expectLater(
      openWebSocket(
        streamUri(server),
        openTimeout: const Duration(milliseconds: 200),
      ),
      throwsA(isA<APITimeoutException>()
          .having((e) => e.kind, 'kind', TimeoutKind.connect)
          .having((e) => e.mayHaveExecuted, 'mayHaveExecuted', isFalse)),
    );
  });

  test('a refused connection is a connection error', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final uri = streamUri(server);
    await server.close(force: true);
    await expectLater(
      openWebSocket(uri),
      throwsA(isA<APIConnectionException>()
          .having((e) => e, 'type', isNot(isA<APITimeoutException>()))
          .having((e) => e.message, 'message', contains('refused'))),
    );
  });

  test('only ws and wss URLs are accepted', () {
    expect(
      () => openWebSocket(Uri.parse('ftp://example.com/stream')),
      throwsArgumentError,
    );
  });

  test('the conditional export picks the dart:io transport', () async {
    final server = await serve(reject(401, 'Unauthorized'));
    await expectLater(
      ws.openWebSocket(streamUri(server)),
      throwsA(isA<AuthenticationException>()),
    );
  });
}
