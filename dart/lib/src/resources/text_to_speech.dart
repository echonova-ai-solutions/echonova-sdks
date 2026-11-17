/// Text to Speech over REST: `generate`, voices and async jobs.
library;

import 'dart:typed_data';

import 'package:meta/meta.dart';

import '../audio.dart' show Audio;
import '../client.dart';
import '../errors.dart';
import '../models/text_to_speech.dart';
import '../operations.dart';
import '../pagination.dart';
import '../polling.dart';
import '../response.dart';
import '../streaming/api.dart' as streaming;
import '../streaming/tts_session.dart' show TtsSession;
import '../transport/http_transport.dart' show ApiRequest, ApiResponse;
import 'context.dart';

Map<String, Object> _speechBody(
  String text,
  String voiceId,
  double? speed,
  double? cfg,
  int? numSteps,
  bool? tashkeel,
  bool? normalize,
) =>
    {
      'text': text,
      'voiceId': voiceId,
      ...compact({
        'speed': speed,
        'cfg': cfg,
        'numSteps': numSteps,
        'tashkeel': tashkeel,
        'normalize': normalize,
      }),
    };

final _parseResult = modelParser(TtsResult.fromJson, 'TtsResult');
final _parseInitiated = modelParser(JobInitiated.fromJson, 'JobInitiated');
final _parseJob = modelParser(TtsJob.fromJson, 'TtsJob');
final _parseVoices = modelParser(VoiceList.fromJson, 'VoiceList');

/// `generate` after `202 Processing`: poll the job every 3 s.
final _syncJob = SyncJob<TtsResult, TtsJob>(
  get: ttsJobsGet,
  parse: _parseJob,
  statusOf: (job) => job.status,
  errorOf: (job) => job.error,
  interval: ttsPollInterval,
  toResult: (job) => TtsResult.fromJson(
    syncResultJson(job.id, job.raw),
    requestId: job.requestId,
  ),
);

/// Text to Speech: `client.textToSpeech`.
final class TextToSpeech {
  /// Internal: the client creates it.
  @internal
  TextToSpeech(this._context)
      : voices = Voices._(_context),
        jobs = TtsJobs._(_context);

  final ClientContext _context;

  /// Opens a streaming Text to Speech session. The options apply to every
  /// synthesis on it; [waitForSlot] keeps retrying for that long when the
  /// workspace has no free stream slot. Close it with [TtsSession.close].
  Future<TtsSession> connect({
    required String voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    Duration? waitForSlot,
  }) =>
      streaming.connectTts(
        _context.client.streamOptions(),
        voiceId: voiceId,
        speed: speed,
        cfg: cfg,
        numSteps: numSteps,
        tashkeel: tashkeel,
        normalize: normalize,
        waitForSlot: waitForSlot,
      );

  /// Synthesizes [text] over a stream of its own and returns the PCM audio
  /// (lower latency than [generate]).
  Future<Audio> speak(
    String text, {
    required String voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    Duration? waitForSlot,
  }) =>
      streaming.speak(
        _context.client.streamOptions(),
        text,
        voiceId: voiceId,
        speed: speed,
        cfg: cfg,
        numSteps: numSteps,
        tashkeel: tashkeel,
        normalize: normalize,
        waitForSlot: waitForSlot,
      );

  /// The voices you can use.
  final Voices voices;

  /// Async jobs.
  final TtsJobs jobs;

  /// The client this belongs to. Internal: for the streaming layer.
  @internal
  EchoNova get client => _context.client;

  /// Synthesizes [text] (1 to 500 characters) and waits for the audio.
  ///
  /// [TtsResult.audioUrl] is a signed WAV link that expires: download it
  /// with `client.download` soon. Options you leave out are not sent, so the
  /// API's defaults apply.
  ///
  /// Every call sends an `Idempotency-Key` (a new one, or
  /// [RequestOptions.idempotencyKey]), so it is retried safely after a lost
  /// response or a server error, and sent again every 5 s while the API
  /// says the first request with the key is still running. When the API
  /// answers that the job is still processing, this polls the job every 3 s
  /// and returns the same result; a failed job throws [JobFailedException].
  /// Both waits share [RequestOptions.waitTimeout] (20 minutes); running out
  /// of it throws [JobWaitTimeoutException] or
  /// [RequestInProgressException].
  Future<TtsResult> generate(
    String text, {
    required String voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    RequestOptions? options,
  }) =>
      _context.callSync(
        _request(ttsGenerate, text, voiceId, speed, cfg, numSteps, tashkeel,
            normalize, options),
        _parseResult,
        _syncJob,
      );

  /// [generate], returning the HTTP response too: after a wait for the job,
  /// the response of the last poll.
  Future<RawResponse<TtsResult>> generateWithResponse(
    String text, {
    required String voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    RequestOptions? options,
  }) =>
      _context.callSyncRaw(
        _request(ttsGenerate, text, voiceId, speed, cfg, numSteps, tashkeel,
            normalize, options),
        _parseResult,
        _syncJob,
      );

  ApiRequest _request(
    Operation operation,
    String text,
    String voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    RequestOptions? options,
  ) =>
      _context.request(
        operation,
        json: _speechBody(
            text, voiceId, speed, cfg, numSteps, tashkeel, normalize),
        options: options,
      );
}

/// The voices you can use: `client.textToSpeech.voices`.
final class Voices {
  Voices._(this._context);

  final ClientContext _context;

  /// Every voice you can use. The list changes rarely: cache it.
  Future<VoiceList> list({RequestOptions? options}) => _context.call(
        _context.request(ttsVoicesList, options: options),
        _parseVoices,
      );

  /// [list], returning the HTTP response too.
  Future<RawResponse<VoiceList>> listWithResponse({RequestOptions? options}) =>
      _context.callRaw(
        _context.request(ttsVoicesList, options: options),
        _parseVoices,
      );
}

/// Text to Speech jobs: `client.textToSpeech.jobs`.
final class TtsJobs {
  TtsJobs._(this._context);

  final ClientContext _context;

  /// Starts an async synthesis job. Get the result with [wait] or a
  /// `job.completed` webhook.
  Future<JobInitiated> create(
    String text, {
    required String voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    RequestOptions? options,
  }) =>
      _context.call(
        _create(
            text, voiceId, speed, cfg, numSteps, tashkeel, normalize, options),
        _parseInitiated,
      );

  /// [create], returning the HTTP response too.
  Future<RawResponse<JobInitiated>> createWithResponse(
    String text, {
    required String voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    RequestOptions? options,
  }) =>
      _context.callRaw(
        _create(
            text, voiceId, speed, cfg, numSteps, tashkeel, normalize, options),
        _parseInitiated,
      );

  ApiRequest _create(
    String text,
    String voiceId,
    double? speed,
    double? cfg,
    int? numSteps,
    bool? tashkeel,
    bool? normalize,
    RequestOptions? options,
  ) =>
      _context.request(
        ttsJobsCreate,
        json: _speechBody(
            text, voiceId, speed, cfg, numSteps, tashkeel, normalize),
        options: options,
      );

  /// Gets a job, with a freshly signed `audioUrl` once it has completed.
  Future<TtsJob> get(String jobId, {RequestOptions? options}) =>
      _context.call(_get(jobId, options), _parseJob);

  /// [get], returning the HTTP response too.
  Future<RawResponse<TtsJob>> getWithResponse(
    String jobId, {
    RequestOptions? options,
  }) =>
      _context.callRaw(_get(jobId, options), _parseJob);

  ApiRequest _get(String jobId, RequestOptions? options) => _context.request(
        ttsJobsGet,
        path: {'jobId': jobId},
        options: options,
      );

  /// Lists jobs, newest first: one page of at most [limit] (the API's
  /// default is 20, the maximum 100).
  Future<Page<TtsJob>> list({
    int? offset,
    int? limit,
    RequestOptions? options,
  }) =>
      _context.call(
          _list(offset, limit, options), _page(offset, limit, options));

  /// [list], returning the HTTP response too.
  Future<RawResponse<Page<TtsJob>>> listWithResponse({
    int? offset,
    int? limit,
    RequestOptions? options,
  }) =>
      _context.callRaw(
          _list(offset, limit, options), _page(offset, limit, options));

  /// Every job, newest first, fetching pages of [limit] as they are
  /// needed. A job is never returned twice, even when new jobs shift the
  /// pages.
  Stream<TtsJob> listAll({int? limit, RequestOptions? options}) =>
      allItems(() => list(limit: limit, options: options), (job) => job.id);

  ApiRequest _list(int? offset, int? limit, RequestOptions? options) =>
      _context.request(
        ttsJobsList,
        query: pageQuery(offset, limit),
        options: options,
      );

  Page<TtsJob> Function(ApiResponse) _page(
    int? offset,
    int? limit,
    RequestOptions? options,
  ) =>
      pageParser(
        TtsJob.fromJson,
        'TtsJob',
        offset: offset,
        limit: limit,
        fetch: (next) => list(offset: next, limit: limit, options: options),
      );

  /// Deletes a finished job and its audio.
  Future<DeleteResult> delete(String jobId, {RequestOptions? options}) =>
      _context.call(_delete(jobId, options), parseDelete);

  /// [delete], returning the HTTP response too.
  Future<RawResponse<DeleteResult>> deleteWithResponse(
    String jobId, {
    RequestOptions? options,
  }) =>
      _context.callRaw(_delete(jobId, options), parseDelete);

  ApiRequest _delete(String jobId, RequestOptions? options) => _context.request(
        ttsJobsDelete,
        path: {'jobId': jobId},
        options: options,
      );

  /// Polls the job until it completes or fails, every 3 s by default
  /// ([pollInterval] can't be under 1 s), for up to [timeout].
  ///
  /// Throws [JobFailedException] for a failed job unless [raiseOnFailure]
  /// is false, and [JobWaitTimeoutException] after [timeout]; calling it
  /// again is safe. Every `wait` on one client shares a budget of 80 polls
  /// a minute.
  Future<TtsJob> wait(
    String jobId, {
    Duration? pollInterval,
    Duration timeout = defaultWaitTimeout,
    bool raiseOnFailure = true,
  }) {
    final interval = checkPollInterval(pollInterval, ttsPollInterval);
    return waitForJob(
      jobId: jobId,
      get: () => get(jobId),
      statusOf: (job) => job.status,
      errorOf: (job) => job.error,
      interval: interval,
      timeout: timeout,
      raiseOnFailure: raiseOnFailure,
      limiter: _context.pollLimiter,
      bucket: ttsJobsGet.name,
      runtime: _context.runtime,
    );
  }

  /// Gets the job for a fresh link, then downloads its WAV audio.
  Future<Uint8List> download(String jobId) async =>
      _context.download(await _audioUrl(jobId));

  /// Gets the job for a fresh link, then downloads its WAV audio to [path]
  /// (a file, or a folder to keep the link's file name). Returns the file's
  /// path. Not available on the web.
  Future<String> downloadTo(String jobId, String path) async =>
      _context.downloadTo(await _audioUrl(jobId), path);

  Future<String> _audioUrl(String jobId) async {
    final job = await get(jobId);
    return requireDownloadUrl(
      jobId: job.id,
      status: job.status.value,
      url: job.audioUrl,
      error: job.error,
      job: job,
    );
  }

  /// Jobs that may have come from a request whose response was lost.
  ///
  /// Lists jobs created from [sentAt] (an exception's `sentAt`) minus 5 s,
  /// newest first, optionally only those with the same [text]. It never
  /// picks one for you: other requests can match too, so check before you
  /// act.
  Future<List<TtsJob>> findCandidates(DateTime sentAt, {String? text}) =>
      findJobCandidates(
        listPage: (offset) => list(offset: offset, limit: 100),
        sentAt: sentAt,
        text: text,
        idOf: (job) => job.id,
        createdAtOf: (job) => job.createdAt,
        fromStream: (job) => job.stream != null,
        textOf: (job) => job.text,
      );
}
