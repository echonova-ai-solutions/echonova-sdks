/// Helpers for the raw audio the streams use: 16-bit little-endian mono PCM.
///
/// Nothing here resamples or converts formats: audio must already be mono
/// PCM16 at the sample rate you stream with. Everything works on bytes, so it
/// runs on every platform, including the web.
library;

import 'dart:typed_data';

/// PCM16: two bytes per sample.
const int _bytesPerSample = 2;

/// The RIFF and data sizes written in a WAV header for audio whose length
/// isn't known yet (a live stream).
const int unknownWavSize = 0xFFFFFFFF;

const int _wavHeaderSize = 44;
const int _formatPcm = 1;
const int _formatExtensible = 0xFFFE;

/// PCM16LE mono audio and its sample rate.
final class Audio {
  /// Wraps [pcm] (16-bit little-endian mono samples) at [sampleRate] Hz.
  Audio(this.pcm, this.sampleRate);

  /// The samples: 16-bit little-endian, mono.
  final Uint8List pcm;

  /// Samples per second, in Hz. 0 when unknown (a synthesis that produced no
  /// audio).
  final int sampleRate;

  /// Always 1: the streams are mono.
  int get channels => 1;

  /// The length of the audio.
  Duration get duration => pcmDuration(pcm.length, sampleRate);

  /// The audio as a complete WAV file.
  Uint8List toWav() => pcmToWav(pcm, sampleRate);

  @override
  String toString() => 'Audio(sampleRate: $sampleRate, duration: $duration, '
      'bytes: ${pcm.length})';
}

/// The length of [bytes] of PCM16 mono audio at [sampleRate] Hz.
Duration pcmDuration(int bytes, int sampleRate) => sampleRate <= 0
    ? Duration.zero
    : Duration(
        microseconds: (bytes ~/ _bytesPerSample) * 1000000 ~/ sampleRate,
      );

/// A 44-byte WAV header for PCM audio.
///
/// With [dataLength] `null`, the sizes are written as [unknownWavSize], for
/// audio that is still streaming (players read such a file to its end).
Uint8List wavHeader(
  int sampleRate, {
  int channels = 1,
  int bitsPerSample = 16,
  int? dataLength,
}) {
  if (sampleRate <= 0) {
    throw ArgumentError.value(
      sampleRate,
      'sampleRate',
      'must be a positive number of Hz',
    );
  }
  final int riffSize;
  final int dataSize;
  if (dataLength == null) {
    riffSize = dataSize = unknownWavSize;
  } else {
    if (dataLength < 0 ||
        dataLength + _wavHeaderSize - 8 > unknownWavSize - 1) {
      throw ArgumentError.value(
        dataLength,
        'dataLength',
        "doesn't fit in a WAV header",
      );
    }
    dataSize = dataLength;
    riffSize = dataLength + _wavHeaderSize - 8;
  }
  final blockAlign = channels * bitsPerSample ~/ 8;
  final header = ByteData(_wavHeaderSize);
  void tag(int offset, String text) {
    for (var i = 0; i < 4; i++) {
      header.setUint8(offset + i, text.codeUnitAt(i));
    }
  }

  tag(0, 'RIFF');
  header.setUint32(4, riffSize, Endian.little);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  header
    ..setUint32(16, 16, Endian.little)
    ..setUint16(20, _formatPcm, Endian.little)
    ..setUint16(22, channels, Endian.little)
    ..setUint32(24, sampleRate, Endian.little)
    ..setUint32(28, sampleRate * blockAlign, Endian.little)
    ..setUint16(32, blockAlign, Endian.little)
    ..setUint16(34, bitsPerSample, Endian.little);
  tag(36, 'data');
  header.setUint32(40, dataSize, Endian.little);
  return header.buffer.asUint8List();
}

/// [pcm] (16-bit mono) as a complete WAV file.
Uint8List pcmToWav(List<int> pcm, int sampleRate) {
  final header = wavHeader(sampleRate, dataLength: pcm.length);
  return Uint8List(header.length + pcm.length)
    ..setRange(0, header.length, header)
    ..setRange(header.length, header.length + pcm.length, pcm);
}

/// A WAV file streamed as [pcm] arrives: a header with unknown sizes, then
/// the audio. Feed it to a player that accepts a growing WAV stream, or save
/// it as it comes.
Stream<Uint8List> wavStream(Stream<List<int>> pcm, int sampleRate) async* {
  yield wavHeader(sampleRate);
  await for (final chunk in pcm) {
    yield chunk is Uint8List ? chunk : Uint8List.fromList(chunk);
  }
}

/// Reads a mono 16-bit PCM WAV file. Throws [FormatException] for anything
/// else.
Audio parseWav(Uint8List bytes) {
  final data = ByteData.sublistView(bytes);
  String tagAt(int offset) => String.fromCharCodes(bytes, offset, offset + 4);
  if (bytes.length < 12 || tagAt(0) != 'RIFF' || tagAt(8) != 'WAVE') {
    throw const FormatException('not a WAV file (missing RIFF/WAVE header)');
  }
  (int, int, int, int)? format;
  var offset = 12;
  while (true) {
    if (offset + 8 > bytes.length) {
      throw const FormatException('not a valid WAV file: no data chunk');
    }
    final id = tagAt(offset);
    final size = data.getUint32(offset + 4, Endian.little);
    offset += 8;
    if (id == 'fmt ') {
      if (size < 16 || offset + size > bytes.length) {
        throw const FormatException('not a valid WAV file: short fmt chunk');
      }
      var tagValue = data.getUint16(offset, Endian.little);
      final channels = data.getUint16(offset + 2, Endian.little);
      final rate = data.getUint32(offset + 4, Endian.little);
      final bits = data.getUint16(offset + 14, Endian.little);
      if (tagValue == _formatExtensible && size >= 26) {
        tagValue = data.getUint16(offset + 24, Endian.little);
      }
      format = (tagValue, channels, rate, bits);
      offset += size + size % 2;
      continue;
    }
    if (id == 'data') {
      final fmt = format;
      if (fmt == null) {
        throw const FormatException('not a valid WAV file: data before fmt');
      }
      final (tagValue, channels, rate, bits) = fmt;
      if (tagValue != _formatPcm) {
        throw FormatException('unsupported WAV encoding (format $tagValue); '
            'only uncompressed PCM is supported');
      }
      if (channels != 1) {
        throw FormatException(
          'the WAV file has $channels channels; streams need mono audio',
        );
      }
      if (bits != 16) {
        throw FormatException(
          'the WAV file is $bits-bit; streams need 16-bit PCM',
        );
      }
      var end = size == unknownWavSize ? bytes.length : offset + size;
      if (end > bytes.length) end = bytes.length;
      end -= (end - offset) % 2;
      return Audio(bytes.sublist(offset, end), rate);
    }
    offset += size + size % 2;
  }
}

/// Splits PCM16 mono audio into frames of [frameMs] milliseconds (the last
/// one may be shorter). Useful to send a recording at a steady pace.
Iterable<Uint8List> pcmFrames(
  Uint8List pcm,
  int sampleRate, {
  int frameMs = 100,
}) sync* {
  if (sampleRate <= 0 || frameMs <= 0) {
    throw ArgumentError('sampleRate and frameMs must be positive');
  }
  var size = sampleRate * _bytesPerSample * frameMs ~/ 1000;
  size -= size % 2;
  if (size < _bytesPerSample) size = _bytesPerSample;
  for (var start = 0; start < pcm.length; start += size) {
    final end = start + size < pcm.length ? start + size : pcm.length;
    yield Uint8List.sublistView(pcm, start, end);
  }
}
