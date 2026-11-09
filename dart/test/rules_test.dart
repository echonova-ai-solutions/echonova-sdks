import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:echonova/src/core/rules.dart';
import 'package:test/test.dart';

import 'support/spec.dart';

/// A canonical description of a rule set, to compare two of them.
Map<String, Object?> describe(RuleSet rules) => {
      'version': rules.version,
      'taxonomy': rules.taxonomy,
      'rules': [
        for (final r in rules.rules)
          {
            'id': r.id,
            'row': r.row,
            'error': r.error,
            'retry': _retry(r.retry),
            'executed': r.mayHaveExecuted.name,
            'statuses': r.statuses?.toList(),
            'range': r.statusRange == null
                ? null
                : [r.statusRange!.$1, r.statusRange!.$2],
            'equals': r.messageEquals,
            'prefix': r.messagePrefix,
            'suffix': r.messageSuffix,
            'contains': r.messageContains,
            'json': r.json,
            'retryAfter': r.retryAfter,
            'blocksBucket': r.blocksBucket,
            'fromProxy': r.fromProxy,
          },
      ],
      'transport': {
        for (final MapEntry(:key, :value) in rules.transport.entries)
          key: {
            'row': value.row,
            'phase': value.phase,
            'error': value.error,
            'retry': _retry(value.retry),
            'executed': value.mayHaveExecuted.name,
          },
      },
      'defaults': [
        rules.defaults.maxRetries,
        rules.defaults.backoffInitialSeconds,
        rules.defaults.backoffMultiplier,
        rules.defaults.backoffMaxSeconds,
        rules.defaults.backoffJitter.$1,
        rules.defaults.backoffJitter.$2,
        rules.defaults.retryAfterJitterSeconds.$1,
        rules.defaults.retryAfterJitterSeconds.$2,
        rules.defaults.maxRetryAfterSeconds,
        rules.defaults.wsMaxRetryAfterSeconds,
      ],
    };

List<String> _retry(RetryColumns c) =>
    [c.get.name, c.delete.name, c.post.name, c.ws.name, c.delay.name];

void main() {
  final spec = loadSpecMap('error-rules.json');

  test('the compiled rules equal spec/error-rules.json', () {
    expect(describe(errorRules), describe(RuleSet.fromJson(spec)));
  });

  test('rules.g.dart was generated from the current spec file', () {
    final bytes = File('${specDir.path}/error-rules.json').readAsBytesSync();
    final digest = sha256.convert(bytes).toString().substring(0, 16);
    final generated = File('lib/src/core/rules.g.dart').readAsStringSync();
    expect(
      generated,
      contains('SHA-256 $digest'),
      reason: 'run python3 tools/gen_dart_rules.py',
    );
  });

  test('rule ids are unique and every rule names a taxonomy class', () {
    final ids = errorRules.rules.map((r) => r.id).toList();
    expect(ids.toSet(), hasLength(ids.length));
    for (final rule in errorRules.rules) {
      expect(errorRules.taxonomy, contains(rule.error), reason: rule.id);
      expect(rule.row, startsWith('R'), reason: rule.id);
    }
  });

  test('every 4xx and 5xx status classifies (the rules end with catch-alls)',
      () {
    for (var status = 400; status < 600; status++) {
      errorRules.classify(
        status,
        isJson: true,
        message: 'anything',
        hasRetryAfter: false,
      );
      errorRules.classify(
        status,
        isJson: false,
        message: null,
        hasRetryAfter: false,
      );
    }
  });

  test('statuses outside 4xx and 5xx have no rule', () {
    expect(
      () => errorRules.classify(
        302,
        isJson: false,
        message: null,
        hasRetryAfter: false,
      ),
      throwsStateError,
    );
  });

  test('messages are compared after trimming', () {
    final rule = errorRules.classify(
      429,
      isJson: true,
      message: '  Monthly spending limit exhausted\n',
      hasRetryAfter: false,
    );
    expect(rule.id, 'spending_limit');
  });

  test('retry columns treat unknown methods as POST', () {
    final throttled = errorRules.ruleById('internal_error')!;
    expect(throttled.retry.forMethod('get'), RetryFlag.yes);
    expect(throttled.retry.forMethod('HEAD'), RetryFlag.yes);
    expect(throttled.retry.forMethod('PATCH'), RetryFlag.no);
    expect(throttled.retry.forMethod('POST'), RetryFlag.no);
  });

  test('parsing rejects unknown values', () {
    expect(() => RetryFlag.fromJson('sometimes'), throwsFormatException);
    expect(() => RetryDelay.fromJson('later'), throwsFormatException);
    expect(() => Executed.fromJson('maybe'), throwsFormatException);
    expect(
      () => RetryColumns.fromJson({'GET': true}),
      throwsFormatException,
    );
  });
}
