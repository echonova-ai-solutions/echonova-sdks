// Audio uploads: media types, sniffing, and replay across retries.
@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:echonova_ai/src/files.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

import '../support/rest.dart';

Uint8List bytes(List<int> head) =>
    Uint8List.fromList([...head, ...List.filled(32, 0)]);

final initiated = {'jobId': jobId, 'status': 'processing'};

void main() {
  test('the extension map', () {
    for (final MapEntry(key: ext, value: type) in {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.opus': 'audio/opus',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.webm': 'audio/webm',
      '.amr': 'audio/amr',
    }.entries) {
      expect(AudioFile.fromBytes(Uint8List(4), 'a$ext').contentType, type);
      expect(
          AudioFile.fromBytes(Uint8List(4), 'A${ext.toUpperCase()}')
              .contentType,
          type);
    }
    expect(audioExtensionTypes, hasLength(9));
  });

  test('sniffing the first bytes', () {
    final cases = <List<int>, String?>{
      [...'RIFF'.codeUnits, 0, 0, 0, 0, ...'WAVE'.codeUnits]: 'audio/wav',
      'fLaC'.codeUnits: 'audio/flac',
      'OggS'.codeUnits: 'audio/ogg',
      'ID3'.codeUnits: 'audio/mpeg',
      '#!AMR\n'.codeUnits: 'audio/amr',
      [0, 0, 0, 0x20, ...'ftypM4A '.codeUnits]: 'audio/mp4',
      [0x1a, 0x45, 0xdf, 0xa3]: 'audio/webm',
      [0xff, 0xfb, 0x90]: 'audio/mpeg',
      [0xff, 0xf1, 0x50]: 'audio/aac',
      'hello world'.codeUnits: null,
      <int>[]: null,
    };
    for (final MapEntry(:key, :value) in cases.entries) {
      expect(sniffAudioType(key), value, reason: '$key');
    }
  });

  test('bytes without a known extension are sniffed', () {
    final file = AudioFile.fromBytes(wav, 'recording');
    expect(file.contentType, 'audio/wav');
    expect(file.filename, 'recording');
    expect(AudioFile.fromBytes(mp3, '').filename, 'audio.mp3');
  });

  test('an explicit type wins; a generic one is refused', () {
    expect(
        AudioFile.fromBytes(wav, 'a.wav', contentType: 'audio/x-custom')
            .contentType,
        'audio/x-custom');
    for (final generic in [
      'application/octet-stream',
      'binary/octet-stream',
      ' ',
      'Application/Octet-Stream; x=1',
    ]) {
      expect(() => AudioFile.fromBytes(wav, 'a.wav', contentType: generic),
          throwsA(isA<UsageException>()),
          reason: generic);
    }
    expect(() => AudioFile.fromBytes(wav, 'a.wav', contentType: 'not a type'),
        throwsA(isA<UsageException>()));
  });

  test('an unrecognisable file is refused before anything is sent', () {
    expect(
      () => AudioFile.fromBytes(bytes('hello'.codeUnits), 'notes.txt'),
      throwsA(isA<UsageException>()
          .having((e) => e.message, 'message', contains('.mp3'))),
    );
  });

  test(
      'a stream is sniffed when its name does not tell, and its first '
      'bytes are sent', () async {
    final controller = StreamController<List<int>>();
    final file = AudioFile.fromStream(controller.stream, wav.length, 'rec');
    expect(file.contentType, isNull);
    controller
      ..add(wav.sublist(0, 6))
      ..add(wav.sublist(6, 20))
      ..add(wav.sublist(20))
      ..close().ignore();
    final h = makeClient((_, __) => ok(initiated));
    await h.client.speechToText.jobs.create(file, language: 'ar');
    final part = multipartParts(h.api.last)['file']!;
    expect(part.contentType, 'audio/wav');
    expect(part.value, wav);
    expect(file.contentType, 'audio/wav');
  });

  test('a short stream that cannot be recognised is a usage error', () async {
    final file = AudioFile.fromStream(Stream.value('hey'.codeUnits), 3, 'clip');
    final h = makeClient((_, __) => ok(initiated));
    await expectLater(h.client.speechToText.jobs.create(file, language: 'ar'),
        throwsA(isA<UsageException>()));
    expect(h.api.requests, isEmpty);
  });

  test('a stream error reaches the caller', () async {
    final file = AudioFile.fromStream(
        Stream<List<int>>.error(const FileSystemException('disk gone')),
        10,
        'a.mp3');
    final h = makeClient((_, __) => ok(initiated));
    await expectLater(h.client.speechToText.jobs.create(file, language: 'ar'),
        throwsA(anything));
  });

  group('paths', () {
    late Directory dir;
    setUp(() async {
      dir = await Directory.systemTemp.createTemp('echonova_files_');
    });
    tearDown(() => dir.delete(recursive: true));

    test('are read again for every attempt', () async {
      final path = '${dir.path}/meeting.mp3';
      File(path).writeAsBytesSync(mp3);
      final h = makeClient((_, index) => index == 0
          ? failure(503, 'Speech to Text is temporarily unavailable')
          : ok(initiated));
      await h.client.speechToText.jobs
          .create(AudioFile.fromPath(path), language: 'ar');
      expect(h.api.requests, hasLength(2));
      for (final request in h.api.requests) {
        final part = multipartParts(request)['file']!;
        expect(part.filename, 'meeting.mp3');
        expect(part.contentType, 'audio/mpeg');
        expect(part.value, mp3);
      }
    });

    test('without a known extension are sniffed', () async {
      final path = '${dir.path}/recording.bin';
      File(path).writeAsBytesSync(wav);
      final file = AudioFile.fromPath(path);
      expect(file.contentType, isNull);
      final h = makeClient((_, __) => ok(initiated));
      await h.client.speechToText.jobs.create(file, language: 'en');
      expect(multipartParts(h.api.last)['file']!.contentType, 'audio/wav');
    });

    test('a missing file is a usage error', () async {
      final h = makeClient((_, __) => ok(initiated));
      await expectLater(
        h.client.soundCleaning.clean(AudioFile.fromPath('${dir.path}/no.wav')),
        throwsA(isA<UsageException>()),
      );
      await expectLater(
        h.client.soundCleaning.clean(AudioFile.fromPath('${dir.path}/no')),
        throwsA(isA<UsageException>()),
      );
      expect(h.api.requests, isEmpty);
    });

    test('a File works through its path', () async {
      final file = File('${dir.path}/x.flac')..writeAsBytesSync([1, 2]);
      final upload = AudioFile.fromPath(file.path, filename: 'renamed.flac');
      expect(upload.filename, 'renamed.flac');
      expect(upload.contentType, 'audio/flac');
      expect(upload.isReplayable, isTrue);
    });
  });

  test('bytes are replayable; a stream only until it is read', () async {
    final file = AudioFile.fromBytes(mp3, 'a.mp3');
    expect(file.isReplayable, isTrue);
    expect(file.length, mp3.length);
    final h = makeClient((_, __) => http.Response('x', 503));
    await expectLater(h.client.speechToText.jobs.create(file, language: 'ar'),
        throwsA(isA<ServiceUnavailableException>()));
    expect(h.api.requests, hasLength(3));
    expect(file.isReplayable, isTrue);
  });
}
