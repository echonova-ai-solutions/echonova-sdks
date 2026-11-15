/// Live scenario B: free calls with a key. Voices, job lists and paging,
/// not-found and validation errors, restricted and disabled keys, and widget
/// tickets.
///
/// Needs ECHONOVA_LIVE=1 and ECHONOVA_API_KEY; the key tests and the widget
/// test also need their own variables. See live_support.dart.
@Tags(['live'])
@TestOn('vm')
library;

import 'package:echonova_ai/echonova_ai.dart';
import 'package:test/test.dart';

import 'live_support.dart';

void main() {
  late EchoNova client;
  Future<Voice>? voice;

  Future<Voice> englishVoice() =>
      voice ??= client.textToSpeech.voices.list().then(pickVoice);

  group('B. free, with a key', () {
    setUpAll(() => client = liveClient());
    tearDownAll(() => client.close());

    test('3. voices: at least one, with an English voice picked', () async {
      final voices = await client.textToSpeech.voices.list();
      expect(voices, isNotEmpty);
      for (final voice in voices) {
        expect(voice.id, isNotEmpty);
      }
      final picked = pickVoice(voices);
      voice ??= Future.value(picked);
      log('${voices.length} voices; picked a voice with language '
          '${picked.language} (request ${voices.requestId})');
    }, timeout: quick);

    test('4. job lists: one page each, and listAll stops when asked', () async {
      Future<void> check<T>(
        String product,
        Future<Page<T>> Function() page,
        Stream<T> Function() all,
        String Function(T job) idOf,
      ) async {
        final first = await page();
        expect(first.total, isNotNull, reason: '$product total');
        expect(first.total, greaterThanOrEqualTo(0));
        expect(first.items.length, lessThanOrEqualTo(1));
        expect(first.offset, 0);
        final some = await all().take(2).toList();
        expect(some.length, lessThanOrEqualTo(2));
        expect(some.map(idOf).toSet(), hasLength(some.length));
        log('$product jobs: total ${first.total} '
            '(request ${first.requestId})');
      }

      await check<TtsJob>(
        'Text to Speech',
        () => client.textToSpeech.jobs.list(limit: 1),
        () => client.textToSpeech.jobs.listAll(limit: 1),
        (job) => job.id,
      );
      await check<SttJob>(
        'Speech to Text',
        () => client.speechToText.jobs.list(limit: 1),
        () => client.speechToText.jobs.listAll(limit: 1),
        (job) => job.id,
      );
      await check<CleanJob>(
        'Sound Cleaning',
        () => client.soundCleaning.jobs.list(limit: 1),
        () => client.soundCleaning.jobs.listAll(limit: 1),
        (job) => job.id,
      );
    }, timeout: quick);

    test('5. a job that does not exist throws JobNotFoundException', () async {
      final missing = '0' * 24;
      final calls = <String, Future<Object?> Function()>{
        'Text to Speech': () => client.textToSpeech.jobs.get(missing),
        'Speech to Text': () => client.speechToText.jobs.get(missing),
        'Sound Cleaning': () => client.soundCleaning.jobs.get(missing),
      };
      for (final MapEntry(key: product, value: call) in calls.entries) {
        final error = await thrown<JobNotFoundException>(call);
        expect(error.statusCode, 404);
        expect(error.requestId, isNotNull);
        log('$product job 404: request ${error.requestId}');
      }
    }, timeout: quick);

    test('6. generate with 501 characters throws InvalidRequestException',
        () async {
      final voice = await englishVoice();
      final text = ('This sentence is repeated. ' * 20).substring(0, 501);
      expect(text.length, 501);
      try {
        final result =
            await client.textToSpeech.generate(text, voiceId: voice.id);
        // Not expected: it ran and was charged. Delete what it made.
        await client.textToSpeech.jobs.delete(result.jobId);
        fail('501 characters were accepted');
      } on InvalidRequestException catch (error) {
        expect(error.statusCode, inInclusiveRange(400, 499));
        expect(error.requestId, isNotNull);
        expect(error.mayHaveExecuted, isFalse);
        log('501 characters: ${error.statusCode} '
            '(request ${error.requestId})');
      }
    }, timeout: quick);

    test('8. a private widget ticket has an expiry', () async {
      final ticket =
          await client.widgets.createTicket(env(widgetIdVar)!, ttlSeconds: 60);
      expect(ticket.ticket.isNotEmpty, isTrue, reason: 'a ticket');
      final expiresAt = ticket.expiresAt;
      expect(expiresAt, isNotNull);
      expect(
        expiresAt!.isAfter(DateTime.now().subtract(const Duration(minutes: 5))),
        isTrue,
        reason: 'the ticket expires in the future (allowing for clock skew)',
      );
      log('widget ticket minted (request ${ticket.requestId})');
    }, timeout: quick, skip: liveSkip([apiKeyVar, widgetIdVar]));
  }, skip: liveSkip([apiKeyVar]));

  group('B. other keys', () {
    test(
        '7a. a Text to Speech only key gets PermissionDeniedException for '
        'Speech to Text jobs', () async {
      final restricted = liveClient(ttsOnlyKeyVar);
      addTearDown(restricted.close);
      final error = await thrown<PermissionDeniedException>(
        () => restricted.speechToText.jobs.list(limit: 1),
      );
      expect(error.statusCode, 403);
      expect(error.requestId, isNotNull);
      log('TTS-only key on STT jobs: 403 (request ${error.requestId})');
    }, timeout: quick, skip: liveSkip([ttsOnlyKeyVar]));

    test('7b. a disabled key gets AuthenticationException', () async {
      final disabled = liveClient(disabledKeyVar);
      addTearDown(disabled.close);
      final error = await thrown<AuthenticationException>(
        () => disabled.textToSpeech.voices.list(),
      );
      expect(error.statusCode, 401);
      expect(error.requestId, isNotNull);
      log('disabled key: 401 (request ${error.requestId})');
    }, timeout: quick, skip: liveSkip([disabledKeyVar]));
  });
}
