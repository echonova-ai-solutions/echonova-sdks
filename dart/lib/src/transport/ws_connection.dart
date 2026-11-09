/// The platform-neutral interface of an open WebSocket stream.
library;

import 'dart:typed_data';

/// How long opening a stream (connect, TLS and the HTTP upgrade) may take.
const Duration defaultOpenTimeout = Duration(seconds: 10);

/// The close code reported when a connection ended without a close frame.
const int abnormalClosure = 1006;

/// An open WebSocket connection to an EchoNova stream.
abstract interface class WebSocketConnection {
  /// Messages from the server: a [String] for a text frame, a [Uint8List]
  /// for a binary frame. The stream closes when the connection does, and
  /// never carries an error.
  Stream<Object> get messages;

  /// Sends a text frame. Frames are written whole and in order. Does
  /// nothing once the connection is closing.
  void sendText(String text);

  /// Sends a binary frame. Frames are written whole and in order. Does
  /// nothing once the connection is closing.
  void sendBytes(List<int> bytes);

  /// Completes once the transport's send buffer has room again
  /// (backpressure). Completes at once when nothing is waiting, and when the
  /// connection closes.
  Future<void> flush();

  /// Closes the connection with an optional [code] and [reason], and
  /// completes when the closing handshake is done.
  Future<void> close([int? code, String? reason]);

  /// Drops the connection at once, without the closing handshake.
  void abort();

  /// The close code, once the connection has closed: the code in the
  /// server's close frame, or [abnormalClosure] (1006) when the connection
  /// ended without one.
  int? get closeCode;

  /// The close reason the server sent, once the connection has closed.
  String? get closeReason;

  /// The `X-Request-Id` of the upgrade response, when the platform exposes
  /// it (never in a browser).
  String? get handshakeRequestId;

  /// The headers of the upgrade response (empty in a browser).
  Map<String, String> get handshakeHeaders;
}
