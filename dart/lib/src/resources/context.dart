/// What the resource classes share: building requests from operations, and
/// parsing results. Internal.
library;

import 'dart:convert';
import 'dart:typed_data';

import '../client.dart';
import '../errors.dart';
import '../models/base.dart';
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
  ApiRequest request(
    Operation operation, {
    Map<String, String> path = const {},
    Map<String, String> query = const {},
    Object? json,
    Map<String, String>? form,
    MultipartUpload? upload,
    RequestOptions? options,
  }) {
    _check(options);
    return ApiRequest(
      method: operation.method,
      path: operation.expand(path),
      query: query,
      body: json == null ? null : utf8.encode(jsonEncode(json)),
      contentType: json == null ? null : 'application/json',
      form: form,
      upload: upload,
      headers: options?.headers ?? const {},
      bucket: operation.name,
      timeoutProfile: operation.profile,
      timeout: options?.timeout,
      maxRetries: options?.maxRetries,
      deadline: options?.deadline,
      expectEnvelope: operation.envelope,
      secretResponse: operation.secretResponse,
    );
  }

  static void _check(RequestOptions? options) {
    if (options == null) return;
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

  /// Downloads a signed link without credentials.
  Future<Uint8List> download(String url) => client.download(url);

  /// Downloads a signed link to a file.
  Future<String> downloadTo(String url, String path) =>
      client.downloadTo(url, path);
}

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
