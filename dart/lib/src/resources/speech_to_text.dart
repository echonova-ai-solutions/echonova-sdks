/// Speech to Text over REST: `transcribe`, async jobs and transcript export.
library;

import 'dart:convert';

import 'package:meta/meta.dart';

import '../client.dart';
import '../errors.dart';
import '../files.dart';
import '../models/base.dart';
import '../models/enums.dart';
import '../models/speech_to_text.dart';
import '../models/text_to_speech.dart' show DeleteResult, JobInitiated;
import '../operations.dart';
import '../pagination.dart';
import '../params.dart';
import '../polling.dart';
import '../response.dart';
import '../transport/http_transport.dart' show ApiRequest, ApiResponse;
import 'context.dart';

/// The multipart fields. Their names are snake_case, and `terminology`
/// travels as a JSON string. Only the options that were set are sent.
Map<String, String> _form(
  String language,
  bool? numbersAsDigits,
  bool? identifySpeakers,
  Terminology? terminology,
) =>
    {
      'language': language,
      if (numbersAsDigits != null)
        'numbers_as_digits': formValue(numbersAsDigits),
      if (identifySpeakers != null)
        'identify_speakers': formValue(identifySpeakers),
      if (terminology != null) 'terminology': terminology.encode(),
    };

final _parseResult = modelParser(SttResult.fromJson, 'SttResult');
final _parseInitiated = modelParser(JobInitiated.fromJson, 'JobInitiated');
final _parseJob = modelParser(SttJob.fromJson, 'SttJob');

String _parseText(ApiResponse response) =>
    utf8.decode(response.body, allowMalformed: true);

TranscriptExport _parseExport(ApiResponse response) {
  final Object? data;
  try {
    data = jsonDecode(utf8.decode(response.body));
  } on FormatException {
    throw const FormatException('the JSON export is not valid JSON');
  }
  return TranscriptExport.fromJson(
    jsonObject(data, 'TranscriptExport'),
    requestId: response.requestId,
  );
}

/// Speech to Text: `client.speechToText`.
final class SpeechToText {
  /// Internal: the client creates it.
  @internal
  SpeechToText(this._context) : jobs = SttJobs._(_context);

  final ClientContext _context;

  /// Async jobs.
  final SttJobs jobs;

  /// The client this belongs to. Internal: for the streaming layer.
  @internal
  EchoNova get client => _context.client;

  /// Transcribes [file] and waits for the result.
  ///
  /// * [language]: `ar` for Arabic and mixed Arabic/English, `en` only for
  ///   wholly English speech.
  /// * [numbersAsDigits]: write spoken numbers as digits (the API's default
  ///   is `true`).
  /// * [identifySpeakers]: split the transcript into timed segments, each
  ///   with its speaker.
  /// * [terminology]: your own terms, applied to a corrected copy of the
  ///   transcript.
  Future<SttResult> transcribe(
    AudioFile file, {
    required String language,
    bool? numbersAsDigits,
    bool? identifySpeakers,
    Terminology? terminology,
    RequestOptions? options,
  }) async =>
      _context.call(
        await _upload(sttTranscribe, file, language, numbersAsDigits,
            identifySpeakers, terminology, options),
        _parseResult,
      );

  /// [transcribe], returning the HTTP response too.
  Future<RawResponse<SttResult>> transcribeWithResponse(
    AudioFile file, {
    required String language,
    bool? numbersAsDigits,
    bool? identifySpeakers,
    Terminology? terminology,
    RequestOptions? options,
  }) async =>
      _context.callRaw(
        await _upload(sttTranscribe, file, language, numbersAsDigits,
            identifySpeakers, terminology, options),
        _parseResult,
      );

  Future<ApiRequest> _upload(
    Operation operation,
    AudioFile file,
    String language,
    bool? numbersAsDigits,
    bool? identifySpeakers,
    Terminology? terminology,
    RequestOptions? options,
  ) =>
      _uploadRequest(_context, operation, file, language, numbersAsDigits,
          identifySpeakers, terminology, options);
}

Future<ApiRequest> _uploadRequest(
  ClientContext context,
  Operation operation,
  AudioFile file,
  String language,
  bool? numbersAsDigits,
  bool? identifySpeakers,
  Terminology? terminology,
  RequestOptions? options,
) async {
  final form = _form(language, numbersAsDigits, identifySpeakers, terminology);
  return context.request(
    operation,
    form: form,
    upload: await prepareUpload(file),
    options: options,
  );
}

/// Speech to Text jobs: `client.speechToText.jobs`.
final class SttJobs {
  SttJobs._(this._context);

  final ClientContext _context;

  /// Uploads [file] for an async transcription job. Get the result with
  /// [wait] or a webhook. The options are as for
  /// [SpeechToText.transcribe].
  Future<JobInitiated> create(
    AudioFile file, {
    required String language,
    bool? numbersAsDigits,
    bool? identifySpeakers,
    Terminology? terminology,
    RequestOptions? options,
  }) async =>
      _context.call(
        await _uploadRequest(_context, sttJobsCreate, file, language,
            numbersAsDigits, identifySpeakers, terminology, options),
        _parseInitiated,
      );

  /// [create], returning the HTTP response too.
  Future<RawResponse<JobInitiated>> createWithResponse(
    AudioFile file, {
    required String language,
    bool? numbersAsDigits,
    bool? identifySpeakers,
    Terminology? terminology,
    RequestOptions? options,
  }) async =>
      _context.callRaw(
        await _uploadRequest(_context, sttJobsCreate, file, language,
            numbersAsDigits, identifySpeakers, terminology, options),
        _parseInitiated,
      );

  /// Gets a job.
  Future<SttJob> get(String jobId, {RequestOptions? options}) =>
      _context.call(_get(jobId, options), _parseJob);

  /// [get], returning the HTTP response too.
  Future<RawResponse<SttJob>> getWithResponse(
    String jobId, {
    RequestOptions? options,
  }) =>
      _context.callRaw(_get(jobId, options), _parseJob);

  ApiRequest _get(String jobId, RequestOptions? options) => _context.request(
        sttJobsGet,
        path: {'jobId': jobId},
        options: options,
      );

  /// Lists jobs, newest first: one page of at most [limit] (the API's
  /// default is 20, the maximum 100).
  Future<Page<SttJob>> list({
    int? offset,
    int? limit,
    RequestOptions? options,
  }) =>
      _context.call(
          _list(offset, limit, options), _page(offset, limit, options));

  /// [list], returning the HTTP response too.
  Future<RawResponse<Page<SttJob>>> listWithResponse({
    int? offset,
    int? limit,
    RequestOptions? options,
  }) =>
      _context.callRaw(
          _list(offset, limit, options), _page(offset, limit, options));

  /// Every job, newest first, fetching pages of [limit] as they are
  /// needed. A job is never returned twice, even when new jobs shift the
  /// pages.
  Stream<SttJob> listAll({int? limit, RequestOptions? options}) =>
      allItems(() => list(limit: limit, options: options), (job) => job.id);

  ApiRequest _list(int? offset, int? limit, RequestOptions? options) =>
      _context.request(
        sttJobsList,
        query: pageQuery(offset, limit),
        options: options,
      );

  Page<SttJob> Function(ApiResponse) _page(
    int? offset,
    int? limit,
    RequestOptions? options,
  ) =>
      pageParser(
        SttJob.fromJson,
        'SttJob',
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
        sttJobsDelete,
        path: {'jobId': jobId},
        options: options,
      );

  /// Polls the job until it completes or fails, every 5 s by default
  /// ([pollInterval] can't be under 1 s), for up to [timeout].
  ///
  /// Throws [JobFailedException] for a failed job unless [raiseOnFailure]
  /// is false, and [JobWaitTimeoutException] after [timeout]; calling it
  /// again is safe. Every `wait` on one client shares a budget of 80 polls
  /// a minute.
  Future<SttJob> wait(
    String jobId, {
    Duration? pollInterval,
    Duration timeout = defaultWaitTimeout,
    bool raiseOnFailure = true,
  }) {
    final interval = checkPollInterval(pollInterval, sttPollInterval);
    return waitForJob(
      jobId: jobId,
      get: () => get(jobId),
      statusOf: (job) => job.status,
      errorOf: (job) => job.error,
      interval: interval,
      timeout: timeout,
      raiseOnFailure: raiseOnFailure,
      limiter: _context.pollLimiter,
      bucket: sttJobsGet.name,
      runtime: _context.runtime,
    );
  }

  /// Exports a completed transcript as text: [ExportFormat.txt] for the
  /// text, [ExportFormat.srt] for subtitles ([ExportFormat.json] gives the
  /// JSON as text; [exportJson] parses it).
  ///
  /// [lang] sets the language of the speaker labels: `en` (the default)
  /// gives "Speaker 1", `ar` gives "المتحدث 1".
  Future<String> export(
    String jobId, {
    required ExportFormat format,
    String? lang,
    RequestOptions? options,
  }) =>
      _context.call(_export(jobId, format, lang, options), _parseText);

  /// [export], returning the HTTP response too.
  Future<RawResponse<String>> exportWithResponse(
    String jobId, {
    required ExportFormat format,
    String? lang,
    RequestOptions? options,
  }) =>
      _context.callRaw(_export(jobId, format, lang, options), _parseText);

  /// Exports a completed transcript as JSON: text, speakers and timed
  /// segments. [lang] is as for [export].
  Future<TranscriptExport> exportJson(
    String jobId, {
    String? lang,
    RequestOptions? options,
  }) =>
      _context.call(
          _export(jobId, ExportFormat.json, lang, options), _parseExport);

  /// [exportJson], returning the HTTP response too.
  Future<RawResponse<TranscriptExport>> exportJsonWithResponse(
    String jobId, {
    String? lang,
    RequestOptions? options,
  }) =>
      _context.callRaw(
          _export(jobId, ExportFormat.json, lang, options), _parseExport);

  ApiRequest _export(
    String jobId,
    ExportFormat format,
    String? lang,
    RequestOptions? options,
  ) =>
      _context.request(
        sttJobsExport,
        path: {'jobId': jobId},
        query: {'format': format.name, if (lang != null) 'lang': lang},
        options: options,
      );

  /// Jobs that may have come from an upload whose response was lost.
  ///
  /// Lists jobs created from [sentAt] (an exception's `sentAt`) minus 5 s,
  /// newest first. It never picks one for you: concurrent uploads appear
  /// too, so check before you act.
  Future<List<SttJob>> findCandidates(DateTime sentAt) => findJobCandidates(
        listPage: (offset) => list(offset: offset, limit: 100),
        sentAt: sentAt,
        idOf: (job) => job.id,
        createdAtOf: (job) => job.createdAt,
        fromStream: (job) => job.stream != null,
      );
}
