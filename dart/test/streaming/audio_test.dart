/// The audio helpers.
library;

import 'dart:typed_data';

import 'package:echonova/src/audio.dart';
import 'package:test/test.dart';

Uint8List ramp(int length) =>
    Uint8List.fromList([for (var i = 0; i < length; i++) i % 251]);

void main() {
  test('Audio has a duration and round-trips through WAV', () {
    final audio = Audio(ramp(48000), 24000);
    expect(audio.channels, 1);
    expect(audio.duration, const Duration(seconds: 1));
    final wav = audio.toWav();
    expect(wav, hasLength(44 + 48000));
    expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
    expect(String.fromCharCodes(wav.sublist(8, 16)), 'WAVEfmt ');
    final back = parseWav(wav);
    expect(back.sampleRate, 24000);
    expect(back.pcm, audio.pcm);
    expect('$audio', contains('sampleRate: 24000'));
  });

  test('empty audio has no duration', () {
    expect(Audio(Uint8List(0), 0).duration, Duration.zero);
    expect(Audio(Uint8List(10), 0).duration, Duration.zero);
  });

  test('a streaming WAV header has unknown sizes', () {
    final header = ByteData.sublistView(wavHeader(16000));
    expect(header.getUint32(4, Endian.little), unknownWavSize);
    expect(header.getUint32(40, Endian.little), unknownWavSize);
    expect(header.getUint32(24, Endian.little), 16000);
    expect(header.getUint32(28, Endian.little), 32000);
    expect(header.getUint16(32, Endian.little), 2);
    expect(header.getUint16(34, Endian.little), 16);
    final sized = ByteData.sublistView(wavHeader(16000, dataLength: 100));
    expect(sized.getUint32(4, Endian.little), 136);
    expect(sized.getUint32(40, Endian.little), 100);
    expect(() => wavHeader(0), throwsArgumentError);
    expect(() => wavHeader(16000, dataLength: -1), throwsArgumentError);
  });

  test('pcmToWav is a header plus the samples', () {
    final wav = pcmToWav([1, 2, 3, 4], 8000);
    expect(wav.sublist(44), [1, 2, 3, 4]);
    expect(ByteData.sublistView(wav).getUint32(40, Endian.little), 4);
  });

  test('wavStream sends the header first', () async {
    final parts = await wavStream(
      Stream.fromIterable([
        [1, 2],
        [3, 4],
      ]),
      16000,
    ).toList();
    expect(parts, hasLength(3));
    expect(parts.first, wavHeader(16000));
    // A streamed WAV with unknown sizes is read to its end.
    final whole = Uint8List.fromList([for (final p in parts) ...p]);
    expect(parseWav(whole).pcm, [1, 2, 3, 4]);
  });

  test('parseWav validates mono 16-bit PCM', () {
    expect(() => parseWav(Uint8List(10)), throwsFormatException);
    Uint8List withFormat({int tag = 1, int channels = 1, int bits = 16}) {
      final wav = pcmToWav([0, 0], 16000);
      ByteData.sublistView(wav)
        ..setUint16(20, tag, Endian.little)
        ..setUint16(22, channels, Endian.little)
        ..setUint16(34, bits, Endian.little);
      return wav;
    }

    expect(
      () => parseWav(withFormat(channels: 2)),
      throwsA(isA<FormatException>()
          .having((e) => e.message, 'message', contains('mono'))),
    );
    expect(
      () => parseWav(withFormat(bits: 8)),
      throwsA(isA<FormatException>()
          .having((e) => e.message, 'message', contains('16-bit'))),
    );
    expect(
      () => parseWav(withFormat(tag: 3)),
      throwsA(isA<FormatException>()
          .having((e) => e.message, 'message', contains('PCM'))),
    );
  });

  test('pcmFrames cuts 100 ms frames', () {
    final frames = pcmFrames(ramp(7000), 16000).toList();
    expect([for (final f in frames) f.length], [3200, 3200, 600]);
    expect([for (final f in frames) ...f], ramp(7000));
    expect(() => pcmFrames(ramp(2), 0).toList(), throwsArgumentError);
  });
}
