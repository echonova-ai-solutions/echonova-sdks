/// Sound Cleaning: `clean` (synchronous) and the jobs it leaves behind.
library;

import 'dart:typed_data';

import 'package:meta/meta.dart';

import '../files.dart';
import '../models/sound_cleaning.dart';
import '../models/text_to_speech.dart' show DeleteResult;
import '../operations.dart';
import '../pagination.dart';
import '../response.dart';
import '../transport/http_transport.dart' show ApiRequest, ApiResponse;
import 'context.dart';

final _parseJob = modelParser(CleanJob.fromJson, 'CleanJob');

/// Sound Cleaning: `client.soundCleaning`.
final class SoundCleaning {
  /// Internal: the client creates it.
  @internal
  SoundCleaning(this._context) : jobs = CleanJobs._(_context);

  final ClientContext _context;

  /// The cleaning jobs.
  final CleanJobs jobs;

  /// Cleans [file] (mp3, wav, flac, ogg or opus) and waits for the result.
  /// [CleanJob.outputUrl] links to the cleaned WAV.
  ///
  /// The tuning values are optional: those you leave out are not sent, so
  /// the API's defaults apply. [sampleRate] (16000, 24000, 32000 or 48000)
  /// and [bitDepth] (16 or 24) set the format of the cleaned file.
  Future<CleanJob> clean(
    AudioFile file, {
    double? cutoffFreq,
    double? qFactor,
    double? targetLufs,
    double? truePeakDbfs,
    double? compThreshDb,
    double? compRatio,
    double? compAttackMs,
    double? compReleaseMs,
    int? sampleRate,
    int? bitDepth,
    RequestOptions? options,
  }) async =>
      _context.call(
        await _clean(
            file,
            {
              'cutoffFreq': cutoffFreq,
              'qFactor': qFactor,
              'targetLufs': targetLufs,
              'truePeakDbfs': truePeakDbfs,
              'compThreshDb': compThreshDb,
              'compRatio': compRatio,
              'compAttackMs': compAttackMs,
              'compReleaseMs': compReleaseMs,
              'sampleRate': sampleRate,
              'bitDepth': bitDepth,
            },
            options),
        _parseJob,
      );

  /// [clean], returning the HTTP response too.
  Future<RawResponse<CleanJob>> cleanWithResponse(
    AudioFile file, {
    double? cutoffFreq,
    double? qFactor,
    double? targetLufs,
    double? truePeakDbfs,
    double? compThreshDb,
    double? compRatio,
    double? compAttackMs,
    double? compReleaseMs,
    int? sampleRate,
    int? bitDepth,
    RequestOptions? options,
  }) async =>
      _context.callRaw(
        await _clean(
            file,
            {
              'cutoffFreq': cutoffFreq,
              'qFactor': qFactor,
              'targetLufs': targetLufs,
              'truePeakDbfs': truePeakDbfs,
              'compThreshDb': compThreshDb,
              'compRatio': compRatio,
              'compAttackMs': compAttackMs,
              'compReleaseMs': compReleaseMs,
              'sampleRate': sampleRate,
              'bitDepth': bitDepth,
            },
            options),
        _parseJob,
      );

  /// The multipart fields are camelCase, as the API names them.
  Future<ApiRequest> _clean(
    AudioFile file,
    Map<String, Object?> settings,
    RequestOptions? options,
  ) async =>
      _context.request(
        cleanClean,
        form: {
          for (final MapEntry(:key, :value) in compact(settings).entries)
            key: formValue(value),
        },
        upload: await prepareUpload(file),
        options: options,
      );
}

/// Sound Cleaning jobs: `client.soundCleaning.jobs`.
final class CleanJobs {
  CleanJobs._(this._context);

  final ClientContext _context;

  /// Gets a job, with a freshly signed `outputUrl`.
  Future<CleanJob> get(String jobId, {RequestOptions? options}) =>
      _context.call(_get(jobId, options), _parseJob);

  /// [get], returning the HTTP response too.
  Future<RawResponse<CleanJob>> getWithResponse(
    String jobId, {
    RequestOptions? options,
  }) =>
      _context.callRaw(_get(jobId, options), _parseJob);

  ApiRequest _get(String jobId, RequestOptions? options) => _context.request(
        cleanJobsGet,
        path: {'jobId': jobId},
        options: options,
      );

  /// Lists jobs, newest first: one page of at most [limit] (the API's
  /// default is 20, the maximum 100).
  Future<Page<CleanJob>> list({
    int? offset,
    int? limit,
    RequestOptions? options,
  }) =>
      _context.call(
          _list(offset, limit, options), _page(offset, limit, options));

  /// [list], returning the HTTP response too.
  Future<RawResponse<Page<CleanJob>>> listWithResponse({
    int? offset,
    int? limit,
    RequestOptions? options,
  }) =>
      _context.callRaw(
          _list(offset, limit, options), _page(offset, limit, options));

  /// Every job, newest first, fetching pages of [limit] as they are
  /// needed. A job is never returned twice, even when new jobs shift the
  /// pages.
  Stream<CleanJob> listAll({int? limit, RequestOptions? options}) =>
      allItems(() => list(limit: limit, options: options), (job) => job.id);

  ApiRequest _list(int? offset, int? limit, RequestOptions? options) =>
      _context.request(
        cleanJobsList,
        query: pageQuery(offset, limit),
        options: options,
      );

  Page<CleanJob> Function(ApiResponse) _page(
    int? offset,
    int? limit,
    RequestOptions? options,
  ) =>
      pageParser(
        CleanJob.fromJson,
        'CleanJob',
        offset: offset,
        limit: limit,
        fetch: (next) => list(offset: next, limit: limit, options: options),
      );

  /// Deletes a job with its original and cleaned audio.
  Future<DeleteResult> delete(String jobId, {RequestOptions? options}) =>
      _context.call(_delete(jobId, options), parseDelete);

  /// [delete], returning the HTTP response too.
  Future<RawResponse<DeleteResult>> deleteWithResponse(
    String jobId, {
    RequestOptions? options,
  }) =>
      _context.callRaw(_delete(jobId, options), parseDelete);

  ApiRequest _delete(String jobId, RequestOptions? options) => _context.request(
        cleanJobsDelete,
        path: {'jobId': jobId},
        options: options,
      );

  /// Gets the job for a fresh link, then downloads the cleaned WAV.
  Future<Uint8List> download(String jobId) async =>
      _context.download(await _outputUrl(jobId));

  /// Gets the job for a fresh link, then downloads the cleaned WAV to
  /// [path] (a file, or a folder to keep the link's file name). Returns the
  /// file's path. Not available on the web.
  Future<String> downloadTo(String jobId, String path) async =>
      _context.downloadTo(await _outputUrl(jobId), path);

  Future<String> _outputUrl(String jobId) async {
    final job = await get(jobId);
    return requireDownloadUrl(
      jobId: job.id,
      status: job.status.value,
      url: job.outputUrl,
      error: job.error,
      job: job,
    );
  }
}
