/// Live check (spike c): an unauthenticated WebSocket upgrade to EchoNova is
/// rejected with 401, and the SDK sees the status, JSON body and request ID.
///
/// It costs nothing (no key is sent) but uses the network, so it only runs
/// with ECHONOVA_LIVE=1:
///
///     ECHONOVA_LIVE=1 dart test test/live
@Tags(['live'])
@TestOn('vm')
library;

import 'dart:io';

import 'package:echonova/echonova.dart';
import 'package:echonova/src/transport/ws_io.dart';
import 'package:test/test.dart';

void main() {
  final enabled = Platform.environment['ECHONOVA_LIVE'] == '1';

  test(
    'an unauthenticated TTS stream handshake is rejected with 401',
    () async {
      final uri = Uri.parse('wss://api.echonova.ai/v1/text-to-speech/stream');
      try {
        final connection = await openWebSocket(
          uri,
          headers: {'User-Agent': 'echonova-dart/$packageVersion (live test)'},
        );
        await connection.close(1000);
        fail('the server accepted a stream without an API key');
      } on AuthenticationException catch (error) {
        // ignore: avoid_print
        print('status: ${error.statusCode}\n'
            'request id: ${error.requestId}\n'
            'error message: ${error.errorMessage}\n'
            'docs: ${error.docsUrl}\n'
            'rule: ${error.rule}\n'
            'content-type: ${error.headers['content-type']}\n'
            'body: ${error.rawBody}');
        expect(error.statusCode, 401);
        expect(error.requestId, isNotNull);
        expect(error.rawBody, contains('"success"'));
        expect(error.transport, TransportKind.websocket);
        expect(error.headers.keys, isNot(contains('x-ratelimit-limit')));
      }
    },
    skip: enabled ? false : 'live test: set ECHONOVA_LIVE=1 to run',
  );
}
