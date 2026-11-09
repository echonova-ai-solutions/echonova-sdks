/// Speech to Text stream protocol (sans-IO).
///
/// [SttProtocol] tracks one session: frames to send, events received, and
/// how the session ended. [SegmentPlan] is the bookkeeping
/// `transcribeStream` needs on top: where to cut segments, which audio is not
/// yet cut (and so can be replayed after a reconnect), and which cut
/// segments are still waiting for a result.
library;

import 'dart:collection';
import 'dart:math' as math;
import 'dart:typed_data';

import '../audio.dart' show pcmDuration;
import '../core/pcm_framer.dart';
import '../errors.dart';
import 'link.dart';
import 'stream_errors.dart';
import 'types.dart';

/// Where a Speech to Text session is in its life.
enum SttState {
  /// Waiting for `session.started`.
  awaitStarted,

  /// Taking audio.
  open,

  /// `stop` was sent; waiting for the last transcripts.
  stopping,

  /// `session.ended` arrived.
  ended,

  /// The socket closed normally.
  closed,

  /// The session ended abnormally; `failure` says why.
  failed,
}

/// Segments shorter than this get no transcript.
const Duration minResultDuration = Duration(milliseconds: 50);

double _number(Object? value, [double fallback = 0]) =>
    value is num ? value.toDouble() : fallback;

String? _string(Object? value) => value is String ? value : null;

/// The Speech to Text protocol state for one session.
final class SttProtocol {
  /// Creates the state for a session sending audio at [sampleRate] Hz.
  SttProtocol(this.sampleRate, {int frameMs = 100})
      : framer = PcmFramer(sampleRate, frameMs: frameMs);

  /// The sample rate of the audio sent.
  final int sampleRate;

  /// Cuts audio into frames.
  final PcmFramer framer;

  /// The session's state.
  SttState state = SttState.awaitStarted;

  /// Events not yet handed to the caller.
  final Queue<SttEvent> events = Queue();

  /// `session.started` arrived.
  bool started = false;

  /// When `session.started` arrived.
  Duration? startedAt;

  /// The session's ID.
  String? sessionId;

  /// The ID the session's job gets once it is saved.
  String? jobId;

  /// The language the server confirmed.
  String? language;

  /// The sample rate the server confirmed.
  int? serverSampleRate;

  /// Seconds from `session.started` until the server ends the session.
  double? maxSessionSeconds;

  /// The `session.ended` event.
  SessionEnded? ended;

  /// The `session.saved` event.
  SessionSaved? saved;

  /// The error that ended the session abnormally.
  EchoNovaException? fatal;

  /// The socket closed.
  bool closed = false;

  /// How the socket closed.
  CloseInfo? closeInfo;

  /// `stop` was sent (or is being sent).
  bool stopRequested = false;

  /// Transcripts received.
  int transcripts = 0;

  /// A terminology frame waits for its answer.
  bool terminologyWaiting = false;

  /// The answer to the last terminology frame: a [TerminologySet] or an
  /// [EchoNovaException].
  Object? terminologyReply;

  Map<String, Object?>? _lastError;
  int _segmentIndex = 0;
  int _segmentStart = 0;

  // --- Outbound --------------------------------------------------------------

  /// Throws when the session takes no more audio.
  void checkSendable() {
    final error = fatal;
    if (error != null) throw error;
    final end = ended;
    if (closed || end != null) {
      throw SessionEndedException(
        'the Speech to Text session has ended'
        '${end == null ? '' : ' (${end.reason})'}',
      );
    }
    if (stopRequested) {
      throw SessionEndedException(
        'stop() was called; this session takes no more audio',
      );
    }
  }

  /// Frames ready to send for [data] (about 100 ms each, even-length, at
  /// most 64 KiB).
  List<Uint8List> pushAudio(List<int> data) {
    checkSendable();
    return framer.push(data);
  }

  /// Ends the current segment: the frames to flush first, and where the cut
  /// falls.
  (List<Uint8List>, SegmentMark) cut() {
    checkSendable();
    final frames = framer.flush();
    final segmentBytes = framer.bytesEmitted - _segmentStart;
    final mark = SegmentMark(
      index: _segmentIndex,
      audioOffset: pcmDuration(framer.bytesEmitted, sampleRate),
      duration: pcmDuration(segmentBytes, sampleRate),
      expectResult: segmentBytes >= minResultBytes,
    );
    _segmentStart = framer.bytesEmitted;
    _segmentIndex += 1;
    return (frames, mark);
  }

  /// Segments shorter than this many bytes get no transcript.
  int get minResultBytes =>
      sampleRate * minResultDuration.inMicroseconds ~/ 1000000 * bytesPerSample;

  /// The last frames before `stop`, and how many odd trailing bytes were
  /// dropped.
  (List<Uint8List>, int) beginStop() {
    checkSendable();
    final (:frames, :droppedBytes) = framer.finish();
    stopRequested = true;
    if (state == SttState.open) state = SttState.stopping;
    return (frames, droppedBytes);
  }

  /// The terminology frame to send.
  String beginTerminology(Map<String, Object?>? terminology) {
    checkSendable();
    final text = encodeJson({
      'type': 'terminology',
      'terminology': terminology == null ? null : Map.of(terminology),
    });
    terminologyWaiting = true;
    terminologyReply = null;
    return text;
  }

  // --- Inbound ---------------------------------------------------------------

  /// A JSON frame arrived.
  void receiveEvent(Map<String, Object?> event, Duration now) {
    switch (event['type']) {
      case 'session.started':
        if (started) return;
        started = true;
        startedAt = now;
        sessionId = _string(event['sessionId']);
        jobId = _string(event['jobId']);
        language = _string(event['language']);
        final rate = event['sampleRate'];
        serverSampleRate = rate is int ? rate : null;
        final limit = _number(event['maxSessionSeconds'], -1);
        maxSessionSeconds = limit > 0 ? limit : null;
        if (state == SttState.awaitStarted) {
          state = stopRequested ? SttState.stopping : SttState.open;
        }
      case 'transcript':
        final terminology = event['terminology'];
        events.add(Transcript(
          segmentId: _string(event['segmentId']) ?? '',
          text: _string(event['text']) ?? '',
          durationSeconds: _number(event['durationSeconds']),
          creditsConsumed: _number(event['creditsConsumed']),
          index: transcripts,
          terminology:
              terminology is Map<String, Object?> ? Map.of(terminology) : null,
          language: _string(event['language']),
          sessionId: sessionId,
          raw: Map.of(event),
        ));
        transcripts += 1;
      case 'terminology.set':
        final reply =
            TerminologySet(active: event['active'] == true, raw: Map.of(event));
        events.add(reply);
        if (terminologyWaiting) {
          terminologyWaiting = false;
          terminologyReply = reply;
        }
      case 'session.ended':
        final end = SessionEnded(
          reason: _string(event['reason']) ?? 'unknown',
          totalSeconds: _number(event['totalSeconds']),
          creditsConsumed: _number(event['creditsConsumed']),
          raw: Map.of(event),
        );
        ended = end;
        events.add(end);
        state = SttState.ended;
      case 'session.saved':
        if (saved != null) return;
        final id = _string(event['jobId']);
        final event0 = SessionSaved(
          jobId: id ?? jobId ?? '',
          status: SessionSaveStatus.parse(event['status']),
          sessionId: sessionId,
          raw: Map.of(event),
        );
        saved = event0;
        jobId ??= id;
        events.add(event0);
      case 'error':
        final error = errorFromFrame(event, sessionId: sessionId);
        _lastError = Map.of(event);
        if (event['code'] == 'validation_failed' && terminologyWaiting) {
          terminologyWaiting = false;
          terminologyReply = error;
          return;
        }
        events.add(StreamErrorEvent(
          code: _string(event['code']) ?? '',
          message: _string(event['message']) ?? '',
          error: error,
          raw: Map.of(event),
        ));
      case 'pong':
        break;
      default:
        events.add(UnknownEvent(Map.of(event)));
    }
  }

  /// The socket closed.
  void connectionClosed(CloseInfo info) {
    closed = true;
    closeInfo = info;
    var error = closeError(
      info,
      endedNormally: ended != null,
      lastError: _lastError,
      sessionId: sessionId,
    );
    if (error == null && !started && !info.local) error = _startFailure(info);
    if (error != null) {
      fatal = error;
      state = SttState.failed;
    } else {
      state = SttState.closed;
    }
    if (terminologyWaiting) {
      terminologyWaiting = false;
      terminologyReply = error ??
          SessionEndedException(
            'the session closed before terminology was set',
          );
    }
  }

  /// The session ended before `session.started`.
  EchoNovaException _startFailure(CloseInfo info) {
    final reason = ended?.reason;
    final last = _lastError ?? const <String, Object?>{};
    final message = _string(last['message']) ??
        'the session ended before it started ($reason)';
    final code = _string(last['code']) ?? reason;
    switch (reason ?? code) {
      case 'upstream_error':
        return UpstreamException(
          errorMessage: message,
          errorCode: code,
          closeCode: info.code,
          transport: TransportKind.websocket,
        );
      case 'insufficient_balance':
        return InsufficientBalanceException(
          errorMessage: message,
          errorCode: code,
          closeCode: info.code,
          transport: TransportKind.websocket,
        );
      case 'spending_limit':
        return SpendingLimitException(
          errorMessage: message,
          errorCode: code,
          closeCode: info.code,
          transport: TransportKind.websocket,
        );
    }
    return StreamClosedException(
      'the Speech to Text session ended before it started '
      '(${reason ?? info.code})',
      closeCode: info.code,
      reason: info.reason.isEmpty ? null : info.reason,
    );
  }

  /// The session's totals, once `session.ended` has arrived.
  SessionSummary? summary() {
    final end = ended;
    if (end == null) return null;
    final save = saved;
    return SessionSummary(
      reason: end.reason,
      totalSeconds: end.totalSeconds,
      creditsConsumed: end.creditsConsumed,
      sessionId: sessionId,
      jobId: save == null || save.jobId.isEmpty ? null : save.jobId,
      savedStatus: save?.status,
    );
  }
}

// --- transcribeStream bookkeeping ---------------------------------------------

/// A piece of the source to send, and whether to cut after it.
final class Piece {
  /// Creates a piece.
  const Piece(this.data, {required this.cut});

  /// The audio.
  final Uint8List data;

  /// End the segment after this piece.
  final bool cut;
}

/// Cuts every `segmentLength` of audio and tracks what a reconnect must
/// replay.
///
/// Audio is kept sample-aligned: an odd trailing byte waits for the next
/// chunk. Offsets in the marks it returns count audio from the start of the
/// stream, across sessions.
final class SegmentPlan {
  /// Creates a plan for audio at [sampleRate] Hz, cut every
  /// [segmentLength].
  SegmentPlan(this.sampleRate, Duration segmentLength)
      : segmentBytes = math.max(
          bytesPerSample,
          sampleRate * segmentLength.inMicroseconds ~/ 1000000 * bytesPerSample,
        ) {
    if (segmentLength <= Duration.zero) {
      throw ArgumentError.value(
        segmentLength,
        'segmentLength',
        'must be positive',
      );
    }
  }

  /// The audio's sample rate.
  final int sampleRate;

  /// Bytes per segment.
  final int segmentBytes;

  /// Audio sent (or being sent) since the last cut.
  final BytesBuilder uncut = BytesBuilder();

  /// Cut segments waiting for a result.
  final Queue<SegmentMark> pending = Queue();

  /// A result arrived for audio this plan never cut (the final segment).
  bool tailAnswered = false;

  Uint8List _carry = Uint8List(0);
  int _fill = 0; // planned bytes in the current segment
  int _cutOffset = 0; // stream offset (bytes) of the last cut
  int _cuts = 0;

  /// Splits [chunk] into pieces, marking where segments end.
  List<Piece> split(List<int> chunk) {
    var data = Uint8List(_carry.length + chunk.length)
      ..setRange(0, _carry.length, _carry)
      ..setRange(_carry.length, _carry.length + chunk.length, chunk);
    if (data.length.isOdd) {
      _carry = Uint8List.fromList(data.sublist(data.length - 1));
      data = Uint8List.sublistView(data, 0, data.length - 1);
    } else {
      _carry = Uint8List(0);
    }
    final pieces = <Piece>[];
    var offset = 0;
    while (offset < data.length) {
      final room = segmentBytes - _fill;
      final end = math.min(data.length, offset + room);
      final piece = Uint8List.sublistView(data, offset, end);
      offset = end;
      _fill += piece.length;
      final cut = _fill >= segmentBytes;
      if (cut) _fill = 0;
      pieces.add(Piece(piece, cut: cut));
    }
    return pieces;
  }

  /// [data] was handed to the session.
  void delivered(Uint8List data) => uncut.add(data);

  /// Records a cut (after the uncut audio was sent). Returns the mark in
  /// stream terms.
  SegmentMark cut(SegmentMark sessionMark) {
    final end = _cutOffset + uncut.length;
    final mark = SegmentMark(
      index: _cuts,
      audioOffset: pcmDuration(end, sampleRate),
      duration: pcmDuration(uncut.length, sampleRate),
      expectResult: sessionMark.expectResult,
    );
    _cuts += 1;
    _cutOffset = end;
    uncut.clear();
    _fill = 0;
    if (mark.expectResult) pending.add(mark);
    return mark;
  }

  /// A transcript (or a per-segment error) arrived: it answers the oldest
  /// pending cut.
  void result() {
    if (pending.isNotEmpty) {
      pending.removeFirst();
    } else {
      tailAnswered = true;
    }
  }

  /// A new session started.
  void newSession() => tailAnswered = false;

  /// The cut segments that got no result, which are now lost.
  List<SegmentMark> takeDropped() {
    final marks = pending.toList();
    pending.clear();
    return marks;
  }

  /// The audio to send again on a new session: everything since the last
  /// cut.
  Uint8List replay() => uncut.toBytes();

  /// End of the source: returns how many odd trailing bytes were dropped
  /// (0 or 1).
  int finish() {
    final dropped = _carry.length;
    _carry = Uint8List(0);
    return dropped;
  }
}
