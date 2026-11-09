/// Base classes and lenient JSON readers for response models.
///
/// The API omits fields it has no value for, so a missing field reads as
/// `null`. Unknown fields are kept in `raw`. Numbers are accepted as int,
/// double or numeric strings, and ISO 8601 timestamps become UTC
/// [DateTime]s. Only the fields the SDK itself relies on (IDs and status)
/// are required: without them `fromJson` throws a [FormatException].
library;

/// A JSON object from the API.
abstract base class ApiObject {
  /// Wraps [raw].
  ApiObject(Map<String, Object?> raw) : raw = Map.unmodifiable(raw);

  /// The JSON exactly as received, including fields this SDK version
  /// doesn't know yet.
  final Map<String, Object?> raw;

  /// The JSON as received ([raw]).
  Map<String, Object?> toJson() => raw;
}

/// The result of an API call: a JSON object with the request ID of the
/// response it came in.
abstract base class ApiResult extends ApiObject {
  /// Wraps [raw].
  ApiResult(super.raw, {this.requestId});

  /// The `X-Request-Id` of the response this came in. Quote it to support.
  final String? requestId;
}

/// [data] as a JSON object, or a [FormatException] naming [model].
Map<String, Object?> jsonObject(Object? data, String model) {
  final object = readObject(data);
  if (object == null) {
    throw FormatException(
      'expected a JSON object for $model, got ${_kind(data)}',
    );
  }
  return object;
}

String _kind(Object? value) => switch (value) {
      null => 'null',
      List<Object?>() => 'a list',
      String() => 'a string',
      num() => 'a number',
      bool() => 'a boolean',
      _ => 'something else',
    };

/// A required string field, or a [FormatException].
String requireString(Map<String, Object?> json, String key, String model) {
  final value = readString(json[key]);
  if (value == null) {
    throw FormatException('$model is missing "$key"');
  }
  return value;
}

/// A JSON object, with its keys as strings.
Map<String, Object?>? readObject(Object? value) {
  if (value is Map<String, Object?>) return value;
  if (value is Map) {
    return {for (final MapEntry(:key, :value) in value.entries) '$key': value};
  }
  return null;
}

/// A string; numbers are converted.
String? readString(Object? value) => switch (value) {
      final String text => text,
      final num number => '$number',
      _ => null,
    };

/// A number, from a number or a numeric string.
double? readDouble(Object? value) => switch (value) {
      final num number => number.toDouble(),
      final String text => double.tryParse(text.trim()),
      _ => null,
    };

/// A whole number, from a number or a numeric string. A number with a
/// fraction is not rounded: it reads as `null` and stays in `raw`.
int? readInt(Object? value) {
  if (value is int) return value;
  if (value is String) {
    final text = value.trim();
    final parsed = int.tryParse(text);
    if (parsed != null) return parsed;
    return _wholeNumber(double.tryParse(text));
  }
  if (value is double) return _wholeNumber(value);
  return null;
}

int? _wholeNumber(double? value) {
  if (value == null || !value.isFinite || value != value.roundToDouble()) {
    return null;
  }
  return value.toInt();
}

/// A boolean, from a boolean, 0 or 1, or `"true"`/`"false"`.
bool? readBool(Object? value) {
  if (value is bool) return value;
  if (value == 0) return false;
  if (value == 1) return true;
  if (value is String) {
    switch (value.trim().toLowerCase()) {
      case 'true':
        return true;
      case 'false':
        return false;
    }
  }
  return null;
}

final _iso = RegExp(
  r'^(\d{4})-(\d{2})-(\d{2})'
  r'(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?'
  r'\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$',
);

/// An ISO 8601 timestamp, in UTC. One without an offset is read as UTC.
DateTime? readDateTime(Object? value) {
  if (value is DateTime) return value.toUtc();
  if (value is! String) return null;
  final match = _iso.firstMatch(value.trim());
  if (match == null) return null;
  int part(int group) => int.parse(match[group] ?? '0');
  final year = part(1), month = part(2), day = part(3);
  final hour = part(4), minute = part(5), second = part(6);
  final fraction = (match[7] ?? '').padRight(6, '0').substring(0, 6);
  final micros = int.parse(fraction);
  final date = DateTime.utc(
      year, month, day, hour, minute, second, micros ~/ 1000, micros % 1000);
  // DateTime.utc rolls invalid dates over (month 13 is next January).
  if (date.year != year ||
      date.month != month ||
      date.day != day ||
      date.hour != hour ||
      date.minute != minute ||
      date.second != second) {
    return null;
  }
  final zone = match[8];
  if (zone == null || zone == 'Z' || zone == 'z') return date;
  final digits = zone.substring(1).replaceAll(':', '');
  final hours = int.parse(digits.substring(0, 2));
  final minutes = digits.length > 2 ? int.parse(digits.substring(2)) : 0;
  final offset = Duration(hours: hours, minutes: minutes);
  return zone.startsWith('-') ? date.add(offset) : date.subtract(offset);
}

/// A nested object, parsed with [parse].
T? readModel<T>(Object? value, T Function(Map<String, Object?>) parse) {
  final object = readObject(value);
  return object == null ? null : parse(object);
}

/// A list of nested objects, parsed with [parse]. Entries that aren't
/// objects are skipped.
List<T>? readModels<T>(
  Object? value,
  T Function(Map<String, Object?>) parse,
) {
  if (value is! List) return null;
  return List.unmodifiable([
    for (final item in value)
      if (readObject(item) case final object?) parse(object),
  ]);
}
