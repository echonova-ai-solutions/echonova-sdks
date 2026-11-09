/// The Sound Cleaning models.
library;

import 'base.dart';
import 'enums.dart';

/// The tuning values a cleaning job ran with. Values the API didn't return
/// are `null`.
final class CleanJobOptions extends ApiObject {
  CleanJobOptions._(
    super.raw, {
    required this.cutoffFreq,
    required this.qFactor,
    required this.targetLufs,
    required this.truePeakDbfs,
    required this.compThreshDb,
    required this.compRatio,
    required this.compAttackMs,
    required this.compReleaseMs,
  });

  /// Parses the API's JSON.
  factory CleanJobOptions.fromJson(Map<String, Object?> json) =>
      CleanJobOptions._(
        json,
        cutoffFreq: readDouble(json['cutoffFreq']),
        qFactor: readDouble(json['qFactor']),
        targetLufs: readDouble(json['targetLufs']),
        truePeakDbfs: readDouble(json['truePeakDbfs']),
        compThreshDb: readDouble(json['compThreshDb']),
        compRatio: readDouble(json['compRatio']),
        compAttackMs: readDouble(json['compAttackMs']),
        compReleaseMs: readDouble(json['compReleaseMs']),
      );

  /// High-pass cutoff in Hz.
  final double? cutoffFreq;

  /// High-pass smoothness.
  final double? qFactor;

  /// Target loudness in LUFS.
  final double? targetLufs;

  /// Peak ceiling in dBFS.
  final double? truePeakDbfs;

  /// Compressor threshold in dBFS.
  final double? compThreshDb;

  /// Compressor ratio.
  final double? compRatio;

  /// Compressor attack in ms.
  final double? compAttackMs;

  /// Compressor release in ms.
  final double? compReleaseMs;

  @override
  String toString() => 'CleanJobOptions($raw)';
}

/// Measurements of a cleaned file.
final class CleanMetrics extends ApiObject {
  CleanMetrics._(
    super.raw, {
    required this.sampleRate,
    required this.bitDepth,
    required this.integratedLufs,
    required this.truePeakDbfs,
  });

  /// Parses the API's JSON.
  factory CleanMetrics.fromJson(Map<String, Object?> json) => CleanMetrics._(
        json,
        sampleRate: readInt(json['sampleRate']),
        bitDepth: readInt(json['bitDepth']),
        integratedLufs: readDouble(json['integratedLufs']),
        truePeakDbfs: readDouble(json['truePeakDbfs']),
      );

  /// Sample rate of the cleaned file in Hz.
  final int? sampleRate;

  /// Bits per sample of the cleaned file.
  final int? bitDepth;

  /// Measured loudness in LUFS.
  final double? integratedLufs;

  /// Measured peak in dBFS.
  final double? truePeakDbfs;

  @override
  String toString() => 'CleanMetrics(sampleRate: $sampleRate, '
      'bitDepth: $bitDepth, integratedLufs: $integratedLufs, '
      'truePeakDbfs: $truePeakDbfs)';
}

/// A Sound Cleaning job. [outputUrl] is a signed link to the cleaned WAV;
/// it expires.
final class CleanJob extends ApiResult {
  CleanJob._(
    super.raw, {
    required super.requestId,
    required this.id,
    required this.status,
    required this.fileName,
    required this.outputUrl,
    required this.durationSeconds,
    required this.creditsConsumed,
    required this.options,
    required this.metrics,
    required this.error,
    required this.createdAt,
  });

  /// Parses the API's JSON. Throws [FormatException] without `id` or
  /// `status`.
  factory CleanJob.fromJson(Map<String, Object?> json, {String? requestId}) =>
      CleanJob._(
        json,
        requestId: requestId,
        id: requireString(json, 'id', 'CleanJob'),
        status: JobStatus(requireString(json, 'status', 'CleanJob')),
        fileName: readString(json['fileName']),
        outputUrl: readString(json['outputUrl']),
        durationSeconds: readDouble(json['durationSeconds']),
        creditsConsumed: readInt(json['creditsConsumed']),
        options: readModel(json['options'], CleanJobOptions.fromJson),
        metrics: readModel(json['metrics'], CleanMetrics.fromJson),
        error: readString(json['error']),
        createdAt: readDateTime(json['createdAt']),
      );

  /// The job ID.
  final String id;

  /// The job's status.
  final JobStatus status;

  /// The name of the uploaded file.
  final String? fileName;

  /// A signed link to the cleaned WAV. It expires.
  final String? outputUrl;

  /// The length of the audio in seconds.
  final double? durationSeconds;

  /// Credits charged.
  final int? creditsConsumed;

  /// The tuning values the job ran with.
  final CleanJobOptions? options;

  /// Measurements of the cleaned file.
  final CleanMetrics? metrics;

  /// Why the job failed, when it did.
  final String? error;

  /// When the job was created, in UTC.
  final DateTime? createdAt;

  @override
  String toString() => 'CleanJob(id: $id, status: $status)';
}
