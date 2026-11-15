import 'dart:math';
import 'dart:typed_data';

import 'package:echonova_ai/src/core/pcm_framer.dart';
import 'package:test/test.dart';

Uint8List bytes(int length, Random random) =>
    Uint8List.fromList([for (var i = 0; i < length; i++) random.nextInt(256)]);

Uint8List concat(List<Uint8List> parts) {
  final builder = BytesBuilder(copy: false);
  parts.forEach(builder.add);
  return builder.takeBytes();
}

bool sameBytes(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

void main() {
  for (final (sampleRate, frameMs, expected) in [
    (16000, 100, 3200),
    (8000, 100, 1600),
    (48000, 100, 9600),
    (48000, 1000, maxFrameBytes),
    (8001, 100, 1600),
    (8000, 1, 16),
  ]) {
    test('frame size at $sampleRate Hz, $frameMs ms', () {
      expect(PcmFramer(sampleRate, frameMs: frameMs).frameBytes, expected);
    });
  }

  test('frames are lossless, even and bounded (randomised)', () {
    final random = Random(20261109);
    const rates = [8000, 16000, 22050, 44100, 48000];
    for (var run = 0; run < 300; run++) {
      final framer = PcmFramer(
        rates[random.nextInt(rates.length)],
        frameMs: random.nextBool() ? 100 : 1 + random.nextInt(2000),
      );
      final chunks = [
        for (var i = random.nextInt(30); i > 0; i--)
          bytes(random.nextInt(random.nextBool() ? 20 : 100000), random),
      ];
      final segmentAfter = random.nextInt(31);
      final sent = <Uint8List>[];
      for (final (index, chunk) in chunks.indexed) {
        sent.addAll(framer.push(chunk));
        if (index == segmentAfter) sent.addAll(framer.flush()); // endSegment
        expect(framer.pendingBytes, lessThan(framer.frameBytes));
      }
      final (:frames, :droppedBytes) = framer.finish();
      sent.addAll(frames);

      final data = concat(chunks);
      for (final frame in sent) {
        expect(frame.length.isEven, isTrue);
        expect(frame.length, inInclusiveRange(1, maxFrameBytes));
      }
      expect(droppedBytes, data.length % 2);
      expect(
        sameBytes(concat(sent), data.sublist(0, data.length - droppedBytes)),
        isTrue,
      );
      expect(framer.bytesEmitted, data.length - droppedBytes);
      expect(framer.pendingBytes, 0);
    }
  });

  test('an odd byte carries across endSegment', () {
    final framer = PcmFramer(16000);
    framer.push([1, 2, 3]);
    expect(framer.flush(), [
      [1, 2],
    ]);
    expect(framer.pendingBytes, 1);
    expect(framer.push([4]), isEmpty);
    expect(framer.flush(), [
      [3, 4],
    ]);
  });

  test('finish drops a trailing odd byte', () {
    final framer = PcmFramer(16000);
    framer.push([1, 2, 3]);
    final (:frames, :droppedBytes) = framer.finish();
    expect(frames, [
      [1, 2],
    ]);
    expect(droppedBytes, 1);
    expect(framer.finish().frames, isEmpty);
  });

  test('input is copied', () {
    final framer = PcmFramer(8000, frameMs: 1); // 16-byte frames
    final buffer = Uint8List.fromList(List.filled(10, 0x61));
    framer.push(buffer);
    buffer.fillRange(0, 10, 0x62);
    expect(framer.push(List.filled(6, 0x63)), [
      [...List.filled(10, 0x61), ...List.filled(6, 0x63)],
    ]);
  });

  test('frames do not share memory with the framer', () {
    final framer = PcmFramer(8000, frameMs: 1);
    final first = framer.push(List.filled(16, 1)).single;
    framer.push(List.filled(16, 2));
    expect(first, List.filled(16, 1));
  });

  test('seconds emitted', () {
    final framer = PcmFramer(16000);
    framer.push(Uint8List(32000));
    expect(framer.secondsEmitted, 1.0);
  });

  test('invalid arguments', () {
    expect(
      () => PcmFramer(0),
      throwsA(isA<ArgumentError>()
          .having((e) => e.message, 'message', contains('sampleRate'))),
    );
    expect(
      () => PcmFramer(16000, frameMs: 0),
      throwsA(isA<ArgumentError>()
          .having((e) => e.message, 'message', contains('frameMs'))),
    );
  });
}
