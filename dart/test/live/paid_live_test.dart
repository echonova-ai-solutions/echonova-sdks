/// Live scenario C: small paid calls. Text to Speech (sync, job, stream),
/// Speech to Text (sync, job and exports, stream, transcribeStream), Sound
/// Cleaning, and an agent session.
///
/// Needs ECHONOVA_LIVE=1 and ECHONOVA_API_KEY; the agent test also needs
/// ECHONOVA_AGENT_ID. About 300 credits a run (see live_support.dart). The
/// WAV that test 9 synthesizes is the audio the later tests transcribe and
/// clean; it is made once, by whichever test needs it first.
@Tags(['live'])
@TestOn('vm')
library;

import 'dart:async';
import 'dart:typed_data';

import 'package:echonova_ai/echonova_ai.dart';
import 'package:test/test.dart';

import 'live_support.dart';

/// The shared test audio: about 3 s of English speech.
const sharedText = 'Hello from the EchoNova Dart SDK live test.';

/// For the async Text to Speech job.
const jobText = 'A short job from the Dart SDK live test.';

/// For the first synthesis on the stream.
const streamText = 'Streaming hello from the Dart SDK live test.';

/// Long enough that a cancel after the first audio lands mid-stream. Only
/// the share of audio sent is charged.
const cancelText = 'This longer passage from the Dart SDK live test is only '
    'here to be cancelled. It keeps going for a while, sentence after '
    'sentence, so that the first audio arrives well before the end and the '
    'cancel lands in the middle.';

/// For `speakStream`.
const sentences = [
  'Dart sentence one.',
  'Dart sentence two.',
  'Dart sentence three.',
];

void main() {
  late EchoNova client;
  late Janitor janitor;
  Future<Voice>? voice;
  Future<({TtsResult speech, Uint8List wav})>? shared;

  Future<Voice> englishVoice() =>
      voice ??= client.textToSpeech.voices.list().then(pickVoice);

  /// Synthesizes and downloads the shared WAV once. Its job is deleted after
  /// the test that made it; the bytes stay in memory.
  Future<({TtsResult speech, Uint8List wav})> sharedAudio() =>
      shared ??= () async {
        final v = await englishVoice();
        final speech = await client.textToSpeech.generate(
          sharedText,
          voiceId: v.id,
        );
        janitor.track(JobKind.tts, speech.jobId);
        final url = speech.audioUrl;
        if (url == null) throw StateError('generate returned no audioUrl');
        final wav = await client.download(url);
        return (speech: speech, wav: wav);
      }();

  Future<Uint8List> sharedWav() async => (await sharedAudio()).wav;

  group('C. paid', () {
    setUpAll(() => client = liveClient());
    tearDownAll(() => client.close());
    setUp(() {
      janitor = Janitor(client);
      addTearDown(janitor.sweep);
    });

    test('9. generate: audio link, duration and credits; the WAV downloads',
        () async {
      final (:speech, :wav) = await sharedAudio();
      expect(speech.status, JobStatus.completed);
      expect(speech.audioUrl, isNotNull);
      expect(speech.durationSeconds, greaterThan(0));
      expect(speech.creditsConsumed, greaterThanOrEqualTo(1));
      expect(looksLikeWav(wav), isTrue, reason: 'starts with RIFF....WAVE');
      final audio = parseWav(wav);
      expect(audio.sampleRate, greaterThan(0));
      expect(audio.pcm, isNotEmpty);
      log('generate: ${speech.durationSeconds} s, '
          '${speech.creditsConsumed} credits, ${audio.sampleRate} Hz '
          '(request ${speech.requestId})');
    }, timeout: slow);

    test('10. Text to Speech job: create, wait, download, delete', () async {
      final v = await englishVoice();
      final job = await client.textToSpeech.jobs.create(jobText, voiceId: v.id);
      janitor.track(JobKind.tts, job.jobId);
      expect(job.jobId, isNotEmpty);

      final started = DateTime.now();
      final done = await client.textToSpeech.jobs
          .wait(job.jobId, timeout: const Duration(minutes: 3));
      expect(done.status, JobStatus.completed);
      expect(done.durationSeconds, greaterThan(0));
      expect(done.creditsConsumed, greaterThanOrEqualTo(1));

      final audio = await client.textToSpeech.jobs.download(done.id);
      expect(looksLikeWav(audio), isTrue);

      final deleted = await janitor.delete(JobKind.tts, done.id);
      expect(deleted.deleted, isTrue);
      await thrown<NotFoundException>(
        () => client.textToSpeech.jobs.get(done.id),
      );
      log('TTS job: done in ${DateTime.now().difference(started).inSeconds} '
          's, ${done.creditsConsumed} credits (request ${job.requestId})');
    }, timeout: slow);

    test('11. transcribe the shared WAV (sync, English)', () async {
      final wav = await sharedWav();
      final result = await client.speechToText.transcribe(
        AudioFile.fromBytes(wav, 'speech.wav'),
        language: 'en',
      );
      janitor.track(JobKind.stt, result.jobId);
      expect(result.status, JobStatus.completed);
      expect(result.transcription?.trim(), isNotEmpty);
      expect(result.durationSeconds, greaterThan(0));
      expect(result.creditsConsumed, greaterThanOrEqualTo(0));
      log('transcribe: ${result.durationSeconds} s, '
          '${result.creditsConsumed} credits (request ${result.requestId})');
    }, timeout: slow);

    test('12. Speech to Text job: create, wait, export txt/srt/json, delete',
        () async {
      final wav = await sharedWav();
      final job = await client.speechToText.jobs.create(
        AudioFile.fromBytes(wav, 'speech.wav'),
        language: 'en',
      );
      janitor.track(JobKind.stt, job.jobId);

      final done = await client.speechToText.jobs
          .wait(job.jobId, timeout: const Duration(minutes: 4));
      expect(done.status, JobStatus.completed);
      expect(done.transcription?.trim(), isNotEmpty);

      final jobs = client.speechToText.jobs;
      final txt = await jobs.export(done.id, format: ExportFormat.txt);
      expect(txt.trim(), isNotEmpty);
      final srt = await jobs.export(done.id, format: ExportFormat.srt);
      expect(srt.contains('-->'), isTrue, reason: 'at least one subtitle cue');
      final json = await jobs.exportJson(done.id);
      expect(json.text?.trim(), isNotEmpty);

      final deleted = await janitor.delete(JobKind.stt, done.id);
      expect(deleted.deleted, isTrue);
      log('STT job: ${done.durationSeconds} s, ${done.creditsConsumed} '
          'credits, ${json.segments?.length} segments '
          '(request ${job.requestId})');
    }, timeout: slow);

    test('13. Sound Cleaning: clean, download, get, delete', () async {
      final wav = await sharedWav();
      final job = await client.soundCleaning.clean(
        AudioFile.fromBytes(wav, 'speech.wav'),
      );
      janitor.track(JobKind.clean, job.id);
      expect(job.status, JobStatus.completed);
      expect(job.outputUrl, isNotNull);

      final cleaned = await client.download(job.outputUrl!);
      expect(looksLikeWav(cleaned), isTrue);

      final again = await client.soundCleaning.jobs.get(job.id);
      expect(again.id, job.id);
      expect(again.status, JobStatus.completed);

      final deleted = await janitor.delete(JobKind.clean, job.id);
      expect(deleted.deleted, isTrue);
      log('clean: ${job.durationSeconds} s, ${job.creditsConsumed} credits '
          '(request ${job.requestId})');
    }, timeout: slow);

    test('14. Text to Speech stream: synthesize, cancel, speakStream, close',
        () async {
      final v = await englishVoice();
      final since = DateTime.now().toUtc().subtract(const Duration(minutes: 5));
      final requestIds = <String>{};
      janitor.later(() => deleteTtsStreamJobs(
            client,
            since: since,
            requestIds: requestIds,
            texts: sentences.toSet(),
          ));

      final tts = await client.textToSpeech.connect(voiceId: v.id);
      try {
        // A whole synthesis.
        final first = tts.synthesize(streamText);
        requestIds.add(first.requestId);
        final audio = await first.collect();
        final result = await first.result;
        expect(result.outcome, SynthesisOutcome.completed);
        expect(result.sampleRate, greaterThan(0));
        expect(audio.sampleRate, result.sampleRate);
        expect(audio.pcm, isNotEmpty);
        expect(result.charged, isTrue);
        expect(result.creditsConsumed, greaterThan(0));
        expect(result.durationSeconds, greaterThan(0));
        log('stream synthesis: ${audio.duration.inMilliseconds} ms of audio '
            'at ${result.sampleRate} Hz, first audio after '
            '${first.ttfb?.inMilliseconds} ms, ${result.creditsConsumed} '
            'credits (handshake request ${tts.handshakeRequestId})');

        // Cancelled after its first audio: an outcome, not an error.
        final cancelled = tts.synthesize(cancelText);
        requestIds.add(cancelled.requestId);
        var chunks = 0;
        await for (final _ in cancelled.audio) {
          if (++chunks == 1) cancelled.cancel();
        }
        final cancelResult = await cancelled.result;
        expect(chunks, greaterThanOrEqualTo(1));
        expect(cancelResult.outcome, SynthesisOutcome.cancelled);
        expect(cancelResult.charged, isTrue);
        expect(cancelResult.creditsConsumed, greaterThanOrEqualTo(1));
        log('cancelled synthesis: ${cancelResult.creditsConsumed} credits '
            'for the share sent');

        // Three sentences as one PCM stream.
        final pcm = BytesBuilder(copy: false);
        await for (final chunk in tts.speakStream(sentences)) {
          pcm.add(chunk);
        }
        expect(pcm.length, greaterThan(0));
        log('speakStream: ${pcm.length} bytes for ${sentences.length} '
            'sentences');
      } finally {
        await tts.close();
      }
      expect(tts.isClosed, isTrue);
      expect(tts.failure, isNull);
    }, timeout: slow);

    test('15. Speech to Text stream: send, endSegment, stop', () async {
      final audio = parseWav(await sharedWav());
      final stt = await client.speechToText.connect(
        sampleRate: audio.sampleRate,
        language: 'en',
      );
      final jobId = stt.jobId;
      if (jobId != null) janitor.track(JobKind.stt, jobId);
      // Listen from the start; awaited after stop().
      final events = stt.events.toList()..ignore();
      try {
        await stt.sendAudio(audio.pcm);
        final mark = await stt.endSegment();
        expect(mark.expectResult, isTrue);
        final summary = await stt.stop();
        final received = await events.timeout(const Duration(seconds: 30));

        final transcripts = received.whereType<Transcript>().toList();
        expect(transcripts, isNotEmpty);
        expect(transcripts.map((t) => t.text).join(' ').trim(), isNotEmpty);
        expect(summary.reason, 'stopped');
        expect(summary.totalSeconds, greaterThan(0));
        expect(summary.creditsConsumed, greaterThanOrEqualTo(0));
        if (summary.jobId case final saved?) {
          janitor.track(JobKind.stt, saved);
        }
        log('STT stream: ${transcripts.length} transcript(s), '
            '${summary.totalSeconds} s, ${summary.creditsConsumed} credits, '
            'saved: ${summary.savedStatus?.name} '
            '(handshake request ${stt.handshakeRequestId})');
      } finally {
        await stt.close();
      }
    }, timeout: slow);

    test('16. transcribeStream over the same audio', () async {
      final audio = parseWav(await sharedWav());
      final source = Stream<List<int>>.fromIterable(
        pcmFrames(audio.pcm, audio.sampleRate),
      );
      final events = await client.speechToText
          .transcribeStream(
            source,
            sampleRate: audio.sampleRate,
            language: 'en',
          )
          .toList();
      for (final saved in events.whereType<SessionSaved>()) {
        janitor.track(JobKind.stt, saved.jobId);
      }
      final transcripts = events.whereType<Transcript>().toList();
      expect(transcripts, isNotEmpty);
      expect(transcripts.map((t) => t.text).join(' ').trim(), isNotEmpty);
      expect(events.whereType<StreamErrorEvent>(), isEmpty);
      log('transcribeStream: ${transcripts.length} transcript(s), '
          '${events.whereType<SessionSaved>().length} saved session(s)');
    }, timeout: slow);

    test('17. agent session: start (chat), get, end', () async {
      final agentId = env(agentIdVar)!;
      final sessions = client.agents.sessions;
      final started = await sessions.start(
        agentId,
        channel: AgentChannel.chat,
      );
      var ended = false;
      try {
        expect(started.id, isNotEmpty);
        expect(started.status, AgentSessionStatus.active);
        expect(started.channel, AgentChannel.chat);
        expect(started.token.isNotEmpty, isTrue, reason: 'a room token');

        final got = await sessions.get(agentId, started.id);
        expect(got.id, started.id);

        final end = await sessions.end(agentId, started.id);
        ended = true;
        expect(end.id, started.id);
        expect(end.status.isOver, isTrue);
        log('agent session: ${end.status} (request ${started.requestId})');
      } finally {
        if (!ended) {
          try {
            await sessions.end(agentId, started.id);
          } on EchoNovaException catch (error) {
            log('cleanup: the agent session was not ended: '
                '${describe(error)}');
          }
        }
      }
    }, timeout: slow, skip: liveSkip([apiKeyVar, agentIdVar]));
  }, skip: liveSkip([apiKeyVar]));
}
