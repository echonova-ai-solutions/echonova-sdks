// A smoke test of the whole app on fakes: voices, speak, transcribe.

import 'package:echonova_sample/src/app.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

void main() {
  late FakeSpeechService speech;
  late FakePcmPlayer player;
  late FakeMicrophone microphone;

  setUp(() {
    speech = FakeSpeechService();
    player = FakePcmPlayer();
    microphone = FakeMicrophone();
  });

  Future<void> pumpApp(WidgetTester tester) async {
    await tester.pumpWidget(
      EchoNovaSampleApp(
        proxyUrl: Uri.parse('http://127.0.0.1:8080/echonova'),
        speech: speech,
        createPlayer: () => player,
        createMicrophone: () => microphone,
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('speaks, then transcribes', (tester) async {
    await pumpApp(tester);
    expect(
      find.text('Through your proxy: http://127.0.0.1:8080/echonova'),
      findsOneWidget,
    );
    expect(find.text('Sara (AR, Female)'), findsOneWidget);

    // Text to Speech.
    await tester.enterText(find.byKey(const Key('text')), 'مرحبا');
    await tester.pump(); // enables Speak
    await tester.tap(find.byKey(const Key('speak')));
    await tester.pump();
    final synthesis = speech.tts.last;
    expect(synthesis.text, 'مرحبا');
    synthesis.emit(pcm(240));
    await tester.pump();
    expect(find.text('Speaking…'), findsOneWidget);
    synthesis.finish(credits: 3);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('report')), findsOneWidget);
    expect(find.textContaining('3 credits'), findsOneWidget);
    expect(player.log, contains('start 24000'));

    // Speech to Text.
    await tester.tap(find.text('Speech to Text').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('record')));
    await tester.pumpAndSettle();
    expect(find.text('Stop'), findsWidgets);
    microphone.emit(pcm(1600));
    speech.stt.transcript('أهلاً وسهلاً');
    await tester.pumpAndSettle();
    expect(find.text('أهلاً وسهلاً'), findsOneWidget);

    await tester.tap(find.byKey(const Key('record')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('summary')), findsOneWidget);
    expect(find.textContaining('saved as job job_1'), findsOneWidget);
    expect(speech.stt.sent.length, 3200);

    // Closing the app closes the SDK client.
    await tester.pumpWidget(const SizedBox());
    expect(speech.closed, isTrue);
    expect(microphone.disposed, isTrue);
  });

  testWidgets('shows SDK errors', (tester) async {
    speech.voicesError = Exception('offline');
    await pumpApp(tester);
    expect(find.byKey(const Key('error')), findsOneWidget);
    expect(find.textContaining('offline'), findsOneWidget);
  });

  testWidgets('shows a configuration problem instead of the app', (
    tester,
  ) async {
    await tester.pumpWidget(const ConfigErrorApp(message: 'No proxy URL.'));
    expect(find.text('No proxy URL.'), findsOneWidget);
  });
}
