/// Verify and parse EchoNova webhook requests.
///
/// ```dart
/// final event = verifyWebhook(
///   rawBody, // the bytes exactly as received
///   request.headers,
///   [Platform.environment['ECHONOVA_WEBHOOK_SECRET']!],
/// );
/// switch (event) {
///   case JobCompleted(:final jobId, :final service):
///     print('$service job $jobId finished');
///   case JobFailed(:final jobId, :final error):
///     print('job $jobId failed: $error');
///   case SpendingWarning() || SpendingExhausted() || UnknownWebhookEvent():
///     break;
/// }
/// ```
///
/// Pass the raw request body exactly as received. Parsing the JSON and
/// serialising it again changes the bytes, and the signature check then
/// fails.
library;

import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'core/envelope.dart' show header;
import 'errors.dart';

/// The default tolerance between a webhook's timestamp and now.
const Duration defaultWebhookTolerance = Duration(seconds: 300);

/// The header that names the event.
const String webhookEventHeader = 'X-Webhook-Event';

/// The header with the signing time, in Unix seconds.
const String webhookTimestampHeader = 'X-Webhook-Timestamp';

/// The header with the HMAC-SHA256 signature, as hex.
const String webhookSignatureHeader = 'X-Webhook-Signature';

/// A verified webhook event. `switch` over it to handle each kind.
sealed class WebhookEvent {
  const WebhookEvent();

  /// The event name, such as `job.completed`.
  String get event;

  /// When the delivery was signed, in Unix seconds.
  int get timestamp;

  /// The parsed JSON body.
  Object? get raw;

  /// A key to deduplicate deliveries (the same event can arrive more than
  /// once), or `null` when the event can't be deduplicated.
  String? get dedupeKey;
}

/// An async Text to Speech or Speech to Text job finished. Check [service].
final class JobCompleted extends WebhookEvent {
  /// Creates the event.
  const JobCompleted({
    required this.jobId,
    required this.apiKeyId,
    required this.service,
    required this.durationSeconds,
    required this.text,
    required this.audioUrl,
    required this.transcription,
    required this.terminology,
    required this.timestamp,
    required this.raw,
  });

  /// The finished job.
  final String jobId;

  /// The API key that created the job.
  final String? apiKeyId;

  /// `tts` or `stt`.
  final String service;

  /// The audio length, in seconds.
  final double? durationSeconds;

  /// TTS: the synthesised text.
  final String? text;

  /// TTS: a signed link to the audio. It expires; get the job again for a
  /// fresh one.
  final String? audioUrl;

  /// STT: the transcript.
  final String? transcription;

  /// STT: the terminology result, when terminology was sent.
  final Map<String, Object?>? terminology;

  @override
  final int timestamp;

  @override
  final Map<String, Object?> raw;

  @override
  String get event => 'job.completed';

  @override
  String get dedupeKey => '$event:$jobId';
}

/// An async job failed.
final class JobFailed extends WebhookEvent {
  /// Creates the event.
  const JobFailed({
    required this.jobId,
    required this.apiKeyId,
    required this.service,
    required this.error,
    required this.timestamp,
    required this.raw,
  });

  /// The failed job.
  final String jobId;

  /// The API key that created the job.
  final String? apiKeyId;

  /// `tts` or `stt`.
  final String service;

  /// Why it failed.
  final String? error;

  @override
  final int timestamp;

  @override
  final Map<String, Object?> raw;

  @override
  String get event => 'job.failed';

  @override
  String get dedupeKey => '$event:$jobId';
}

/// The key is close to its Credit Limit for this billing cycle.
final class SpendingWarning extends WebhookEvent {
  /// Creates the event.
  const SpendingWarning({
    required this.apiKeyId,
    required this.apiKeyName,
    required this.creditsUsed,
    required this.creditLimit,
    required this.percentageUsed,
    required this.timestamp,
    required this.raw,
  });

  /// The API key.
  final String apiKeyId;

  /// The API key's name.
  final String? apiKeyName;

  /// Credits used this cycle.
  final double? creditsUsed;

  /// The key's Credit Limit.
  final double? creditLimit;

  /// [creditsUsed] as a percentage of [creditLimit].
  final int? percentageUsed;

  @override
  final int timestamp;

  @override
  final Map<String, Object?> raw;

  @override
  String get event => 'spending.warning';

  @override
  String get dedupeKey =>
      '$event:$apiKeyId:${_numberKey(creditsUsed)}:${_numberKey(creditLimit)}';
}

/// The key reached its Credit Limit; paid calls with it now fail until the
/// limit changes.
final class SpendingExhausted extends WebhookEvent {
  /// Creates the event.
  const SpendingExhausted({
    required this.apiKeyId,
    required this.apiKeyName,
    required this.creditsUsed,
    required this.creditLimit,
    required this.timestamp,
    required this.raw,
  });

  /// The API key.
  final String apiKeyId;

  /// The API key's name.
  final String? apiKeyName;

  /// Credits used this cycle.
  final double? creditsUsed;

  /// The key's Credit Limit.
  final double? creditLimit;

  @override
  final int timestamp;

  @override
  final Map<String, Object?> raw;

  @override
  String get event => 'spending.exhausted';

  @override
  String get dedupeKey =>
      '$event:$apiKeyId:${_numberKey(creditsUsed)}:${_numberKey(creditLimit)}';
}

/// An event this SDK version doesn't know yet. The signature was valid.
final class UnknownWebhookEvent extends WebhookEvent {
  /// Creates the event.
  const UnknownWebhookEvent({
    required this.event,
    required this.timestamp,
    required this.raw,
  });

  @override
  final String event;

  @override
  final int timestamp;

  @override
  final Object? raw;

  @override
  String? get dedupeKey => null;
}

/// Checks a webhook's signature and timestamp, then parses it.
///
/// [payload] is the raw request body, exactly as received (use
/// `utf8.encode` if your framework only gives you a string). [secrets] may
/// hold more than one secret, so two can be valid at once (for example
/// during a switch-over). [now] defaults to the current time.
///
/// Throws [WebhookVerificationException] with a [WebhookFailure] reason, or
/// [ArgumentError] when [secrets] is empty or holds an empty string.
WebhookEvent verifyWebhook(
  List<int> payload,
  Map<String, String> headers,
  List<String> secrets, {
  Duration tolerance = defaultWebhookTolerance,
  DateTime? now,
}) {
  if (secrets.isEmpty || secrets.any((secret) => secret.isEmpty)) {
    throw ArgumentError.value(
      secrets,
      'secrets',
      'secret must be a non-empty string or a list of them',
    );
  }

  final eventName = header(headers, webhookEventHeader);
  final timestampHeader = header(headers, webhookTimestampHeader);
  final signature = header(headers, webhookSignatureHeader);
  if (eventName == null ||
      eventName.isEmpty ||
      timestampHeader == null ||
      timestampHeader.isEmpty ||
      signature == null ||
      signature.isEmpty) {
    throw WebhookVerificationException(
      'missing $webhookEventHeader, $webhookTimestampHeader or '
      '$webhookSignatureHeader header',
      reason: WebhookFailure.headers,
    );
  }

  final timestampText = timestampHeader.trim();
  if (!_asciiDigits.hasMatch(timestampText)) {
    throw WebhookVerificationException(
      'webhook timestamp is not a number',
      reason: WebhookFailure.timestamp,
    );
  }
  final timestamp = int.tryParse(timestampText);
  final current = (now ?? DateTime.now()).microsecondsSinceEpoch /
      Duration.microsecondsPerSecond;
  final allowed = tolerance.inMicroseconds / Duration.microsecondsPerSecond;
  if (timestamp == null || (current - timestamp).abs() > allowed) {
    throw WebhookVerificationException(
      'webhook timestamp is outside the allowed tolerance',
      reason: WebhookFailure.timestamp,
    );
  }

  final message = [...ascii.encode(timestampText), 0x2E, ...payload];
  final received = signature.trim().toLowerCase();
  var valid = false;
  for (final secret in secrets) {
    final expected = Hmac(sha256, utf8.encode(secret)).convert(message);
    // Check every secret, so timing doesn't reveal which one matched.
    if (_constantTimeEquals(expected.toString(), received)) valid = true;
  }
  if (!valid) {
    throw WebhookVerificationException(
      'webhook signature does not match',
      reason: WebhookFailure.signature,
    );
  }

  final Object? data;
  try {
    data = jsonDecode(utf8.decode(payload));
  } on FormatException {
    throw WebhookVerificationException(
      'webhook body is not JSON',
      reason: WebhookFailure.payload,
    );
  }
  return _parseEvent(eventName.trim(), data, timestamp);
}

final _asciiDigits = RegExp(r'^[0-9]+$');

/// Compares two strings in time that depends only on their lengths.
bool _constantTimeEquals(String a, String b) {
  if (a.length != b.length) return false;
  var difference = 0;
  for (var i = 0; i < a.length; i++) {
    difference |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
  }
  return difference == 0;
}

WebhookEvent _parseEvent(String name, Object? data, int timestamp) {
  if (data is! Map<String, Object?>) {
    return UnknownWebhookEvent(event: name, timestamp: timestamp, raw: data);
  }
  switch (name) {
    case 'job.completed':
      final terminology = data['terminology'];
      return JobCompleted(
        jobId: _requiredString(data, 'jobId'),
        apiKeyId: _string(data['apiKeyId']),
        service: _requiredString(data, 'service'),
        durationSeconds: _number(data['durationSeconds']),
        text: _string(data['text']),
        audioUrl: _string(data['audioUrl']),
        transcription: _string(data['transcription']),
        terminology: terminology is Map<String, Object?> ? terminology : null,
        timestamp: timestamp,
        raw: data,
      );
    case 'job.failed':
      return JobFailed(
        jobId: _requiredString(data, 'jobId'),
        apiKeyId: _string(data['apiKeyId']),
        service: _requiredString(data, 'service'),
        error: _string(data['error']),
        timestamp: timestamp,
        raw: data,
      );
    case 'spending.warning':
      final percentage = _number(data['percentageUsed']);
      return SpendingWarning(
        apiKeyId: _requiredString(data, 'apiKeyId'),
        apiKeyName: _string(data['apiKeyName']),
        creditsUsed: _number(data['creditsUsed']),
        creditLimit: _number(data['creditLimit']),
        percentageUsed: percentage == null ? null : _roundHalfEven(percentage),
        timestamp: timestamp,
        raw: data,
      );
    case 'spending.exhausted':
      return SpendingExhausted(
        apiKeyId: _requiredString(data, 'apiKeyId'),
        apiKeyName: _string(data['apiKeyName']),
        creditsUsed: _number(data['creditsUsed']),
        creditLimit: _number(data['creditLimit']),
        timestamp: timestamp,
        raw: data,
      );
    default:
      return UnknownWebhookEvent(event: name, timestamp: timestamp, raw: data);
  }
}

String _requiredString(Map<String, Object?> data, String key) {
  final value = data[key];
  if (value is! String || value.isEmpty) {
    throw WebhookVerificationException(
      'webhook payload is missing $key',
      reason: WebhookFailure.payload,
    );
  }
  return value;
}

String? _string(Object? value) => value is String ? value : null;

/// A finite number from a JSON number or numeric string, or `null`.
double? _number(Object? value) {
  final number = switch (value) {
    final num n => n.toDouble(),
    final String s => double.tryParse(s.trim()),
    _ => null,
  };
  return number != null && number.isFinite ? number : null;
}

/// Rounds half to even, like Python's `round()`.
int _roundHalfEven(double value) {
  final floor = value.floorToDouble();
  final fraction = value - floor;
  if (fraction != 0.5) return value.round();
  final lower = floor.toInt();
  return lower.isEven ? lower : lower + 1;
}

/// Formats a number for a dedupe key the same way in every EchoNova SDK:
/// whole numbers without a decimal point, others in shortest form.
String _numberKey(double? value) {
  if (value == null) return '-';
  if (value == value.truncateToDouble()) {
    return BigInt.from(value).toString();
  }
  if (value.abs() < 1e-4) {
    // Python's repr switches to exponent form below 1e-4 ("1e-05").
    final text = value.toStringAsExponential();
    final at = text.indexOf('e');
    final mantissa = text.substring(0, at);
    final exponent = int.parse(text.substring(at + 1));
    final sign = exponent < 0 ? '-' : '+';
    return '${mantissa}e$sign${exponent.abs().toString().padLeft(2, '0')}';
  }
  return value.toString();
}
