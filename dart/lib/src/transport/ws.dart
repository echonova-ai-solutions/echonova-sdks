/// Opens WebSocket streams, with the implementation chosen at compile time:
/// a manual HTTP upgrade on `dart:io` platforms, and (for now) an
/// [UnsupportedError] on the web.
library;

export 'ws_connection.dart';
export 'ws_web.dart' if (dart.library.io) 'ws_io.dart';
