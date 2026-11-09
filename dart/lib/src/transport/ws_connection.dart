/// The platform-neutral interface of an open WebSocket stream.
library;

import 'dart:typed_data';

/// How long opening a stream (connect, TLS and the HTTP upgrade) may take.
const Duration defaultOpenTimeout = Duration(seconds: 10);

/// An open WebSocket connection to an EchoNova stream.
abstract interface class WebSocketConnection {
  /// Messages from the server: a [String] for a text frame, a [Uint8List]
  /// for a binary frame. The stream closes when the connection does.
  Stream<Object> get messages;

  /// Sends a text frame.
  void sendText(String text);

  /// Sends a binary frame.
  void sendBytes(List<int> bytes);

  /// Closes the connection with an optional [code] and [reason].
  Future<void> close([int? code, String? reason]);

  /// The close code the server sent, once the connection has closed.
  int? get closeCode;

  /// The close reason the server sent, once the connection has closed.
  String? get closeReason;

  /// The `X-Request-Id` of the upgrade response.
  String? get handshakeRequestId;

  /// The headers of the upgrade response.
  Map<String, String> get handshakeHeaders;
}
