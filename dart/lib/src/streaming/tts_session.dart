/// Text to Speech stream sessions: [TtsSession] and [Synthesis].
///
/// One socket carries many syntheses, one at a time. The socket is reopened
/// lazily when something needs sending, and rotated while idle before the
/// server's session limit.
library;

import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import '../audio.dart';
import '../errors.dart';
import 'async_util.dart';
import 'link.dart';
import 'options.dart';
import 'socket.dart';
import 'stream_errors.dart';
import 'tts_protocol.dart';
import 'types.dart';

/// One synthesis on a [TtsSession].
///
/// Listen to [audio] for PCM16LE mono chunks at [sampleRate] (known from the
/// first chunk on), and await [result] for how it ended. [audio] can be
/// listened to once; cancelling that subscription cancels the synthesis.
final class Synthesis {
  Synthesis._(this._session, this._core) {
    _audio = StreamController<Uint8List>(onCancel: _onAudioCancel);
    result = _result.future..ignore();
    whenSent = _sent.future..ignore();
  }

  final TtsSession _session;
  final SynthesisCore _core;
  late final StreamController<Uint8List> _audio;
  final Completer<SynthesisResult> _result = Completer();
  final Completer<void> _sent = Completer();

  /// The SDK-generated `requestId`.
  String get requestId => _core.requestId;

  /// Where the synthesis is in its life.
  SynthesisState get state => _core.state;

  /// The audio's sample rate, from the server's `start` (`null` before it
  /// arrives). It is set before the first audio chunk is delivered.
  int? get sampleRate => _core.sampleRate;

  /// Timings and counters.
  SynthesisMetrics get metrics => _core.metrics();

  /// From sending the request to the first audio frame.
  Duration? get ttfb => _core.metrics().ttfb;

  /// Whether it has been charged, as far as the SDK can tell.
  ChargeState get chargeState => _core.chargeState;

  /// Once it has ended: whether it was billed (`null`: unknown). See
  /// [SynthesisResult.charged].
  bool? get charged => _core.terminal ? _core.charged : null;

  /// The final cost the server reported (`done`, `cancelled`, or a
  /// mid-stream `error`).
  double? get creditsConsumed => _core.creditsConsumed;

  /// Why it failed or was lost, once it has.
  EchoNovaException? get error => _core.error;

  /// Whether it has ended.
  bool get isDone => _core.terminal;

  /// The audio: PCM16LE mono chunks at [sampleRate]. The stream ends when
  /// the synthesis does; it ends with [error] when the synthesis failed or
  /// was lost (after the audio that did arrive).
  ///
  /// Single-subscription. Cancelling the subscription cancels the
  /// synthesis.
  Stream<Uint8List> get audio => _audio.stream;

  /// How the synthesis ended: completed, cancelled or superseded. Completes
  /// with the error when it failed or was lost (`chargeStateOf(error)` says
  /// whether it was charged). A cancellation is an outcome, not an error.
  late final Future<SynthesisResult> result;

  /// Completes once the request has been written to the socket (or has
  /// ended). Completes with an error when no connection could be opened to
  /// send it.
  late final Future<void> whenSent;

  /// All the audio, once the synthesis has ended. Listens to [audio], so
  /// use one or the other. Throws the synthesis's error when it failed.
  Future<Audio> collect() async {
    final builder = BytesBuilder(copy: false);
    await for (final chunk in audio) {
      builder.add(chunk);
    }
    return Audio(builder.takeBytes(), _core.sampleRate ?? 0);
  }

  /// Stops this synthesis. A request not yet sent is dropped locally; one in
  /// flight gets a `cancel`. Its result reports the outcome and cost.
  void cancel() => _session._cancelCore(_core);

  void _onAudioCancel() {
    if (!_core.terminal) cancel();
  }

  /// Delivers new audio and the final state. Returns `true` once finished.
  bool _sync() {
    final core = _core;
    while (core.chunks.isNotEmpty) {
      _audio.add(core.chunks.removeFirst());
    }
    if (!_sent.isCompleted &&
        (core.terminal ||
            (core.state != SynthesisState.queued && !core.sending))) {
      final error = core.error;
      if (core.state == SynthesisState.failed &&
          !core.everSent &&
          error != null) {
        _sent.completeError(error);
      } else {
        _sent.complete();
      }
    }
    if (!core.terminal) return false;
    final error = core.error;
    if (!_audio.isClosed) {
      if (error != null) _audio.addError(error);
      unawaited(_audio.close());
    }
    if (!_result.isCompleted) {
      if (error != null) {
        _result.completeError(error);
      } else if (core.outcome != null) {
        _result.complete(core.result());
      } else {
        _result.completeError(
          StreamClosedException('the synthesis ended without a result'),
        );
      }
    }
    return true;
  }

  @override
  String toString() => 'Synthesis($requestId, ${state.name})';
}

/// A Text to Speech stream. Open one with `connectTts`.
///
/// [synthesize] speaks text now, replacing whatever is running (barge-in);
/// [enqueue] queues text to play after the current one; [speakStream] speaks
/// streamed text (for example LLM output) sentence by sentence.
///
/// The socket reopens by itself when a request needs it after a dropped
/// connection or a server timeout, and is rotated while idle before the
/// server's 30-minute limit. A request that was sent but never started is
/// never resent automatically, because it may have been charged.
final class TtsSession {
  TtsSession._(
    this._options, {
    required String voiceId,
    SynthesisOptions defaults = const SynthesisOptions(),
    Duration? waitForSlot,
    String Function()? newRequestId,
  })  : _clock = _options.clock,
        _url = _options.url(ttsStreamPath),
        _waitForSlot = waitForSlot,
        _protocol = TtsProtocol(
          voiceId: voiceId,
          defaults: defaults,
          startTimeout: _options.synthesisStartTimeout,
          cancelAckTimeout: _options.cancelAckTimeout,
          newRequestId: newRequestId,
        ),
        _limiter = AttemptLimiter(
          maxAttempts: _options.maxConnectAttempts,
          window: _options.connectWindow,
        );

  final StreamOptions _options;
  final StreamClock _clock;
  final Uri _url;
  final Duration? _waitForSlot;
  final TtsProtocol _protocol;
  final AttemptLimiter _limiter;
  final Map<SynthesisCore, Synthesis> _handles = LinkedHashMap.identity();
  final Mutex _connectLock = Mutex();
  Link? _link;
  bool _closed = false;
  bool _pumping = false;
  bool _pumpAgain = false;
  bool _tickScheduled = false;
  bool _rotating = false;
  Timer? _timer;

  /// The `X-Request-Id` of the latest handshake (not available in a
  /// browser).
  String? handshakeRequestId;

  /// Whether [close] was called.
  bool get isClosed => _closed;

  /// Whether a socket is open now.
  bool get isConnected => _link != null && !_link!.closed;

  /// The sample rate of the most recent synthesis that started, from its
  /// `start` event (`null` before the first).
  ///
  /// [speakStream] yields only audio; read its rate here. It is set before
  /// the first chunk of each synthesis is delivered.
  int? get sampleRate => _protocol.sampleRate;

  /// Audio frames that matched no running synthesis and were discarded.
  int get droppedFrames => _protocol.orphanFrames;

  /// The latest events of types this SDK version doesn't know (kept, never
  /// thrown).
  List<UnknownEvent> get unknownEvents => _protocol.unknownEvents.toList();

  /// The error that ended the session, when it can't continue (a billing or
  /// protocol close).
  EchoNovaException? get failure => _protocol.fatal;

  // --- Public API ------------------------------------------------------------

  /// Speaks [text] now, replacing whatever is running and dropping anything
  /// queued. Options left `null` use the session's defaults.
  ///
  /// Throws [SessionEndedException] when the session is closed or failed,
  /// and [UsageException] when the request is too large to send.
  Synthesis synthesize(
    String text, {
    String? voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    Map<String, Object?>? extraBody,
  }) {
    final core = _protocol.synthesize(
      text,
      SynthesisOptions(
        voiceId: voiceId,
        speed: speed,
        cfg: cfg,
        numSteps: numSteps,
        tashkeel: tashkeel,
        normalize: normalize,
        extraBody: extraBody,
      ),
      _clock(),
    );
    final synthesis = _register(core);
    _kick();
    return synthesis;
  }

  /// Queues [text]. It is sent once everything before it has finished
  /// (sending it earlier would cancel the running one).
  Synthesis enqueue(
    String text, {
    String? voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    Map<String, Object?>? extraBody,
  }) {
    final core = _protocol.enqueue(
      text,
      SynthesisOptions(
        voiceId: voiceId,
        speed: speed,
        cfg: cfg,
        numSteps: numSteps,
        tashkeel: tashkeel,
        normalize: normalize,
        extraBody: extraBody,
      ),
      _clock(),
    );
    final synthesis = _register(core);
    _kick();
    return synthesis;
  }

  /// Cancels the running synthesis, if any. Queued ones still play
  /// afterwards. Sends nothing when nothing is running.
  void cancel() {
    _protocol.cancelActive(_clock());
    _kick();
  }

  /// Barge-in: cancels the running synthesis and drops everything queued.
  void interrupt() {
    _protocol.interrupt(_clock());
    _kick();
  }

  /// Speaks [texts] as one continuous PCM stream, sentence by sentence.
  ///
  /// [texts] is a [String], an [Iterable] of strings, or a [Stream] of
  /// strings (for example the text deltas of an LLM). Text is split into
  /// sentences of at most 500 characters, which are queued in order; the
  /// audio arrives in order, at [sampleRate]. [deltas] says whether items
  /// are fragments of one text; it defaults to `true` for a stream and
  /// `false` for an iterable. [interrupt] ends the stream, and cancelling the
  /// subscription cancels what is left.
  Stream<Uint8List> speakStream(
    Object texts, {
    String? voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    bool? deltas,
  }) {
    if (texts is! String && texts is! Iterable<String> && texts is! Stream) {
      throw ArgumentError.value(
        texts,
        'texts',
        'must be a String, an Iterable<String> or a Stream<String>',
      );
    }
    final handles = Queue<Synthesis>();
    final splitter = SentenceSplitter();
    final generation = _protocol.interrupts;
    late final StreamController<Uint8List> out;
    StreamSubscription<Object?>? feed;
    StreamSubscription<Uint8List>? playing;
    var feedDone = false;
    var stopped = false;

    void stop([Object? error, StackTrace? stack]) {
      if (stopped) return;
      stopped = true;
      unawaited(feed?.cancel());
      unawaited(playing?.cancel());
      playing = null;
      for (final handle in handles) {
        handle.cancel();
      }
      handles.clear();
      if (error != null) out.addError(error, stack);
      unawaited(out.close());
    }

    void next() {
      if (stopped || playing != null) return;
      if (_protocol.interrupts != generation) return stop();
      if (handles.isEmpty) {
        if (feedDone) stop();
        return;
      }
      final current = handles.first;
      playing = current.audio.listen(
        out.add,
        onError: (Object error, StackTrace stack) {
          playing = null;
          handles.removeFirst();
          stop(error, stack);
        },
        onDone: () {
          playing = null;
          if (handles.isNotEmpty) handles.removeFirst();
          next();
        },
        cancelOnError: true,
      );
      if (out.isPaused) playing!.pause();
    }

    void add(List<String> sentences) {
      if (stopped) return;
      if (_protocol.interrupts != generation) return stop();
      try {
        for (final sentence in sentences) {
          handles.add(enqueue(
            sentence,
            voiceId: voiceId,
            speed: speed,
            cfg: cfg,
            numSteps: numSteps,
            tashkeel: tashkeel,
            normalize: normalize,
          ));
        }
      } on Object catch (error, stack) {
        stop(error, stack);
        return;
      }
      next();
    }

    void finishFeed() {
      add(splitter.flush());
      feedDone = true;
      next();
    }

    void start() {
      final source = texts;
      if (source is String) {
        add(splitter.push(source));
        finishFeed();
      } else if (source is Iterable<String>) {
        for (final item in source) {
          if (stopped) return;
          add(deltas ?? false
              ? splitter.push(item)
              : [...splitter.push(item), ...splitter.flush()]);
        }
        finishFeed();
      } else if (source is Stream) {
        feed = source.listen(
          (Object? item) {
            final text = '${item ?? ''}';
            add(deltas ?? true
                ? splitter.push(text)
                : [...splitter.push(text), ...splitter.flush()]);
          },
          onError: stop,
          onDone: () {
            feed = null;
            finishFeed();
          },
          cancelOnError: true,
        );
      }
    }

    out = StreamController<Uint8List>(
      onListen: start,
      onPause: () => playing?.pause(),
      onResume: () => playing?.resume(),
      onCancel: () async {
        final current = playing;
        playing = null;
        if (!stopped) {
          stopped = true;
          unawaited(feed?.cancel());
          for (final handle in handles) {
            handle.cancel();
          }
          handles.clear();
        }
        await current?.cancel();
      },
    );
    return out.stream;
  }

  /// Closes the socket. Requests not yet sent are dropped; one still running
  /// ends as cancelled.
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _protocol.close(_clock());
    _timer?.cancel();
    _sync();
    final link = _link;
    if (link != null) await link.close();
    _sync();
  }

  // --- Internals -------------------------------------------------------------

  Future<TtsSession> _start() async {
    await _reconnect();
    return this;
  }

  Synthesis _register(SynthesisCore core) {
    final synthesis = Synthesis._(this, core);
    _handles[core] = synthesis;
    return synthesis;
  }

  void _cancelCore(SynthesisCore core) {
    _protocol.cancel(core, _clock());
    _kick();
  }

  /// Hands new audio and final states to the handles.
  void _sync() {
    for (final synthesis in _handles.values.toList()) {
      if (synthesis._sync()) _handles.remove(synthesis._core);
    }
  }

  void _kick() {
    _sync();
    _schedulePump();
    _scheduleTick();
  }

  void _schedulePump() {
    if (_closed) return;
    if (_pumping) {
      _pumpAgain = true;
      return;
    }
    _pumping = true;
    unawaited(_pump());
  }

  Future<void> _pump() async {
    try {
      do {
        _pumpAgain = false;
        await _drain();
      } while (_pumpAgain && !_closed);
    } on Object catch (error, stack) {
      // Never let a bug stop all sending silently.
      streamLog(
        'Text to Speech sender failed',
        level: 1000,
        error: '$error\n$stack',
      );
    } finally {
      _pumping = false;
      _scheduleTick();
    }
  }

  Future<void> _drain() async {
    while (!_closed) {
      final item = _protocol.nextOutbound(_clock());
      if (item == null) return;
      _sync();
      var link = _link;
      if (item.kind == OutboundKind.synthesize) {
        if (link != null &&
            !link.closed &&
            _rotationDue(link) &&
            _protocol.inFlight().isEmpty) {
          await link.close();
          link = null;
        }
        if (link == null || link.closed) {
          try {
            link = await _reconnect();
          } on EchoNovaException catch (error) {
            if (_closed) {
              _protocol.requeue(item, _clock());
            } else {
              _protocol.sendFailed(item, error, _clock());
            }
            _sync();
            continue;
          } on Object {
            _protocol.requeue(item, _clock());
            _sync();
            rethrow;
          }
        }
        final core = item.core;
        if (core.state == SynthesisState.cancelling && !core.everSent) {
          // Cancelled or replaced while the socket was opening: never sent,
          // so never charged.
          _protocol.requeue(item, _clock());
          _sync();
          continue;
        }
      }
      if (link == null) {
        _protocol.requeue(item, _clock());
        continue;
      }
      if (!link.writeText(item.text)) {
        _protocol.requeue(item, _clock());
        _sync();
        await link.done;
        continue;
      }
      // Registered before waiting for the send buffer, so a fast reply
      // finds it in flight.
      _protocol.sent(item, _clock());
      _sync();
      _scheduleTick();
      await link.flush();
    }
  }

  Future<Link> _reconnect() => _connectLock.run(() async {
        final current = _link;
        if (current != null && !current.closed) return current;
        final connection = await openStream(
          _options,
          _url,
          limiter: _limiter,
          waitForSlot: _waitForSlot,
          afterAbnormal: _protocol.afterAbnormal,
          abandoned: () => _closed,
        );
        if (_closed) {
          unawaited(connection.close(1000).catchError((Object _) {}));
          throw SessionEndedException('the Text to Speech session is closed');
        }
        final gen = _protocol.connGen;
        final link = Link(
          connection,
          _options,
          onText: (text) => _onText(gen, text),
          onBinary: (data) => _onBinary(gen, data),
          onClosed: (info) => _onClosed(gen, info),
        );
        _link = link;
        handshakeRequestId = link.handshakeRequestId;
        _protocol.connectionOpened(_clock());
        _kick();
        return link;
      });

  void _onText(int gen, String text) {
    if (gen != _protocol.connGen) return;
    final event = decodeEvent(text);
    if (event['type'] == 'pong') {
      _link?.pong();
      return;
    }
    _protocol.receiveEvent(event, _clock());
    _kick();
  }

  void _onBinary(int gen, Uint8List data) {
    if (gen != _protocol.connGen) return;
    final core = _protocol.active;
    _protocol.receiveBinary(data, _clock());
    if (core != null) _handles[core]?._sync();
  }

  void _onClosed(int gen, CloseInfo info) {
    if (gen != _protocol.connGen) return;
    _protocol.connectionClosed(info, _clock());
    _link = null;
    if (!info.local) {
      streamLog(
        'Text to Speech socket closed (code ${info.code}); it reopens when '
        'needed',
      );
    }
    _kick();
  }

  bool _rotationDue(Link link) => link.age(_clock()) >= _options.rotateAfter;

  void _scheduleTick() {
    if (_tickScheduled || _closed) return;
    _tickScheduled = true;
    scheduleMicrotask(_onTick);
  }

  void _onTick() {
    _tickScheduled = false;
    if (_closed) return;
    final now = _clock();
    _protocol.tick(now);
    _sync();
    if (_protocol.hasOutbound()) _schedulePump();
    var next = _protocol.nextDeadline();
    final link = _link;
    if (link != null && !link.closed) {
      final rotation = link.openedAt + _options.rotateAfter;
      if (rotation <= now) {
        // Once due, rotation waits for the socket to go idle; activity
        // calls this again.
        if (_protocol.idle && !_rotating) {
          _rotating = true;
          streamLog('rotating an idle Text to Speech socket', level: 500);
          unawaited(link.close().whenComplete(() => _rotating = false));
        }
      } else if (next == null || rotation < next) {
        next = rotation;
      }
    }
    _timer?.cancel();
    _timer = null;
    if (next != null) {
      var wait = next - _clock() + const Duration(milliseconds: 1);
      if (wait < Duration.zero) wait = Duration.zero;
      _timer = Timer(wait, _onTick);
    }
  }
}

/// Opens a Text to Speech session. Internal: use `connectTts`.
Future<TtsSession> openTtsSession(
  StreamOptions options, {
  required String voiceId,
  SynthesisOptions defaults = const SynthesisOptions(),
  Duration? waitForSlot,
  String Function()? newRequestId,
}) =>
    TtsSession._(
      options,
      voiceId: voiceId,
      defaults: defaults,
      waitForSlot: waitForSlot,
      newRequestId: newRequestId,
    )._start();
