/// Shared helpers for the live suite in `test/live/`.
///
/// The live suite calls the real EchoNova API. It runs nightly and before
/// releases, with a key from a dedicated test workspace whose Credit Limit
/// caps the spending:
///
///     cd dart && ECHONOVA_LIVE=1 dart test -t live
///
/// Every test is skipped unless `ECHONOVA_LIVE=1`. The variables are the ones
/// `tools/record/record.py` uses:
///
/// * `ECHONOVA_API_KEY`: a full-access test key with a Credit Limit. Tests
///   that need it are skipped without it; the tests with a made-up key still
///   run (they are free).
/// * `ECHONOVA_TTS_ONLY_KEY`: a key limited to Text to Speech (optional).
/// * `ECHONOVA_DISABLED_KEY`: a disabled key (optional).
/// * `ECHONOVA_AGENT_ID`: an agent in the test workspace (optional).
/// * `ECHONOVA_WIDGET_PUBLIC_ID`: a private widget (optional).
/// * `ECHONOVA_BASE_URL`: defaults to https://api.echonova.ai.
///
/// A full run costs a few hundred credits. Every job a test creates is
/// deleted after it. The suite prints request IDs and durations only: never
/// keys, tickets, room tokens, signed links or response bodies.
library;

import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:test/test.dart';

/// The full-access test key.
const apiKeyVar = 'ECHONOVA_API_KEY';

/// A key limited to Text to Speech.
const ttsOnlyKeyVar = 'ECHONOVA_TTS_ONLY_KEY';

/// A disabled key.
const disabledKeyVar = 'ECHONOVA_DISABLED_KEY';

/// An agent in the test workspace.
const agentIdVar = 'ECHONOVA_AGENT_ID';

/// A private widget in the test workspace.
const widgetIdVar = 'ECHONOVA_WIDGET_PUBLIC_ID';

/// A key no workspace has. Requests with it are rejected before anything
/// runs, so they cost nothing.
const madeUpKey = 'ek_REDACTED_dart_live_suite_made_up_key_0000';

/// The time limit for a test of a few quick requests.
const quick = Timeout(Duration(minutes: 1));

/// The time limit for a test that waits for jobs or streams audio.
const slow = Timeout(Duration(minutes: 5));

/// Whether the live suite runs at all.
final bool liveEnabled = Platform.environment['ECHONOVA_LIVE'] == '1';

/// The environment variable [name], or `null` when it is unset or blank.
String? env(String name) {
  final value = Platform.environment[name]?.trim();
  return value == null || value.isEmpty ? null : value;
}

/// The `skip:` value for a live test that needs the variables in [needs]:
/// `false` when it can run, otherwise why it is skipped.
Object liveSkip([List<String> needs = const []]) {
  if (!liveEnabled) return 'live test: set ECHONOVA_LIVE=1 to run';
  final missing = [
    for (final name in needs)
      if (env(name) == null) name,
  ];
  return missing.isEmpty
      ? false
      : 'live test: set ${missing.join(' and ')} to run';
}

/// A client with the key in the environment variable [keyVar].
EchoNova liveClient([String keyVar = apiKeyVar]) {
  final key = env(keyVar);
  if (key == null) throw StateError('$keyVar is not set');
  return EchoNova(apiKey: key);
}

/// Prints a line of the run's log. Only request IDs, durations, counts and
/// other non-secret values go here.
void log(String message) {
  // ignore: avoid_print
  print('[live] $message');
}

/// Runs [call], which must throw an [E], and returns the exception.
Future<E> thrown<E extends EchoNovaException>(
  Future<Object?> Function() call,
) async {
  try {
    await call();
  } on E catch (error) {
    return error;
  }
  fail('expected $E, but the call succeeded');
}

/// The first English voice, or the first voice when there is none.
Voice pickVoice(VoiceList voices) => voices.firstWhere(
      (voice) => voice.language?.toLowerCase().startsWith('en') ?? false,
      orElse: () => voices.first,
    );

/// Whether [bytes] start like a WAV file.
bool looksLikeWav(List<int> bytes) =>
    bytes.length > 12 &&
    String.fromCharCodes(bytes.sublist(0, 4)) == 'RIFF' &&
    String.fromCharCodes(bytes.sublist(8, 12)) == 'WAVE';

/// The kinds of job a test can leave behind.
enum JobKind {
  /// A Text to Speech job.
  tts('Text to Speech'),

  /// A Speech to Text job.
  stt('Speech to Text'),

  /// A Sound Cleaning job.
  clean('Sound Cleaning');

  const JobKind(this.label);

  /// The product name, for the log.
  final String label;
}

/// Deletes the jobs a test created once they have finished, after the test,
/// whether it passed or not.
///
/// Create one per test and register [sweep] as its tear-down. [track] a job
/// as soon as its ID is known; [delete] deletes one now (for tests that
/// check deletion) and forgets it.
final class Janitor {
  /// A janitor for jobs made with [client].
  Janitor(this.client);

  /// The client the jobs were made with.
  final EchoNova client;

  final Set<(JobKind, String)> _jobs = {};
  final List<Future<void> Function()> _tasks = [];

  /// Deletes the job after the test, unless the test deleted it.
  void track(JobKind kind, String jobId) => _jobs.add((kind, jobId));

  /// Runs [task] after the test (for jobs found by other means).
  void later(Future<void> Function() task) => _tasks.add(task);

  /// Deletes a finished job now.
  Future<DeleteResult> delete(JobKind kind, String jobId) async {
    final result = await _delete(kind, jobId);
    _jobs.remove((kind, jobId));
    return result;
  }

  /// Deletes every job still tracked, waiting for unfinished ones first.
  /// Failures are logged, not thrown, so they don't hide the test's result.
  Future<void> sweep() async {
    final jobs = _jobs.toList();
    _jobs.clear();
    for (final (kind, id) in jobs) {
      try {
        await _deleteWhenFinished(kind, id);
      } on NotFoundException {
        // Already gone, or never saved.
      } on EchoNovaException catch (error) {
        log('cleanup: a ${kind.label} job was not deleted: '
            '${describe(error)}');
      }
    }
    final tasks = _tasks.toList();
    _tasks.clear();
    for (final task in tasks) {
      try {
        await task();
      } on EchoNovaException catch (error) {
        log('cleanup failed: ${describe(error)}');
      }
    }
  }

  Future<void> _deleteWhenFinished(JobKind kind, String id) async {
    try {
      await _delete(kind, id);
    } on InvalidRequestException {
      // Still running: a job can only be deleted once it has finished.
      const timeout = Duration(minutes: 2);
      switch (kind) {
        case JobKind.tts:
          await client.textToSpeech.jobs
              .wait(id, timeout: timeout, raiseOnFailure: false);
        case JobKind.stt:
          await client.speechToText.jobs
              .wait(id, timeout: timeout, raiseOnFailure: false);
        case JobKind.clean:
          rethrow;
      }
      await _delete(kind, id);
    }
  }

  Future<DeleteResult> _delete(JobKind kind, String id) => switch (kind) {
        JobKind.tts => client.textToSpeech.jobs.delete(id),
        JobKind.stt => client.speechToText.jobs.delete(id),
        JobKind.clean => client.soundCleaning.jobs.delete(id),
      };
}

/// Text to Speech stream syntheses are kept as jobs, but the stream doesn't
/// say their job IDs. Finds them among the newest jobs, by the synthesis's
/// request ID or, for `speakStream`, by their [texts], and deletes them.
Future<void> deleteTtsStreamJobs(
  EchoNova client, {
  required DateTime since,
  Set<String> requestIds = const {},
  Set<String> texts = const {},
}) async {
  final expected = requestIds.length + texts.length;
  final done = <String>{};
  for (var attempt = 0; attempt < 4 && done.length < expected; attempt++) {
    if (attempt > 0) await Future<void>.delayed(const Duration(seconds: 3));
    final page = await client.textToSpeech.jobs.list(limit: 50);
    for (final job in page.items) {
      final stream = job.stream;
      final createdAt = job.createdAt;
      if (stream == null ||
          done.contains(job.id) ||
          !job.status.isTerminal ||
          (createdAt != null && createdAt.isBefore(since))) {
        continue;
      }
      final ours = requestIds.contains(stream.synthesisRequestId) ||
          texts.contains(job.text?.trim());
      if (!ours) continue;
      try {
        await client.textToSpeech.jobs.delete(job.id);
      } on NotFoundException {
        // Deleted meanwhile.
      }
      done.add(job.id);
    }
  }
  log('cleanup: deleted ${done.length} of $expected Text to Speech stream '
      'jobs');
}

/// An exception's class, status and request ID, without its message (which
/// can quote the server's response).
String describe(EchoNovaException error) {
  final name = error.toString().split(':').first;
  return switch (error) {
    APIStatusException(:final statusCode, :final requestId) =>
      '$name (status $statusCode, request $requestId)',
    _ => name,
  };
}
