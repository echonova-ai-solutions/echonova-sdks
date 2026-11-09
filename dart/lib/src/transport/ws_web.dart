/// Web stub for opening WebSocket streams.
library;

import 'ws_connection.dart';

/// Not available on the web yet.
///
/// Browsers can't set the `Authorization` header on a WebSocket, so on the
/// web EchoNova streams go through your own backend proxy (proxy mode),
/// authenticated by your app's cookies or session. That transport is not
/// built yet; this throws [UnsupportedError].
Future<WebSocketConnection> openWebSocket(
  Uri uri, {
  Map<String, String> headers = const {},
  Duration openTimeout = defaultOpenTimeout,
}) =>
    Future.error(
      UnsupportedError(
        'EchoNova streaming is not available on the web yet. Browsers cannot '
        'send an API key on a WebSocket, so web apps will stream through '
        'their own backend proxy (EchoNova.proxy) with cookie or session '
        'auth.',
      ),
    );
