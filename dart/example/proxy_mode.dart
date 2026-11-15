// Proxy mode, as a Flutter app uses it: the app calls your own backend,
// which checks the app's credentials, adds the EchoNova API key and forwards
// the call to EchoNova. The app never holds an EchoNova key.
//
// Reference proxies (FastAPI and Express) are in proxy-examples/ in the
// repository; this example matches them.
//
// Run, against your proxy:
//
//     APP_TOKEN=... dart run example/proxy_mode.dart https://api.example.com/echonova
import 'dart:convert';
import 'dart:io';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:http/http.dart' as http;

/// Whether this runs in a browser. In a Flutter app, use `kIsWeb`.
const isWeb = bool.fromEnvironment('dart.library.js_interop');

Future<void> main(List<String> args) async {
  if (args.isEmpty) {
    stderr.writeln('usage: dart run example/proxy_mode.dart PROXY_URL');
    exitCode = 64;
    return;
  }
  final proxy = Uri.parse(args[0]);
  final client = EchoNova.proxy(
    baseUrl: proxy,
    // Your app's own credentials, asked for before every attempt, so a
    // token can be refreshed.
    auth: () async => {'Authorization': 'Bearer ${await appToken()}'},
    // Browsers can't send headers on a WebSocket. On Flutter web, streams
    // carry a short-lived token in the URL instead (or a cookie).
    streamQuery:
        isWeb ? () async => {'access_token': await streamToken(proxy)} : null,
  );
  try {
    final voices = await client.textToSpeech.voices.list();
    for (final voice in voices) {
      stdout.writeln('${voice.id}  ${voice.displayName}  ${voice.language}');
    }
    // Streams go through the proxy too.
    final audio = await client.textToSpeech.speak(
      'مرحبا',
      voiceId: voices.first.id,
    );
    stdout.writeln('streamed ${audio.duration.inMilliseconds} ms of audio');
  } finally {
    client.close();
  }
}

/// Stand-in for your app's signed-in session.
Future<String> appToken() async => Platform.environment['APP_TOKEN'] ?? '';

/// A one-minute stream token from the reference proxy's
/// `POST <proxy>/stream-token`.
Future<String> streamToken(Uri proxy) async {
  final response = await http.post(
    proxy.replace(path: '${proxy.path}/stream-token'),
    headers: {'Authorization': 'Bearer ${await appToken()}'},
  );
  if (response.statusCode != 200) {
    throw StateError('stream-token: HTTP ${response.statusCode}');
  }
  final body = jsonDecode(response.body) as Map<String, Object?>;
  return body['token']! as String;
}
