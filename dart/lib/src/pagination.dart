/// Offset pagination for job lists.
///
/// Lists are newest first, so a job created while you page shifts later
/// pages by one. `listAll` skips IDs it has already returned.
library;

import 'errors.dart';

/// One page of results.
///
/// ```dart
/// var page = await client.speechToText.jobs.list(limit: 50);
/// while (true) {
///   for (final job in page.items) print(job.id);
///   if (!page.hasNextPage) break;
///   page = await page.nextPage();
/// }
/// ```
final class Page<T> {
  Page._({
    required this.items,
    required this.total,
    required this.offset,
    required this.limit,
    required this.requestId,
    required this.raw,
    required Future<Page<T>> Function(int offset) fetch,
  }) : _fetch = fetch;

  /// The items on this page.
  final List<T> items;

  /// The total number of items, as the API counted them.
  final int? total;

  /// How many items come before this page.
  final int offset;

  /// The page size that was asked for, or `null` for the API's default.
  final int? limit;

  /// The `X-Request-Id` of the response.
  final String? requestId;

  /// The API's JSON for the page, without parsing.
  final Map<String, Object?> raw;

  final Future<Page<T>> Function(int offset) _fetch;

  /// Whether there are more items after this page.
  bool get hasNextPage {
    if (items.isEmpty) return false;
    final total = this.total;
    if (total != null) return offset + items.length < total;
    final limit = this.limit;
    return limit != null && items.length >= limit;
  }

  /// The offset of the next page.
  int get nextOffset => offset + items.length;

  /// Fetches the next page. Throws [UsageException] when there is none:
  /// check [hasNextPage] first.
  Future<Page<T>> nextPage() {
    if (!hasNextPage) {
      throw UsageException(
        'There is no next page; check hasNextPage first.',
      );
    }
    return _fetch(nextOffset);
  }

  @override
  String toString() =>
      'Page(offset: $offset, items: ${items.length}, total: $total)';
}

/// Creates a page. Internal.
Page<T> newPage<T>({
  required List<T> items,
  required int? total,
  required int offset,
  required int? limit,
  required String? requestId,
  required Map<String, Object?> raw,
  required Future<Page<T>> Function(int offset) fetch,
}) =>
    Page._(
      items: List.unmodifiable(items),
      total: total,
      offset: offset,
      limit: limit,
      requestId: requestId,
      raw: Map.unmodifiable(raw),
      fetch: fetch,
    );

/// Every item from [first] on, fetching pages as they are needed, without
/// repeating an ID. Internal.
Stream<T> allItems<T>(
  Future<Page<T>> Function() first,
  String Function(T item) idOf,
) async* {
  final seen = <String>{};
  var page = await first();
  while (true) {
    for (final item in page.items) {
      if (seen.add(idOf(item))) yield item;
    }
    if (!page.hasNextPage) return;
    page = await page.nextPage();
  }
}
