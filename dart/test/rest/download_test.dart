// Downloads of signed links: no credentials, expired links, retries, and
// jobs.download getting a fresh link first.
@TestOn('vm')
library;

import 'dart:io';

import 'package:echonova/echonova.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

import '../support/rest.dart';

http.Response audio([List<int> bytes = const [1, 2, 3]]) =>
    http.Response.bytes(bytes, 200, headers: {'content-type': 'audio/wav'});

void main() {
  test('sends no API key and no default headers', () async {
    final h = makeClient((_, __) => ok(jobJson()),
        download: (_, __) => audio(), defaultHeaders: {'X-App': 'demo'});
    final bytes = await h.client.download(signedUrl);
    expect(bytes, [1, 2, 3]);
    final request = h.downloads.last;
    expect(request.url.toString(), signedUrl);
    expect(request.headers.keys.map((k) => k.toLowerCase()),
        isNot(contains('authorization')));
    expect(request.headers.keys.map((k) => k.toLowerCase()),
        isNot(contains('x-app')));
    expect(request.headers['user-agent'], startsWith('echonova-dart/'));
    expect(h.api.requests, isEmpty);
  });

  test('sends no proxy credentials either', () async {
    var authCalls = 0;
    final h = makeClient(
      (_, __) => ok(jobJson()),
      download: (_, __) => audio(),
      proxy: true,
      auth: () {
        authCalls++;
        return {'Authorization': 'Bearer app-session', 'Cookie': 'sid=1'};
      },
    );
    await h.client.download(signedUrl);
    expect(h.downloads.last.headers.keys.map((k) => k.toLowerCase()),
        isNot(anyOf(contains('authorization'), contains('cookie'))));
    expect(authCalls, 0);
  });

  test('an expired link says so, without its signature', () async {
    final h = makeClient((_, __) => ok(jobJson()),
        download: (_, __) => http.Response(
            '<Error><Code>AuthenticationFailed</Code></Error>', 403));
    await expectLater(
      h.client.download(signedUrl),
      throwsA(isA<DownloadExpiredException>()
          .having(
              (e) => e.url, 'url', 'https://storage.example.com/tts/out.wav')
          .having((e) => e.toString(), 'toString', isNot(contains('sig=')))
          .having((e) => e.toString(), 'toString',
              isNot(contains('AuthenticationFailed')))),
    );
    expect(h.downloads.requests, hasLength(1));
  });

  test('transient storage errors are retried', () async {
    final h = makeClient((_, __) => ok(jobJson()),
        download: (_, index) => switch (index) {
              0 => throw http.ClientException('Connection reset'),
              1 => http.Response('busy', 503),
              _ => audio(),
            });
    expect(await h.client.download(signedUrl), [1, 2, 3]);
    expect(h.downloads.requests, hasLength(3));
    expect(h.time.sleeps, hasLength(2));
  });

  test('a missing file is not retried and its body is not kept', () async {
    final h = makeClient((_, __) => ok(jobJson()),
        download: (_, __) => http.Response(
            '<Error>BlobNotFound sig=REDACTED</Error>', 404,
            reasonPhrase: 'The specified blob does not exist.'));
    await expectLater(
      h.client.download(signedUrl),
      throwsA(isA<NotFoundException>()
          .having((e) => e.rawBody, 'rawBody', isNull)
          .having((e) => e.message, 'message',
              contains('https://storage.example.com/tts/out.wav'))
          .having((e) => e.message, 'message', isNot(contains('sig=')))),
    );
    expect(h.downloads.requests, hasLength(1));
  });

  test('storage errors after the retries are server errors', () async {
    final h = makeClient((_, __) => ok(jobJson()),
        download: (_, __) => http.Response('oops', 500));
    await expectLater(
        h.client.download(signedUrl), throwsA(isA<ServerException>()));
    expect(h.downloads.requests, hasLength(3));
  });

  test('a missing or invalid link is a usage error', () async {
    final h = makeClient((_, __) => ok(jobJson()));
    expect(() => h.client.download(''), throwsA(isA<UsageException>()));
    expect(() => h.client.download('/relative/path'),
        throwsA(isA<UsageException>()));
  });

  group('jobs.download', () {
    test('gets the job for a fresh link first', () async {
      final h = makeClient(
        (_, __) => ok(jobJson(audioUrl: signedUrl)),
        download: (_, __) => audio([9, 9]),
      );
      final bytes = await h.client.textToSpeech.jobs.download(jobId);
      expect(bytes, [9, 9]);
      expect(h.api.last.url.path, '/v1/text-to-speech/jobs/$jobId');
      expect(h.downloads.last.url.toString(), signedUrl);
      expect(h.downloads.last.headers['authorization'], isNull);
    });

    test('Sound Cleaning uses the output link', () async {
      final h = makeClient(
        (_, __) => ok(jobJson(outputUrl: signedUrl)),
        download: (_, __) => audio([7]),
      );
      expect(await h.client.soundCleaning.jobs.download(jobId), [7]);
      expect(h.api.last.url.path, '/v1/sound-cleaning/jobs/$jobId');
    });

    test('of an unfinished or failed job', () async {
      final pending = makeClient((_, __) => ok(jobJson(status: 'processing')));
      await expectLater(pending.client.textToSpeech.jobs.download(jobId),
          throwsA(isA<UsageException>()));
      final failed =
          makeClient((_, __) => ok(jobJson(status: 'failed', error: 'x')));
      await expectLater(failed.client.soundCleaning.jobs.download(jobId),
          throwsA(isA<JobFailedException>()));
      expect(failed.downloads.requests, isEmpty);
    });
  });

  group('downloadTo', () {
    late Directory dir;
    setUp(() async {
      dir = await Directory.systemTemp.createTemp('echonova_download_');
    });
    tearDown(() => dir.delete(recursive: true));

    test('writes the file', () async {
      final h = makeClient((_, __) => ok(jobJson()),
          download: (_, __) => audio([1, 2, 3, 4]));
      final path = await h.client.downloadTo(signedUrl, '${dir.path}/a.wav');
      expect(path, '${dir.path}/a.wav');
      expect(File(path).readAsBytesSync(), [1, 2, 3, 4]);
      expect(dir.listSync(), hasLength(1));
    });

    test('into a folder, with the link\'s file name', () async {
      final h =
          makeClient((_, __) => ok(jobJson()), download: (_, __) => audio());
      final path = await h.client.downloadTo(signedUrl, dir.path);
      expect(path, '${dir.path}/out.wav');
      expect(File(path).existsSync(), isTrue);
    });

    test('a retried download restarts the file', () async {
      final h = makeClient((_, __) => ok(jobJson()),
          download: (_, index) =>
              index == 0 ? http.Response('busy', 503) : audio([5, 6]));
      final path = await h.client.downloadTo(signedUrl, '${dir.path}/b.wav');
      expect(File(path).readAsBytesSync(), [5, 6]);
    });

    test('a failed download leaves no file', () async {
      final h = makeClient((_, __) => ok(jobJson()),
          download: (_, __) => http.Response('expired', 403));
      await expectLater(h.client.downloadTo(signedUrl, '${dir.path}/c.wav'),
          throwsA(isA<DownloadExpiredException>()));
      expect(dir.listSync(), isEmpty);
    });

    test('jobs.downloadTo', () async {
      final h = makeClient((_, __) => ok(jobJson(audioUrl: signedUrl)),
          download: (_, __) => audio([3]));
      final path = await h.client.textToSpeech.jobs
          .downloadTo(jobId, '${dir.path}/job.wav');
      expect(File(path).readAsBytesSync(), [3]);
    });
  });
}
