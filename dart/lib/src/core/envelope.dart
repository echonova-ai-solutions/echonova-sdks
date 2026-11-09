/// Parse EchoNova's response envelope: `{data, success, statusCode,
/// errorMessage}`.
///
/// Success responses carry `success: true` and `data`. Errors carry
/// `errorMessage`, usually `docs`, and may carry an `errorCode`. Responses
/// from the hosting proxy (for example an ingress 504) are not JSON.
library;

import 'dart:convert';
import 'dart:math' as math;

/// At most this many bytes of an error body are kept as `rawBody`.
const int rawBodyLimit = 4096;

/// A non-JSON error body becomes an error message of at most this many
/// characters.
const int nonJsonMessageLimit = 500;

/// A 2xx body that isn't a valid success envelope. Internal: the transport
/// turns it into a `ProtocolException`.
final class MalformedEnvelope implements Exception {
  /// Creates the exception.
  const MalformedEnvelope(this.message);

  /// What is wrong with the body.
  final String message;

  @override
  String toString() => 'MalformedEnvelope: $message';
}

/// The parts of an error response the SDK uses.
final class ErrorBody {
  /// Creates a parsed error body.
  const ErrorBody({
    required this.isJson,
    required this.errorMessage,
    required this.errorCode,
    required this.docsUrl,
    required this.rawBody,
  });

  /// Whether the body is an EchoNova envelope.
  final bool isJson;

  /// The envelope's `errorMessage`, or the start of a non-JSON body.
  final String? errorMessage;

  /// The envelope's `errorCode`.
  final String? errorCode;

  /// The envelope's `docs` link.
  final String? docsUrl;

  /// The first [rawBodyLimit] bytes of the body, as text.
  final String? rawBody;
}

/// Case-insensitive header lookup that works for any map.
String? header(Map<String, String> headers, String name) {
  final exact = headers[name];
  if (exact != null) return exact;
  final lowered = name.toLowerCase();
  for (final MapEntry(:key, :value) in headers.entries) {
    if (key.toLowerCase() == lowered) return value;
  }
  return null;
}

String? _decodePreview(List<int> body) {
  if (body.isEmpty) return null;
  final end = math.min(body.length, rawBodyLimit);
  return utf8.decode(body.sublist(0, end), allowMalformed: true);
}

/// Decodes a JSON body, or returns `null` when it isn't valid UTF-8 JSON.
Object? _tryJson(List<int> body) {
  try {
    var text = utf8.decode(body);
    if (text.startsWith('﻿')) text = text.substring(1);
    return jsonDecode(text);
  } on FormatException {
    return null;
  }
}

/// Parses the body of an error response.
ErrorBody parseErrorBody(List<int> body) {
  final preview = _decodePreview(body);
  final parsed = body.isEmpty ? null : _tryJson(body);
  if (parsed is Map<String, Object?> &&
      (parsed.containsKey('errorMessage') || parsed.containsKey('success'))) {
    final message = parsed['errorMessage'];
    final code = parsed['errorCode'];
    final docs = parsed['docs'];
    return ErrorBody(
      isJson: true,
      errorMessage: message is String ? message : null,
      errorCode: code is String ? code : null,
      docsUrl: docs is String ? docs : null,
      rawBody: preview,
    );
  }
  String? text;
  if (preview != null) {
    final runes = preview.trim().runes;
    text = String.fromCharCodes(runes.take(nonJsonMessageLimit));
  }
  return ErrorBody(
    isJson: false,
    errorMessage: text == null || text.isEmpty ? null : text,
    errorCode: null,
    docsUrl: null,
    rawBody: preview,
  );
}

/// Returns `data` from a success envelope, or throws [MalformedEnvelope].
Object? unwrapSuccess(List<int> body) {
  final Object? parsed;
  try {
    var text = utf8.decode(body);
    if (text.startsWith('﻿')) text = text.substring(1);
    parsed = jsonDecode(text);
  } on FormatException {
    throw const MalformedEnvelope('response body is not JSON');
  }
  if (parsed is! Map<String, Object?> || !parsed.containsKey('data')) {
    throw const MalformedEnvelope('response body is not an EchoNova envelope');
  }
  if (parsed['success'] == false) {
    throw const MalformedEnvelope('2xx response with success=false');
  }
  return parsed['data'];
}

/// The longest wait the SDK represents; larger values are clamped to it.
const Duration _maxDuration = Duration(days: 365 * 100);

/// Converts seconds to a [Duration]: negative and NaN become zero, and huge
/// or infinite values are clamped.
Duration durationFromSeconds(double seconds) {
  if (seconds.isNaN || seconds <= 0) return Duration.zero;
  if (seconds >= _maxDuration.inSeconds) return _maxDuration;
  return Duration(
      microseconds: (seconds * Duration.microsecondsPerSecond).round());
}

/// Parses `Retry-After`: delta-seconds (what EchoNova sends) or an HTTP date.
///
/// Returns `null` when the header is missing or unreadable. Negative values
/// become zero.
Duration? parseRetryAfter(String? value, {DateTime? now}) {
  if (value == null) return null;
  final text = value.trim();
  final seconds = double.tryParse(text);
  if (seconds != null) return durationFromSeconds(seconds);
  final when = parseHttpDate(text);
  if (when == null) return null;
  final difference = when.difference(now ?? DateTime.now().toUtc());
  return difference.isNegative ? Duration.zero : difference;
}

const _months = {
  'jan': 1,
  'feb': 2,
  'mar': 3,
  'apr': 4,
  'may': 5,
  'jun': 6,
  'jul': 7,
  'aug': 8,
  'sep': 9,
  'oct': 10,
  'nov': 11,
  'dec': 12,
};

// IMF-fixdate and RFC 850 ("Sun, 06 Nov 1994 08:49:37 GMT",
// "Sunday, 06-Nov-94 08:49:37 GMT"), also with a numeric zone (+0000).
final _rfcDate = RegExp(
  r'^(?:[A-Za-z]+,\s*)?(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*[\s-]+(\d{2,4})\s+'
  r'(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(GMT|UTC|UT|Z|[+-]\d{4})?$',
  caseSensitive: false,
);

// asctime ("Sun Nov  6 08:49:37 1994").
final _asctime = RegExp(
  r'^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$',
);

/// Parses an HTTP date (RFC 9110: IMF-fixdate, RFC 850 or asctime), or
/// returns `null`.
DateTime? parseHttpDate(String text) {
  int? day, month, year, hour, minute, second;
  var offsetMinutes = 0;
  final rfc = _rfcDate.firstMatch(text);
  final asc = rfc == null ? _asctime.firstMatch(text) : null;
  if (rfc != null) {
    day = int.parse(rfc[1]!);
    month = _months[rfc[2]!.toLowerCase()];
    year = int.parse(rfc[3]!);
    if (rfc[3]!.length == 2) year += year < 50 ? 2000 : 1900;
    hour = int.parse(rfc[4]!);
    minute = int.parse(rfc[5]!);
    second = int.parse(rfc[6] ?? '0');
    final zone = rfc[7];
    if (zone != null && (zone.startsWith('+') || zone.startsWith('-'))) {
      final sign = zone.startsWith('-') ? -1 : 1;
      offsetMinutes = sign *
          (int.parse(zone.substring(1, 3)) * 60 + int.parse(zone.substring(3)));
    }
  } else if (asc != null) {
    month = _months[asc[1]!.toLowerCase()];
    day = int.parse(asc[2]!);
    hour = int.parse(asc[3]!);
    minute = int.parse(asc[4]!);
    second = int.parse(asc[5]!);
    year = int.parse(asc[6]!);
  } else {
    return null;
  }
  if (month == null ||
      day < 1 ||
      day > 31 ||
      hour > 23 ||
      minute > 59 ||
      second > 60) {
    return null;
  }
  return DateTime.utc(year, month, day, hour, minute, second)
      .subtract(Duration(minutes: offsetMinutes));
}
