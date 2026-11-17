// Live, paid: one small call per endpoint and stream. The tests run in order and share
// the audio made by test (9). Every job they create is deleted, in the test or in afterAll.
//
// Text to Speech is charged per character, so the texts are short: 195 characters spoken in
// full (the idempotency test sends its text twice with one key, and is charged once; the same
// key with another text is refused, uncharged), plus a 163-character text cancelled after its
// first audio (charged only for the share sent).
// Speech to Text and Sound Cleaning process the same ~3 s clip: six passes in all.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect } from 'vitest';
import type EchoNova from '../../src/index.js';
import { InvalidRequestError, JobNotFoundError, toFile, type TranscriptExport, type Voice } from '../../src/index.js';
import { parseWav, type Transcript } from '../../src/streaming/index.js';
import {
  clientFor,
  findStreamJobs,
  from,
  isWav,
  JobCleanup,
  liveTest,
  note,
  pickVoice,
  rejection,
  required,
  scrubbing,
  since,
  summarize,
} from './support.js';

/** The shared test audio, in English so every check can use language "en". */
const SPEECH = 'Welcome to EchoNova. This is a live test.';
const JOB_SPEECH = 'This is an async job test.';
const KEY_SPEECH = 'Idempotency key test.';
const OTHER_SPEECH = 'Another text, same key.';
const STREAM_SPEECH = 'Streaming speech arrives in chunks.';
/** Cancelled after its first audio, so only the share of audio sent is charged (at least 1 credit). */
const LONG_SPEECH =
  'This longer passage is here to test cancelling a stream. It keeps going for a while, ' +
  'so the first audio arrives well before the end and the test can stop it early.';
const SENTENCES = ['This is the first sentence.', 'Here is the second one.', 'And this is the third.'];

const KEY = ['ECHONOVA_API_KEY'] as const;
const WAIT = { timeoutMs: 4 * 60_000 };

let client: EchoNova | null = null;
const api = (): EchoNova => (client ??= clientFor(required('ECHONOVA_API_KEY')));
const jobs = new JobCleanup();

let voice: Voice | null = null;
/** The idempotencyKey test (9b) synthesized KEY_SPEECH with. */
let usedKey: string | null = null;
/** The WAV from test (9): the input of every Speech to Text and Sound Cleaning test. */
let wav: Uint8Array | null = null;

// Text to Speech streams save each synthesis as a job; they are found by request ID after the tests.
const streamRequestIds = new Set<string>();
let streamSyntheses = 0;
let streamsStarted = Date.now();

afterAll(() =>
  scrubbing(async () => {
    if (client === null) return;
    try {
      if (streamRequestIds.size > 0) {
        const ids = await findStreamJobs(client, streamRequestIds, { expected: streamSyntheses, since: streamsStarted });
        note(`found ${ids.length} of ${streamSyntheses} jobs saved by the Text to Speech stream`);
        for (const id of ids) jobs.track('textToSpeech', id);
      }
      await jobs.run(client);
    } finally {
      await client.close();
    }
  }),
);

describe('REST (paid)', () => {
  liveTest('(9) textToSpeech.generate returns a WAV link and its cost', KEY, async () => {
    const voices = await api().textToSpeech.voices.list();
    const picked = pickVoice(voices.items);
    if (!picked) throw new Error('voices.list returned no voices');
    voice = picked;

    const started = performance.now();
    const speech = await api().textToSpeech.generate({ text: SPEECH, voiceId: picked.id });
    jobs.track('textToSpeech', speech.jobId);
    note(`textToSpeech.generate: ${speech.durationSeconds} s of audio, ${speech.creditsConsumed} credits in ${since(started)}, request ${speech.requestId}`);
    expect(speech.status).toBe('completed');
    expect(typeof speech.jobId).toBe('string');
    expect(typeof speech.audioUrl).toBe('string');
    expect(speech.durationSeconds ?? 0).toBeGreaterThan(0);
    expect(Number.isInteger(speech.creditsConsumed)).toBe(true);
    expect(speech.creditsConsumed).toBeGreaterThanOrEqual(1);

    const bytes = await api().download(speech.audioUrl);
    expect(isWav(bytes)).toBe(true);
    wav = bytes;
  });

  liveTest('(9b) textToSpeech.generate twice with one idempotencyKey returns the same job', KEY, async (ctx) => {
    const { id: voiceId } = from(ctx, voice, 'the voice from test (9)');
    const idempotencyKey = `live-${randomUUID()}`;
    const first = await api().textToSpeech.generate({ text: KEY_SPEECH, voiceId }, { idempotencyKey });
    jobs.track('textToSpeech', first.jobId);
    usedKey = idempotencyKey;
    const again = await api().textToSpeech.generate({ text: KEY_SPEECH, voiceId }, { idempotencyKey });
    jobs.track('textToSpeech', again.jobId);
    note(`textToSpeech.generate twice with one key: ${first.creditsConsumed} and ${again.creditsConsumed} credits, requests ${first.requestId}, ${again.requestId}`);
    expect(first.status).toBe('completed');
    expect(again.jobId).toBe(first.jobId);
  });

  liveTest('(9c) the same idempotencyKey with another text is refused (409), uncharged', KEY, async (ctx) => {
    const { id: voiceId } = from(ctx, voice, 'the voice from test (9)');
    const idempotencyKey = from(ctx, usedKey, 'the key from test (9b)');
    const outcome: unknown = await api()
      .textToSpeech.generate({ text: OTHER_SPEECH, voiceId }, { idempotencyKey })
      .then(
        (result) => {
          jobs.track('textToSpeech', result.jobId); // not expected: clean it up anyway
          return result;
        },
        (error: unknown) => error,
      );
    note(`textToSpeech.generate with a reused key: ${summarize(outcome)}`);
    expect(outcome instanceof InvalidRequestError).toBe(true); // a boolean: a result would hold a signed link
    const error = outcome as InvalidRequestError;
    expect(error.statusCode).toBe(409);
    expect(error.rule).toBe('idempotency_key_reused');
    expect(error.idempotencyKey === idempotencyKey).toBe(true);
  });

  liveTest('(10) textToSpeech.jobs: create, wait, download, delete', KEY, async (ctx) => {
    const { id: voiceId } = from(ctx, voice, 'the voice from test (9)');
    const tts = api().textToSpeech;
    const started = performance.now();
    const created = await tts.jobs.create({ text: JOB_SPEECH, voiceId });
    jobs.track('textToSpeech', created.jobId);
    expect(typeof created.jobId).toBe('string');
    expect(['pending', 'processing', 'completed']).toContain(created.status);

    const done = await tts.jobs.wait(created, WAIT);
    note(`textToSpeech job finished in ${since(started)}, request ${done.requestId}`);
    expect(done.id).toBe(created.jobId);
    expect(done.status).toBe('completed');
    expect(done.voiceId).toBe(voiceId);
    expect(done.creditsConsumed).toBeGreaterThanOrEqual(1);
    expect(done.durationSeconds ?? 0).toBeGreaterThan(0);

    expect(isWav(await tts.jobs.download(done))).toBe(true); // gets a fresh link first
    const deleted = await tts.jobs.delete(done);
    expect(deleted.deleted).toBe(true);
    jobs.forget(done.id);
    await rejection(tts.jobs.get(done.id), JobNotFoundError);
  });

  liveTest('(11) speechToText.transcribe transcribes the test audio', KEY, async (ctx) => {
    const audio = from(ctx, wav, 'the test audio from test (9)');
    const started = performance.now();
    const result = await api().speechToText.transcribe({ file: toFile(audio, 'live-test.wav'), language: 'en' });
    jobs.track('speechToText', result.jobId);
    note(`speechToText.transcribe: ${result.durationSeconds} s, ${result.creditsConsumed} credits in ${since(started)}, request ${result.requestId}`);
    expect(result.status).toBe('completed');
    expect(result.transcription.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(result.segments)).toBe(true);
    for (const segment of result.segments) expect(segment.end).toBeGreaterThanOrEqual(segment.start);
    expect(Number.isInteger(result.creditsConsumed)).toBe(true);
    expect(result.creditsConsumed).toBeGreaterThanOrEqual(0);
  });

  liveTest('(11b) speechToText.transcribe without a language detects it', KEY, async (ctx) => {
    const audio = from(ctx, wav, 'the test audio from test (9)');
    const result = await api().speechToText.transcribe({ file: toFile(audio, 'live-test.wav') });
    jobs.track('speechToText', result.jobId);
    note(`speechToText.transcribe without a language: reported ${result.language}, request ${result.requestId}`);
    expect(result.status).toBe('completed');
    expect(['auto', 'ar', 'en']).toContain(result.language);
  });

  liveTest('(12) speechToText.jobs: create, wait, export txt, srt and json, delete', KEY, async (ctx) => {
    const audio = from(ctx, wav, 'the test audio from test (9)');
    const stt = api().speechToText;
    const started = performance.now();
    const created = await stt.jobs.create({ file: toFile(audio, 'live-test.wav'), language: 'en' });
    jobs.track('speechToText', created.jobId);
    const done = await stt.jobs.wait(created, WAIT);
    note(`speechToText job finished in ${since(started)}, request ${done.requestId}`);
    expect(done.id).toBe(created.jobId);
    expect(done.status).toBe('completed');
    expect((done.transcription ?? '').trim().length).toBeGreaterThan(0);

    const txt = await stt.jobs.export(done, { format: 'txt' });
    expect(typeof txt).toBe('string');
    expect(txt.trim().length).toBeGreaterThan(0);
    const srt = await stt.jobs.export(done, { format: 'srt' });
    expect(typeof srt).toBe('string');
    expect(srt.includes('-->')).toBe(true);
    const json: TranscriptExport = await stt.jobs.export(done, { format: 'json' });
    expect(typeof json).toBe('object');
    expect(json.requestId).toBeTruthy();
    expect(typeof json.text === 'string' || Array.isArray(json.segments)).toBe(true);

    const deleted = await stt.jobs.delete(done);
    expect(deleted.deleted).toBe(true);
    jobs.forget(done.id);
  });

  liveTest('(13) soundCleaning.clean returns cleaned audio; get and delete the job', KEY, async (ctx) => {
    const audio = from(ctx, wav, 'the test audio from test (9)');
    const c = api();
    const started = performance.now();
    const job = await c.soundCleaning.clean({ file: toFile(audio, 'live-test.wav') });
    jobs.track('soundCleaning', job.id);
    note(`soundCleaning.clean: ${job.creditsConsumed} credits in ${since(started)}, request ${job.requestId}`);
    expect(job.status).toBe('completed');
    expect(typeof job.outputUrl).toBe('string');
    expect(isWav(await c.download(job.outputUrl))).toBe(true);

    const got = await c.soundCleaning.jobs.get(job);
    expect(got.id).toBe(job.id);
    expect(got.status).toBe('completed');
    expect(typeof got.outputUrl).toBe('string');
    const deleted = await c.soundCleaning.jobs.delete(job);
    expect(deleted.deleted).toBe(true);
    jobs.forget(job.id);
  });
});

describe('streams (paid)', () => {
  liveTest('(14) Text to Speech stream: synthesize, cancel after the first audio, speakStream', KEY, async (ctx) => {
    const { id: voiceId } = from(ctx, voice, 'the voice from test (9)');
    streamsStarted = Date.now();
    const tts = await api().textToSpeech.connect({ voiceId });
    note(`Text to Speech stream open, request ${tts.handshakeRequestId}`);
    try {
      // One whole synthesis. The sample rate comes from the server's start event.
      const synth = tts.synthesize(STREAM_SPEECH);
      streamRequestIds.add(synth.requestId);
      streamSyntheses += 1;
      const audio = await synth.collect();
      const result = await synth.result;
      note(`synthesis completed: ${audio.duration.toFixed(2)} s at ${audio.sampleRate} Hz, first audio after ${Math.round(synth.metrics.ttfb ?? 0)} ms, ${result.creditsConsumed} credits`);
      expect(result.outcome).toBe('completed');
      expect(audio.sampleRate).toBeGreaterThan(0);
      expect(result.sampleRate).toBe(audio.sampleRate);
      expect(audio.pcm.length).toBeGreaterThan(0);
      expect(audio.pcm.length % 2).toBe(0);
      expect(result.charged).toBe(true);
      expect(result.creditsConsumed ?? 0).toBeGreaterThanOrEqual(1);
      expect(result.durationSeconds ?? 0).toBeGreaterThan(0);

      // Leaving the loop after the first chunk cancels the synthesis: an outcome, not an error.
      const long = tts.synthesize(LONG_SPEECH);
      streamRequestIds.add(long.requestId);
      streamSyntheses += 1;
      let first = 0;
      for await (const chunk of long) {
        first = chunk.length;
        break;
      }
      const cancelled = await long.result;
      note(`cancelled after the first audio: ${cancelled.creditsConsumed} credits`);
      expect(first).toBeGreaterThan(0);
      expect(cancelled.outcome).toBe('cancelled');
      expect(long.error === null ? null : summarize(long.error)).toBeNull();

      // Three sentences as one continuous stream.
      let spoken = 0;
      for await (const chunk of tts.speakStream(SENTENCES)) spoken += chunk.length;
      streamSyntheses += SENTENCES.length;
      note(`speakStream: ${(spoken / 2 / audio.sampleRate).toFixed(2)} s of audio`);
      expect(spoken).toBeGreaterThan(0);
    } finally {
      await tts.close();
    }
  });

  liveTest('(15) Speech to Text stream: send the test audio, get transcripts and the summary', KEY, async (ctx) => {
    const audio = parseWav(from(ctx, wav, 'the test audio from test (9)'));
    const stt = await api().speechToText.connect({ sampleRate: audio.sampleRate, language: 'en' });
    note(`Speech to Text stream open at ${audio.sampleRate} Hz, request ${stt.handshakeRequestId}`);
    jobs.track('speechToText', stt.jobId); // the session is saved as a job
    try {
      const feeding = stt.feedFrom(audio.pcm); // sends the audio, then stop()
      const transcripts: Transcript[] = [];
      const errors: string[] = [];
      for await (const event of stt) {
        if (event.type === 'transcript') transcripts.push(event);
        else if (event.type === 'error') errors.push(event.code);
      }
      const summary = await feeding;
      jobs.track('speechToText', summary.jobId);
      note(`Speech to Text stream: ${transcripts.length} transcript(s), ${summary.totalSeconds} s, ${summary.creditsConsumed} credits, ${summary.reason}, saved ${summary.savedStatus}`);
      expect(errors).toEqual([]);
      expect(transcripts.length).toBeGreaterThanOrEqual(1);
      expect(transcripts.some((transcript) => transcript.text.trim().length > 0)).toBe(true);
      transcripts.forEach((transcript, index) => {
        expect(transcript.index).toBe(index);
        expect(transcript.creditsConsumed).toBeGreaterThanOrEqual(0);
      });
      expect(summary.totalSeconds).toBeGreaterThan(0);
      expect(summary.creditsConsumed).toBeGreaterThanOrEqual(0);
      expect(summary.sessionId).toBe(stt.sessionId);
      expect(['saved', null]).toContain(summary.savedStatus);
    } finally {
      await stt.close();
    }
  });

  liveTest('(16) transcribeStream transcribes the test audio', KEY, async (ctx) => {
    const audio = parseWav(from(ctx, wav, 'the test audio from test (9)'));
    const transcripts: Transcript[] = [];
    const errors: string[] = [];
    const other: string[] = [];
    const started = performance.now();
    for await (const event of api().speechToText.transcribeStream(audio.pcm, { sampleRate: audio.sampleRate, language: 'en' })) {
      if (event.type === 'transcript') transcripts.push(event);
      else if (event.type === 'session.saved') jobs.track('speechToText', event.jobId);
      else if (event.type === 'error') errors.push(event.code);
      else other.push(event.type);
    }
    note(`transcribeStream: ${transcripts.length} transcript(s) in ${since(started)}`);
    expect(errors).toEqual([]);
    expect(other.filter((type) => type === 'reconnected' || type === 'audio.dropped')).toEqual([]);
    expect(transcripts.length).toBeGreaterThanOrEqual(1);
    expect(transcripts.some((transcript) => transcript.text.trim().length > 0)).toBe(true);
  });
});
