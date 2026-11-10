/// EchoNova Flutter sample: Text to Speech and Speech to Text streaming
/// through your own proxy. The app never holds an EchoNova API key.
library;

import 'package:flutter/material.dart';

import 'src/app.dart';
import 'src/audio/microphone.dart';
import 'src/audio/pcm_player.dart';
import 'src/config.dart';
import 'src/proxy_auth.dart';
import 'src/speech_service.dart';

void main() {
  final AppConfig config;
  try {
    config = AppConfig.fromEnvironment();
  } on ConfigException catch (error) {
    runApp(ConfigErrorApp(message: error.message));
    return;
  }

  // REPLACE DemoTokenAuth with your app's own sign-in (lib/src/proxy_auth.dart).
  final auth = DemoTokenAuth(config.demoToken);

  // One client for the life of the app: it keeps the connection pool and the
  // rate-limit state.
  final client = createEchoNovaClient(config, auth);

  runApp(
    EchoNovaSampleApp(
      proxyUrl: config.proxyUrl,
      speech: EchoNovaSpeechService(client),
      createPlayer: createPcmPlayer,
      createMicrophone: RecordMicrophone.new,
    ),
  );
}
