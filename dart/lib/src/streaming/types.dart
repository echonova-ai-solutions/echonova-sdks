/// Public data types for the Text to Speech and Speech to Text streams.
library;

import '../errors.dart';

// --- Text to Speech ----------------------------------------------------------

/// Where a synthesis is in its life.
enum SynthesisState {
  /// Not sent yet: waiting in the client queue or for a connection.
  queued,

  /// Sent; the server hasn't started it yet.
  sent,

  /// `start` arrived; audio is flowing.
  streaming,

  /// A cancel (or a newer synthesis) was requested; waiting for the server
  /// to stop.
  cancelling,

  /// All audio arrived (`done`).
  completed,

  /// Cancelled by `cancel()`, `interrupt()` or closing the session.
  cancelled,

  /// Replaced by a newer `synthesize()`.
  superseded,

  /// The server rejected or failed it. Its error says why.
  failed,

  /// The connection dropped while it was in flight. Its error carries the
  /// charge state (`chargeStateOf`).
  lost;

  /// Whether this is a final state.
  bool get isTerminal => index >= completed.index;
}

/// How a synthesis ended, when it didn't fail.
enum SynthesisOutcome {
  /// All audio arrived.
  completed,

  /// It was cancelled.
  cancelled,

  /// A newer synthesis replaced it.
  superseded,
}

/// Whether a synthesis was charged, as far as the SDK can tell.
enum ChargeState {
  /// It was charged: `start` or audio arrived, or the server reported its
  /// cost.
  yes,

  /// It was not charged: never sent, rejected, or failed before any audio.
  no,

  /// It was sent but nothing came back for it before the connection
  /// dropped. It was probably charged, so it is never resent automatically.
  unknown,
}

/// Timings and counters for one synthesis.
final class SynthesisMetrics {
  /// Creates metrics.
  const SynthesisMetrics({
    required this.ttfb,
    required this.timeToStart,
    required this.total,
    required this.audioBytes,
    required this.frames,
    required this.droppedFrames,
  });

  /// From sending the request to the first audio frame.
  final Duration? ttfb;

  /// From sending the request to `start`.
  final Duration? timeToStart;

  /// From sending the request to its final state.
  final Duration? total;

  /// Bytes of audio received.
  final int audioBytes;

  /// Audio frames received.
  final int frames;

  /// Frames that arrived after a cancel was requested, and were discarded.
  final int droppedFrames;

  @override
  String toString() => 'SynthesisMetrics(ttfb: $ttfb, timeToStart: '
      '$timeToStart, total: $total, audioBytes: $audioBytes, frames: $frames, '
      'droppedFrames: $droppedFrames)';
}

/// How a synthesis ended.
///
/// A synthesis is charged per character when it starts. One that stops after
/// its audio started (a cancel, or a newer synthesis replacing it) costs only
/// the share of audio sent, at least 1 credit, and the rest is refunded.
///
/// [creditsConsumed] is the final cost the server reported: on `done` for a
/// completed synthesis, and on `cancelled` for a cancelled or superseded one.
///
/// [charged] is `true` when the synthesis was billed (the server reported its
/// cost, or its audio had started), `false` when it was not (never sent, or
/// cancelled before it was charged), and `null` when the SDK ended it without
/// hearing from the server (a cancel the server never confirmed, or a closed
/// session). [durationSeconds] and [characters] come from `done`, so only a
/// completed synthesis has them.
final class SynthesisResult {
  /// Creates a result.
  const SynthesisResult({
    required this.requestId,
    required this.outcome,
    required this.charged,
    this.durationSeconds,
    this.characters,
    this.creditsConsumed,
    this.sampleRate,
    this.raw,
  });

  /// The synthesis's `requestId`.
  final String requestId;

  /// How it ended.
  final SynthesisOutcome outcome;

  /// Whether it was billed. See the class description.
  final bool? charged;

  /// The audio's length, from `done`.
  final double? durationSeconds;

  /// Characters charged, from `done`.
  final int? characters;

  /// The final cost the server reported, from `done` or `cancelled`.
  final double? creditsConsumed;

  /// The audio's sample rate, from `start`.
  final int? sampleRate;

  /// The final frame (`done` or `cancelled`) as received.
  final Map<String, Object?>? raw;

  @override
  String toString() => 'SynthesisResult(requestId: $requestId, outcome: '
      '${outcome.name}, charged: $charged, creditsConsumed: $creditsConsumed)';
}

// --- Speech to Text ----------------------------------------------------------

/// Where `endSegment()` cut the audio.
///
/// [audioOffset] is the end of the segment, in audio sent in this session
/// (or, from `transcribeStream`, in the whole stream). [expectResult] is
/// `false` for an empty or very short segment, for which no transcript comes.
final class SegmentMark {
  /// Creates a mark.
  const SegmentMark({
    required this.index,
    required this.audioOffset,
    required this.duration,
    required this.expectResult,
  });

  /// Counts cuts from 0.
  final int index;

  /// Where the segment ends.
  final Duration audioOffset;

  /// The segment's length.
  final Duration duration;

  /// Whether a transcript (or a per-segment error) is expected for it.
  final bool expectResult;

  @override
  String toString() => 'SegmentMark(index: $index, audioOffset: $audioOffset, '
      'duration: $duration, expectResult: $expectResult)';
}

/// Whether a Speech to Text session was kept as a job (`session.saved`).
enum SessionSaveStatus {
  /// The job is available from the Speech to Text jobs API by its ID.
  saved,

  /// Nothing was transcribed, so nothing was kept.
  empty,

  /// The session could not be kept.
  failed,

  /// A status this SDK version doesn't know.
  unknown;

  /// Parses the wire value.
  static SessionSaveStatus parse(Object? value) => switch (value) {
        'saved' => saved,
        'empty' => empty,
        'failed' => failed,
        _ => unknown,
      };
}

/// Totals from `session.ended`, and whether the session was kept as a job.
///
/// [jobId] and [savedStatus] come from `session.saved`; both are `null` if it
/// never arrived.
final class SessionSummary {
  /// Creates a summary.
  const SessionSummary({
    required this.reason,
    required this.totalSeconds,
    required this.creditsConsumed,
    this.sessionId,
    this.jobId,
    this.savedStatus,
  });

  /// Why the session ended: `stopped`, `max_duration`, `idle_timeout`, ...
  final String reason;

  /// Seconds of audio transcribed.
  final double totalSeconds;

  /// Credits charged in the session.
  final double creditsConsumed;

  /// The session's ID.
  final String? sessionId;

  /// The session's job ID, from `session.saved`.
  final String? jobId;

  /// Whether the session was kept as a job, from `session.saved`.
  final SessionSaveStatus? savedStatus;

  @override
  String toString() => 'SessionSummary(reason: $reason, totalSeconds: '
      '$totalSeconds, creditsConsumed: $creditsConsumed, sessionId: '
      '$sessionId, jobId: $jobId, savedStatus: ${savedStatus?.name})';
}

/// An event on a Speech to Text session.
///
/// Sealed, so a `switch` over it is exhaustive.
sealed class SttEvent {}

/// An event from `transcribeStream`.
///
/// Sealed, so a `switch` over it is exhaustive.
sealed class TranscribeEvent {}

/// The final transcript of one segment.
///
/// [text] is passed through unchanged: it can be empty or carry surrounding
/// whitespace. [index] counts transcripts in arrival order, from 0.
/// [terminology] is the server's terminology report for this segment, when
/// terms are set.
final class Transcript implements SttEvent, TranscribeEvent {
  /// Creates a transcript.
  const Transcript({
    required this.segmentId,
    required this.text,
    required this.durationSeconds,
    required this.creditsConsumed,
    required this.index,
    this.terminology,
    this.language,
    this.sessionId,
    this.raw = const {},
  });

  /// Identifies the segment.
  final String segmentId;

  /// The transcript.
  final String text;

  /// The segment's audio length, as reported by the server.
  final double durationSeconds;

  /// Credits charged for this segment.
  final double creditsConsumed;

  /// Counts transcripts in arrival order, from 0.
  final int index;

  /// The segment corrected to the terms you set, while terms are set.
  final Map<String, Object?>? terminology;

  /// The detected language, `ar` or `en`; `auto` for a segment with no
  /// speech on a stream opened with `auto`.
  final String? language;

  /// The session it came from.
  final String? sessionId;

  /// The frame as received.
  final Map<String, Object?> raw;

  /// A copy with another [index].
  Transcript withIndex(int index) => Transcript(
        segmentId: segmentId,
        text: text,
        durationSeconds: durationSeconds,
        creditsConsumed: creditsConsumed,
        index: index,
        terminology: terminology,
        language: language,
        sessionId: sessionId,
        raw: raw,
      );

  @override
  String toString() => 'Transcript(index: $index, segmentId: $segmentId, '
      'text: $text, durationSeconds: $durationSeconds)';
}

/// The server accepted a terminology frame. [active] is `false` when terms
/// were cleared.
final class TerminologySet implements SttEvent {
  /// Creates the event.
  const TerminologySet({required this.active, this.raw = const {}});

  /// Whether terms are now set.
  final bool active;

  /// The frame as received.
  final Map<String, Object?> raw;

  @override
  String toString() => 'TerminologySet(active: $active)';
}

/// A non-fatal error on the stream, such as one segment failing. The
/// session continues.
final class StreamErrorEvent implements SttEvent, TranscribeEvent {
  /// Creates the event.
  const StreamErrorEvent({
    required this.code,
    required this.message,
    required this.error,
    this.raw = const {},
  });

  /// The error's `code`, such as `upstream_error`.
  final String code;

  /// The server's message.
  final String message;

  /// The same error as an exception.
  final APIStatusException error;

  /// The frame as received.
  final Map<String, Object?> raw;

  @override
  String toString() => 'StreamErrorEvent(code: $code, message: $message)';
}

/// The server ended the session. Only [SessionSaved] can follow it.
final class SessionEnded implements SttEvent {
  /// Creates the event.
  const SessionEnded({
    required this.reason,
    required this.totalSeconds,
    required this.creditsConsumed,
    this.raw = const {},
  });

  /// Why the session ended.
  final String reason;

  /// Seconds of audio transcribed.
  final double totalSeconds;

  /// Credits charged in the session.
  final double creditsConsumed;

  /// The frame as received.
  final Map<String, Object?> raw;

  @override
  String toString() => 'SessionEnded(reason: $reason, totalSeconds: '
      '$totalSeconds, creditsConsumed: $creditsConsumed)';
}

/// Whether the session was kept as a job. It usually follows
/// [SessionEnded].
final class SessionSaved implements SttEvent, TranscribeEvent {
  /// Creates the event.
  const SessionSaved({
    required this.jobId,
    required this.status,
    this.sessionId,
    this.raw = const {},
  });

  /// The session's job ID.
  final String jobId;

  /// Whether the job was kept.
  final SessionSaveStatus status;

  /// The session it belongs to.
  final String? sessionId;

  /// The frame as received.
  final Map<String, Object?> raw;

  @override
  String toString() =>
      'SessionSaved(jobId: $jobId, status: ${status.name}, sessionId: '
      '$sessionId)';
}

/// An event type this SDK version doesn't know. Kept so nothing is lost
/// silently.
final class UnknownEvent implements SttEvent, TranscribeEvent {
  /// Wraps an event.
  const UnknownEvent(this.raw);

  /// The frame as received.
  final Map<String, Object?> raw;

  /// The frame's `type`.
  String? get type => switch (raw['type']) { final String t => t, _ => null };

  @override
  String toString() => 'UnknownEvent(type: $type)';
}

/// An unknown event on a Speech to Text session.
typedef UnknownSttEvent = UnknownEvent;

/// `transcribeStream` opened a new session.
///
/// [reason] is `rollover` for a planned handover before the session's time
/// limit, or why the previous connection ended (`connection_lost`,
/// `server_restarting`, `upstream_error`, `session_expired`, `max_duration`
/// or `idle_timeout`).
final class Reconnected implements TranscribeEvent {
  /// Creates the event.
  const Reconnected({
    required this.reason,
    required this.sessionId,
    this.attempt = 0,
  });

  /// Why a new session was opened.
  final String reason;

  /// The new session's ID.
  final String? sessionId;

  /// Reconnects in a row without a transcript in between (0 for a rollover).
  final int attempt;

  @override
  String toString() => 'Reconnected(reason: $reason, sessionId: $sessionId, '
      'attempt: $attempt)';
}

/// Segments that were cut but got no result before the connection dropped.
/// Their audio was not transcribed and is not charged.
final class AudioDropped implements TranscribeEvent {
  /// Creates the event.
  const AudioDropped(this.segmentMarks);

  /// The segments.
  final List<SegmentMark> segmentMarks;

  /// Their total length.
  Duration get duration =>
      segmentMarks.fold(Duration.zero, (sum, mark) => sum + mark.duration);

  @override
  String toString() =>
      'AudioDropped(segments: ${segmentMarks.length}, duration: $duration)';
}
