/// `Idempotency-Key` values (ADR 0014): a new random key per call, or the
/// caller's own.
library;

import 'dart:math' as math;

math.Random? _source;

/// A secure source of randomness where the platform has one.
math.Random _random() => _source ??= () {
      try {
        return math.Random.secure();
      } on UnsupportedError {
        // Keys only need to be unique, not secret.
        return math.Random();
      }
    }();

/// A new random UUID (version 4), such as
/// `3b241101-e2bb-4255-8caf-4136c566a962`. [random] is for tests.
String newIdempotencyKey([math.Random? random]) {
  final source = random ?? _random();
  final bytes = [for (var i = 0; i < 16; i++) source.nextInt(256)];
  bytes[6] = bytes[6] & 0x0f | 0x40; // version 4
  bytes[8] = bytes[8] & 0x3f | 0x80; // the RFC 9562 variant
  final hex = [
    for (final byte in bytes) byte.toRadixString(16).padLeft(2, '0'),
  ].join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// Checks a key the caller chose: it is sent as a header, so it must be
/// printable ASCII, without surrounding spaces. Throws [ArgumentError].
String checkIdempotencyKey(String key) {
  final printable = key.codeUnits.every((c) => c >= 0x20 && c <= 0x7e);
  if (key.isEmpty || !printable || key.trim() != key) {
    throw ArgumentError.value(
      key,
      'idempotencyKey',
      'must be non-empty printable ASCII without surrounding spaces',
    );
  }
  return key;
}
