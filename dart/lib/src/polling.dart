/// `jobs.wait` and `jobs.findCandidates`.
library;

import 'dart:collection';

import 'errors.dart';
import 'models/enums.dart';
import 'pagination.dart';
import 'runtime.dart';

/// The documented polling interval for Text to Speech jobs.
const Duration ttsPollInterval = Duration(seconds: 3);

/// The documented polling interval for Speech to Text jobs.
const Duration sttPollInterval = Duration(seconds: 5);

/// The API asks clients not to poll faster than this.
const Duration minPollInterval = Duration(seconds: 1);

/// How long `wait` polls by default: longer than the 15 minutes the API
/// allows a job.
const Duration defaultWaitTimeout = Duration(minutes: 20);

/// Polls per minute per job-get endpoint, shared by every `wait` on one
/// client: below the API's 100 per minute, so other calls still fit.
const int pollRate = 80;

/// `findCandidates` looks at jobs created from this long before `sentAt`.
const Duration candidateWindow = Duration(seconds: 5);

/// `findCandidates` reads at most this many pages of 100.
const int candidateMaxPages = 10;

/// A sliding-window limit shared by every `wait` on one client, so many
/// waiters can't exhaust a key's rate limit.
final class PollLimiter {
  /// Creates a limiter allowing [rate] polls per [period] per bucket.
  PollLimiter({
    required Duration Function() clock,
    this.rate = pollRate,
    this.period = const Duration(minutes: 1),
  }) : _clock = clock;

  /// Polls allowed per [period].
  final int rate;

  /// The window.
  final Duration period;

  final Duration Function() _clock;
  final Map<String, ListQueue<Duration>> _slots = {};

  /// Reserves the next free slot in [bucket] and returns how long to wait
  /// for it.
  Duration reserve(String bucket) {
    final now = _clock();
    final slots = _slots.putIfAbsent(bucket, ListQueue.new);
    while (slots.length > rate && slots.first <= now - period) {
      slots.removeFirst();
    }
    var at = slots.isEmpty || slots.last < now ? now : slots.last;
    if (slots.length >= rate) {
      final freed = slots.elementAt(slots.length - rate) + period;
      if (freed > at) at = freed;
    }
    slots.addLast(at);
    return at - now;
  }
}

/// Checks a `pollInterval` argument.
Duration checkPollInterval(Duration? interval, Duration fallback) {
  if (interval == null) return fallback;
  if (interval < minPollInterval) {
    throw UsageException(
      'pollInterval must be at least 1 s; the API asks clients not to poll '
      'faster',
    );
  }
  return interval;
}

bool _isTransient(EchoNovaException error) =>
    error is APIConnectionException ||
    error is RateLimitException ||
    error is RequestTimeoutException ||
    error is ServerException ||
    error is ProtocolException;

/// Polls [get] until the job completes or fails.
Future<J> waitForJob<J extends Object>({
  required String jobId,
  required Future<J> Function() get,
  required JobStatus Function(J job) statusOf,
  required String? Function(J job) errorOf,
  required Duration interval,
  required Duration timeout,
  required bool raiseOnFailure,
  required PollLimiter limiter,
  required String bucket,
  required ClientRuntime runtime,
}) async {
  if (timeout.isNegative) {
    throw UsageException('timeout must not be negative');
  }
  final clock = runtime.clock;
  final deadline = clock() + timeout;
  J? lastJob;
  EchoNovaException? lastError;

  JobWaitTimeoutException giveUp() {
    final status = lastJob == null ? 'unknown' : '${statusOf(lastJob)}';
    return JobWaitTimeoutException(
      'Job $jobId is still $status after ${timeout.inSeconds} s; calling '
      'wait again is safe',
      jobId: jobId,
      lastJob: lastJob,
      cause: lastError,
    );
  }

  while (true) {
    final delay = limiter.reserve(bucket);
    if (delay > Duration.zero) {
      if (clock() + delay > deadline) throw giveUp();
      await runtime.sleep(delay);
    }
    var pause = interval * (0.9 + 0.2 * runtime.random());
    if (pause < minPollInterval) pause = minPollInterval;
    try {
      final job = await get();
      lastJob = job;
      lastError = null;
      final status = statusOf(job);
      if (status == JobStatus.completed) return job;
      if (status == JobStatus.failed) {
        if (!raiseOnFailure) return job;
        throw JobFailedException(
          'Job $jobId failed: ${errorOf(job) ?? 'no error message'}',
          job: job,
        );
      }
    } on EchoNovaException catch (error) {
      if (error is JobFailedException || !_isTransient(error)) rethrow;
      lastError = error;
      if (error case RateLimitException(:final retryAfter?)) {
        if (retryAfter > pause) pause = retryAfter;
      }
    }
    if (clock() + pause > deadline) throw giveUp();
    await runtime.sleep(pause);
  }
}

/// Jobs created at or after [sentAt] minus 5 s, newest first, optionally
/// with the same text. Never picks one for you. Jobs made on a stream are
/// skipped: a lost REST request never made one.
Future<List<J>> findJobCandidates<J>({
  required Future<Page<J>> Function(int offset) listPage,
  required DateTime sentAt,
  required String Function(J job) idOf,
  required DateTime? Function(J job) createdAtOf,
  required bool Function(J job) fromStream,
  String? text,
  String? Function(J job)? textOf,
}) async {
  final earliest = sentAt.toUtc().subtract(candidateWindow);
  final wanted = text?.trim();
  final found = <J>[];
  final seen = <String>{};
  var offset = 0;
  for (var pages = 0; pages < candidateMaxPages; pages++) {
    final page = await listPage(offset);
    var reachedOlder = false;
    for (final job in page.items) {
      final createdAt = createdAtOf(job);
      if (createdAt == null) continue;
      if (createdAt.isBefore(earliest)) {
        reachedOlder = true;
        continue;
      }
      if (fromStream(job) || !seen.add(idOf(job))) continue;
      if (wanted != null && (textOf?.call(job) ?? '').trim() != wanted) {
        continue;
      }
      found.add(job);
    }
    if (reachedOlder || !page.hasNextPage) break;
    offset = page.nextOffset;
  }
  return found;
}
