import 'package:echonova/echonova.dart';
import 'package:echonova/src/core/classifier.dart';
import 'package:echonova/src/core/rules.dart';
import 'package:test/test.dart';

import 'support/spec.dart';

/// `is` checks for every class, by its name in the shared taxonomy.
final predicates = <String, bool Function(Object)>{
  'EchoNovaError': (e) => e is EchoNovaException,
  'UsageError': (e) => e is UsageException,
  'SessionEndedError': (e) => e is SessionEndedException,
  'UnsupportedEnvironmentError': (e) => e is UnsupportedEnvironmentException,
  'APIConnectionError': (e) => e is APIConnectionException,
  'APITimeoutError': (e) => e is APITimeoutException,
  'StreamConnectionLostError': (e) => e is StreamConnectionLostException,
  'APIStatusError': (e) => e is APIStatusException,
  'InvalidRequestError': (e) => e is InvalidRequestException,
  'AuthenticationError': (e) => e is AuthenticationException,
  'PermissionDeniedError': (e) => e is PermissionDeniedException,
  'FeatureNotEnabledError': (e) => e is FeatureNotEnabledException,
  'NotFoundError': (e) => e is NotFoundException,
  'VoiceNotFoundError': (e) => e is VoiceNotFoundException,
  'JobNotFoundError': (e) => e is JobNotFoundException,
  'RequestTimeoutError': (e) => e is RequestTimeoutException,
  'BillingError': (e) => e is BillingException,
  'InsufficientBalanceError': (e) => e is InsufficientBalanceException,
  'SpendingLimitError': (e) => e is SpendingLimitException,
  'RateLimitError': (e) => e is RateLimitException,
  'ConcurrencyLimitError': (e) => e is ConcurrencyLimitException,
  'ServerError': (e) => e is ServerException,
  'ServiceUnavailableError': (e) => e is ServiceUnavailableException,
  'GatewayError': (e) => e is GatewayException,
  'UpstreamError': (e) => e is UpstreamException,
  'ProtocolError': (e) => e is ProtocolException,
  'StreamClosedError': (e) => e is StreamClosedException,
  'ServerRestartingError': (e) => e is ServerRestartingException,
  'SessionExpiredError': (e) => e is SessionExpiredException,
  'JobFailedError': (e) => e is JobFailedException,
  'JobWaitTimeoutError': (e) => e is JobWaitTimeoutException,
  'DownloadExpiredError': (e) => e is DownloadExpiredException,
  'WebhookVerificationError': (e) => e is WebhookVerificationException,
};

/// One instance of every concrete class.
final instances = <String, EchoNovaException>{
  'UsageError': UsageException('m'),
  'SessionEndedError': SessionEndedException('m'),
  'UnsupportedEnvironmentError': UnsupportedEnvironmentException('m'),
  'APIConnectionError': APIConnectionException('m'),
  'APITimeoutError': APITimeoutException('m', kind: TimeoutKind.read),
  'StreamConnectionLostError': StreamConnectionLostException('m'),
  for (final MapEntry(:key, :value) in statusExceptionFactories.entries)
    key: value(),
  'StreamClosedError': StreamClosedException('m'),
  'ServerRestartingError': ServerRestartingException('m'),
  'SessionExpiredError': SessionExpiredException('m'),
  'JobFailedError': JobFailedException('m', job: null),
  'JobWaitTimeoutError': JobWaitTimeoutException('m', jobId: 'j'),
  'DownloadExpiredError': DownloadExpiredException('m'),
  'WebhookVerificationError':
      WebhookVerificationException('m', reason: WebhookFailure.signature),
};

/// Sealed (abstract) classes, which have no instances.
const abstractClasses = {'EchoNovaError', 'BillingError'};

Set<String> lineage(Map<String, String?> taxonomy, String name) {
  final names = <String>{};
  String? current = name;
  while (current != null) {
    names.add(current);
    current = taxonomy[current];
  }
  return names;
}

/// Compiles only while the sealed hierarchies are exhaustive.
String topLevelFamily(EchoNovaException error) => switch (error) {
      UsageException() => 'usage',
      UnsupportedEnvironmentException() => 'environment',
      APIConnectionException() => 'connection',
      APIStatusException() => 'status',
      StreamClosedException() => 'stream',
      JobFailedException() => 'job',
      JobWaitTimeoutException() => 'wait',
      DownloadExpiredException() => 'download',
      WebhookVerificationException() => 'webhook',
    };

String billingKind(BillingException error) => switch (error) {
      InsufficientBalanceException() => 'balance',
      SpendingLimitException() => 'limit',
    };

void main() {
  final taxonomy = errorRules.taxonomy;

  test('the Dart classes are exactly the shared taxonomy', () {
    expect(predicates.keys.toSet(), taxonomy.keys.toSet());
    expect(
      instances.keys.toSet(),
      taxonomy.keys.toSet().difference(abstractClasses),
    );
  });

  test('every class has the parent the taxonomy gives it', () {
    for (final MapEntry(key: name, value: instance) in instances.entries) {
      final satisfied = {
        for (final MapEntry(:key, :value) in predicates.entries)
          if (value(instance)) key,
      };
      expect(satisfied, lineage(taxonomy, name), reason: name);
    }
  });

  test('class names are the taxonomy names with an Exception suffix', () {
    for (final MapEntry(key: name, value: instance) in instances.entries) {
      expect(exceptionName(instance), dartName(name));
    }
  });

  test('the compiled taxonomy matches the spec file', () {
    expect(
      taxonomy,
      (loadSpecMap('error-rules.json')['taxonomy']! as Map)
          .cast<String, String?>(),
    );
  });

  test('a spending limit is not a rate limit', () {
    final error = SpendingLimitException();
    expect(error, isNot(isA<RateLimitException>()));
    expect(error, isA<BillingException>());
    expect(billingKind(error), 'limit');
    expect(topLevelFamily(error), 'status');
  });

  test('status exceptions describe themselves', () {
    final error = RateLimitException(
      statusCode: 429,
      errorMessage: 'ThrottlerException: Too Many Requests',
      requestId: 'r-1',
    );
    expect(error.message,
        '429 ThrottlerException: Too Many Requests (request_id: r-1)');
    expect(
      ProtocolException(closeCode: 1008, errorCode: 'frame_too_large').message,
      'close 1008 [frame_too_large] no error message',
    );
  });

  test('headers are copied and read-only', () {
    final headers = {'a': 'b'};
    final error = APIStatusException(headers: headers);
    headers['a'] = 'changed';
    expect(error.headers, {'a': 'b'});
    expect(() => error.headers['x'] = 'y', throwsUnsupportedError);
  });

  test('defaults: nothing ran unless the SDK says otherwise', () {
    expect(APIConnectionException('m').mayHaveExecuted, isFalse);
    expect(APIStatusException().mayHaveExecuted, isFalse);
    expect(APIStatusException().transport, TransportKind.http);
  });
}
