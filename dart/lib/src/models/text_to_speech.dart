/// Shared job results and the Text to Speech models.
library;

import 'dart:collection';

import 'base.dart';
import 'enums.dart';

/// An async job was accepted. Poll it with `jobs.wait` or wait for its
/// webhook.
final class JobInitiated extends ApiResult {
  JobInitiated._(
    super.raw, {
    required super.requestId,
    required this.jobId,
    required this.status,
  });

  /// Parses the API's JSON. Throws [FormatException] without `jobId` or
  /// `status`.
  factory JobInitiated.fromJson(
    Map<String, Object?> json, {
    String? requestId,
  }) =>
      JobInitiated._(
        json,
        requestId: requestId,
        jobId: requireString(json, 'jobId', 'JobInitiated'),
        status: JobStatus(requireString(json, 'status', 'JobInitiated')),
      );

  /// The new job's ID.
  final String jobId;

  /// Usually [JobStatus.processing].
  final JobStatus status;

  /// The same as [jobId].
  String get id => jobId;

  @override
  String toString() => 'JobInitiated(jobId: $jobId, status: $status)';
}

/// The result of deleting a job.
final class DeleteResult extends ApiResult {
  DeleteResult._(
    super.raw, {
    required super.requestId,
    required this.deleted,
    required this.alreadyDeleted,
  });

  /// Parses the API's JSON.
  factory DeleteResult.fromJson(
    Map<String, Object?> json, {
    String? requestId,
    bool alreadyDeleted = false,
  }) =>
      DeleteResult._(
        json,
        requestId: requestId,
        deleted: readBool(json['deleted']),
        alreadyDeleted: alreadyDeleted,
      );

  /// `true` once the job is deleted.
  final bool? deleted;

  /// `true` when a retried delete found the job gone, because an earlier
  /// attempt (whose response was lost) deleted it.
  final bool alreadyDeleted;

  @override
  String toString() =>
      'DeleteResult(deleted: $deleted, alreadyDeleted: $alreadyDeleted)';
}

/// The result of `textToSpeech.generate`. [audioUrl] is a signed WAV link
/// that expires: download it soon, or get the job again for a fresh one.
final class TtsResult extends ApiResult {
  TtsResult._(
    super.raw, {
    required super.requestId,
    required this.jobId,
    required this.status,
    required this.audioUrl,
    required this.durationSeconds,
    required this.creditsConsumed,
  });

  /// Parses the API's JSON. Throws [FormatException] without `jobId` or
  /// `status`.
  factory TtsResult.fromJson(Map<String, Object?> json, {String? requestId}) =>
      TtsResult._(
        json,
        requestId: requestId,
        jobId: requireString(json, 'jobId', 'TtsResult'),
        status: JobStatus(requireString(json, 'status', 'TtsResult')),
        audioUrl: readString(json['audioUrl']),
        durationSeconds: readDouble(json['durationSeconds']),
        creditsConsumed: readInt(json['creditsConsumed']),
      );

  /// The ID of the job the call created.
  final String jobId;

  /// [JobStatus.completed]: a synchronous call creates its job finished.
  final JobStatus status;

  /// A signed link to the WAV file. It expires.
  final String? audioUrl;

  /// The length of the audio in seconds.
  final double? durationSeconds;

  /// Credits charged.
  final int? creditsConsumed;

  /// The same as [jobId].
  String get id => jobId;

  @override
  String toString() => 'TtsResult(jobId: $jobId, status: $status, '
      'durationSeconds: $durationSeconds, creditsConsumed: $creditsConsumed)';
}

/// A voice you can use with Text to Speech.
final class Voice extends ApiResult {
  Voice._(
    super.raw, {
    required super.requestId,
    required this.id,
    required this.name,
    required this.displayName,
    required this.language,
    required this.gender,
    required this.previewUrl,
  });

  /// Parses the API's JSON. Throws [FormatException] without `id`.
  factory Voice.fromJson(Map<String, Object?> json, {String? requestId}) =>
      Voice._(
        json,
        requestId: requestId,
        id: requireString(json, 'id', 'Voice'),
        name: readString(json['name']),
        displayName: readString(json['displayName']),
        language: readString(json['language']),
        gender: readString(json['gender']),
        previewUrl: readString(json['previewUrl']),
      );

  /// The value to send as `voiceId`.
  final String id;

  /// The engine identifier, such as `ae_ahmed`.
  final String? name;

  /// The human label, such as `Ahmed`.
  final String? displayName;

  /// `ar` for Arabic voices, `en` for English voices.
  final String? language;

  /// The gender label, such as `Male`.
  final String? gender;

  /// A link to a short sample of the voice, when there is one.
  final String? previewUrl;

  @override
  String toString() => 'Voice(id: $id, name: $name, language: $language)';
}

/// Every voice you can use. Iterate it directly. The list changes rarely:
/// cache it.
final class VoiceList extends ApiResult with IterableMixin<Voice> {
  VoiceList._(
    super.raw, {
    required super.requestId,
    required this.items,
    required this.total,
  });

  /// Parses the API's JSON. A missing `items` reads as an empty list.
  factory VoiceList.fromJson(Map<String, Object?> json, {String? requestId}) =>
      VoiceList._(
        json,
        requestId: requestId,
        items: readModels(
              json['items'],
              (item) => Voice.fromJson(item, requestId: requestId),
            ) ??
            const [],
        total: readInt(json['total']),
      );

  /// The voices.
  final List<Voice> items;

  /// The number of voices, as the API counted them.
  final int? total;

  @override
  Iterator<Voice> get iterator => items.iterator;

  @override
  int get length => items.length;

  /// The voice at [index].
  Voice operator [](int index) => items[index];

  @override
  String toString() => 'VoiceList(${items.length} voices, total: $total)';
}

/// Where a Text to Speech job made by a stream came from.
final class TtsJobStream extends ApiObject {
  TtsJobStream._(
    super.raw, {
    required this.sessionId,
    required this.synthesisRequestId,
    required this.cancelled,
    required this.audioDropped,
  });

  /// Parses the API's JSON.
  factory TtsJobStream.fromJson(Map<String, Object?> json) => TtsJobStream._(
        json,
        sessionId: readString(json['sessionId']),
        synthesisRequestId: readString(json['requestId']),
        cancelled: readBool(json['cancelled']),
        audioDropped: readBool(json['audioDropped']),
      );

  /// The stream session. Every synthesis on one connection shares it.
  final String? sessionId;

  /// The API's `requestId`: the synthesis' own ID on the stream (the one
  /// you sent, or the one the server made). It is renamed because
  /// `requestId` is the HTTP request ID on every result.
  final String? synthesisRequestId;

  /// `true` when the synthesis stopped early. The audio holds only what was
  /// sent.
  final bool? cancelled;

  /// `true` when the audio could not be saved; the job then has no
  /// `audioUrl`.
  final bool? audioDropped;

  @override
  String toString() => 'TtsJobStream(sessionId: $sessionId, '
      'synthesisRequestId: $synthesisRequestId, cancelled: $cancelled)';
}

/// A Text to Speech job. [audioUrl] is signed again on every get and
/// expires: don't store it.
final class TtsJob extends ApiResult {
  TtsJob._(
    super.raw, {
    required super.requestId,
    required this.id,
    required this.status,
    required this.text,
    required this.voiceId,
    required this.audioUrl,
    required this.durationSeconds,
    required this.creditsConsumed,
    required this.error,
    required this.stream,
    required this.createdAt,
  });

  /// Parses the API's JSON. Throws [FormatException] without `id` or
  /// `status`.
  factory TtsJob.fromJson(Map<String, Object?> json, {String? requestId}) =>
      TtsJob._(
        json,
        requestId: requestId,
        id: requireString(json, 'id', 'TtsJob'),
        status: JobStatus(requireString(json, 'status', 'TtsJob')),
        text: readString(json['text']),
        voiceId: readString(json['voiceId']),
        audioUrl: readString(json['audioUrl']),
        durationSeconds: readDouble(json['durationSeconds']),
        creditsConsumed: readInt(json['creditsConsumed']),
        error: readString(json['error']),
        stream: readModel(json['stream'], TtsJobStream.fromJson),
        createdAt: readDateTime(json['createdAt']),
      );

  /// The job ID.
  final String id;

  /// The job's status; unknown values are not finished.
  final JobStatus status;

  /// The text that was sent.
  final String? text;

  /// The voice that read it.
  final String? voiceId;

  /// A signed link to the WAV file, once the job has completed. It expires.
  final String? audioUrl;

  /// The length of the audio in seconds.
  final double? durationSeconds;

  /// Credits charged.
  final int? creditsConsumed;

  /// Why the job failed, when it did.
  final String? error;

  /// Only on a job made by a Text to Speech stream: where it came from.
  final TtsJobStream? stream;

  /// When the job was created, in UTC.
  final DateTime? createdAt;

  @override
  String toString() => 'TtsJob(id: $id, status: $status)';
}
