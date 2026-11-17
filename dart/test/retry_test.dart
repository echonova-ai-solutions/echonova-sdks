import 'package:echonova_ai/src/core/retry.dart';
import 'package:echonova_ai/src/core/rules.dart';
import 'package:test/test.dart';

RetryPolicy policy({int? maxRetries}) =>
    RetryPolicy(maxRetries: maxRetries, random: () => 0.5);

ErrorRule rule(String id) => errorRules.ruleById(id)!;

Duration seconds(num value) =>
    Duration(microseconds: (value * Duration.microsecondsPerSecond).round());

void main() {
  group(
      'the safety invariant: a POST without an Idempotency-Key that may '
      'have run is never retried', () {
    for (final r in errorRules.rules) {
      test(r.id, () {
        for (final retryAfter in [null, Duration.zero, seconds(1)]) {
          final decision = policy().decideStatus(
            'POST',
            r,
            retriesDone: 0,
            retryAfter: retryAfter,
          );
          if (r.mayHaveExecuted != Executed.no) {
            expect(decision.retry, isFalse);
          }
        }
      });
    }
    for (final phase in FailurePhase.values) {
      test(phase.key, () {
        final decision =
            policy().decideTransport('POST', phase, retriesDone: 0);
        if (decision.mayHaveExecuted != Executed.no) {
          expect(decision.retry, isFalse);
        }
      });
    }
  });

  group('POST_IDEMPOTENT: a POST with an Idempotency-Key', () {
    for (final (id, retry) in [
      ('internal_error', true),
      ('bad_gateway', true),
      ('unavailable_other', true),
      ('ingress_unavailable', true),
      ('unavailable_refunded', true),
      ('gateway_timeout', true),
      ('ingress_timeout', true),
      ('throttled', true),
      ('request_timeout', true),
      ('idempotency_in_progress', true),
      ('same_request_starting', true),
      ('idempotency_key_reused', false),
      ('invalid_request', false),
      ('unauthorized', false),
      ('forbidden', false),
      ('insufficient_balance', false),
      ('spending_limit', false),
      ('server_error_other', false),
      ('client_error_other', false),
    ]) {
      test('$id -> $retry', () {
        final decision = policy().decideStatus(
          'POST',
          rule(id),
          retriesDone: 0,
          retryAfter: seconds(5),
          withIdempotencyKey: true,
        );
        expect(decision.retry, retry);
      });
    }

    test('the in-progress 409s are not retried without a key', () {
      for (final id in ['idempotency_in_progress', 'same_request_starting']) {
        final decision = policy()
            .decideStatus('POST', rule(id), retriesDone: 0, retryAfter: null);
        expect(decision.retry, isFalse, reason: id);
        expect(rule(id).mayHaveExecuted, Executed.yes, reason: id);
      }
    });

    test('the in-progress 409 waits Retry-After, or backs off', () {
      final r = rule('idempotency_in_progress');
      expect(
        policy()
            .decideStatus('POST', r,
                retriesDone: 0,
                retryAfter: seconds(3),
                withIdempotencyKey: true)
            .delay,
        seconds(3.5),
      );
      expect(
        policy()
            .decideStatus('POST', r,
                retriesDone: 1, retryAfter: null, withIdempotencyKey: true)
            .delay,
        seconds(0.75),
      );
    });

    for (final (phase, retry) in [
      (FailurePhase.connect, true),
      (FailurePhase.sendIncomplete, true),
      (FailurePhase.noResponse, true),
      (FailurePhase.malformedSuccess, true),
    ]) {
      test('${phase.key} -> $retry', () {
        final decision = policy().decideTransport('POST', phase,
            retriesDone: 0, withIdempotencyKey: true);
        expect(decision.retry, retry);
      });
    }

    test('a malformed success is retried once', () {
      expect(
        policy(maxRetries: 5)
            .decideTransport('POST', FailurePhase.malformedSuccess,
                retriesDone: 1, withIdempotencyKey: true)
            .retry,
        isFalse,
      );
    });

    test('the retry budget and unreplayable bodies still apply', () {
      final p = policy(maxRetries: 2);
      expect(
        p
            .decideStatus('POST', rule('internal_error'),
                retriesDone: 2, retryAfter: null, withIdempotencyKey: true)
            .reason,
        RetryReason.maxRetries,
      );
      expect(
        p
            .decideTransport('POST', FailurePhase.noResponse,
                retriesDone: 0, bodyReplayable: false, withIdempotencyKey: true)
            .reason,
        RetryReason.bodyNotReplayable,
      );
    });
  });

  group('status table', () {
    for (final (id, method, retry) in [
      ('throttled', 'POST', true),
      ('throttled', 'GET', true),
      ('spending_limit', 'GET', false),
      ('insufficient_balance', 'POST', false),
      ('unauthorized', 'GET', false),
      ('unavailable_refunded', 'POST', true),
      ('unavailable_other', 'POST', false),
      ('unavailable_other', 'GET', true),
      ('storage_delete_failed', 'DELETE', true),
      ('storage_delete_failed', 'GET', false),
      ('ingress_unavailable', 'POST', true),
      ('internal_error', 'POST', false),
      ('internal_error', 'GET', true),
      ('bad_gateway', 'POST', false),
      ('ingress_timeout', 'POST', false),
      ('ingress_timeout', 'DELETE', true),
      ('request_timeout', 'POST', true),
      ('invalid_request', 'GET', false),
    ]) {
      test('$id $method -> $retry', () {
        final decision = policy().decideStatus(
          method,
          rule(id),
          retriesDone: 0,
          retryAfter: seconds(5),
        );
        expect(decision.retry, retry);
      });
    }
  });

  test('a throttle waits Retry-After plus jitter', () {
    final decision = policy().decideStatus(
      'GET',
      rule('throttled'),
      retriesDone: 0,
      retryAfter: seconds(12),
    );
    expect(decision.retry, isTrue);
    expect(decision.delay, seconds(12.5));
  });

  test('a throttle without Retry-After is not retried', () {
    final decision = policy().decideStatus(
      'GET',
      rule('throttled'),
      retriesDone: 0,
      retryAfter: null,
    );
    expect(decision.retry, isFalse);
    expect(decision.reason, RetryReason.missingRetryAfter);
  });

  test('a 503 without Retry-After falls back to backoff', () {
    final decision = policy().decideStatus(
      'POST',
      rule('unavailable_refunded'),
      retriesDone: 0,
      retryAfter: null,
    );
    expect(decision.retry, isTrue);
    expect(decision.delay, seconds(0.375));
  });

  test('a Retry-After longer than the cap is not waited for', () {
    final decision = policy().decideStatus(
      'GET',
      rule('throttled'),
      retriesDone: 0,
      retryAfter: seconds(61),
    );
    expect(decision.retry, isFalse);
    expect(decision.reason, RetryReason.retryAfterTooLong);
  });

  test('max retries', () {
    final p = policy(maxRetries: 2);
    expect(
      p
          .decideStatus('GET', rule('internal_error'),
              retriesDone: 1, retryAfter: null)
          .retry,
      isTrue,
    );
    final decision = p.decideStatus('GET', rule('internal_error'),
        retriesDone: 2, retryAfter: null);
    expect(decision.retry, isFalse);
    expect(decision.reason, RetryReason.maxRetries);
  });

  test('an unreplayable body is not retried', () {
    final decision = policy().decideStatus(
      'POST',
      rule('unavailable_refunded'),
      retriesDone: 0,
      retryAfter: null,
      bodyReplayable: false,
    );
    expect(decision.retry, isFalse);
    expect(decision.reason, RetryReason.bodyNotReplayable);
  });

  group('transport phases', () {
    for (final (phase, method, retry, executed) in [
      (FailurePhase.connect, 'POST', true, Executed.no),
      (FailurePhase.sendIncomplete, 'POST', true, Executed.no),
      (FailurePhase.noResponse, 'POST', false, Executed.yes),
      (FailurePhase.noResponse, 'GET', true, Executed.yes),
      (FailurePhase.noResponse, 'DELETE', true, Executed.yes),
      (FailurePhase.malformedSuccess, 'POST', false, Executed.yes),
    ]) {
      test('${phase.key} $method', () {
        final decision =
            policy().decideTransport(method, phase, retriesDone: 0);
        expect(decision.retry, retry);
        expect(decision.mayHaveExecuted, executed);
      });
    }
  });

  test('a malformed success is retried once for GET', () {
    final p = policy(maxRetries: 5);
    expect(
      p
          .decideTransport('GET', FailurePhase.malformedSuccess, retriesDone: 0)
          .retry,
      isTrue,
    );
    expect(
      p
          .decideTransport('GET', FailurePhase.malformedSuccess, retriesDone: 1)
          .retry,
      isFalse,
    );
  });

  test('backoff grows and is capped', () {
    final top = RetryPolicy(random: () => 1.0);
    expect(
      [
        for (final n in [1, 2, 3, 4, 5, 6]) top.backoff(n)
      ],
      [
        for (final s in [0.5, 1.0, 2.0, 4.0, 8.0, 8.0]) seconds(s)
      ],
    );
    expect(RetryPolicy(random: () => 0.0).backoff(1), seconds(0.25));
  });

  test('the handshake concurrency limit needs opt-in', () {
    final r = rule('concurrent_streams');
    expect(
      policy().decideStatus('WS', r, retriesDone: 0, retryAfter: null).retry,
      isFalse,
    );
    expect(
      policy()
          .decideStatus('WS', r,
              retriesDone: 0, retryAfter: null, waitForSlot: true)
          .retry,
      isTrue,
    );
  });

  test('the handshake has a shorter Retry-After cap', () {
    final r = rule('throttled');
    expect(
      policy()
          .decideStatus('WS', r, retriesDone: 0, retryAfter: seconds(30))
          .retry,
      isTrue,
    );
    expect(
      policy()
          .decideStatus('WS', r, retriesDone: 0, retryAfter: seconds(31))
          .retry,
      isFalse,
    );
  });

  for (final id in [
    'unauthorized',
    'insufficient_balance',
    'spending_limit',
    'streaming_disabled',
  ]) {
    test('the handshake never retries $id', () {
      expect(
        policy()
            .decideStatus('WS', rule(id),
                retriesDone: 0, retryAfter: seconds(1))
            .retry,
        isFalse,
      );
    });
  }
}
