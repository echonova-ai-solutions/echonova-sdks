/// The Speech to Text models.
library;

import 'base.dart';
import 'enums.dart';

/// A timed piece of a transcript, with its speaker.
final class SttSegment extends ApiObject {
  SttSegment._(
    super.raw, {
    required this.start,
    required this.end,
    required this.text,
    required this.speaker,
  });

  /// Parses the API's JSON.
  factory SttSegment.fromJson(Map<String, Object?> json) => SttSegment._(
        json,
        start: readDouble(json['start']),
        end: readDouble(json['end']),
        text: readString(json['text']),
        speaker: readString(json['speaker']),
      );

  /// Where the piece starts, in seconds from the start of the audio.
  final double? start;

  /// Where the piece ends, in seconds.
  final double? end;

  /// What was said.
  final String? text;

  /// The speaker ID (`spk0`, `spk1`, ...), or `null` when unknown.
  final String? speaker;

  @override
  String toString() =>
      'SttSegment(start: $start, end: $end, speaker: $speaker)';
}

/// A speaker heard in the audio.
final class SttSpeaker extends ApiObject {
  SttSpeaker._(super.raw, {required this.id, required this.talkTime});

  /// Parses the API's JSON.
  factory SttSpeaker.fromJson(Map<String, Object?> json) => SttSpeaker._(
        json,
        id: readString(json['id']),
        talkTime: readDouble(json['talkTime']),
      );

  /// The speaker ID the segments use.
  final String? id;

  /// How long this speaker talks, in seconds.
  final double? talkTime;

  @override
  String toString() => 'SttSpeaker(id: $id, talkTime: $talkTime)';
}

/// One replacement your terminology made.
final class TerminologyEdit extends ApiObject {
  TerminologyEdit._(
    super.raw, {
    required this.start,
    required this.end,
    required this.original,
    required this.replacement,
    required this.stage,
    required this.score,
  });

  /// Parses the API's JSON.
  factory TerminologyEdit.fromJson(Map<String, Object?> json) =>
      TerminologyEdit._(
        json,
        start: readInt(json['start']),
        end: readInt(json['end']),
        original: readString(json['original']),
        replacement: readString(json['replacement']),
        stage: readString(json['stage']),
        score: readDouble(json['score']),
      );

  /// Where the replaced words start in the raw transcript, as a character
  /// offset.
  final int? start;

  /// Where they end (exclusive).
  final int? end;

  /// The words as heard.
  final String? original;

  /// Your term, as written in the corrected transcript.
  final String? replacement;

  /// How it matched: `exact`, `phonetic` or `fuzzy`.
  final String? stage;

  /// Match confidence from 0 to 1.
  final double? score;

  @override
  String toString() => 'TerminologyEdit(start: $start, end: $end, '
      'stage: $stage, score: $score)';
}

/// A close match your terminology did not apply.
final class TerminologyNearMiss extends ApiObject {
  TerminologyNearMiss._(
    super.raw, {
    required this.start,
    required this.end,
    required this.original,
    required this.candidate,
    required this.score,
  });

  /// Parses the API's JSON.
  factory TerminologyNearMiss.fromJson(Map<String, Object?> json) =>
      TerminologyNearMiss._(
        json,
        start: readInt(json['start']),
        end: readInt(json['end']),
        original: readString(json['original']),
        candidate: readString(json['candidate']),
        score: readDouble(json['score']),
      );

  /// Where the words start in the raw transcript, as a character offset.
  final int? start;

  /// Where they end (exclusive).
  final int? end;

  /// The words as heard.
  final String? original;

  /// The term they may be.
  final String? candidate;

  /// Match confidence from 0 to 1.
  final double? score;

  @override
  String toString() => 'TerminologyNearMiss(start: $start, end: $end, '
      'score: $score)';
}

/// Something that limited the terminology mapping.
final class TerminologyWarning extends ApiObject {
  TerminologyWarning._(super.raw, {required this.code, required this.detail});

  /// Parses the API's JSON.
  factory TerminologyWarning.fromJson(Map<String, Object?> json) =>
      TerminologyWarning._(
        json,
        code: readString(json['code']),
        detail: readString(json['detail']),
      );

  /// A stable code, such as `terminology_too_large`.
  final String? code;

  /// What happened, in words.
  final String? detail;

  @override
  String toString() => 'TerminologyWarning(code: $code)';
}

/// How your terminology changed the transcript.
///
/// [rawText] is the API's `raw` field (the transcript as heard); it is
/// renamed because `raw` holds the JSON on every model.
final class TerminologyResult extends ApiObject {
  TerminologyResult._(
    super.raw, {
    required this.rawText,
    required this.corrected,
    required this.edits,
    required this.nearMisses,
    required this.warnings,
    required this.mapperStatus,
    required this.mapperVersion,
  });

  /// Parses the API's JSON.
  factory TerminologyResult.fromJson(Map<String, Object?> json) =>
      TerminologyResult._(
        json,
        rawText: readString(json['raw']),
        corrected: readString(json['corrected']),
        edits: readModels(json['edits'], TerminologyEdit.fromJson),
        nearMisses:
            readModels(json['nearMisses'], TerminologyNearMiss.fromJson),
        warnings: readModels(json['warnings'], TerminologyWarning.fromJson),
        mapperStatus: readString(json['mapperStatus']),
        mapperVersion: readString(json['mapperVersion']),
      );

  /// The transcript as heard (the API's `raw`).
  final String? rawText;

  /// The transcript with your terms applied.
  final String? corrected;

  /// Each replacement made, in order.
  final List<TerminologyEdit>? edits;

  /// Close matches that were not applied.
  final List<TerminologyNearMiss>? nearMisses;

  /// Anything that limited the mapping.
  final List<TerminologyWarning>? warnings;

  /// `applied`, `no_keywords` or `skipped`.
  final String? mapperStatus;

  /// The mapper version that answered.
  final String? mapperVersion;

  @override
  String toString() => 'TerminologyResult(mapperStatus: $mapperStatus, '
      'edits: ${edits?.length})';
}

/// The result of `speechToText.transcribe`.
final class SttResult extends ApiResult {
  SttResult._(
    super.raw, {
    required super.requestId,
    required this.jobId,
    required this.status,
    required this.transcription,
    required this.durationSeconds,
    required this.language,
    required this.numbersAsDigits,
    required this.identifySpeakers,
    required this.segments,
    required this.speakers,
    required this.terminology,
    required this.creditsConsumed,
  });

  /// Parses the API's JSON. Throws [FormatException] without `jobId` or
  /// `status`.
  factory SttResult.fromJson(Map<String, Object?> json, {String? requestId}) =>
      SttResult._(
        json,
        requestId: requestId,
        jobId: requireString(json, 'jobId', 'SttResult'),
        status: JobStatus(requireString(json, 'status', 'SttResult')),
        transcription: readString(json['transcription']),
        durationSeconds: readDouble(json['durationSeconds']),
        language: readString(json['language']),
        numbersAsDigits: readBool(json['numbersAsDigits']),
        identifySpeakers: readBool(json['identifySpeakers']),
        segments: readModels(json['segments'], SttSegment.fromJson),
        speakers: readModels(json['speakers'], SttSpeaker.fromJson),
        terminology: readModel(json['terminology'], TerminologyResult.fromJson),
        creditsConsumed: readInt(json['creditsConsumed']),
      );

  /// The ID of the job the call created.
  final String jobId;

  /// [JobStatus.completed]: a synchronous call creates its job finished.
  final JobStatus status;

  /// The transcript text, as heard.
  final String? transcription;

  /// The length of the audio in seconds.
  final double? durationSeconds;

  /// The language the transcription was requested with: `auto`, `ar` or
  /// `en`, as the API returns it.
  final String? language;

  /// Whether spoken numbers were written as digits.
  final bool? numbersAsDigits;

  /// Whether speakers were identified.
  final bool? identifySpeakers;

  /// The transcript in timed pieces. Empty unless speakers were identified.
  final List<SttSegment>? segments;

  /// The speakers heard. Empty unless speakers were identified.
  final List<SttSpeaker>? speakers;

  /// The transcript corrected to your terminology, when you sent one.
  final TerminologyResult? terminology;

  /// Credits charged.
  final int? creditsConsumed;

  /// The same as [jobId].
  String get id => jobId;

  @override
  String toString() => 'SttResult(jobId: $jobId, status: $status, '
      'durationSeconds: $durationSeconds, creditsConsumed: $creditsConsumed)';
}

/// Where a Speech to Text job made by a stream came from.
final class SttJobStream extends ApiObject {
  SttJobStream._(super.raw, {required this.sessionId});

  /// Parses the API's JSON.
  factory SttJobStream.fromJson(Map<String, Object?> json) =>
      SttJobStream._(json, sessionId: readString(json['sessionId']));

  /// The stream session the job came from.
  final String? sessionId;

  @override
  String toString() => 'SttJobStream(sessionId: $sessionId)';
}

/// A Speech to Text job. [transcription] is missing until it completes.
final class SttJob extends ApiResult {
  SttJob._(
    super.raw, {
    required super.requestId,
    required this.id,
    required this.status,
    required this.transcription,
    required this.durationSeconds,
    required this.language,
    required this.numbersAsDigits,
    required this.identifySpeakers,
    required this.segments,
    required this.speakers,
    required this.terminology,
    required this.stream,
    required this.audioUrl,
    required this.creditsConsumed,
    required this.error,
    required this.createdAt,
  });

  /// Parses the API's JSON. Throws [FormatException] without `id` or
  /// `status`.
  factory SttJob.fromJson(Map<String, Object?> json, {String? requestId}) =>
      SttJob._(
        json,
        requestId: requestId,
        id: requireString(json, 'id', 'SttJob'),
        status: JobStatus(requireString(json, 'status', 'SttJob')),
        transcription: readString(json['transcription']),
        durationSeconds: readDouble(json['durationSeconds']),
        language: readString(json['language']),
        numbersAsDigits: readBool(json['numbersAsDigits']),
        identifySpeakers: readBool(json['identifySpeakers']),
        segments: readModels(json['segments'], SttSegment.fromJson),
        speakers: readModels(json['speakers'], SttSpeaker.fromJson),
        terminology: readModel(json['terminology'], TerminologyResult.fromJson),
        stream: readModel(json['stream'], SttJobStream.fromJson),
        audioUrl: readString(json['audioUrl']),
        creditsConsumed: readInt(json['creditsConsumed']),
        error: readString(json['error']),
        createdAt: readDateTime(json['createdAt']),
      );

  /// The job ID.
  final String id;

  /// The job's status; unknown values are not finished.
  final JobStatus status;

  /// The transcript text, once the job has completed.
  final String? transcription;

  /// The length of the audio in seconds: an estimate while processing.
  final double? durationSeconds;

  /// The language the transcription was requested with: `auto`, `ar` or
  /// `en`, as the API returns it.
  final String? language;

  /// Whether spoken numbers were written as digits.
  final bool? numbersAsDigits;

  /// Whether speakers were identified.
  final bool? identifySpeakers;

  /// The transcript in timed pieces. Empty unless speakers were identified.
  final List<SttSegment>? segments;

  /// The speakers heard. Empty unless speakers were identified.
  final List<SttSpeaker>? speakers;

  /// The transcript corrected to your terminology, when you sent one.
  final TerminologyResult? terminology;

  /// Only on jobs from a Speech to Text stream: the session it came from.
  final SttJobStream? stream;

  /// Only on jobs from a Speech to Text stream: a signed link to the
  /// recording. It expires; get the job again for a fresh one.
  final String? audioUrl;

  /// Credits charged.
  final int? creditsConsumed;

  /// Why the job failed, when it did.
  final String? error;

  /// When the job was created, in UTC.
  final DateTime? createdAt;

  @override
  String toString() => 'SttJob(id: $id, status: $status)';
}

/// A speaker in a JSON transcript export.
final class TranscriptExportSpeaker extends ApiObject {
  TranscriptExportSpeaker._(
    super.raw, {
    required this.id,
    required this.label,
    required this.talkTime,
  });

  /// Parses the API's JSON.
  factory TranscriptExportSpeaker.fromJson(Map<String, Object?> json) =>
      TranscriptExportSpeaker._(
        json,
        id: readString(json['id']),
        label: readString(json['label']),
        talkTime: readDouble(json['talkTime']),
      );

  /// The speaker ID the segments use.
  final String? id;

  /// The label, such as `Speaker 1`.
  final String? label;

  /// How long this speaker talks, in seconds.
  final double? talkTime;

  @override
  String toString() => 'TranscriptExportSpeaker(id: $id, label: $label)';
}

/// A timed segment in a JSON transcript export.
final class TranscriptExportSegment extends ApiObject {
  TranscriptExportSegment._(
    super.raw, {
    required this.start,
    required this.end,
    required this.speaker,
    required this.speakerLabel,
    required this.text,
  });

  /// Parses the API's JSON.
  factory TranscriptExportSegment.fromJson(Map<String, Object?> json) =>
      TranscriptExportSegment._(
        json,
        start: readDouble(json['start']),
        end: readDouble(json['end']),
        speaker: readString(json['speaker']),
        speakerLabel: readString(json['speakerLabel']),
        text: readString(json['text']),
      );

  /// Where the segment starts, in seconds.
  final double? start;

  /// Where it ends, in seconds.
  final double? end;

  /// The speaker ID.
  final String? speaker;

  /// The speaker's label, such as `Speaker 1`.
  final String? speakerLabel;

  /// What was said.
  final String? text;

  @override
  String toString() => 'TranscriptExportSegment(start: $start, end: $end, '
      'speaker: $speaker)';
}

/// `speechToText.jobs.exportJson`: the text, speakers and timed segments.
final class TranscriptExport extends ApiResult {
  TranscriptExport._(
    super.raw, {
    required super.requestId,
    required this.id,
    required this.fileName,
    required this.durationSeconds,
    required this.language,
    required this.text,
    required this.speakers,
    required this.segments,
  });

  /// Parses the API's JSON.
  factory TranscriptExport.fromJson(
    Map<String, Object?> json, {
    String? requestId,
  }) =>
      TranscriptExport._(
        json,
        requestId: requestId,
        id: readString(json['id']),
        fileName: readString(json['fileName']),
        durationSeconds: readDouble(json['durationSeconds']),
        language: readString(json['language']),
        text: readString(json['text']),
        speakers:
            readModels(json['speakers'], TranscriptExportSpeaker.fromJson),
        segments:
            readModels(json['segments'], TranscriptExportSegment.fromJson),
      );

  /// The job ID.
  final String? id;

  /// The name of the uploaded file.
  final String? fileName;

  /// The length of the audio in seconds.
  final double? durationSeconds;

  /// The language of the transcript.
  final String? language;

  /// The transcript text.
  final String? text;

  /// The speakers, with their labels.
  final List<TranscriptExportSpeaker>? speakers;

  /// The timed segments.
  final List<TranscriptExportSegment>? segments;

  @override
  String toString() => 'TranscriptExport(id: $id, '
      'segments: ${segments?.length}, speakers: ${speakers?.length})';
}
