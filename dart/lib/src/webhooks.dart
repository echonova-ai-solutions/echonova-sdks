/// Verify and parse EchoNova webhook requests (Standard Webhooks v1).
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

/// The header that names the event. It isn't covered by the signature.
const String webhookEventHeader = 'X-Webhook-Event';

/// The header with the delivery's id. It stays the same on retries.
const String webhookIdHeader = 'webhook-id';

/// The header with the signing time, in Unix seconds.
const String webhookTimestampHeader = 'webhook-timestamp';

/// The header with the signatures: `v1,<base64 HMAC-SHA256>`, one per
/// active secret, separated by spaces.
const String webhookSignatureHeader = 'webhook-signature';

/// A verified webhook event. `switch` over it to handle each kind.
sealed class WebhookEvent {
  const WebhookEvent();

  /// The event name, such as `job.completed`.
  String get event;

  /// When the delivery was signed, in Unix seconds.
  int get timestamp;

  /// The parsed JSON body.
  Object? get raw;

  /// The delivery's `webhook-id`. It stays the same when a delivery is
  /// retried.
  String get webhookId;

  /// The key to deduplicate deliveries with (the same delivery can arrive
  /// more than once): the [webhookId].
  String get dedupeKey => webhookId;
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
    required this.webhookId,
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
  final String webhookId;

  @override
  String get event => 'job.completed';
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
    required this.webhookId,
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
  final String webhookId;

  @override
  String get event => 'job.failed';
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
    required this.webhookId,
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
  final String webhookId;

  @override
  String get event => 'spending.warning';
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
    required this.webhookId,
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
  final String webhookId;

  @override
  String get event => 'spending.exhausted';
}

/// An event this SDK version doesn't know yet. The signature was valid.
final class UnknownWebhookEvent extends WebhookEvent {
  /// Creates the event.
  const UnknownWebhookEvent({
    required this.event,
    required this.timestamp,
    required this.raw,
    required this.webhookId,
  });

  @override
  final String event;

  @override
  final int timestamp;

  @override
  final Object? raw;

  @override
  final String webhookId;
}

/// Checks a webhook's signature and timestamp, then parses it.
///
/// [payload] is the raw request body, exactly as received (use
/// `utf8.encode` if your framework only gives you a string). [secrets] are
/// the webhook's signing secrets (`whsec_...`) as shown in the portal; more
/// than one can be valid at once. During a rotation in the portal the gateway
/// signs with both the new and the previous secret, so passing only the new
/// one works. [now] defaults to the current time.
///
/// Throws [WebhookVerificationException] with a [WebhookFailure] reason, or
/// [ArgumentError] when [secrets] is empty or holds a secret that isn't
/// valid.
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
  final keys = [for (final secret in secrets) _signingKey(secret)];

  final eventName = header(headers, webhookEventHeader);
  final idHeader = header(headers, webhookIdHeader);
  final timestampHeader = header(headers, webhookTimestampHeader);
  final signature = header(headers, webhookSignatureHeader);
  if (eventName == null ||
      eventName.isEmpty ||
      idHeader == null ||
      idHeader.trim().isEmpty ||
      timestampHeader == null ||
      timestampHeader.isEmpty ||
      signature == null ||
      signature.isEmpty) {
    throw WebhookVerificationException(
      'missing $webhookEventHeader, $webhookIdHeader, $webhookTimestampHeader '
      'or $webhookSignatureHeader header',
      reason: WebhookFailure.headers,
    );
  }

  final timestampText = timestampHeader.trim();
  // Unix seconds fit in far fewer digits. The cap keeps a header of
  // thousands of digits from being parsed at all.
  if (timestampText.length > _maxTimestampLength ||
      !_asciiDigits.hasMatch(timestampText)) {
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

  final webhookId = idHeader.trim();
  final message = [
    ...utf8.encode(webhookId),
    0x2E,
    ...ascii.encode(timestampText),
    0x2E,
    ...payload,
  ];
  // One `v1,<base64>` per secret the gateway signed with, separated by
  // spaces; entries of other versions are ignored.
  final received = [
    for (final entry in signature.split(_whitespace))
      if (entry.startsWith('v1,')) entry.substring(3),
  ];
  var valid = false;
  for (final key in keys) {
    final expected = base64.encode(Hmac(sha256, key).convert(message).bytes);
    // Check every pair, so timing doesn't reveal which one matched.
    for (final candidate in received) {
      if (_constantTimeEquals(expected, candidate)) valid = true;
    }
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
  return _parseEvent(eventName.trim(), data, timestamp, webhookId);
}

/// The HMAC key: the base64 after `whsec_`, decoded. Either base64 alphabet,
/// padding optional.
List<int> _signingKey(String secret) {
  var text = secret.trim();
  if (text.startsWith(_secretPrefix)) {
    text = text.substring(_secretPrefix.length);
  }
  text = text.replaceAll('-', '+').replaceAll('_', '/');
  text = text.replaceFirst(RegExp(r'={1,2}$'), '');
  List<int>? key;
  if (RegExp(r'^[A-Za-z0-9+/]+$').hasMatch(text) && text.length % 4 != 1) {
    try {
      key = base64.decode(text.padRight((text.length + 3) ~/ 4 * 4, '='));
    } on FormatException {
      key = null;
    }
  }
  if (key == null || key.isEmpty) {
    throw ArgumentError.value(
      '$_secretPrefix...',
      'secrets',
      'secret is not a webhook signing secret: expected whsec_ followed by '
          'base64',
    );
  }
  return key;
}

const _secretPrefix = 'whsec_';

final _whitespace = RegExp(r'\s+');

final _asciiDigits = RegExp(r'^[0-9]+$');

/// The longest timestamp header accepted, after trimming.
const _maxTimestampLength = 15;

/// Compares two strings in time that depends only on their lengths.
bool _constantTimeEquals(String a, String b) {
  if (a.length != b.length) return false;
  var difference = 0;
  for (var i = 0; i < a.length; i++) {
    difference |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
  }
  return difference == 0;
}

WebhookEvent _parseEvent(
  String name,
  Object? data,
  int timestamp,
  String webhookId,
) {
  if (data is! Map<String, Object?>) {
    return UnknownWebhookEvent(
      event: name,
      timestamp: timestamp,
      raw: data,
      webhookId: webhookId,
    );
  }
  switch (name) {
    case 'job.completed':
      final terminology = data['terminology'];
      final jobId = _requiredString(data, 'jobId');
      final service = _requiredString(data, 'service');
      // The signature doesn't cover the event header, so a signed job.failed
      // body could be replayed as job.completed. As SDK policy, a completed
      // job must carry its result.
      switch (service) {
        case 'tts':
          _requiredString(data, 'audioUrl');
        case 'stt':
          _requiredString(data, 'transcription');
      }
      return JobCompleted(
        jobId: jobId,
        apiKeyId: _string(data['apiKeyId']),
        service: service,
        durationSeconds: _number(data['durationSeconds']),
        text: _string(data['text']),
        audioUrl: _string(data['audioUrl']),
        transcription: _string(data['transcription']),
        terminology: terminology is Map<String, Object?> ? terminology : null,
        timestamp: timestamp,
        raw: data,
        webhookId: webhookId,
      );
    case 'job.failed':
      // A failed job has no result. With one, the body may be a
      // job.completed sent under this event name.
      _refuseKeys(data, const ['audioUrl', 'transcription']);
      return JobFailed(
        jobId: _requiredString(data, 'jobId'),
        apiKeyId: _string(data['apiKeyId']),
        service: _requiredString(data, 'service'),
        error: _string(data['error']),
        timestamp: timestamp,
        raw: data,
        webhookId: webhookId,
      );
    case 'spending.warning':
      // A spending event carries its credits. Without them, the body may be
      // a job event sent under this event name.
      final creditsUsed = _requiredNumber(data, 'creditsUsed');
      final creditLimit = _requiredNumber(data, 'creditLimit');
      final percentage = _number(data['percentageUsed']);
      return SpendingWarning(
        apiKeyId: _requiredString(data, 'apiKeyId'),
        apiKeyName: _string(data['apiKeyName']),
        creditsUsed: creditsUsed,
        creditLimit: creditLimit,
        percentageUsed: percentage == null ? null : _roundHalfEven(percentage),
        timestamp: timestamp,
        raw: data,
        webhookId: webhookId,
      );
    case 'spending.exhausted':
      final creditsUsed = _requiredNumber(data, 'creditsUsed');
      final creditLimit = _requiredNumber(data, 'creditLimit');
      return SpendingExhausted(
        apiKeyId: _requiredString(data, 'apiKeyId'),
        apiKeyName: _string(data['apiKeyName']),
        creditsUsed: creditsUsed,
        creditLimit: creditLimit,
        timestamp: timestamp,
        raw: data,
        webhookId: webhookId,
      );
    default:
      return UnknownWebhookEvent(
        event: name,
        timestamp: timestamp,
        raw: data,
        webhookId: webhookId,
      );
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

double _requiredNumber(Map<String, Object?> data, String key) {
  final value = _number(data[key]);
  if (value == null) {
    throw WebhookVerificationException(
      'webhook payload is missing $key',
      reason: WebhookFailure.payload,
    );
  }
  return value;
}

/// Refuses a body that carries any of [keys] as a non-empty string (null or
/// empty is allowed).
void _refuseKeys(Map<String, Object?> data, List<String> keys) {
  for (final key in keys) {
    final value = data[key];
    if (value is String && value.isNotEmpty) {
      throw WebhookVerificationException(
        'webhook payload has an unexpected $key',
        reason: WebhookFailure.payload,
      );
    }
  }
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
