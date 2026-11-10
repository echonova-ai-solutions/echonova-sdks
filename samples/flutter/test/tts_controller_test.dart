import 'dart:async';

import 'package:echonova/echonova.dart';
import 'package:echonova_sample/src/tts/tts_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

void main() {
  late FakeSpeechService speech;
  late FakePcmPlayer player;
  late TtsController controller;

  setUp(() {
    speech = FakeSpeechService();
    player = FakePcmPlayer();
    controller = TtsController(speech: speech, player: player);
  });

  tearDown(() => controller.dispose());

  /// Lets pending microtasks and stream events run.
  Future<void> settle() => pumpEventQueue();

  group('voices', () {
    test('loads them and picks the first', () async {
      await controller.loadVoices();
      expect(controller.voices.map((v) => v.id), ['voice_sara', 'voice_adam']);
      expect(controller.voiceId, 'voice_sara');
      expect(controller.loadingVoices, isFalse);
    });

    test('keeps the chosen voice on reload', () async {
      await controller.loadVoices();
      controller.selectVoice('voice_adam');
      await controller.loadVoices();
      expect(controller.voiceId, 'voice_adam');
    });

    test('shows why they could not load', () async {
      speech.voicesError = AuthenticationException(
        statusCode: 401,
        errorMessage: 'Unauthorized',
        requestId: 'req_1',
      );
      await controller.loadVoices();
      expect(controller.voices, isEmpty);
      expect(controller.error, contains('401'));
      expect(controller.error, contains('Request ID: req_1'));
    });
  });

  group('speak', () {
    setUp(() => controller.loadVoices());

    test(
      'plays the audio as it arrives, at the stream\'s sample rate',
      () async {
        final statuses = <TtsStatus>[];
        controller.addListener(() => statuses.add(controller.status));

        final speaking = controller.speak('  مرحبا  ');
        expect(player.log.first, 'unlock'); // before any await
        expect(controller.status, TtsStatus.connecting);
        await settle();

        final synthesis = speech.tts.last;
        expect(synthesis.text, 'مرحبا');
        expect(synthesis.voiceId, 'voice_sara');
        synthesis.emit(pcm(240), rate: 22050);
        await settle();
        expect(controller.status, TtsStatus.speaking);
        synthesis.emit(pcm(480), rate: 22050);
        synthesis.finish(credits: 7);
        await speaking;

        expect(
          player.log,
          containsAllInOrder(['start 22050', 'feed 480', 'feed 960']),
        );
        expect(player.fedBytes, 1440);
        expect(controller.status, TtsStatus.idle);
        expect(controller.report!.result.outcome, SynthesisOutcome.completed);
        expect(controller.report!.result.creditsConsumed, 7);
        expect(controller.report!.ttfb, const Duration(milliseconds: 120));
        expect(
          statuses,
          containsAllInOrder([
            TtsStatus.connecting,
            TtsStatus.speaking,
            TtsStatus.idle,
          ]),
        );
      },
    );

    test('stays speaking until the audio has played', () async {
      player.holdDrain = true;
      final speaking = controller.speak('hello');
      await settle();
      speech.tts.last
        ..emit(pcm(10))
        ..finish();
      await settle();
      expect(controller.status, TtsStatus.speaking);
      player.finishPlaying();
      await speaking;
      expect(controller.status, TtsStatus.idle);
    });

    test('opens one stream and reuses it', () async {
      for (final text in ['one', 'two']) {
        final speaking = controller.speak(text);
        await settle();
        speech.tts.last.finish();
        await speaking;
      }
      expect(speech.ttsConnections, hasLength(1));
      expect(speech.tts.syntheses.map((s) => s.text), ['one', 'two']);
    });

    test('uses the chosen voice', () async {
      controller.selectVoice('voice_adam');
      final speaking = controller.speak('hello');
      await settle();
      expect(speech.tts.last.voiceId, 'voice_adam');
      speech.tts.last.finish();
      await speaking;
    });

    test('a new speak replaces the one playing (barge-in)', () async {
      final first = controller.speak('first');
      await settle();
      final firstSynthesis = speech.tts.last..emit(pcm(10));
      await settle();

      final second = controller.speak('second');
      await settle();
      expect(firstSynthesis.cancelled, isTrue);
      final secondSynthesis = speech.tts.last;
      expect(secondSynthesis.text, 'second');
      secondSynthesis
        ..emit(pcm(10))
        ..finish();
      await Future.wait([first, second]);

      expect(controller.status, TtsStatus.idle);
      expect(controller.report!.result.requestId, 'req_second');
    });

    test('refuses text over the limit without sending it', () async {
      await controller.speak('a' * (TtsController.maxTextLength + 1));
      expect(controller.error, contains('${TtsController.maxTextLength}'));
      expect(speech.ttsConnections, isEmpty);
    });

    test('does nothing for blank text', () async {
      await controller.speak('   ');
      expect(speech.ttsConnections, isEmpty);
      expect(controller.status, TtsStatus.idle);
    });

    test('shows a failed synthesis and stops the audio', () async {
      final speaking = controller.speak('hello');
      await settle();
      speech.tts.last
        ..emit(pcm(10))
        ..fail(
          InsufficientBalanceException(
            statusCode: 402,
            errorMessage: 'Insufficient balance',
          ),
        );
      await speaking;
      expect(controller.status, TtsStatus.idle);
      expect(controller.error, contains('Insufficient balance'));
      expect(player.log.last, 'stop');
    });

    test('shows a refused connection', () async {
      speech.connectError = ConcurrencyLimitException(
        statusCode: 429,
        errorMessage: 'Too many concurrent streams',
      );
      await controller.speak('hello');
      expect(controller.error, contains('Too many streams'));
      expect(controller.status, TtsStatus.idle);

      speech.connectError = null; // the next speak connects again
      final speaking = controller.speak('hello');
      await settle();
      speech.tts.last.finish();
      await speaking;
      expect(controller.error, isNull);
    });

    test('opens a new stream after the old one failed for good', () async {
      var speaking = controller.speak('one');
      await settle();
      speech.tts.last.finish();
      await speaking;
      final broken = speech.tts..failure = SessionEndedException('gone');

      speaking = controller.speak('two');
      await settle();
      expect(broken.closed, isTrue);
      expect(speech.ttsConnections, hasLength(2));
      speech.tts.last.finish();
      await speaking;
    });
  });

  group('stop', () {
    setUp(() => controller.loadVoices());

    test('cancels the synthesis and reports what it cost', () async {
      final speaking = controller.speak('hello');
      await settle();
      final synthesis = speech.tts.last..emit(pcm(10));
      await settle();

      await controller.stop();
      await speaking;
      expect(synthesis.cancelled, isTrue);
      expect(player.log.last, 'stop');
      expect(controller.status, TtsStatus.idle);
      expect(controller.report!.result.outcome, SynthesisOutcome.cancelled);
      expect(controller.report!.result.creditsConsumed, 1);
    });

    test('while connecting, drops the speak', () async {
      speech.connectGate = Completer();
      final speaking = controller.speak('hello');
      await settle();
      await controller.stop();
      speech.connectGate!.complete();
      await speaking;
      expect(speech.tts.syntheses, isEmpty);
      expect(controller.status, TtsStatus.idle);
    });
  });

  test('dispose closes the stream and the player', () async {
    await controller.loadVoices();
    final speaking = controller.speak('hello');
    await settle();
    final synthesis = speech.tts.last..emit(pcm(10));
    await settle();

    final other = TtsController(speech: speech, player: player);
    controller.dispose();
    controller = other; // tearDown disposes this one
    await speaking;
    await settle();
    expect(synthesis.cancelled, isTrue);
    expect(speech.tts.closed, isTrue);
    expect(player.log, contains('dispose'));
  });
}
