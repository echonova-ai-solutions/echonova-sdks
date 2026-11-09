/// Text to Speech stream protocol (sans-IO).
///
/// A pure state machine: the session feeds it user calls, inbound frames,
/// socket closes and clock ticks, and sends whatever [TtsProtocol.nextOutbound]
/// returns.
///
/// Correlation rules:
/// * The SDK generates every `requestId`.
/// * Binary frames carry no ID. They belong to the synthesis whose `start`
///   came last, and only while it is streaming; anything else is dropped and
///   counted.
/// * `start` for a request ends every request sent before it (superseded).
/// * `done` and `cancelled` are matched by ID; duplicates and late frames for
///   finished requests are ignored.
/// * `cancel` is only sent while a request is in flight on the current
///   socket, and the SDK never depends on a reply to it: a cancel that is not
///   acknowledged within the ack timeout is treated as done.
///
/// Billing: a synthesis is charged per character when it starts; one that
/// stops after its audio started costs only the share sent, at least 1
/// credit. `done`, `cancelled` and a mid-stream `error` report the final
/// `creditsConsumed`; a `cancelled` without it was cancelled before it was
/// charged.
///
/// `chargeState` is the SDK's conservative estimate: `yes` once `start` or
/// audio arrived (or the server reported a cost), `unknown` when a request
/// was sent but neither arrived, `no` when it was never sent or was rejected
/// or failed before any audio. A request in the `unknown` state is never
/// resent automatically, so it can't be paid for twice.
library;

import 'dart:collection';
import 'dart:math' as math;
import 'dart:typed_data';

import '../errors.dart';
import 'async_util.dart';
import 'link.dart';
import 'stream_errors.dart';
import 'types.dart';

/// Only a pre-audio `upstream_error` is resent, and only this many times.
const int maxResends = 1;

const int _recentLimit = 64;
const int _unknownLimit = 32;

/// The `cancel` frame.
const String cancelFrame = '{"type":"cancel"}';

/// Options for a synthesis. Only the options that are set are sent: the
/// server rejects unknown fields.
final class SynthesisOptions {
  /// Creates options. Every field is optional.
  const SynthesisOptions({
    this.voiceId,
    this.speed,
    this.cfg,
    this.numSteps,
    this.tashkeel,
    this.normalize,
    this.extraBody,
  });

  /// The voice; defaults to the session's.
  final String? voiceId;

  /// How fast the voice speaks (0.5 to 2).
  final double? speed;

  /// How closely the voice follows the text (1 to 5).
  final double? cfg;

  /// Diffusion steps: 16, 32, 48, 64 or 128.
  final int? numSteps;

  /// Add vowel marks to Arabic text first (Fusha voices).
  final bool? tashkeel;

  /// Read numbers, dates and the like the way a speaker of the dialect says
  /// them.
  final bool? normalize;

  /// Extra fields sent as they are, for options newer than this SDK.
  final Map<String, Object?>? extraBody;

  /// These options, with unset fields taken from [defaults].
  SynthesisOptions over(SynthesisOptions defaults) => SynthesisOptions(
        voiceId: voiceId ?? defaults.voiceId,
        speed: speed ?? defaults.speed,
        cfg: cfg ?? defaults.cfg,
        numSteps: numSteps ?? defaults.numSteps,
        tashkeel: tashkeel ?? defaults.tashkeel,
        normalize: normalize ?? defaults.normalize,
        extraBody: extraBody ?? defaults.extraBody,
      );
}

/// Where a synthesis came from.
enum SynthesisOrigin {
  /// `synthesize()`: replaces whatever is running.
  synthesize,

  /// `enqueue()`: waits its turn in the client queue.
  queue,
}

/// The kind of frame an [Outbound] sends.
enum OutboundKind {
  /// A `synthesize` frame.
  synthesize,

  /// A `cancel` frame.
  cancel,
}

/// A frame to send for a synthesis.
final class Outbound {
  /// Creates an outbound frame.
  const Outbound(this.kind, this.core);

  /// What to send.
  final OutboundKind kind;

  /// The synthesis it is for.
  final SynthesisCore core;

  /// The frame's text.
  String get text =>
      kind == OutboundKind.synthesize ? core.frameText : cancelFrame;
}

/// The state of one synthesis request. Owned by [TtsProtocol]; read by the
/// handle classes.
final class SynthesisCore {
  /// Creates the state of a new request.
  SynthesisCore(
    this.requestId,
    this.frame,
    this.frameText,
    this.origin,
    this.createdAt,
  );

  /// The SDK-generated `requestId`.
  final String requestId;

  /// The `synthesize` frame.
  final Map<String, Object?> frame;

  /// The `synthesize` frame, encoded.
  final String frameText;

  /// Where it came from.
  final SynthesisOrigin origin;

  /// When it was created.
  final Duration createdAt;

  /// Its state.
  SynthesisState state = SynthesisState.queued;

  /// Audio received and not yet handed to the caller.
  final Queue<Uint8List> chunks = Queue();

  /// Bytes of audio received.
  int audioBytes = 0;

  /// Audio frames received.
  int frames = 0;

  /// Frames dropped because a cancel was requested.
  int droppedFrames = 0;

  /// The audio's sample rate, from `start`.
  int? sampleRate;

  /// The `start` frame.
  Map<String, Object?>? startEvent;

  /// The `done` frame.
  Map<String, Object?>? doneEvent;

  /// The `cancelled` frame.
  Map<String, Object?>? cancelledEvent;

  /// When it was sent.
  Duration? sentAt;

  /// When `start` arrived.
  Duration? startedAt;

  /// When the first audio frame arrived.
  Duration? firstAudioAt;

  /// When it reached its final state.
  Duration? finishedAt;

  /// `start` or audio arrived: the server is producing it.
  bool started = false;

  /// Handed to the session; may be on the wire.
  bool sending = false;

  /// It was written to a socket at least once.
  bool everSent = false;

  /// Why a cancel was requested.
  SynthesisOutcome? cancelReason;

  /// When the cancel was requested (or the newer request sent).
  Duration? cancelRequestedAt;

  /// A `cancel` frame was sent for it.
  bool cancelSent = false;

  /// The server confirmed the cancel.
  bool cancelAcked = false;

  /// No `start` arrived in time.
  bool timedOut = false;

  /// Requests this one replaces.
  final List<SynthesisCore> supersedes = [];

  /// Why it failed or was lost.
  EchoNovaException? error;

  /// Whether it was charged (`null`: unknown).
  bool? charged;

  /// The final cost the server reported.
  double? creditsConsumed;

  /// Times it was resent after a pre-audio `upstream_error`.
  int resends = 0;

  /// The connection generation it was sent on.
  int connGen = -1;

  /// The order it was sent in.
  int sendSeq = -1;

  /// Whether it reached a final state.
  bool get terminal => state.isTerminal;

  /// Whether it has been charged: `yes`, `no` or `unknown`.
  ChargeState get chargeState {
    if (terminal) {
      return switch (charged) {
        null => ChargeState.unknown,
        true => ChargeState.yes,
        false => ChargeState.no,
      };
    }
    if (started) return ChargeState.yes;
    return everSent ? ChargeState.unknown : ChargeState.no;
  }

  /// How it ended, when it didn't fail.
  SynthesisOutcome? get outcome => switch (state) {
        SynthesisState.completed => SynthesisOutcome.completed,
        SynthesisState.cancelled => SynthesisOutcome.cancelled,
        SynthesisState.superseded => SynthesisOutcome.superseded,
        _ => null,
      };

  /// Its timings.
  SynthesisMetrics metrics() {
    final sent = sentAt;
    Duration? since(Duration? at) =>
        at != null && sent != null ? at - sent : null;
    return SynthesisMetrics(
      ttfb: since(firstAudioAt),
      timeToStart: since(startedAt),
      total: since(finishedAt),
      audioBytes: audioBytes,
      frames: frames,
      droppedFrames: droppedFrames,
    );
  }

  /// Its result. Only valid once [outcome] is set.
  SynthesisResult result() {
    final outcome = this.outcome;
    if (outcome == null) throw StateError('the synthesis has not finished');
    final done = doneEvent ?? const <String, Object?>{};
    return SynthesisResult(
      requestId: requestId,
      outcome: outcome,
      charged: charged,
      durationSeconds: numberOf(done['durationSeconds']),
      characters: numberOf(done['characters'])?.toInt(),
      creditsConsumed: creditsConsumed,
      sampleRate: sampleRate,
      raw: doneEvent ?? cancelledEvent,
    );
  }

  @override
  String toString() => 'SynthesisCore($requestId, ${state.name})';
}

/// A JSON number as a double, or `null`.
double? numberOf(Object? value) => value is num ? value.toDouble() : null;

/// Request IDs only need to be unique, so any random source will do when
/// the platform has no secure one.
final math.Random _random = () {
  try {
    final random = math.Random.secure();
    random.nextInt(256);
    return random;
  } on Object {
    return math.Random();
  }
}();

/// A random (version 4) UUID.
String uuid4() {
  final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = [for (final b in bytes) b.toRadixString(16).padLeft(2, '0')];
  return '${hex.sublist(0, 4).join()}-${hex.sublist(4, 6).join()}-'
      '${hex.sublist(6, 8).join()}-${hex.sublist(8, 10).join()}-'
      '${hex.sublist(10).join()}';
}

/// The Text to Speech protocol state machine.
final class TtsProtocol {
  /// Creates the state machine for a session on [voiceId].
  TtsProtocol({
    required this.voiceId,
    this.defaults = const SynthesisOptions(),
    this.startTimeout = const Duration(seconds: 30),
    this.cancelAckTimeout = const Duration(seconds: 5),
    this.errorHold = const Duration(seconds: 1),
    String Function()? newRequestId,
  }) : _newRequestId = newRequestId ?? uuid4;

  /// The session's voice.
  final String voiceId;

  /// Options applied to every synthesis unless it overrides them.
  final SynthesisOptions defaults;

  /// No `start` within this long fails the request.
  final Duration startTimeout;

  /// A cancel not confirmed within this long is treated as done.
  final Duration cancelAckTimeout;

  /// An error frame that matches no request waits this long for a close.
  final Duration errorHold;

  final String Function() _newRequestId;
  final Queue<Outbound> _pending = Queue(); // frames to send, in order
  final Queue<SynthesisCore> _queue = Queue(); // enqueue(): one at a time
  // Sent and not finished, in send order.
  final LinkedHashMap<String, SynthesisCore> _inFlight = LinkedHashMap();
  final LinkedHashMap<String, SynthesisCore> _recent = LinkedHashMap();

  /// The request whose audio is arriving.
  SynthesisCore? active;
  SynthesisCore? _sending; // handed to the session, not yet confirmed sent
  CloseInfo? _lastClose;

  /// Whether a socket is open.
  bool connected = false;

  /// Increases on every close; frames from an older socket are ignored.
  int connGen = 0;
  int _sendSeq = 0;

  /// The error that ended the session, if it can't continue.
  EchoNovaException? fatal;

  /// The user closed the session.
  bool closed = false;

  /// The last socket ended abnormally (reconnect may wait for a slot).
  bool afterAbnormal = false;

  /// Audio frames that matched no running synthesis.
  int orphanFrames = 0;

  /// How many times `interrupt()` was called.
  int interrupts = 0;

  /// The latest events of unknown types.
  final Queue<UnknownEvent> unknownEvents = Queue();

  ({Map<String, Object?> event, Duration at})? _heldError;

  // --- User calls ------------------------------------------------------------

  /// Throws when the session can't take requests.
  void checkUsable() {
    if (closed) {
      throw SessionEndedException('the Text to Speech session is closed');
    }
    final error = fatal;
    if (error != null) {
      throw SessionEndedException(
        'the Text to Speech session failed: $error',
        cause: error,
      );
    }
  }

  /// A new request for [text]. Throws [UsageException] when the frame is
  /// too large to send.
  SynthesisCore newCore(
    String text,
    SynthesisOptions options, {
    required SynthesisOrigin origin,
    required Duration now,
  }) {
    final requestId = _newRequestId();
    final merged = options.over(defaults);
    final frame = <String, Object?>{
      'type': 'synthesize',
      'requestId': requestId,
      'text': text,
      'voiceId': merged.voiceId ?? voiceId,
      if (merged.speed != null) 'speed': merged.speed,
      if (merged.cfg != null) 'cfg': merged.cfg,
      if (merged.numSteps != null) 'numSteps': merged.numSteps,
      if (merged.tashkeel != null) 'tashkeel': merged.tashkeel,
      if (merged.normalize != null) 'normalize': merged.normalize,
      ...?merged.extraBody,
    };
    return SynthesisCore(requestId, frame, encodeJson(frame), origin, now);
  }

  /// Starts a synthesis now. Anything not yet sent is dropped; the running
  /// one is superseded.
  SynthesisCore synthesize(
    String text,
    SynthesisOptions options,
    Duration now,
  ) {
    checkUsable();
    final core =
        newCore(text, options, origin: SynthesisOrigin.synthesize, now: now);
    _dropUnsent(now, SynthesisState.superseded);
    for (final other in _liveCores()) {
      if (other.state == SynthesisState.sent ||
          other.state == SynthesisState.streaming ||
          other.state == SynthesisState.queued) {
        other
          ..state = SynthesisState.cancelling
          ..cancelReason = SynthesisOutcome.superseded;
        core.supersedes.add(other);
      }
    }
    _pending.add(Outbound(OutboundKind.synthesize, core));
    return core;
  }

  /// Adds to the client FIFO. It is sent after everything before it has
  /// finished.
  SynthesisCore enqueue(String text, SynthesisOptions options, Duration now) {
    checkUsable();
    final core =
        newCore(text, options, origin: SynthesisOrigin.queue, now: now);
    _queue.add(core);
    return core;
  }

  /// Cancels [core]. A request never sent is dropped locally; nothing is
  /// sent for it.
  void cancel(SynthesisCore core, Duration now) {
    if (core.terminal || core.state == SynthesisState.cancelling) return;
    if (core.state == SynthesisState.queued && !core.sending) {
      _removeUnsent(core);
      _finish(core, SynthesisState.cancelled, charged: false, now: now);
      return;
    }
    core
      ..state = SynthesisState.cancelling
      ..cancelReason = SynthesisOutcome.cancelled
      ..cancelRequestedAt = now;
    _pending.add(Outbound(OutboundKind.cancel, core));
  }

  /// Cancels whatever is in flight. Does nothing (and sends nothing) when
  /// nothing is.
  void cancelActive(Duration now) {
    for (final core in _liveCores()) {
      cancel(core, now);
    }
  }

  /// Barge-in: cancels what is in flight and drops everything not yet sent.
  void interrupt(Duration now) {
    interrupts += 1;
    _dropUnsent(now, SynthesisState.cancelled);
    cancelActive(now);
  }

  /// The user closed the session. In-flight requests end when the socket
  /// closes.
  void close(Duration now) {
    closed = true;
    _dropUnsent(now, SynthesisState.cancelled);
  }

  // --- Outbound --------------------------------------------------------------

  /// The next frame to send, if any. The session must call [sent] or
  /// [requeue] for it.
  Outbound? nextOutbound(Duration now) {
    if (fatal != null) return null;
    while (_pending.isNotEmpty) {
      final item = _pending.removeFirst();
      final core = item.core;
      if (item.kind == OutboundKind.synthesize) {
        if ((core.state == SynthesisState.queued ||
                core.state == SynthesisState.cancelling) &&
            !core.everSent) {
          if (core.state == SynthesisState.cancelling) {
            // Cancelled before it was ever sent.
            _finish(
              core,
              _outcomeState(core.cancelReason),
              charged: false,
              now: now,
            );
            continue;
          }
          core.sending = true;
          _sending = core;
          return item;
        }
        continue;
      }
      // cancel: only for a request in flight on this socket, and only once.
      if (connected &&
          core.connGen == connGen &&
          !core.cancelSent &&
          (core.state == SynthesisState.cancelling || core.timedOut)) {
        core.cancelSent = true;
        return item;
      }
    }
    if (_queue.isNotEmpty && !_anyRunning) {
      final core = _queue.removeFirst();
      core.sending = true;
      _sending = core;
      return Outbound(OutboundKind.synthesize, core);
    }
    return null;
  }

  bool get _anyRunning => _inFlight.values.any(
        (c) =>
            c.state == SynthesisState.sent ||
            c.state == SynthesisState.streaming,
      );

  /// Whether a frame is waiting to be sent.
  bool hasOutbound() =>
      _pending.isNotEmpty || (_queue.isNotEmpty && !_anyRunning);

  /// [item] was written to the socket.
  void sent(Outbound item, Duration now) {
    final core = item.core;
    if (item.kind == OutboundKind.cancel) return;
    core.sending = false;
    if (identical(_sending, core)) _sending = null;
    core
      ..everSent = true
      ..sentAt = now;
    if (!connected) {
      // The socket closed while this frame was being written.
      final info = _lastClose ?? const CloseInfo(1006);
      final error =
          closeError(info) ?? StreamClosedException('the stream closed');
      attachChargeState(error, ChargeState.unknown);
      _finish(core, SynthesisState.lost, error: error, charged: null, now: now);
      return;
    }
    core.connGen = connGen;
    _sendSeq += 1;
    core.sendSeq = _sendSeq;
    if (core.state == SynthesisState.queued) core.state = SynthesisState.sent;
    _inFlight[core.requestId] = core;
    for (final other in core.supersedes) {
      if (other.state == SynthesisState.cancelling &&
          other.cancelRequestedAt == null) {
        other.cancelRequestedAt = now;
      }
    }
  }

  /// [item] could not be sent (the socket closed first). It goes out on the
  /// next socket, unless it was cancelled meanwhile.
  void requeue(Outbound item, Duration now) {
    final core = item.core;
    if (item.kind == OutboundKind.cancel) {
      core.cancelSent = false;
      return;
    }
    core.sending = false;
    if (identical(_sending, core)) _sending = null;
    if (core.state == SynthesisState.cancelling || closed) {
      _finish(
        core,
        _outcomeState(core.cancelReason),
        charged: false,
        now: now,
      );
    } else if (core.state == SynthesisState.queued) {
      _pending.addFirst(item);
    }
  }

  /// No connection could be opened to send [item]. It was never sent.
  void sendFailed(Outbound item, EchoNovaException error, Duration now) {
    final core = item.core;
    core.sending = false;
    if (identical(_sending, core)) _sending = null;
    if (item.kind == OutboundKind.cancel || core.terminal) return;
    _finish(
      core,
      SynthesisState.failed,
      error: attachChargeState(error, ChargeState.no),
      charged: false,
      now: now,
    );
    if (error is APIStatusException) {
      // The server refused the connection: the rest would fail too.
      for (final other in _unsent()) {
        _removeUnsent(other);
        _finish(
          other,
          SynthesisState.failed,
          error: error,
          charged: false,
          now: now,
        );
      }
    }
  }

  // --- Connection ------------------------------------------------------------

  /// A socket opened.
  void connectionOpened(Duration now) {
    connected = true;
    afterAbnormal = false;
  }

  /// The socket closed.
  void connectionClosed(CloseInfo info, Duration now) {
    final held = _heldError?.event;
    _heldError = null;
    _lastClose = info;
    connected = false;
    connGen += 1;
    active = null;
    afterAbnormal = info.abnormal;
    for (final core in _inFlight.values.toList()) {
      core.sending = false;
      if (core.state == SynthesisState.cancelling ||
          (info.local && info.lostReason == null)) {
        final charged = core.started || core.cancelAcked ? true : null;
        _finish(
          core,
          _outcomeState(core.cancelReason),
          charged: charged,
          now: now,
        );
        continue;
      }
      final error = closeError(
            info,
            lastError: held,
            mayHaveExecuted: core.started ? true : null,
          ) ??
          StreamClosedException(
            'the stream closed',
            closeCode: info.code,
            reason: info.reason.isEmpty ? null : info.reason,
          );
      attachChargeState(
        error,
        core.started ? ChargeState.yes : ChargeState.unknown,
      );
      _finish(
        core,
        fatalCloseCodes.contains(info.code)
            ? SynthesisState.failed
            : SynthesisState.lost,
        error: error,
        charged: core.started ? true : null,
        now: now,
      );
    }
    if (fatalCloseCodes.contains(info.code) &&
        !info.local &&
        info.lostReason == null) {
      fatal = closeError(info, lastError: held);
      for (final core in _unsent()) {
        _removeUnsent(core);
        final error = closeError(info, lastError: held);
        if (error != null) attachChargeState(error, ChargeState.no);
        _finish(
          core,
          SynthesisState.failed,
          error: error,
          charged: false,
          now: now,
        );
      }
    }
  }

  // --- Inbound ---------------------------------------------------------------

  /// A JSON frame arrived.
  void receiveEvent(Map<String, Object?> event, Duration now) {
    switch (event['type']) {
      case 'start':
        _onStart(event, now);
      case 'done':
        _onDone(event, now);
      case 'cancelled':
        _onCancelled(event, now);
      case 'error':
        _onError(event, now);
      case 'pong':
        break;
      default:
        unknownEvents.add(UnknownEvent(Map.of(event)));
        while (unknownEvents.length > _unknownLimit) {
          unknownEvents.removeFirst();
        }
    }
  }

  /// A binary (audio) frame arrived.
  void receiveBinary(Uint8List data, Duration now) {
    final core = active;
    if (core != null && core.state == SynthesisState.streaming) {
      core
        ..firstAudioAt ??= now
        ..audioBytes += data.length
        ..frames += 1;
      core.chunks.add(data);
      return;
    }
    if (core != null) core.droppedFrames += 1;
    orphanFrames += 1;
  }

  SynthesisCore? _lookup(Map<String, Object?> event) =>
      switch (event['requestId']) {
        final String rid => _inFlight[rid],
        _ => null,
      };

  void _onStart(Map<String, Object?> event, Duration now) {
    final core = _lookup(event);
    if (core == null) {
      // Audio until the next start belongs to a request no longer tracked.
      active = null;
      return;
    }
    for (final other in _inFlight.values.toList()) {
      if (identical(other, core)) break;
      final charged = other.started || other.cancelAcked ? true : null;
      final outcome =
          other.state == SynthesisState.cancelling && other.cancelReason != null
              ? _outcomeState(other.cancelReason)
              : SynthesisState.superseded;
      _finish(other, outcome, charged: charged, now: now);
    }
    core
      ..started = true
      ..startedAt = now
      ..startEvent = Map.of(event);
    final rate = event['sampleRate'];
    if (rate is int && rate > 0) core.sampleRate = rate;
    if (core.state == SynthesisState.sent) {
      core.state = SynthesisState.streaming;
    }
    active = core;
  }

  void _onDone(Map<String, Object?> event, Duration now) {
    final core = _lookup(event);
    if (core == null) return;
    core
      ..doneEvent = Map.of(event)
      ..creditsConsumed = numberOf(event['creditsConsumed']);
    _finish(
      core,
      core.state == SynthesisState.cancelling
          ? _outcomeState(core.cancelReason)
          : SynthesisState.completed,
      charged: true,
      now: now,
    );
  }

  void _onCancelled(Map<String, Object?> event, Duration now) {
    final core = _lookup(event);
    if (core == null) return;
    final credits = numberOf(event['creditsConsumed']);
    core
      ..cancelAcked = true
      ..cancelledEvent = Map.of(event)
      ..creditsConsumed = credits;
    // The server reports the final cost of a charged synthesis; without one
    // it was cancelled before it was charged, unless its audio had started.
    _finish(
      core,
      _outcomeState(core.cancelReason),
      charged: credits != null || core.started,
      now: now,
    );
  }

  void _onError(Map<String, Object?> event, Duration now) {
    final code = event['code'];
    final rid = event['requestId'];
    if (code == 'invalid_message' || code == 'frame_too_large') {
      // A policy close follows; it decides what fails.
      _heldError = (event: event, at: now);
      return;
    }
    final SynthesisCore core;
    if (rid is String) {
      final found = _inFlight[rid];
      if (found == null) {
        if (!_recent.containsKey(rid)) _heldError = (event: event, at: now);
        return;
      }
      core = found;
    } else {
      final candidates = _inFlight.values.toList();
      if (candidates.length != 1) {
        _heldError = (event: event, at: now);
        return;
      }
      core = candidates.single;
    }
    final error = errorFromFrame(event);
    final credits = numberOf(event['creditsConsumed']);
    if (code == 'upstream_error') {
      attachCreditsConsumed(error, credits);
      if (core.started ||
          (credits != null && core.state != SynthesisState.cancelling)) {
        // Audio already flowed, or the server reported a cost: it was
        // charged (the share sent). No done follows, and it is never resent.
        core.creditsConsumed = credits;
        _finish(
          core,
          SynthesisState.failed,
          error: attachChargeState(error, ChargeState.yes),
          charged: true,
          now: now,
        );
      } else if (core.state == SynthesisState.cancelling) {
        // The caller asked it to stop: an outcome, not an error.
        core.creditsConsumed = credits;
        _finish(
          core,
          _outcomeState(core.cancelReason),
          charged: credits != null,
          now: now,
        );
      } else if (core.resends < maxResends) {
        // Failed before any audio, and refunded: the one case the SDK
        // resends.
        core
          ..resends += 1
          ..state = SynthesisState.queued
          ..sending = false
          ..everSent = false;
        _inFlight.remove(core.requestId);
        _pending.addFirst(Outbound(OutboundKind.synthesize, core));
        streamLog('resending a synthesis that failed before any audio');
      } else {
        _finish(
          core,
          SynthesisState.failed,
          error: attachChargeState(error, ChargeState.no),
          charged: false,
          now: now,
        );
      }
      return;
    }
    _finish(
      core,
      SynthesisState.failed,
      error: attachChargeState(error, ChargeState.no),
      charged: false,
      now: now,
    );
    if (code == 'validation_failed') {
      // A rejected request may leave the running one going. The caller asked
      // for it to stop, so cancel it explicitly, unless a newer request is on
      // its way (that one replaces it).
      final newerPending =
          _pending.any((item) => item.kind == OutboundKind.synthesize);
      if (core.sendSeq == _sendSeq && !newerPending) {
        for (final other in core.supersedes) {
          if (other.state == SynthesisState.cancelling &&
              !other.cancelSent &&
              other.connGen == connGen) {
            other.cancelRequestedAt = now;
            _pending.add(Outbound(OutboundKind.cancel, other));
          }
        }
      }
    }
  }

  // --- Clock -----------------------------------------------------------------

  /// Applies the timeouts due at [now].
  void tick(Duration now) {
    for (final core in _inFlight.values.toList()) {
      final sentAt = core.sentAt;
      final cancelAt = core.cancelRequestedAt;
      if (core.state == SynthesisState.sent &&
          sentAt != null &&
          now - sentAt >= startTimeout) {
        final error = APITimeoutException(
          'no audio started within ${startTimeout.inMilliseconds / 1000} s; '
          'the request may have been charged',
          kind: TimeoutKind.read,
          mayHaveExecuted: null,
        );
        core.timedOut = true;
        _finish(
          core,
          SynthesisState.failed,
          error: attachChargeState(error, ChargeState.unknown),
          charged: null,
          now: now,
        );
        if (connected) _pending.add(Outbound(OutboundKind.cancel, core));
      } else if (core.state == SynthesisState.cancelling &&
          cancelAt != null &&
          now - cancelAt >= cancelAckTimeout) {
        _finish(
          core,
          _outcomeState(core.cancelReason),
          charged: core.started ? true : null,
          now: now,
        );
      }
    }
    final held = _heldError;
    if (held != null && now - held.at >= errorHold) {
      _heldError = null;
      streamLog(
        'unmatched Text to Speech error frame: ${held.event['code']}',
        level: 900,
      );
    }
  }

  /// When [tick] next needs to run, if ever.
  Duration? nextDeadline() {
    Duration? earliest;
    void consider(Duration at) {
      if (earliest == null || at < earliest!) earliest = at;
    }

    for (final core in _inFlight.values) {
      final sentAt = core.sentAt;
      final cancelAt = core.cancelRequestedAt;
      if (core.state == SynthesisState.sent && sentAt != null) {
        consider(sentAt + startTimeout);
      } else if (core.state == SynthesisState.cancelling && cancelAt != null) {
        consider(cancelAt + cancelAckTimeout);
      }
    }
    final held = _heldError;
    if (held != null) consider(held.at + errorHold);
    return earliest;
  }

  // --- Introspection ---------------------------------------------------------

  /// Nothing in flight and nothing waiting to be sent.
  bool get idle =>
      _inFlight.isEmpty &&
      _sending == null &&
      _queue.isEmpty &&
      !_pending.any((item) => item.kind == OutboundKind.synthesize);

  /// A request is waiting to be sent.
  bool get needsConnection => fatal == null && hasOutbound();

  /// The requests sent and not finished, in send order.
  List<SynthesisCore> inFlight() => _inFlight.values.toList();

  // --- Internals -------------------------------------------------------------

  /// In flight, plus the one being written right now.
  List<SynthesisCore> _liveCores() {
    final sending = _sending;
    return [
      ..._inFlight.values,
      if (sending != null && !sending.terminal) sending,
    ];
  }

  List<SynthesisCore> _unsent() => [
        for (final item in _pending)
          if (item.kind == OutboundKind.synthesize &&
              item.core.state == SynthesisState.queued)
            item.core,
        for (final core in _queue)
          if (core.state == SynthesisState.queued) core,
      ];

  void _removeUnsent(SynthesisCore core) {
    _queue.remove(core);
    _pending.removeWhere(
      (item) =>
          item.kind == OutboundKind.synthesize && identical(item.core, core),
    );
  }

  void _dropUnsent(Duration now, SynthesisState outcome) {
    for (final core in _unsent()) {
      if (core.sending) continue;
      _removeUnsent(core);
      _finish(core, outcome, charged: false, now: now);
    }
  }

  static SynthesisState _outcomeState(SynthesisOutcome? reason) =>
      switch (reason) {
        SynthesisOutcome.superseded => SynthesisState.superseded,
        SynthesisOutcome.completed => SynthesisState.completed,
        _ => SynthesisState.cancelled,
      };

  void _finish(
    SynthesisCore core,
    SynthesisState state, {
    required bool? charged,
    required Duration now,
    EchoNovaException? error,
  }) {
    if (core.terminal) return;
    core
      ..state = state
      ..charged = charged
      ..error = error
      ..finishedAt = now
      ..sending = false;
    _inFlight.remove(core.requestId);
    if (identical(active, core)) active = null;
    _recent[core.requestId] = core;
    while (_recent.length > _recentLimit) {
      _recent.remove(_recent.keys.first);
    }
  }
}

// --- Sentence splitting for speakStream --------------------------------------

/// Characters that end a sentence.
const String sentenceMarks = '.!?؟،؛\n';

/// The longest text one `synthesize` frame accepts.
const int maxSentenceChars = 500;

final RegExp _space = RegExp(r'\s');
final RegExp _speakable = RegExp(r'[\p{L}\p{N}]', unicode: true);

/// Splits streamed text into sentences of at most [maxChars] characters.
///
/// A sentence ends at `. ! ? ؟ ، ؛` followed by whitespace, or at a newline.
/// Waiting for the whitespace keeps numbers like `3.5` whole. Pieces with no
/// letters or digits are skipped, because they produce no speech.
final class SentenceSplitter {
  /// Creates a splitter.
  SentenceSplitter({this.maxChars = maxSentenceChars});

  /// The longest piece returned.
  final int maxChars;

  String _buffer = '';

  /// Adds text and returns the sentences now complete.
  List<String> push(String delta) {
    _buffer += delta;
    final out = <String>[];
    var start = 0;
    final text = _buffer;
    for (var i = 0; i < text.length; i++) {
      final ch = text[i];
      if (!sentenceMarks.contains(ch)) continue;
      if (ch == '\n' || (i + 1 < text.length && _space.hasMatch(text[i + 1]))) {
        out.addAll(_emit(text.substring(start, i + 1)));
        start = i + 1;
      }
    }
    _buffer = text.substring(start);
    while (_buffer.length > maxChars) {
      final (piece, rest) = _cut(_buffer);
      _buffer = rest;
      out.addAll(_emit(piece));
    }
    return out;
  }

  /// Returns whatever text is left.
  List<String> flush() {
    final rest = _buffer;
    _buffer = '';
    return _emit(rest);
  }

  (String, String) _cut(String text) {
    final window = text.substring(0, math.min(text.length, maxChars + 1));
    var at = math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
    if (at <= 0) at = maxChars;
    return (text.substring(0, at), text.substring(at));
  }

  List<String> _emit(String piece) {
    final out = <String>[];
    var rest = piece.trim();
    while (rest.length > maxChars) {
      final (head, tail) = _cut(rest);
      out.add(head.trim());
      rest = tail.trim();
    }
    out.add(rest);
    return [
      for (final p in out)
        if (_speakable.hasMatch(p)) p,
    ];
  }
}
