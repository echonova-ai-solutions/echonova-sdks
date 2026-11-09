/// The dart:io WebSocket connection: backpressure, abort and close codes.
@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/streaming/link.dart' show pingFrame;
import 'package:echonova/src/streaming/options.dart';
import 'package:echonova/src/streaming/socket.dart';
import 'package:echonova/src/streaming/stream_errors.dart';
import 'package:echonova/src/transport/ws_io.dart';
import 'package:test/test.dart';

import 'mock_server.dart';

/// A server whose upgraded sockets are handed to [onSocket].
Future<Uri> serve(
  void Function(WebSocket socket, HttpRequest request) onSocket,
) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  addTearDown(() => server.close(force: true));
  server.listen((request) async {
    final socket = await WebSocketTransformer.upgrade(request);
    addTearDown(socket.close);
    onSocket(socket, request);
  });
  return Uri.parse('ws://127.0.0.1:${server.port}/v1/text-to-speech/stream');
}

void main() {
  test('flush() waits while the peer is not reading (backpressure)', () async {
    final accepted = Completer<WebSocket>();
    final uri = await serve((socket, _) => accepted.complete(socket));
    final connection = await openWebSocket(uri);
    addTearDown(connection.abort);
    final server = await accepted.future; // never listened to: not reading
    final frame = Uint8List(65536);
    var sent = 0;
    var blocked = false;
    while (sent < 256 * 1024 * 1024) {
      connection.sendBytes(frame);
      sent += frame.length;
      final drained = await connection
          .flush()
          .then((_) => true)
          .timeout(const Duration(milliseconds: 200), onTimeout: () => false);
      if (!drained) {
        blocked = true;
        break;
      }
    }
    expect(blocked, isTrue, reason: 'flush never waited after $sent bytes');
    final waiting = connection.flush();
    var received = 0;
    server.listen((message) => received += (message as List<int>).length);
    await waiting.timeout(const Duration(seconds: 10));
    expect(received, greaterThan(0));
    await server.close();
  });

  test('abort() drops the connection at once (1006)', () async {
    final uri = await serve((socket, _) => socket.listen(null));
    final connection = await openWebSocket(uri);
    final done = connection.messages.toList();
    connection.abort();
    await done.timeout(const Duration(seconds: 2));
    expect(connection.closeCode, anyOf(isNull, 1006));
    await connection.flush(); // never hangs on a dead connection
  });

  test('a dropped connection reports 1006', () async {
    final server = await MockServer.start();
    addTearDown(server.stop);
    final connection = await openWebSocket(
      server.url.replace(path: '/v1/text-to-speech/stream'),
    );
    final done = connection.messages.drain<void>();
    await Future<void>.delayed(const Duration(milliseconds: 50));
    server.abortAll(); // no close frame
    await done.timeout(const Duration(seconds: 2));
    expect(connection.closeCode, 1006);
    expect(
      closeError(CloseInfo(connection.closeCode!)),
      isA<StreamConnectionLostException>(),
    );
  });

  test('a server close code and reason pass through', () async {
    final uri = await serve((socket, _) {
      socket.listen(null);
      unawaited(socket.close(4008, 'idle_timeout'));
    });
    final connection = await openWebSocket(uri);
    await connection.messages.drain<void>();
    expect(connection.closeCode, 4008);
    expect(connection.closeReason, 'idle_timeout');
  });

  test('the link maps a silent peer to a lost connection', () async {
    final uri = await serve((socket, _) => socket.listen(null)); // no pongs
    final connection = await openWebSocket(uri);
    final closed = Completer<CloseInfo>();
    final link = Link(
      connection,
      StreamOptions(
        keepalive: const Duration(milliseconds: 30),
        pongTimeout: const Duration(milliseconds: 100),
      ),
      onText: (_) {},
      onBinary: (_) {},
      onClosed: closed.complete,
    );
    final info = await closed.future.timeout(const Duration(seconds: 2));
    expect(info.lostReason, contains('no pong'));
    expect(info.abnormal, isTrue);
    expect(link.closed, isTrue);
    expect(closeError(info), isA<Object>());
    expect(link.writeText(pingFrame), isFalse);
  });

  test('a local close is not an error', () async {
    final uri = await serve((socket, _) => socket.listen(null));
    final connection = await openWebSocket(uri);
    final closed = Completer<CloseInfo>();
    final link = Link(
      connection,
      StreamOptions(),
      onText: (_) {},
      onBinary: (_) {},
      onClosed: closed.complete,
    );
    await link.close();
    final info = await closed.future;
    expect(info.local, isTrue);
    expect(info.code, 1000);
    expect(closeError(info), isNull);
    expect(() => link.sendText(pingFrame), throwsA(isA<LinkClosed>()));
  });
}
