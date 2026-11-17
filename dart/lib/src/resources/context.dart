/// What the resource classes share: building requests from operations, and
/// parsing results. Internal.
library;

import 'dart:convert';
import 'dart:typed_data';

import '../client.dart';
import '../core/idempotency.dart';
import '../errors.dart';
import '../models/base.dart';
import '../models/enums.dart';
import '../models/text_to_speech.dart' show DeleteResult;
import '../operations.dart';
import '../pagination.dart';
import '../polling.dart';
import '../response.dart';
import '../runtime.dart';
import '../transport/http_transport.dart';

/// Parses a model from a JSON object.
typedef FromJson<T> = T Function(
  Map<String, Object?> json, {
  String? requestId,
});

/// What a resource needs from its client. Internal.
final class ClientContext {
  /// Creates a context.
  ClientContext({
    required this.client,
    required this.transport,
    required this.runtime,
    required this.pollLimiter,
  });

  /// The client the resources belong to.
  final EchoNova client;

  /// Sends the requests.
  final HttpTransport transport;

  /// Clocks and sleeps.
  final ClientRuntime runtime;

  /// The polling budget shared by every `wait`.
  final PollLimiter pollLimiter;

  /// The request for [operation].
  ///
  /// An operation that accepts an `Idempotency-Key` gets one: the caller's
  /// ([RequestOptions.idempotencyKey], or an `Idempotency-Key` header in
  /// [RequestOptions.headers]), otherwise a new random one. It is created
  /// here, once per call, so every retry of the call sends the same key.
  /// Such a call also gets its [WaitBudget]: [RequestOptions.waitTimeout],
  /// within what is left of the call's total deadline.
  ApiRequest request(
    Operation operation, {
    Map<String, String> path = const {},
    Map<String, String> query = const {},
    Object? json,
    Map<String, String>? form,
    MultipartUpload? upload,
    RequestOptions? options,
  }) {
    _check(operation, options);
    var headers = options?.headers ?? const <String, String>{};
    String? idempotencyKey;
    WaitBudget? waitBudget;
    if (operation.acceptsIdempotencyKey) {
      final deadline = options?.deadline ?? transport.deadline;
      waitBudget = WaitBudget(
        options?.waitTimeout ?? defaultWaitTimeout,
        deadlineAt: deadline == null ? null : runtime.clock() + deadline,
      );
      final fromHeader = headers.entries
          .where((h) => h.key.toLowerCase() == _idempotencyHeader)
          .map((h) => h.value)
          .firstOrNull;
      headers = _withoutIdempotencyKey(headers);
      idempotencyKey = options?.idempotencyKey ??
          (fromHeader == null ? null : checkIdempotencyKey(fromHeader)) ??
          newIdempotencyKey();
    }
    return ApiRequest(
      method: operation.method,
      path: operation.expand(path),
      query: query,
      body: json == null ? null : utf8.encode(jsonEncode(json)),
      contentType: json == null ? null : 'application/json',
      form: form,
      upload: upload,
      headers: headers,
      bucket: operation.name,
      timeoutProfile: operation.profile,
      timeout: options?.timeout,
      maxRetries: options?.maxRetries,
      deadline: options?.deadline,
      expectEnvelope: operation.envelope,
      secretResponse: operation.secretResponse,
      idempotencyKey: idempotencyKey,
      waitBudget: waitBudget,
    );
  }

  static const _idempotencyHeader = 'idempotency-key';

  static Map<String, String> _withoutIdempotencyKey(
    Map<String, String> headers,
  ) =>
      {
        for (final MapEntry(:key, :value) in headers.entries)
          if (key.toLowerCase() != _idempotencyHeader) key: value,
      };

  static void _check(Operation operation, RequestOptions? options) {
    if (options == null) return;
    if (options.idempotencyKey case final key?) {
      if (!operation.acceptsIdempotencyKey) {
        throw ArgumentError.value(
          key,
          'idempotencyKey',
          '${operation.name} does not accept one; only '
              'textToSpeech.generate, speechToText.transcribe and '
              'soundCleaning.clean do',
        );
      }
      checkIdempotencyKey(key);
    }
    final waitTimeout = options.waitTimeout;
    if (waitTimeout != null && waitTimeout.isNegative) {
      throw ArgumentError.value(
          waitTimeout, 'waitTimeout', 'must not be negative');
    }
    final maxRetries = options.maxRetries;
    if (maxRetries != null && maxRetries < 0) {
      throw ArgumentError.value(maxRetries, 'maxRetries', 'must be >= 0');
    }
    final timeout = options.timeout;
    if (timeout != null && timeout <= Duration.zero) {
      throw ArgumentError.value(timeout, 'timeout', 'must be positive');
    }
    final deadline = options.deadline;
    if (deadline != null && deadline <= Duration.zero) {
      throw ArgumentError.value(deadline, 'deadline', 'must be positive');
    }
  }

  /// Sends [request] and parses the result.
  Future<T> call<T>(ApiRequest request, T Function(ApiResponse) parse) =>
      transport.perform(request, parse);

  /// Sends [request] and returns the raw response; [parse] runs on
  /// [RawResponse.parse].
  Future<RawResponse<T>> callRaw<T>(
    ApiRequest request,
    T Function(ApiResponse) parse,
  ) =>
      transport.perform(request, (response) => newRawResponse(response, parse));

  /// Sends a call that may answer `202 Processing` (an operation that
  /// accepts an `Idempotency-Key`) and parses the result. After a `202`, it
  /// waits for the job as [job] says, within the request's [WaitBudget],
  /// and returns the same type, built from the job.
  Future<T> callSync<T, J extends Object>(
    ApiRequest request,
    T Function(ApiResponse) parse,
    SyncJob<T, J> job,
  ) =>
      _performSync(
        request,
        parse,
        job,
        (polled, _) => job.toResult(polled),
      );

  /// [callSync], returning the raw response: the call's, or after a `202`,
  /// the last poll's, which [RawResponse.parse] turns into the result.
  Future<RawResponse<T>> callSyncRaw<T, J extends Object>(
    ApiRequest request,
    T Function(ApiResponse) parse,
    SyncJob<T, J> job,
  ) =>
      _performSync(
        request,
        (response) => newRawResponse(response, parse),
        job,
        (_, response) => newRawResponse(
          response,
          (response) => job.toResult(job.parse(response)),
        ),
      );

  Future<R> _performSync<R, T, J extends Object>(
    ApiRequest request,
    R Function(ApiResponse response) finish,
    SyncJob<T, J> job,
    R Function(J polled, ApiResponse response) finishJob,
  ) async {
    String? processing;
    final result = await transport.perform<R?>(request, (response) {
      if (response.statusCode != 202) return finish(response);
      // Read here, so a malformed 202 is handled like any malformed 2xx.
      processing = requireString(
        jsonObject(response.data, 'the 202 Processing response'),
        'jobId',
        'the 202 Processing response',
      );
      return null;
    });
    final jobId = processing;
    if (jobId == null) return result as R;

    // Polls carry the call's key only to report it on their exceptions.
    final poll = ApiRequest(
      method: job.get.method,
      path: job.get.expand({'jobId': jobId}),
      headers: request.headers,
      bucket: job.get.name,
      timeoutProfile: job.get.profile,
      expectEnvelope: job.get.envelope,
      idempotencyKey: request.idempotencyKey,
    );
    // The budget the in-progress wait may have started, within the deadline.
    final now = runtime.clock();
    final budget = request.waitBudget ?? WaitBudget(defaultWaitTimeout);
    final left = budget.endsAt(now) - now;
    late ApiResponse last;
    final done = await waitForJob<J>(
      jobId: jobId,
      get: () => transport.perform(poll, (response) {
        final polled = job.parse(response);
        last = response;
        return polled;
      }),
      statusOf: job.statusOf,
      errorOf: job.errorOf,
      interval: job.interval,
      timeout: left.isNegative ? Duration.zero : left,
      raiseOnFailure: true,
      limiter: pollLimiter,
      bucket: job.get.name,
      runtime: runtime,
    );
    return finishJob(done, last);
  }

  /// Downloads a signed link without credentials.
  Future<Uint8List> download(String url) => client.download(url);

  /// Downloads a signed link to a file.
  Future<String> downloadTo(String url, String path) =>
      client.downloadTo(url, path);
}

/// How a synchronous call waits for its job after `202 Processing`: the job
/// is polled with the jobs `get` operation, sharing the client's polling
/// budget with `jobs.wait`, until it completes or fails.
final class SyncJob<T, J extends Object> {
  /// Describes the wait.
  const SyncJob({
    required this.get,
    required this.parse,
    required this.statusOf,
    required this.errorOf,
    required this.interval,
    required this.toResult,
  });

  /// The jobs `get` operation.
  final Operation get;

  /// Parses a polled job.
  final J Function(ApiResponse) parse;

  /// The job's status.
  final JobStatus Function(J job) statusOf;

  /// Why the job failed.
  final String? Function(J job) errorOf;

  /// How often to poll.
  final Duration interval;

  /// The result a `200` would have returned, from the completed job.
  final T Function(J job) toResult;
}

/// The JSON of a synchronous call's result, from its job: the job's JSON
/// with `jobId`, which the result names the job by.
Map<String, Object?> syncResultJson(String jobId, Map<String, Object?> job) =>
    {'jobId': jobId, ...job};

/// A parser for a JSON-object result.
T Function(ApiResponse) modelParser<T>(FromJson<T> fromJson, String name) =>
    (response) => fromJson(
          jsonObject(response.data, name),
          requestId: response.requestId,
        );

/// Parses a delete result, noting when a retry found the job gone.
DeleteResult parseDelete(ApiResponse response) => DeleteResult.fromJson(
      jsonObject(response.data, 'DeleteResult'),
      requestId: response.requestId,
      alreadyDeleted: response.alreadyDeleted,
    );

/// A parser for one page of a job list.
Page<T> Function(ApiResponse) pageParser<T>(
  FromJson<T> fromJson,
  String name, {
  required int? offset,
  required int? limit,
  required Future<Page<T>> Function(int offset) fetch,
}) =>
    (response) {
      final data = jsonObject(response.data, 'a list of $name');
      final items = data['items'];
      if (items is! List) {
        throw const FormatException('expected a list result with items');
      }
      return newPage(
        items: [
          for (final item in items)
            fromJson(jsonObject(item, name), requestId: response.requestId),
        ],
        total: readInt(data['total']),
        offset: offset ?? 0,
        limit: limit,
        requestId: response.requestId,
        raw: data,
        fetch: fetch,
      );
    };

/// The `offset` and `limit` query, with only the values that were set.
Map<String, String> pageQuery(int? offset, int? limit) {
  if (offset != null && offset < 0) {
    throw ArgumentError.value(offset, 'offset', 'must be >= 0');
  }
  if (limit != null && limit < 1) {
    throw ArgumentError.value(limit, 'limit', 'must be >= 1');
  }
  return {
    if (offset != null) 'offset': '$offset',
    if (limit != null) 'limit': '$limit',
  };
}

/// Only the values that were set: the API applies its default to a field
/// that is missing.
Map<String, Object> compact(Map<String, Object?> values) => {
      for (final MapEntry(:key, :value) in values.entries)
        if (value != null) key: value,
    };

/// A multipart field value, the way the API reads it.
String formValue(Object value) => switch (value) {
      final bool flag => flag ? 'true' : 'false',
      final double number
          when number == number.roundToDouble() && number.isFinite =>
        number.toInt().toString(),
      _ => '$value',
    };

/// The signed link of a finished job, or why there is none.
String requireDownloadUrl({
  required String jobId,
  required String status,
  required String? url,
  required String? error,
  required Object job,
}) {
  if (status == 'failed') {
    throw JobFailedException(
      'Job $jobId failed: ${error ?? 'no error message'}',
      job: job,
    );
  }
  if (url == null || url.isEmpty) {
    throw UsageException(
      'Job $jobId has no audio yet (status $status); call wait first',
    );
  }
  return url;
}
