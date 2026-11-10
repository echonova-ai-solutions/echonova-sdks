import 'dart:async';

import 'package:echonova/echonova.dart';
import 'package:echonova_sample/src/stt/stt_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

void main() {
  late FakeSpeechService speech;
  late FakeMicrophone microphone;
  late SttController controller;

  setUp(() {
    speech = FakeSpeechService();
    microphone = FakeMicrophone();
    controller = SttController(speech: speech, microphone: microphone);
  });

  tearDown(() => controller.dispose());

  Future<void> settle() => pumpEventQueue();

  // 100 ms of 16 kHz audio.
  List<int> silence() => pcm(1600);
  List<int> speech100ms() => pcm(1600, value: 8000);

  test(
    'streams the microphone and shows transcripts, then the summary',
    () async {
      final listening = controller.start();
      expect(controller.status, SttStatus.starting);
      await settle();

      expect(speech.sttRequests.single, (sampleRate: 16000, language: 'ar'));
      expect(microphone.sampleRate, 16000);
      expect(controller.status, SttStatus.listening);

      microphone
        ..emit(speech100ms())
        ..emit(silence());
      await settle();
      expect(speech.stt.sent.length, 6400);

      speech.stt
        ..transcript('مرحبا')
        ..transcript('   ') // an empty segment is not shown
        ..transcript('كيف حالك');
      await settle();
      expect(controller.transcripts.map((t) => t.text), ['مرحبا', 'كيف حالك']);

      final stopping = controller.stop();
      expect(controller.status, SttStatus.stopping);
      await stopping;
      await listening;

      expect(speech.stt.stopped, isTrue);
      expect(speech.stt.closed, isTrue);
      expect(microphone.recording, isFalse);
      expect(controller.status, SttStatus.idle);
      expect(controller.summary!.jobId, 'job_1');
      expect(controller.error, isNull);
    },
  );

  test('cuts a segment at each pause after speech', () async {
    final listening = controller.start();
    await settle();

    for (var i = 0; i < 5; i++) {
      microphone.emit(speech100ms()); // 500 ms of speech
    }
    for (var i = 0; i < 6; i++) {
      microphone.emit(silence());
    }
    await settle();
    expect(speech.stt.segmentsEnded, 0); // 600 ms: not a pause yet
    microphone.emit(silence());
    await settle();
    expect(speech.stt.segmentsEnded, 1);

    for (var i = 0; i < 20; i++) {
      microphone.emit(silence()); // silence alone never cuts
    }
    await settle();
    expect(speech.stt.segmentsEnded, 1);

    await controller.stop();
    await listening;
  });

  test('uses the chosen language, chosen only while idle', () async {
    controller.selectLanguage('en');
    final listening = controller.start();
    await settle();
    controller.selectLanguage('ar'); // ignored while listening
    expect(controller.language, 'en');
    expect(speech.sttRequests.single.language, 'en');
    await controller.stop();
    await listening;
  });

  test('asks for the microphone first', () async {
    microphone.allow = false;
    await controller.start();
    expect(speech.sttRequests, isEmpty);
    expect(controller.error, contains('microphone'));
    expect(controller.status, SttStatus.idle);
  });

  test('shows a refused session without recording', () async {
    speech.connectError = AuthenticationException(
      statusCode: 401,
      errorMessage: 'Unauthorized',
    );
    await controller.start();
    expect(controller.error, contains('401'));
    expect(microphone.sampleRate, isNull);
    expect(controller.status, SttStatus.idle);
  });

  test('stops the microphone when the session fails', () async {
    final listening = controller.start();
    await settle();
    speech.stt
      ..transcript('kept')
      ..fail(
        UpstreamException(statusCode: 502, errorMessage: 'Speech service down'),
      );
    await listening;

    expect(microphone.recording, isFalse);
    expect(controller.transcripts.single.text, 'kept');
    expect(controller.error, contains('Speech service down'));
    expect(controller.status, SttStatus.idle);
  });

  test('shows a failed segment as a warning and goes on', () async {
    final listening = controller.start();
    await settle();
    speech.stt.segmentError('one segment failed');
    await settle();
    expect(controller.warning, contains('one segment failed'));
    expect(controller.status, SttStatus.listening);
    await controller.stop();
    await listening;
    expect(controller.error, isNull);
  });

  test('stop while connecting cancels, and closes the late session', () async {
    speech.connectGate = Completer();
    final listening = controller.start();
    await settle();
    await controller.stop();
    expect(controller.status, SttStatus.idle);

    speech.connectGate!.complete();
    await listening;
    expect(speech.stt.closed, isTrue);
    expect(microphone.sampleRate, isNull);
    expect(controller.status, SttStatus.idle);
  });

  test('dispose ends the session and releases the microphone', () async {
    final listening = controller.start();
    await settle();
    final other = SttController(speech: speech, microphone: FakeMicrophone());
    controller.dispose();
    controller = other; // tearDown disposes this one
    await listening;
    expect(speech.stt.closed, isTrue);
    expect(microphone.disposed, isTrue);
  });
}
