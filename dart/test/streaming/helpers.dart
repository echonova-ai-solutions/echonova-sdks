/// Shared helpers for the streaming tests.
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:echonova/src/core/retry.dart';
import 'package:echonova/src/streaming/options.dart';
import 'package:test/test.dart';

import 'mock_server.dart';

/// Starts a mock server, stopped after the test.
Future<MockServer> startServer() async {
  final server = await MockServer.start();
  addTearDown(server.stop);
  return server;
}

/// Options pointing at [server], with fast, deterministic retries.
///
/// [sleeps] records every wait the SDK asks for; when [instantSleep] is
/// set, waits return at once.
StreamOptions optionsFor(
  MockServer server, {
  Duration? keepalive = const Duration(seconds: 30),
  Duration pongTimeout = const Duration(seconds: 15),
  Duration silenceTimeout = const Duration(seconds: 60),
  Duration? waitForSlot,
  Duration reconnectSlotWait = const Duration(seconds: 90),
  int maxConnectAttempts = 6,
  Duration openTimeout = const Duration(seconds: 5),
  Duration closeTimeout = const Duration(seconds: 2),
  Duration sessionStartTimeout = const Duration(seconds: 5),
  Duration synthesisStartTimeout = const Duration(seconds: 30),
  Duration cancelAckTimeout = const Duration(seconds: 5),
  Duration rotateAfter = const Duration(minutes: 28),
  Duration rolloverMargin = const Duration(seconds: 30),
  List<Duration>? sleeps,
  bool instantSleep = false,
  FutureOr<Map<String, String>> Function()? headers,
  FutureOr<Map<String, String>> Function()? query,
  String? userAgent,
}) =>
    StreamOptions(
      wsBaseUri: server.url,
      headers: headers ?? () => {'Authorization': 'Bearer ek_test'},
      query: query,
      userAgent: userAgent,
      keepalive: keepalive,
      pongTimeout: pongTimeout,
      silenceTimeout: silenceTimeout,
      waitForSlot: waitForSlot,
      reconnectSlotWait: reconnectSlotWait,
      maxConnectAttempts: maxConnectAttempts,
      openTimeout: openTimeout,
      closeTimeout: closeTimeout,
      sessionStartTimeout: sessionStartTimeout,
      synthesisStartTimeout: synthesisStartTimeout,
      cancelAckTimeout: cancelAckTimeout,
      rotateAfter: rotateAfter,
      rolloverMargin: rolloverMargin,
      retryPolicy: RetryPolicy(random: () => 0),
      sleep: (duration) {
        sleeps?.add(duration);
        return instantSleep
            ? Future<void>.value()
            : Future<void>.delayed(duration);
      },
    );

/// [seconds] of 16 kHz PCM16 audio with a recognizable byte pattern.
Uint8List pcm(double seconds, {int sampleRate = 16000}) {
  final length = (sampleRate * seconds).round() * 2;
  return Uint8List.fromList([for (var i = 0; i < length; i++) (i ~/ 2) % 251]);
}

/// [data] in chunks of [size] bytes, with an optional pause between them.
Stream<List<int>> chunked(
  Uint8List data, {
  int size = 3200,
  Duration delay = Duration.zero,
}) async* {
  for (var start = 0; start < data.length; start += size) {
    if (delay > Duration.zero) await Future<void>.delayed(delay);
    final end = start + size < data.length ? start + size : data.length;
    yield Uint8List.sublistView(data, start, end);
  }
}

/// Waits until [condition] holds, polling.
Future<void> waitFor(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('condition not met in time');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}
