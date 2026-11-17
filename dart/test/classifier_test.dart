import 'dart:convert';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:echonova_ai/src/core/classifier.dart';
import 'package:echonova_ai/src/core/rules.dart';
import 'package:test/test.dart';

import 'support/spec.dart';

const catchAlls = {
  'client_error_other',
  'server_error_other',
  'rate_limited_other'
};

/// Which error family each documented status must land in.
final family = <int, bool Function(Object)>{
  400: (e) => e is InvalidRequestException,
  401: (e) => e is AuthenticationException,
  402: (e) => e is InsufficientBalanceException,
  403: (e) => e is PermissionDeniedException,
  404: (e) => e is NotFoundException,
  409: (e) =>
      e is InvalidRequestException || // including a reused Idempotency-Key
      e is ConcurrencyLimitException || // agent limits
      e is RequestInProgressException, // a request with the key still runs
  413: (e) => e is InvalidRequestException,
  415: (e) => e is InvalidRequestException,
  429: (e) => e is RateLimitException || e is SpendingLimitException,
  500: (e) => e is ServerException,
  503: (e) => e is ServiceUnavailableException,
  504: (e) => e is GatewayException,
};

(Map<String, String>, List<int>) response(Map<String, Object?> vector) {
  final headers = {
    'X-Request-Id': 'req-123',
    'Content-Type': 'application/json',
    if (vector['retry_after']! as bool) 'Retry-After': '30',
  };
  final status = vector['status']! as int;
  if (vector['json']! as bool) {
    return (headers, envelope(status, vector['message'] as String?));
  }
  headers['Content-Type'] = 'text/plain';
  return (headers, utf8.encode('upstream request timeout'));
}

void main() {
  final rules = loadSpecMap('error-rules.json');
  final catalog = maps(loadSpecMap('fixtures/errors/catalog.json')['entries']);

  group('rules vectors', () {
    for (final vector in maps(rules['vectors'])) {
      final status = vector['status']! as int;
      test('$status ${vector['expect_rule']}', () {
        final (headers, body) = response(vector);
        final (:rule, retryAfter: _) = classifyResponse(status, headers, body);
        expect(rule.id, vector['expect_rule']);
        final error = buildStatusError(status, headers, body, method: 'POST');
        expect(
            exceptionName(error), dartName(vector['expect_error']! as String));
        expect(error.rule, vector['expect_rule']);
        expect(error.requestId, 'req-123');
        expect(error.statusCode, status);
      });
    }
  });

  group('every documented error has a specific rule', () {
    for (final entry in catalog) {
      final status = entry['status']! as int;
      final message = entry['error_message']! as String;
      final docs = (entry['envelope']! as Map)['docs'] as String?;
      test('${entry['operation_id']} $status ${entry['example']}', () {
        final headers = {
          'X-Request-Id': 'req-1',
          // The docs: a throttle 429 carries Retry-After, the spending 429
          // doesn't.
          if (status == 429 && message != 'Monthly spending limit exhausted')
            'Retry-After': '12',
        };
        final body = envelope(status, message, {'docs': docs});
        final (:rule, retryAfter: _) = classifyResponse(status, headers, body);
        expect(catchAlls, isNot(contains(rule.id)),
            reason: 'documented error falls through to ${rule.id}');
        final error = buildStatusError(
          status,
          headers,
          body,
          method: entry['method']! as String,
        );
        expect(family[status]!(error), isTrue, reason: exceptionName(error));
        expect(error.errorMessage, message); // verbatim, commas included
        expect(error.docsUrl, docs);
      });
    }
  });

  test('the idempotency 409s', () {
    for (final (message, rule, matcher) in [
      (
        'This Idempotency-Key was already used for a different request.',
        'idempotency_key_reused',
        isA<InvalidRequestException>(),
      ),
      (
        'A request with this Idempotency-Key is still running.',
        'idempotency_in_progress',
        isA<RequestInProgressException>(),
      ),
      (
        'The same request is still being started. Send it again in a few '
            'seconds.',
        'same_request_starting',
        isA<RequestInProgressException>(),
      ),
    ]) {
      final error = buildStatusError(
        409,
        {'x-request-id': 'r-409'},
        envelope(409, message),
        method: 'POST',
        idempotencyKey: 'key-1',
      );
      expect(error, matcher, reason: rule);
      expect(error, isNot(isA<ConcurrencyLimitException>()));
      expect(error.rule, rule);
      expect(error.idempotencyKey, 'key-1');
      expect(error.mayHaveExecuted,
          rule == 'idempotency_key_reused' ? isFalse : isTrue);
    }
    // Other 409s are unchanged.
    expect(
      buildStatusError(409, const {}, envelope(409, 'Conflict'),
          method: 'POST'),
      isA<InvalidRequestException>()
          .having((e) => e.idempotencyKey, 'idempotencyKey', isNull),
    );
  });

  test('error code and message are surfaced', () {
    final body = envelope(400, 'The file is not valid.', {
      'errorCode': 'example_code',
    });
    final error =
        buildStatusError(400, {'x-request-id': 'r-9'}, body, method: 'POST');
    expect(error, isA<InvalidRequestException>());
    expect(error.errorCode, 'example_code');
    expect(error.message,
        '400 [example_code] The file is not valid. (request_id: r-9)');
    expect(
        error.toString(),
        'InvalidRequestException: 400 [example_code] The file is not valid. '
        '(request_id: r-9)');
  });

  test('a non-JSON proxy timeout may have executed', () {
    final error = buildStatusError(
      504,
      {'content-type': 'text/plain'},
      utf8.encode('upstream request timeout'),
      method: 'POST',
    );
    expect(error, isA<GatewayException>());
    expect(error.fromProxy, isTrue);
    expect(error.mayHaveExecuted, isTrue);
    expect(error.errorMessage, 'upstream request timeout');
  });

  for (final (method, expected) in [
    ('POST', null),
    ('GET', false),
    ('DELETE', false),
    ('WS', false),
  ]) {
    test('mayHaveExecuted for $method is $expected', () {
      final error = buildStatusError(
        500,
        const {},
        envelope(500, 'Something went wrong'),
        method: method,
      );
      expect(error.mayHaveExecuted, expected);
    });
  }

  test('executedFlag only applies to POST', () {
    expect(executedFlag(Executed.yes, 'post'), isTrue);
    expect(executedFlag(Executed.unknown, 'POST'), isNull);
    expect(executedFlag(Executed.no, 'POST'), isFalse);
    expect(executedFlag(Executed.yes, 'GET'), isFalse);
  });

  test('a throttle carries Retry-After', () {
    final error = buildStatusError(
      429,
      {'Retry-After': '17'},
      envelope(429, 'ThrottlerException: Too Many Requests'),
      method: 'GET',
    );
    expect(error, isA<RateLimitException>());
    expect(error.retryAfter, const Duration(seconds: 17));
  });

  test('an empty body uses the reason phrase', () {
    final error = buildStatusError(502, const {}, const [],
        method: 'GET', reasonPhrase: 'Bad Gateway');
    expect(error, isA<GatewayException>());
    expect(error.errorMessage, 'Bad Gateway');
  });

  test('the WebSocket transport is recorded', () {
    final error = buildStatusError(
      401,
      {'X-Request-Id': 'abc'},
      envelope(401, 'Unauthorized'),
      method: 'WS',
      transport: TransportKind.websocket,
    );
    expect(error.transport, TransportKind.websocket);
    expect(error.mayHaveExecuted, isFalse);
    expect(error.headers, {'X-Request-Id': 'abc'});
  });

  test('every rule maps to a concrete status exception', () {
    for (final rule in errorRules.rules) {
      expect(statusExceptionFactories, contains(rule.error), reason: rule.id);
    }
  });
}
