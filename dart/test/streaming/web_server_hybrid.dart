/// Runs the mock server in the VM for the web transport tests (which run
/// compiled to JavaScript, where there is no `dart:io`).
library;

// `stream_channel` comes with `package:test`; only this test helper uses it.
import 'package:stream_channel/stream_channel.dart';

import 'mock_server.dart';

/// Sends the server's port, then answers commands until the test ends.
Future<void> hybridMain(StreamChannel<Object?> channel) async {
  final server = await MockServer.start();
  channel.sink.add(server.url.port);
  await for (final message in channel.stream) {
    switch (message) {
      case ['reject', final int status, final String text]:
        server.rejections.add(Rejection(status, text));
        channel.sink.add('ok');
      case ['attempts']:
        channel.sink.add([
          for (final attempt in server.attempts)
            {
              'path': attempt.path,
              // Isolates spawned from a URI can only send plain maps.
              'query': {...attempt.query},
              'authorization': attempt.headers['authorization'],
              'rejected': attempt.rejected,
            },
        ]);
      case ['stt']:
        channel.sink.add([
          for (final conn in server.sttConns)
            {'audio': conn.audio.length, 'closeCode': conn.closeCode},
        ]);
    }
  }
  await server.stop();
}
