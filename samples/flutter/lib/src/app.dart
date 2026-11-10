/// The app shell: two screens, Text to Speech and Speech to Text.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'audio/microphone.dart';
import 'audio/pcm_player.dart';
import 'speech_service.dart';
import 'stt/stt_controller.dart';
import 'stt/stt_page.dart';
import 'tts/tts_controller.dart';
import 'tts/tts_page.dart';

/// The sample app.
class EchoNovaSampleApp extends StatefulWidget {
  /// Creates the app. It owns [speech] and closes it when it is disposed.
  const EchoNovaSampleApp({
    super.key,
    required this.proxyUrl,
    required this.speech,
    required this.createPlayer,
    required this.createMicrophone,
  });

  /// The proxy the app calls, shown to the user.
  final Uri proxyUrl;

  /// The EchoNova SDK, or a fake in tests.
  final SpeechService speech;

  /// Creates the audio player.
  final PcmPlayer Function() createPlayer;

  /// Creates the microphone.
  final Microphone Function() createMicrophone;

  @override
  State<EchoNovaSampleApp> createState() => _EchoNovaSampleAppState();
}

class _EchoNovaSampleAppState extends State<EchoNovaSampleApp> {
  late final TtsController _tts;
  late final SttController _stt;
  int _screen = 0;

  @override
  void initState() {
    super.initState();
    _tts = TtsController(speech: widget.speech, player: widget.createPlayer());
    _stt = SttController(
      speech: widget.speech,
      microphone: widget.createMicrophone(),
    );
    unawaited(_tts.loadVoices());
  }

  @override
  void dispose() {
    _tts.dispose();
    _stt.dispose();
    widget.speech.close();
    super.dispose();
  }

  void _select(int screen) {
    // Leaving a screen stops it, so nothing plays or listens out of sight.
    if (screen != _screen) {
      unawaited(_screen == 0 ? _tts.stop() : _stt.stop());
    }
    setState(() => _screen = screen);
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'EchoNova sample',
      theme: ThemeData(colorSchemeSeed: Colors.indigo),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        brightness: Brightness.dark,
      ),
      home: Scaffold(
        appBar: AppBar(
          title: Text(_screen == 0 ? 'Text to Speech' : 'Speech to Text'),
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(24),
            child: Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                'Through your proxy: ${widget.proxyUrl}',
                style: Theme.of(context).textTheme.bodySmall,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
        ),
        body: SafeArea(
          child: IndexedStack(
            index: _screen,
            children: [
              TtsPage(controller: _tts),
              SttPage(controller: _stt),
            ],
          ),
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _screen,
          onDestinationSelected: _select,
          destinations: const [
            NavigationDestination(
              icon: Icon(Icons.record_voice_over_outlined),
              selectedIcon: Icon(Icons.record_voice_over),
              label: 'Text to Speech',
            ),
            NavigationDestination(
              icon: Icon(Icons.mic_none),
              selectedIcon: Icon(Icons.mic),
              label: 'Speech to Text',
            ),
          ],
        ),
      ),
    );
  }
}

/// Shown instead of the app when its configuration is unsafe or invalid.
class ConfigErrorApp extends StatelessWidget {
  /// Shows [message].
  const ConfigErrorApp({super.key, required this.message});

  /// What is wrong.
  final String message;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'EchoNova sample',
      theme: ThemeData(colorSchemeSeed: Colors.indigo),
      home: Scaffold(
        appBar: AppBar(title: const Text('Configuration problem')),
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: SelectableText(message),
        ),
      ),
    );
  }
}
