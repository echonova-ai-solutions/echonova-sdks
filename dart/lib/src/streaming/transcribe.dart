/// `transcribeStream`: transcribe an audio source of any length over Speech
/// to Text sessions.
///
/// * It cuts its own segments every `segmentLength` of audio, so it always
///   knows where each cut fell.
/// * Shortly before a session's time limit it rolls over: it cuts, stops the
///   session, waits for its last transcripts and opens a new one. Audio that
///   arrives meanwhile is buffered (bounded) and sent to the new session.
/// * After a dropped connection (1001, 1006 or 1011) it reconnects and
///   replays the audio sent since the last cut. A segment is charged when its
///   transcript is sent, so audio that was never cut into a segment can be
///   replayed without paying twice. Segments that were cut but got no result
///   are not replayed; they are reported as [AudioDropped].
/// * It never reconnects after a billing or protocol close (4002, 4029,
///   1008, 1009).
library;

import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import '../core/pcm_framer.dart' show bytesPerSample;
import '../errors.dart';
import 'async_util.dart';
import 'link.dart';
import 'options.dart';
import 'stt_protocol.dart';
import 'stt_session.dart';
import 'types.dart';

/// Audio held while a session is being replaced, before the source is
/// paused.
const Duration maxBufferDuration = Duration(seconds: 60);

/// Why a new session should be opened after [error], if one should:
/// `(reason, counts as a failure, after an abnormal loss)`.
({String reason, bool counted, bool abnormal})? reconnectReason(
  EchoNovaException error,
  String? summaryReason,
) {
  if (error is ServerRestartingException) {
    return (reason: 'server_restarting', counted: true, abnormal: true);
  }
  if (error is StreamConnectionLostException) {
    return (reason: 'connection_lost', counted: true, abnormal: true);
  }
  if (error is UpstreamException && error.closeCode == 1011) {
    return (reason: 'upstream_error', counted: true, abnormal: false);
  }
  if (error is SessionExpiredException) {
    return (reason: 'session_expired', counted: true, abnormal: false);
  }
  if (error is SessionEndedException &&
      (summaryReason == 'max_duration' || summaryReason == 'idle_timeout')) {
    return (reason: summaryReason!, counted: false, abnormal: false);
  }
  return null;
}

/// Transcribes [source] (PCM16LE mono chunks at [sampleRate] Hz) and emits
/// events as they arrive: [Transcript], [StreamErrorEvent] (one segment
/// failed), [Reconnected], [AudioDropped], [SessionSaved] (once per session)
/// and [UnknownEvent].
///
/// Nothing happens until the stream is listened to; cancelling the
/// subscription closes the session and stops reading [source]. The stream
/// ends with an error when a session can't continue and reconnecting won't
/// help (billing, protocol), or after [reconnect]`.maxAttempts` reconnects
/// in a row without a transcript.
///
/// [realtime] paces sending at 1x, to simulate a live source with a file;
/// by default audio is sent as fast as the socket allows.
Stream<TranscribeEvent> transcribeStream(
  StreamOptions options,
  Stream<List<int>> source, {
  required int sampleRate,
  String? language,
  Map<String, Object?>? terminology,
  Duration segmentLength = const Duration(seconds: 14),
  ReconnectPolicy reconnect = const ReconnectPolicy(),
  bool realtime = false,
  String encoding = 'pcm_s16le',
  Duration? waitForSlot,
}) {
  sttQuery(sampleRate, language, encoding); // validate before anything starts
  if (segmentLength <= Duration.zero) {
    throw ArgumentError.value(segmentLength, 'segmentLength', 'must be > 0');
  }
  return _Transcriber(
    options,
    source,
    sampleRate: sampleRate,
    language: language,
    terminology: terminology,
    segmentLength: segmentLength,
    reconnect: reconnect,
    realtime: realtime,
    encoding: encoding,
    waitForSlot: waitForSlot,
  ).events;
}

/// The subscription was cancelled.
final class _Stopped implements Exception {
  const _Stopped();
}

/// Markers [_Transcriber._nextItem] returns besides audio.
enum _Marker { eof, rollover, sessionDown }

final class _Transcriber {
  _Transcriber(
    this.options,
    this.source, {
    required this.sampleRate,
    required this.language,
    required this.terminology,
    required Duration segmentLength,
    required this.reconnect,
    required this.realtime,
    required this.encoding,
    required this.waitForSlot,
  })  : plan = SegmentPlan(sampleRate, segmentLength),
        limiter = AttemptLimiter(
          maxAttempts: options.maxConnectAttempts,
          window: options.connectWindow,
        ),
        bufferLimit = sampleRate *
            bytesPerSample *
            maxBufferDuration.inMicroseconds ~/
            1000000;

  final StreamOptions options;
  final Stream<List<int>> source;
  final int sampleRate;

  /// Sent to every session, so a reconnect keeps it (or keeps sending none).
  final String? language;
  final Map<String, Object?>? terminology;
  final ReconnectPolicy reconnect;
  final bool realtime;
  final String encoding;
  final Duration? waitForSlot;
  final SegmentPlan plan;
  final AttemptLimiter limiter;
  final int bufferLimit;

  late final StreamController<TranscribeEvent> _out = StreamController(
    onListen: () => unawaited(_drive()),
    onCancel: _onCancel,
  );

  Stream<TranscribeEvent> get events => _out.stream;

  SttSession? _session;
  StreamSubscription<List<int>>? _sourceSubscription;
  bool _sourcePaused = false;
  final Queue<Uint8List> _chunks = Queue();
  int _buffered = 0;
  bool _sourceDone = false;
  (Object, StackTrace)? _sourceError;
  final Signal _changed = Signal();
  StreamSubscription<SttEvent>? _forwarder;
  Completer<void>? _forwarderDone;
  bool _stopping = false;
  Future<void>? _shutdown;
  int _failures = 0;
  int _index = 0;
  Duration? _pacingStart;
  int _bytesPaced = 0;

  SttSession get _current => _session!;

  // --- Driver ----------------------------------------------------------------

  Future<void> _onCancel() async {
    _stopping = true;
    _changed.notify();
    await _shutDown();
  }

  Future<void> _drive() async {
    try {
      await _main();
    } on _Stopped {
      // The subscription was cancelled.
    } on Object catch (error, stack) {
      if (!_stopping) {
        // Drain, then raise: the session's transcripts (already charged)
        // come before the error.
        final session = _session;
        if (session != null && !session.isClosed) await session.close();
        final done = _forwarderDone;
        if (done != null) await waitAtMost(done.future, options.closeTimeout);
        if (!_stopping) _out.addError(error, stack);
      }
    } finally {
      await _shutDown();
      if (!_out.isClosed) unawaited(_out.close());
    }
  }

  void _emit(TranscribeEvent event) {
    if (!_stopping && !_out.isClosed) _out.add(event);
  }

  void _checkStopping() {
    if (_stopping) throw const _Stopped();
  }

  Future<void> _main() async {
    _startReader();
    _session = await _open(afterAbnormal: false);
    while (true) {
      final item = await _nextItem();
      if (item == _Marker.eof) break;
      if (item == _Marker.rollover) {
        await _rollover();
        continue;
      }
      if (item == _Marker.sessionDown) {
        await _recover(_sessionError());
        continue;
      }
      for (final piece in plan.split(item as Uint8List)) {
        await _deliver(piece);
        final delay = _pace(piece.data);
        if (delay > const Duration(milliseconds: 10)) {
          await options.sleep(delay);
        }
      }
    }
    if (plan.finish() > 0) {
      streamLog(
        'dropped 1 trailing byte: audio must be whole 16-bit samples',
        level: 900,
      );
    }
    await _finish();
  }

  // --- Source ----------------------------------------------------------------

  void _startReader() {
    _sourceSubscription = source.listen(
      (chunk) {
        final copy = Uint8List.fromList(chunk);
        _chunks.add(copy);
        _buffered += copy.length;
        if (_buffered >= bufferLimit && !_sourcePaused) {
          _sourcePaused = true;
          _sourceSubscription?.pause();
        }
        _changed.notify();
      },
      onError: (Object error, StackTrace stack) {
        _sourceError = (error, stack);
        _sourceDone = true;
        _changed.notify();
      },
      onDone: () {
        _sourceDone = true;
        _changed.notify();
      },
      cancelOnError: true,
    );
  }

  Future<Object> _nextItem() async {
    while (true) {
      _checkStopping();
      final session = _current;
      if (_chunks.isNotEmpty) {
        final chunk = _chunks.removeFirst();
        _buffered -= chunk.length;
        if (_sourcePaused && _buffered < bufferLimit) {
          _sourcePaused = false;
          _sourceSubscription?.resume();
        }
        return chunk;
      }
      final error = _sourceError;
      if (error != null) Error.throwWithStackTrace(error.$1, error.$2);
      if (_sourceDone) return _Marker.eof;
      if (session.isClosed) return _Marker.sessionDown;
      final deadline = _rolloverAt(session);
      final now = options.clock();
      if (deadline != null && now >= deadline) return _Marker.rollover;
      await _changed.wait(
        deadline == null
            ? null
            : deadline - now + const Duration(milliseconds: 1),
      );
    }
  }

  Duration? _rolloverAt(SttSession session) {
    final startedAt = session.startedAt;
    final limit = session.maxSessionSeconds;
    if (startedAt == null || limit == null) return null;
    var span = Duration(microseconds: (limit * 1000000).round()) -
        options.rolloverMargin;
    if (span < Duration.zero) span = Duration.zero;
    return startedAt + span;
  }

  Duration _pace(Uint8List piece) {
    if (!realtime) return Duration.zero;
    final now = options.clock();
    final start = _pacingStart ??= now;
    _bytesPaced += piece.length;
    final audio = Duration(
      microseconds: _bytesPaced ~/ bytesPerSample * 1000000 ~/ sampleRate,
    );
    final ahead = audio - (now - start);
    return ahead > Duration.zero ? ahead : Duration.zero;
  }

  // --- Sessions --------------------------------------------------------------

  EchoNovaException _sessionError() {
    final session = _current;
    return session.failure ??
        SessionEndedException(
          'the Speech to Text session ended '
          '(${session.summary?.reason ?? 'closed'})',
        );
  }

  Future<void> _deliver(Piece piece) async {
    plan.delivered(piece.data);
    var data = piece.data;
    while (true) {
      final session = _current;
      try {
        if (data.isNotEmpty) await session.sendAudio(data);
        if (piece.cut) plan.cut(await session.endSegment());
        return;
      } on EchoNovaException catch (error) {
        await _recover(error);
        data = Uint8List(0); // the replay after the reconnect included it
      }
    }
  }

  Future<SttSession> _open({required bool afterAbnormal}) async {
    _checkStopping();
    final session = await openSttSession(
      options,
      sampleRate: sampleRate,
      language: language,
      terminology: terminology,
      encoding: encoding,
      waitForSlot: waitForSlot,
      limiter: limiter,
      afterAbnormal: afterAbnormal,
    );
    if (_stopping) {
      await session.close();
      throw const _Stopped();
    }
    plan.newSession();
    _startForwarder(session);
    return session;
  }

  void _startForwarder(SttSession session) {
    final done = Completer<void>();
    _forwarderDone = done;
    _forwarder = session.events.listen(
      (event) {
        final forwarded = _forward(event);
        if (forwarded != null) _emit(forwarded);
      },
      // The driver sees the failure when it next sends, and decides.
      onError: (Object _) {},
      onDone: () {
        if (!done.isCompleted) done.complete();
        _changed.notify();
      },
    );
  }

  TranscribeEvent? _forward(SttEvent event) {
    switch (event) {
      case Transcript():
        plan.result();
        _failures = 0;
        return event.withIndex(_index++);
      case StreamErrorEvent():
        // This segment failed; the session goes on.
        if (event.code == 'upstream_error') plan.result();
        return event;
      case SessionSaved():
        return event;
      case UnknownEvent():
        return event;
      case TerminologySet() || SessionEnded():
        return null;
    }
  }

  Future<void> _joinForwarder() async {
    final done = _forwarderDone;
    if (done != null) {
      await done.future;
      _forwarderDone = null;
      _forwarder = null;
    }
  }

  /// Closes the current session and waits until all of its events have
  /// been passed on.
  Future<void> _endSession() async {
    final session = _session;
    if (session != null && !session.isClosed) await session.close();
    await _joinForwarder();
    final dropped = plan.takeDropped();
    if (dropped.isNotEmpty) _emit(AudioDropped(dropped));
  }

  Future<void> _recover(EchoNovaException error) async {
    var failure = error;
    while (true) {
      _checkStopping();
      final decision = reconnectReason(failure, _session?.summary?.reason);
      if (decision == null) throw failure;
      await _endSession();
      if (decision.counted) {
        _failures += 1;
        if (_failures > reconnect.maxAttempts) throw failure;
        await options.sleep(reconnect.delay(_failures));
      }
      streamLog('Speech to Text stream reconnecting (${decision.reason})');
      final session = await _open(afterAbnormal: decision.abnormal);
      _session = session;
      _emit(Reconnected(
        reason: decision.reason,
        sessionId: session.sessionId,
        attempt: _failures,
      ));
      final replay = plan.replay();
      try {
        if (replay.isNotEmpty) await session.sendAudio(replay);
        return;
      } on EchoNovaException catch (next) {
        failure = next;
      }
    }
  }

  Future<void> _rollover() async {
    final session = _current;
    try {
      if (plan.uncut.isNotEmpty) plan.cut(await session.endSegment());
      await session.stop();
    } on EchoNovaException catch (error) {
      await _recover(error);
      return;
    }
    await _endSession();
    final next = await _open(afterAbnormal: false);
    _session = next;
    _emit(Reconnected(reason: 'rollover', sessionId: next.sessionId));
  }

  Future<void> _finish() async {
    while (true) {
      final session = _current;
      try {
        final summary = await session.stop();
        if (summary.reason == 'max_duration' && plan.uncut.isNotEmpty) {
          // Every result of this session has been counted.
          await _joinForwarder();
          if (!plan.tailAnswered) {
            // The session hit its time limit while stopping and the last
            // segment got no result: send it again.
            throw SessionEndedException(
              'the Speech to Text session ended (max_duration) before its '
              'last segment',
            );
          }
        }
        break;
      } on EchoNovaException catch (error) {
        await _recover(error);
      }
    }
    await _endSession();
  }

  Future<void> _shutDown() => _shutdown ??= () async {
        _stopping = true;
        await _sourceSubscription?.cancel();
        final session = _session;
        if (session != null && !session.isClosed) {
          try {
            await session.close();
          } on Object {
            // Already failing; the stream reports the first error.
          }
        }
        await _forwarder?.cancel();
      }();
}
