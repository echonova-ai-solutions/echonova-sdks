/// Browser WebSocket transport, for Flutter web and other web apps.
///
/// Browsers can't set headers on a WebSocket, and an API key in a web page
/// can be read by anyone, so on the web EchoNova streams only go through
/// your own backend proxy (proxy mode). The proxy authenticates the user by
/// the cookies the browser sends with the upgrade request, or by query
/// parameters (`StreamOptions.query`), then adds the API key upstream.
///
/// Browsers also hide why a handshake failed: the HTTP status, headers and
/// body of a rejected upgrade never reach the page. A failed handshake is
/// therefore an [APIConnectionException]; your proxy's logs have the cause.
///
/// Bound with `dart:js_interop` directly, so the package needs no
/// dependency for it.
library;

import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import '../errors.dart';
import 'ws_connection.dart';

/// The host of the EchoNova API. Browsers must not connect to it directly.
const String _apiHost = 'api.echonova.ai';

/// While more than this many bytes wait in the browser's send buffer,
/// [WebSocketConnection.flush] waits.
const int _maxBufferedBytes = 256 * 1024;

/// How often [WebSocketConnection.flush] checks the send buffer.
const Duration _flushPoll = Duration(milliseconds: 5);

/// How long to wait for the close event that should follow an error.
const Duration _closeFallback = Duration(seconds: 2);

const int _open = 1;

/// Whether the headers passed to [openWebSocket] reach the server. A browser
/// can't set headers on a WebSocket, so stream sessions don't even ask for
/// them (the proxy's `auth` hook isn't called for streams).
const bool sendsHeaders = false;

@JS('WebSocket')
extension type _BrowserSocket._(JSObject _) implements JSObject {
  external factory _BrowserSocket(String url);

  external set binaryType(String value);

  external int get readyState;

  external int get bufferedAmount;

  external void send(JSAny data);

  external void close();

  @JS('close')
  external void closeWith(int code, String reason);

  external set onopen(JSFunction? handler);

  external set onmessage(JSFunction? handler);

  external set onclose(JSFunction? handler);

  external set onerror(JSFunction? handler);
}

extension type _MessageEvent._(JSObject _) implements JSObject {
  external JSAny? get data;
}

extension type _CloseEvent._(JSObject _) implements JSObject {
  external int get code;

  external String get reason;
}

/// Opens a WebSocket to [uri] from a browser.
///
/// [headers] can't be sent by a browser and are ignored: authenticate the
/// stream with cookies, or with query parameters in [uri]. Connecting to the
/// EchoNova API itself throws [UnsupportedEnvironmentException]; connect to
/// your proxy instead.
///
/// Throws [APIConnectionException] when the browser can't open the stream
/// (it doesn't say why), and [APITimeoutException] when opening takes longer
/// than [openTimeout].
Future<WebSocketConnection> openWebSocket(
  Uri uri, {
  Map<String, String> headers = const {},
  Duration openTimeout = defaultOpenTimeout,
}) {
  if (uri.scheme != 'ws' && uri.scheme != 'wss') {
    throw ArgumentError.value(uri, 'uri', 'not a ws:// or wss:// URL');
  }
  if (uri.host.toLowerCase() == _apiHost) {
    return Future.error(
      UnsupportedEnvironmentException(
        'Browsers stream through your own backend proxy, never directly '
        'from the EchoNova API: a browser cannot send the API key on a '
        'WebSocket, and a key in a web page is readable by anyone. Use '
        'EchoNova.proxy with your backend URL.',
      ),
    );
  }
  final dropped =
      headers.keys.where((name) => name.toLowerCase() != 'user-agent').toList();
  final connection = _BrowserConnection(
    _BrowserSocket(uri.toString())..binaryType = 'arraybuffer',
    where: '${uri.scheme}://${uri.host}'
        '${uri.hasPort ? ':${uri.port}' : ''}${uri.path}',
    droppedHeaders: dropped,
  );
  return connection._opened.future.timeout(
    openTimeout,
    onTimeout: () {
      connection.abort();
      throw APITimeoutException(
        'Timed out opening the stream (limit $openTimeout)',
        kind: TimeoutKind.connect,
        sentAt: connection._sentAt,
      );
    },
  );
}

final class _BrowserConnection implements WebSocketConnection {
  _BrowserConnection(
    this._socket, {
    required String where,
    required List<String> droppedHeaders,
  })  : _where = where,
        _droppedHeaders = droppedHeaders {
    _socket
      ..onopen = _onOpen.toJS
      ..onmessage = _onMessage.toJS
      ..onclose = _onClose.toJS
      ..onerror = _onError.toJS;
  }

  final _BrowserSocket _socket;
  final String _where;
  final List<String> _droppedHeaders;
  final DateTime _sentAt = DateTime.now().toUtc();
  final Completer<WebSocketConnection> _opened = Completer();
  final StreamController<Object> _messages = StreamController();
  bool _closing = false;
  bool _finished = false;
  Timer? _errorFallback;
  int? _closeCode;
  String? _closeReason;

  void _onOpen(JSObject _) {
    if (!_opened.isCompleted) _opened.complete(this);
  }

  void _onMessage(_MessageEvent event) {
    if (_finished) return;
    final value = event.data.dartify();
    if (value is String) {
      _messages.add(value);
    } else if (value is ByteBuffer) {
      _messages.add(value.asUint8List());
    } else if (value is List<int>) {
      _messages.add(Uint8List.fromList(value));
    }
  }

  void _onError(JSObject _) {
    if (!_opened.isCompleted) {
      // Some runtimes never send the close event after a failed handshake.
      _failOpen(abnormalClosure);
      return;
    }
    // A close event follows; if the runtime never sends it, end here.
    _errorFallback ??=
        Timer(_closeFallback, () => _finish(abnormalClosure, ''));
  }

  void _onClose(_CloseEvent event) {
    if (!_opened.isCompleted) {
      _failOpen(event.code);
      return;
    }
    _finish(event.code, event.reason);
  }

  void _failOpen(int code) {
    _finish(code, '');
    final dropped = _droppedHeaders.isEmpty
        ? ''
        : ', so ${_droppedHeaders.join(', ')} was not sent';
    final hint = ' Browsers cannot send headers on a WebSocket$dropped: '
        'authenticate streams with cookies or query parameters '
        '(EchoNova.proxy streamQuery).';
    _opened.completeError(
      APIConnectionException(
        'The browser could not open the stream at $_where (close code '
        '$code). Browsers do not say why a WebSocket handshake failed: '
        'check that your proxy allows this stream, that the user is signed '
        'in, and the proxy logs.$hint',
        sentAt: _sentAt,
      ),
    );
  }

  void _finish(int code, String reason) {
    if (_finished) return;
    _finished = true;
    _errorFallback?.cancel();
    _closeCode = code;
    _closeReason = reason;
    _socket
      ..onopen = null
      ..onmessage = null
      ..onclose = null
      ..onerror = null;
    unawaited(_messages.close());
  }

  @override
  Stream<Object> get messages => _messages.stream;

  @override
  void sendText(String text) {
    if (_closing || _finished || _socket.readyState != _open) return;
    _socket.send(text.toJS);
  }

  @override
  void sendBytes(List<int> bytes) {
    if (_closing || _finished || _socket.readyState != _open) return;
    final data = bytes is Uint8List ? bytes : Uint8List.fromList(bytes);
    _socket.send(data.toJS);
  }

  @override
  Future<void> flush() async {
    while (
        !_closing && !_finished && _socket.bufferedAmount > _maxBufferedBytes) {
      await Future<void>.delayed(_flushPoll);
    }
  }

  @override
  Future<void> close([int? code, String? reason]) async {
    if (!_finished && !_closing) {
      _closing = true;
      if (code == null) {
        _socket.close();
      } else {
        _socket.closeWith(code, reason ?? '');
      }
    }
    await _messages.done;
  }

  @override
  void abort() {
    if (_finished) return;
    _closing = true;
    _socket.close();
    // A browser can't drop a connection without the closing handshake; stop
    // listening to it instead.
    _finish(abnormalClosure, '');
  }

  @override
  int? get closeCode => _closeCode;

  @override
  String? get closeReason => _closeReason;

  @override
  String? get handshakeRequestId => null;

  @override
  Map<String, String> get handshakeHeaders => const {};
}
