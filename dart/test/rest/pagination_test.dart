// Offset pagination: pages, nextPage, and listAll without duplicates.
import 'package:echonova_ai/echonova_ai.dart';
import 'package:test/test.dart';

import '../support/rest.dart';

Map<String, Object?> job(int n) => jobJson(id: 'job-$n');

void main() {
  test('a page has its items, total and the next page', () async {
    final h = makeClient((request, _) {
      final offset = int.parse(request.url.queryParameters['offset'] ?? '0');
      return ok({
        'items': [for (var n = offset; n < offset + 2 && n < 5; n++) job(n)],
        'total': 5,
      }, requestId: 'req-$offset');
    });
    final page = await h.client.textToSpeech.jobs.list(limit: 2);
    expect(page.items.map((j) => j.id), ['job-0', 'job-1']);
    expect(page.total, 5);
    expect(page.offset, 0);
    expect(page.limit, 2);
    expect(page.requestId, 'req-0');
    expect(page.raw['total'], 5);
    expect(page.hasNextPage, isTrue);
    expect(page.nextOffset, 2);

    final second = await page.nextPage();
    expect(h.api.last.url.queryParameters, {'offset': '2', 'limit': '2'});
    expect(second.items.map((j) => j.id), ['job-2', 'job-3']);
    final last = await second.nextPage();
    expect(last.offset, 4);
    expect(last.items.single.id, 'job-4');
    expect(last.hasNextPage, isFalse);
    expect(last.nextPage, throwsA(isA<UsageException>()));
    expect(page.toString(), 'Page(offset: 0, items: 2, total: 5)');
  });

  test('without a total, a full page means there may be more', () async {
    final h = makeClient((request, _) {
      final offset = int.parse(request.url.queryParameters['offset'] ?? '0');
      return ok({
        'items': [
          if (offset == 0) ...[job(0), job(1)] else job(2)
        ],
      });
    });
    final page = await h.client.soundCleaning.jobs.list(limit: 2);
    expect(page.total, isNull);
    expect(page.hasNextPage, isTrue);
    final next = await page.nextPage();
    expect(next.hasNextPage, isFalse);
    // Without a limit or total, one page is all there is.
    final unlimited = await h.client.soundCleaning.jobs.list();
    expect(unlimited.hasNextPage, isFalse);
  });

  test('an empty list has no next page', () async {
    final h = makeClient((_, __) => ok({'items': <Object>[], 'total': 0}));
    final page = await h.client.speechToText.jobs.list();
    expect(page.items, isEmpty);
    expect(page.hasNextPage, isFalse);
  });

  test('listAll walks every page and skips jobs it already returned', () async {
    // A job created while paging shifts the second page by one: job-1
    // appears again at the start of it.
    final pages = {
      0: [job(0), job(1)],
      2: [job(1), job(2)],
      4: [job(3)],
    };
    final h = makeClient((request, _) {
      final offset = int.parse(request.url.queryParameters['offset'] ?? '0');
      return ok({'items': pages[offset], 'total': 5});
    });
    final ids = await h.client.speechToText.jobs
        .listAll(limit: 2)
        .map((j) => j.id)
        .toList();
    expect(ids, ['job-0', 'job-1', 'job-2', 'job-3']);
    expect(h.api.requests.map((r) => r.url.queryParameters['offset']),
        [null, '2', '4']);
    expect(h.api.requests.every((r) => r.url.queryParameters['limit'] == '2'),
        isTrue);
  });

  test('listAll fetches lazily', () async {
    final h = makeClient((request, _) {
      final offset = int.parse(request.url.queryParameters['offset'] ?? '0');
      return ok({
        'items': [job(offset), job(offset + 1)],
        'total': 100,
      });
    });
    final first =
        await h.client.textToSpeech.jobs.listAll(limit: 2).take(3).toList();
    expect(first, hasLength(3));
    expect(h.api.requests, hasLength(2));
  });

  test('a list without items is a protocol error', () async {
    final h = makeClient((_, __) => ok({'total': 3}));
    await expectLater(
        h.client.textToSpeech.jobs.list(), throwsA(isA<ProtocolException>()));
  });

  test('raw pages', () async {
    final h = makeClient((_, __) => ok({
          'items': [job(0)],
          'total': 1,
        }, headers: {
          'x-ratelimit-remaining': '7'
        }));
    final raw = await h.client.textToSpeech.jobs.listWithResponse(limit: 1);
    expect(raw.statusCode, 200);
    expect(raw.rateLimit!.remaining, 7);
    final page = raw.parse();
    expect(page.items.single.id, 'job-0');
    expect(identical(raw.parse(), page), isTrue);
  });
}
