/// Speech to Text stream sessions: [SttSession].
///
/// A session never reconnects on its own: a new connection is a new session
/// with a new `sessionId`. `transcribeStream` builds reconnects on top.
library;

import 'dart:async';
import 'dart:typed_data';

import '../audio.dart' show pcmDuration;
import '../errors.dart';
import 'async_util.dart';
import 'link.dart';
import 'options.dart';
import 'socket.dart';
import 'stream_errors.dart';
import 'stt_protocol.dart';
import 'types.dart';

/// The `end_segment` frame.
const String endSegmentFrame = '{"type":"end_segment"}';

/// The `stop` frame.
const String stopFrame = '{"type":"stop"}';

/// How long `stop()` waits by default for the last transcripts.
const Duration defaultStopTimeout = Duration(seconds: 20);

/// The query parameters of a Speech to Text stream. Throws [ArgumentError]
/// for a sample rate that isn't a positive number of Hz.
Map<String, String> sttQuery(int sampleRate, String language, String encoding) {
  if (sampleRate <= 0) {
    throw ArgumentError.value(
      sampleRate,
      'sampleRate',
      'must be a positive number of Hz (the rate of the audio you send)',
    );
  }
  return {
    'sample_rate': '$sampleRate',
    'language': language,
    'encoding': encoding,
  };
}

/// A Speech to Text stream. Open one with `connectStt`.
///
/// Send PCM16LE mono audio with [sendAudio] (or pipe a microphone stream in
/// with [addStream] or [audioSink]), cut segments with [endSegment] when the
/// speaker pauses, and listen to [events] for transcripts. Finish with
/// [stop], which waits for the last transcripts.
///
/// If the session ends abnormally, [events] delivers every event already
/// received and then the error: transcripts that were already sent (and
/// charged) are never lost.
final class SttSession {
  SttSession._(
    this._options, {
    required int sampleRate,
    required String language,
    Map<String, Object?>? terminology,
    String encoding = 'pcm_s16le',
    Duration? waitForSlot,
    AttemptLimiter? limiter,
  })  : _clock = _options.clock,
        _url = _options.url(
          sttStreamPath,
          sttQuery(sampleRate, language, encoding),
        ),
        _terminology = terminology,
        _waitForSlot = waitForSlot,
        _limiter = limiter ??
            AttemptLimiter(
              maxAttempts: _options.maxConnectAttempts,
              window: _options.connectWindow,
            ),
        _protocol = SttProtocol(sampleRate);

  final StreamOptions _options;
  final StreamClock _clock;
  final Uri _url;
  final Map<String, Object?>? _terminology;
  final Duration? _waitForSlot;
  final AttemptLimiter _limiter;
  final SttProtocol _protocol;
  final Signal _changed = Signal();
  final Mutex _outLock = Mutex();
  final Mutex _terminologyLock = Mutex();
  final StreamController<SttEvent> _events = StreamController();
  Link? _link;

  /// The `X-Request-Id` of the handshake (not available in a browser).
  String? handshakeRequestId;

  /// The session's ID, from `session.started`. Quote it to support.
  String? get sessionId => _protocol.sessionId;

  /// The ID this session's job gets once it is saved (from
  /// `session.started`). Whether it was saved arrives at the end, in
  /// [SessionSaved] and in `stop()`'s [SessionSummary.savedStatus].
  String? get jobId => _protocol.jobId;

  /// The language the server confirmed.
  String? get language => _protocol.language;

  /// The sample rate of the audio you send.
  int get sampleRate => _protocol.sampleRate;

  /// Seconds from `session.started` until the server ends the session.
  double? get maxSessionSeconds => _protocol.maxSessionSeconds;

  /// When `session.started` arrived, on the options' clock.
  Duration? get startedAt => _protocol.startedAt;

  /// Where the session is in its life.
  SttState get state => _protocol.state;

  /// Whether the socket has closed.
  bool get isClosed => _protocol.closed;

  /// The error that ended the session, if it ended abnormally.
  EchoNovaException? get failure => _protocol.fatal;

  /// Totals from `session.ended`, once it has arrived (with `session.saved`,
  /// once that has too).
  SessionSummary? get summary => _protocol.summary();

  /// Audio sent so far.
  Duration get audioSent =>
      pcmDuration(_protocol.framer.bytesEmitted, _protocol.sampleRate);

  /// The session's events, in order: [Transcript], [TerminologySet],
  /// [StreamErrorEvent] (non-fatal), [SessionEnded], [SessionSaved] and
  /// [UnknownEvent]. The stream ends when the session does; when it ends
  /// abnormally, the buffered events come first and then the error.
  ///
  /// Single-subscription: listen once (or use [transcripts] instead).
  Stream<SttEvent> get events => _events.stream;

  /// Only the transcripts. Uses [events], so listen to one or the other.
  Stream<Transcript> get transcripts =>
      events.where((event) => event is Transcript).cast<Transcript>();

  // --- Sending ---------------------------------------------------------------

  /// Sends PCM16LE mono audio. It is copied, cut into frames of about
  /// 100 ms, and sent in order; waits while the socket's send buffer is
  /// full.
  ///
  /// Throws [SessionEndedException] once the session has ended or [stop]
  /// was called, or the session's error when it failed.
  Future<void> sendAudio(List<int> audio) {
    // Copied now: the caller may reuse its buffer as soon as this returns.
    final data = Uint8List.fromList(audio);
    return _outLock.run(() async {
      await _settle();
      for (final frame in _protocol.pushAudio(data)) {
        await _sendBytes(frame);
      }
    });
  }

  /// Sends every chunk of [source] with [sendAudio], in order. Completes
  /// when [source] is done; it doesn't stop the session.
  Future<void> addStream(Stream<List<int>> source) async {
    await for (final chunk in source) {
      await sendAudio(chunk);
    }
  }

  /// Sends [source] (see [addStream]), then [stop]s. Completes with the
  /// session's summary.
  Future<SessionSummary> feedFrom(Stream<List<int>> source) async {
    await addStream(source);
    return stop();
  }

  /// A [StreamConsumer] for `source.pipe(session.audioSink)`: it sends the
  /// audio, and its `close()` (called by `pipe` at the end) is [stop].
  StreamConsumer<List<int>> get audioSink => _AudioSink(this);

  /// Transcribes the audio sent since the last segment now (call it when
  /// the speaker pauses). Returns where the cut fell.
  Future<SegmentMark> endSegment() => _outLock.run(() async {
        await _settle();
        final (frames, mark) = _protocol.cut();
        for (final frame in frames) {
          await _sendBytes(frame);
        }
        await _sendText(endSegmentFrame);
        return mark;
      });

  /// Sets (or with `null`, clears) the terms for later segments. Waits for
  /// the server to confirm. Throws [InvalidRequestException] when the server
  /// rejects them.
  Future<TerminologySet> setTerminology(Map<String, Object?>? terminology) =>
      _terminologyLock.run(() async {
        await _outLock.run(() async {
          await _settle();
          await _sendText(_protocol.beginTerminology(terminology));
        });
        await _waitUntil(
          () => !_protocol.terminologyWaiting,
          _options.sessionStartTimeout,
          TimeoutKind.read,
        );
        final reply = _protocol.terminologyReply;
        if (reply is EchoNovaException) throw reply;
        if (reply is TerminologySet) return reply;
        throw SessionEndedException('no reply to the terminology frame');
      });

  /// Finishes: transcribes the remaining audio, waits for the last
  /// transcripts, `session.ended` and (when the server sends it)
  /// `session.saved`. The summary's `jobId` and `savedStatus` are `null` if
  /// `session.saved` did not come.
  ///
  /// Throws [APITimeoutException] after [timeout] (and drops the
  /// connection), or the session's error when it ended abnormally.
  Future<SessionSummary> stop({Duration? timeout = defaultStopTimeout}) async {
    final protocol = _protocol;
    if (!(protocol.closed ||
        protocol.stopRequested ||
        protocol.ended != null ||
        protocol.fatal != null)) {
      await _outLock.run(() async {
        if (protocol.closed ||
            protocol.stopRequested ||
            protocol.ended != null ||
            protocol.fatal != null) {
          return;
        }
        final (frames, dropped) = protocol.beginStop();
        if (dropped > 0) {
          streamLog(
            'dropped $dropped trailing byte at stop(): audio must be whole '
            '16-bit samples',
            level: 900,
          );
        }
        for (final frame in frames) {
          await _sendBytes(frame);
        }
        await _sendText(stopFrame);
      });
    }
    try {
      await _waitUntil(
        () => protocol.closed || protocol.ended != null,
        timeout,
        TimeoutKind.stopDrain,
      );
    } on APITimeoutException {
      _link?.abort(null);
      rethrow;
    }
    await _settle();
    final link = _link;
    if (!protocol.closed && link != null) {
      // No close after session.ended: close it ourselves.
      await link.close();
    }
    final error = protocol.fatal;
    if (error != null) throw error;
    final summary = protocol.summary();
    if (summary == null) {
      throw SessionEndedException('the session closed without session.ended');
    }
    return summary;
  }

  /// Closes now, without [stop]. Audio not yet transcribed is discarded.
  Future<void> close() async {
    if (!_protocol.closed && _protocol.ended == null) {
      streamLog(
        'closing a Speech to Text session without stop(); untranscribed '
        'audio is discarded',
        level: 900,
      );
    }
    await _link?.close();
  }

  // --- Internals -------------------------------------------------------------

  Future<SttSession> _start({bool afterAbnormal = false}) async {
    final connection = await openStream(
      _options,
      _url,
      limiter: _limiter,
      waitForSlot: _waitForSlot,
      afterAbnormal: afterAbnormal,
    );
    final link = Link(
      connection,
      _options,
      onText: _onText,
      onBinary: _onBinary,
      onClosed: _onClosed,
    );
    _link = link;
    handshakeRequestId = link.handshakeRequestId;
    try {
      await _waitUntil(
        () => _protocol.started || _protocol.closed,
        _options.sessionStartTimeout,
        TimeoutKind.sessionStart,
      );
      if (!_protocol.started) {
        throw _protocol.fatal ??
            StreamClosedException(
              'the Speech to Text session closed before it started',
            );
      }
      final terminology = _terminology;
      if (terminology != null) await setTerminology(terminology);
    } on Object {
      await link.close();
      rethrow;
    }
    return this;
  }

  /// After `session.ended`, waits briefly for `session.saved` and the close
  /// (which decides any error).
  Future<void> _settle() async {
    final link = _link;
    if (_protocol.ended != null && !_protocol.closed && link != null) {
      await waitAtMost(link.done, _options.closeTimeout);
    }
  }

  Future<void> _waitUntil(
    bool Function() predicate,
    Duration? timeout,
    TimeoutKind kind,
  ) async {
    final deadline = timeout == null ? null : _clock() + timeout;
    while (!predicate()) {
      if (deadline == null) {
        await _changed.next;
        continue;
      }
      final remaining = deadline - _clock();
      if (remaining <= Duration.zero) {
        throw APITimeoutException(
          'timed out after $timeout (${kind.name})',
          kind: kind,
          mayHaveExecuted: null,
        );
      }
      await _changed.wait(remaining);
    }
  }

  Future<void> _sendText(String text) => _send((link) => link.sendText(text));

  Future<void> _sendBytes(Uint8List data) =>
      _send((link) => link.sendBytes(data));

  Future<void> _send(Future<void> Function(Link link) write) async {
    final link = _link;
    if (link == null) {
      throw SessionEndedException('the session is not connected');
    }
    try {
      await write(link);
    } on LinkClosed {
      await link.done;
      _protocol.checkSendable();
      throw SessionEndedException('the session is closed');
    }
  }

  void _flushEvents() {
    while (_protocol.events.isNotEmpty) {
      _events.add(_protocol.events.removeFirst());
    }
  }

  void _onText(String text) {
    final event = decodeEvent(text);
    if (event['type'] == 'pong') {
      _link?.pong();
      return;
    }
    _protocol.receiveEvent(event, _clock());
    _flushEvents();
    _changed.notify();
  }

  void _onBinary(Uint8List data) {
    // Speech to Text never sends binary frames; ignore any.
  }

  void _onClosed(CloseInfo info) {
    _protocol.connectionClosed(info);
    _flushEvents();
    final error = _protocol.fatal;
    if (error != null) _events.addError(error);
    unawaited(_events.close());
    _changed.notify();
  }

  @override
  String toString() => 'SttSession(sessionId: $sessionId, state: '
      '${state.name})';
}

final class _AudioSink implements StreamConsumer<List<int>> {
  _AudioSink(this._session);

  final SttSession _session;

  @override
  Future<void> addStream(Stream<List<int>> stream) =>
      _session.addStream(stream);

  @override
  Future<SessionSummary> close() => _session.stop();
}

/// Opens a Speech to Text session and waits for `session.started` (and
/// `terminology.set`). Internal: use `connectStt`.
Future<SttSession> openSttSession(
  StreamOptions options, {
  required int sampleRate,
  required String language,
  Map<String, Object?>? terminology,
  String encoding = 'pcm_s16le',
  Duration? waitForSlot,
  AttemptLimiter? limiter,
  bool afterAbnormal = false,
}) =>
    SttSession._(
      options,
      sampleRate: sampleRate,
      language: language,
      terminology: terminology,
      encoding: encoding,
      waitForSlot: waitForSlot,
      limiter: limiter,
    )._start(afterAbnormal: afterAbnormal);
