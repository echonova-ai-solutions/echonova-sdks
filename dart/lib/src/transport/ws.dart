/// Opens WebSocket streams, with the implementation chosen at compile time:
/// a manual HTTP upgrade on `dart:io` platforms (so a rejected handshake's
/// status and body are visible), and the browser's `WebSocket` on the web
/// (proxy mode only).
library;

export 'ws_connection.dart';
export 'ws_web.dart' if (dart.library.io) 'ws_io.dart';
