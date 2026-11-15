// The checks of the runtime smoke test, run against the mock in smoke-runtime-server.mjs.
//
// No Node.js imports here: the same checks run on Node.js, Bun, Deno, in a Cloudflare
// Worker (workerd) and in Vercel's edge-runtime emulator. The caller passes the built
// package's two entry points, the mock's URL, and `files` (temporary-file helpers) when the
// runtime has a file system, or null.

export const OK_KEY = 'ek_REDACTED_smoke_ok';
export const BROKE_KEY = 'ek_REDACTED_smoke_broke';
const BAD_KEY = 'ek_REDACTED_smoke_bad';
/** What the mock serves at /files/smoke.bin, for the download checks. */
export const DOWNLOAD_BYTES = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) % 256);

class CheckFailed extends Error {}

function expect(condition, message) {
  if (!condition) throw new CheckFailed(message);
}

const describe = (error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CheckFailed(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new CheckFailed('expected an error, but the call succeeded');
}

/** A sine tone as PCM16LE mono. */
function tone(seconds, sampleRate) {
  const samples = Math.round(seconds * sampleRate);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), true);
  return pcm;
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Run every check. Resolves to `[{ name, ok, detail }]`; never rejects.
 *
 * @param {object} options
 * @param {object} options.sdk the '@echonova/ai' module
 * @param {object} options.streaming the '@echonova/ai/streaming' module
 * @param {string} options.baseURL the mock's http:// URL
 * @param {object | null} options.files `{ path(name), write(path, bytes), read(path) }`, or null without a file system
 * @param {string} options.closedURL an http:// URL where nothing listens (connection refused)
 * @param {string} [options.expectRuntime] the runtime name the User-Agent should carry
 * @param {boolean} [options.validatesUtf8] false where the runtime's WebSocket passes invalid UTF-8
 *   on as U+FFFD instead of failing with 1007 (workerd)
 * @param {boolean} [options.reportsRefusal] false where `fetch` doesn't say whether a failed request
 *   was sent (workerd: "Network connection lost." either way), so a POST counts as maybe run
 * @param {boolean} [options.streams] false where the SDK doesn't stream (Vercel Edge): the checks
 *   that open a stream are skipped, and one check expects connecting to fail at once instead
 */
export async function runChecks({
  sdk,
  streaming,
  baseURL,
  files,
  closedURL,
  expectRuntime,
  validatesUtf8 = true,
  reportsRefusal = true,
  streams = true,
  downloadBytes = DOWNLOAD_BYTES,
}) {
  const { EchoNova } = sdk;
  const results = [];
  const client = (apiKey, { scenario, ...options } = {}) =>
    new EchoNova({
      apiKey,
      baseURL,
      maxRetries: 0,
      stream: { openTimeout: 5_000, ...(scenario ? { query: () => ({ scenario }) } : {}) },
      ...options,
    });
  const ok = client(OK_KEY);

  async function check(name, body) {
    try {
      const detail = await withTimeout(Promise.resolve().then(body), 15_000, name);
      results.push({ name, ok: true, detail: detail ?? '' });
    } catch (error) {
      results.push({ name, ok: false, detail: describe(error) });
    }
  }
  /** A check that opens a stream: not run where the SDK doesn't stream. */
  const streamCheck = streams ? check : async () => {};

  await check('entry points load', () => {
    expect(typeof EchoNova === 'function' && sdk.default === EchoNova, "'@echonova/ai' exports the client");
    expect(typeof streaming.connectTts === 'function' && typeof streaming.pcmToWav === 'function', "'@echonova/ai/streaming' exports its helpers");
    expect(new sdk.InsufficientBalanceError() instanceof sdk.APIStatusError, 'error classes are exported');
    return `echonova ${sdk.VERSION}`;
  });

  await check('REST: voices.list', async () => {
    const { data: voices, response } = await ok.textToSpeech.voices.list().withResponse();
    expect(voices.items.length === 2 && voices.items[0].language === 'ar', `unexpected voices: ${JSON.stringify(voices.items)}`);
    expect(typeof voices.requestId === 'string' && voices.requestId.startsWith('req-'), 'the result carries the request id');
    const agent = response.headers.get('x-smoke-user-agent');
    expect(!expectRuntime || agent?.includes(`(${expectRuntime}`), `User-Agent ${agent}`);
    return `${voices.items.length} voices; User-Agent: ${agent}`;
  });

  await check('REST: 401 is AuthenticationError with the request id', async () => {
    const error = await rejection(client(BAD_KEY).textToSpeech.voices.list());
    expect(error instanceof sdk.AuthenticationError, `got ${describe(error)}`);
    expect(error.statusCode === 401 && error.errorMessage === 'Unauthorized', `status ${error.statusCode}, message ${error.errorMessage}`);
    expect(typeof error.requestId === 'string' && error.requestId.startsWith('req-'), `request id ${error.requestId}`);
    expect(error.docsUrl === 'https://echonova.ai/docs/developers/authentication', `docs ${error.docsUrl}`);
    return `${error.statusCode} ${error.requestId}`;
  });

  if (!streams) {
    await check('no streaming: connect and transcribeStream fail at once with UnsupportedEnvironmentError', async () => {
      const started = Date.now();
      const errors = [
        await rejection(ok.textToSpeech.connect({ voiceId: '66e5ef3a9c1d2b4f8a7e6c01' })),
        await rejection(ok.speechToText.connect({ sampleRate: 16_000, language: 'ar' })),
        await rejection(ok.speechToText.transcribeStream(tone(0.1, 16_000), { sampleRate: 16_000, language: 'ar' }).next()),
      ];
      const elapsed = Date.now() - started;
      for (const error of errors) expect(error instanceof sdk.UnsupportedEnvironmentError, `got ${describe(error)}`);
      // Well under the 5 s open timeout: refused before any connection attempt.
      expect(elapsed < 1_000, `after ${elapsed} ms`);
      return errors[0].message;
    });
  }

  await streamCheck('TTS stream: synthesize, PCM, done', async () => {
    const tts = await ok.textToSpeech.connect({ voiceId: '66e5ef3a9c1d2b4f8a7e6c01' });
    try {
      const synth = tts.synthesize('مرحبا بكم');
      let bytes = 0;
      let chunks = 0;
      for await (const pcm of synth) {
        expect(pcm instanceof Uint8Array && pcm.length % 2 === 0, 'audio arrives as whole PCM16 samples');
        bytes += pcm.length;
        chunks += 1;
      }
      const result = await synth.result;
      expect(result.outcome === 'completed', `outcome ${result.outcome}`);
      expect(synth.sampleRate === 24_000, `sample rate ${synth.sampleRate}`);
      expect(bytes === 3 * 4_800 && chunks === 3, `${chunks} chunks, ${bytes} bytes`);
      expect(result.creditsConsumed === 9 && result.charged === true, `credits ${result.creditsConsumed}, charged ${result.charged}`);
      // A second synthesis on the same socket.
      const audio = await tts.synthesize('second').collect();
      expect(audio.pcm.length === 3 * 4_800, `second synthesis: ${audio.pcm.length} bytes`);
      return `${chunks} chunks, ${bytes} bytes at ${synth.sampleRate} Hz; second synthesis ok`;
    } finally {
      await tts.close();
    }
  });

  await streamCheck('STT stream: session.started, audio, transcript, session.ended', async () => {
    const stt = await ok.speechToText.connect({ sampleRate: 16_000, language: 'ar' });
    let closed = false;
    try {
      expect(typeof stt.sessionId === 'string' && typeof stt.jobId === 'string', 'session.started gave the session and job ids');
      await stt.sendAudio(tone(0.5, 16_000));
      const mark = await stt.endSegment();
      await stt.sendAudio(tone(0.3, 16_000));
      const events = [];
      const reading = (async () => {
        for await (const event of stt) events.push(event);
      })();
      const summary = await stt.stop();
      closed = true;
      await reading;
      const transcripts = events.filter((e) => e.type === 'transcript');
      expect(transcripts.length === 2, `${transcripts.length} transcripts: ${JSON.stringify(events.map((e) => e.type))}`);
      expect(transcripts[0].text === 'smoke segment 1', `first transcript ${JSON.stringify(transcripts[0].text)}`);
      expect(mark.index === 0 && Math.abs(mark.audioOffsetSeconds - 0.5) < 1e-6, `segment mark ${JSON.stringify(mark)}`);
      expect(summary.reason === 'stopped', `reason ${summary.reason}`);
      expect(summary.jobId === stt.jobId && summary.savedStatus === 'saved', `job ${summary.jobId}, saved ${summary.savedStatus}`);
      expect(Math.abs(summary.totalSeconds - 0.8) < 1e-6, `total ${summary.totalSeconds}`);
      return `${transcripts.length} transcripts, ${summary.totalSeconds} s, saved as ${summary.jobId}`;
    } finally {
      if (!closed) await stt.close();
    }
  });

  await streamCheck('stream handshake: 402 is InsufficientBalanceError with status and body', async () => {
    const error = await rejection(client(BROKE_KEY).textToSpeech.connect({ voiceId: '66e5ef3a9c1d2b4f8a7e6c01' }));
    expect(error instanceof sdk.InsufficientBalanceError, `got ${describe(error)}`);
    expect(error.statusCode === 402, `status ${error.statusCode}`);
    expect(error.transport === 'websocket', `transport ${error.transport}`);
    expect(error.errorMessage === 'Insufficient subscription balance', `message ${error.errorMessage}`);
    expect(typeof error.rawBody === 'string' && error.rawBody.includes('"statusCode":402'), `body ${error.rawBody}`);
    expect(typeof error.requestId === 'string' && error.requestId.startsWith('req-'), `request id ${error.requestId}`);
    return `${error.statusCode} ${error.errorMessage} (${error.requestId})`;
  });

  await streamCheck('stream handshake: 401 is AuthenticationError', async () => {
    const error = await rejection(client(BAD_KEY).speechToText.connect({ sampleRate: 16_000, language: 'en' }));
    expect(error instanceof sdk.AuthenticationError && error.statusCode === 401, `got ${describe(error)}`);
    expect(typeof error.requestId === 'string', `request id ${error.requestId}`);
    return `${error.statusCode} ${error.requestId}`;
  });

  const wav = streaming.pcmToWav(tone(1, 16_000), 16_000);
  if (files) {
    await check('file path: speechToText.transcribe uploads from disk', async () => {
      const path = files.path('smoke upload.wav');
      await files.write(path, wav);
      const result = await ok.speechToText.transcribe({ file: path, language: 'ar' });
      const received = JSON.parse(result.transcription);
      expect(received.filename === 'smoke upload.wav' && received.type === 'audio/wav', `received ${result.transcription}`);
      expect(received.bytes === wav.length && received.sha256 === (await sha256(wav)), 'the server received the file unchanged');
      return `${received.bytes} bytes as ${received.type}${received.chunked ? ', chunked' : ''}`;
    });

    await check('file path: client.download saves to disk', async () => {
      const path = files.path('smoke.bin');
      const saved = await ok.download(`${baseURL}/files/smoke.bin`, { to: path });
      const bytes = await files.read(saved);
      expect(bytes.length === downloadBytes.length && bytes.every((b, i) => b === downloadBytes[i]), 'the saved file matches');
      return `${bytes.length} bytes to ${saved.split(/[\\/]/).pop()}`;
    });
  } else {
    await check('no file system: a file path fails with UnsupportedEnvironmentError', async () => {
      const error = await rejection(ok.speechToText.transcribe({ file: 'smoke.wav', language: 'ar' }));
      expect(error instanceof sdk.UnsupportedEnvironmentError, `got ${describe(error)}`);
      const download = await rejection(ok.download(`${baseURL}/files/smoke.bin`, { to: 'smoke.bin' }));
      expect(download instanceof sdk.UnsupportedEnvironmentError, `download: got ${describe(download)}`);
      return error.message;
    });
  }

  await check('upload from memory: toFile', async () => {
    const result = await ok.speechToText.transcribe({ file: sdk.toFile(wav, 'memory.wav'), language: 'en' });
    const received = JSON.parse(result.transcription);
    expect(received.bytes === wav.length && received.type === 'audio/wav', `received ${result.transcription}`);
    return `${received.bytes} bytes`;
  });

  await check('download to memory', async () => {
    const bytes = await ok.download(`${baseURL}/files/smoke.bin`);
    expect(bytes instanceof Uint8Array && bytes.length === downloadBytes.length, `got ${bytes?.length} bytes`);
    return `${bytes.length} bytes`;
  });

  // Edge cases: the same SDK-level outcome is expected on every runtime.
  const voiceId = '66e5ef3a9c1d2b4f8a7e6c01';

  await streamCheck('stream: a dropped connection is StreamConnectionLostError, charge state yes', async () => {
    const tts = await client(OK_KEY, { scenario: 'drop' }).textToSpeech.connect({ voiceId });
    try {
      const synth = tts.synthesize('hello');
      let bytes = 0;
      const error = await rejection(
        (async () => {
          for await (const pcm of synth) bytes += pcm.length;
        })(),
      );
      expect(error instanceof sdk.StreamConnectionLostError, `got ${describe(error)}`);
      expect(bytes === 4_800 && synth.chargeState === 'yes', `${bytes} bytes, charge state ${synth.chargeState}`);
      return error.message;
    } finally {
      await tts.close();
    }
  });

  await streamCheck('stream: a 4008 close, then a lazy reconnect', async () => {
    const tts = await client(OK_KEY, { scenario: 'close4008' }).textToSpeech.connect({ voiceId });
    try {
      const first = await tts.synthesize('one').collect();
      for (let i = 0; i < 50 && tts.connected; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(!tts.connected, 'the session saw the close');
      const second = await tts.synthesize('two').collect();
      expect(first.pcm.length === 14_400 && second.pcm.length === 14_400, `${first.pcm.length} and ${second.pcm.length} bytes`);
      return 'reconnected';
    } finally {
      await tts.close();
    }
  });

  await streamCheck('stream: close 4002 after a transcript is InsufficientBalanceError, events kept', async () => {
    const stt = await client(OK_KEY, { scenario: 'balance' }).speechToText.connect({ sampleRate: 16_000, language: 'ar' });
    try {
      await stt.sendAudio(tone(0.5, 16_000));
      await stt.endSegment();
      const events = [];
      const error = await rejection(
        (async () => {
          for await (const event of stt) events.push(event.type);
        })(),
      );
      expect(error instanceof sdk.InsufficientBalanceError && error.closeCode === 4002, `got ${describe(error)}, close ${error.closeCode}`);
      expect(events[0] === 'transcript' && events.includes('session.ended'), `events ${events}`);
      return `${events.join(', ')}; then ${error.message}`;
    } finally {
      await stt.close();
    }
  });

  await streamCheck('stream: a service failure at connect is UpstreamError with the server message, close 1011', async () => {
    const stt = client(OK_KEY, { scenario: 'unreachable' }).speechToText.connect({ sampleRate: 16_000, language: 'ar' });
    const error = await rejection(stt);
    expect(error instanceof sdk.UpstreamError, `got ${describe(error)}`);
    expect(error.errorMessage === 'speech service unavailable' && error.closeCode === 1011, `message ${error.errorMessage}, close ${error.closeCode}`);
    return error.message;
  });

  if (!validatesUtf8) {
    await streamCheck('stream: invalid UTF-8 arrives as U+FFFD text, an unknown event (no 1007 here)', async () => {
      const tts = await client(OK_KEY, { scenario: 'badutf8' }).textToSpeech.connect({ voiceId });
      try {
        tts.synthesize('hello');
        for (let i = 0; i < 100 && tts.unknownEvents.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        const raw = JSON.stringify(tts.unknownEvents);
        expect(tts.connected && raw.includes('\ufffd'), `connected ${tts.connected}, unknown events ${raw}`);
        return raw;
      } finally {
        await tts.close();
      }
    });
  }
  for (const [scenario, code] of validatesUtf8 ? [['badutf8', 1007], ['oversize', 1009]] : [['oversize', 1009]]) {
    await streamCheck(`stream: a protocol violation (${scenario}) is ProtocolError ${code}`, async () => {
      const tts = await client(OK_KEY, { scenario }).textToSpeech.connect({ voiceId });
      try {
        const error = await rejection(tts.synthesize('hello').collect());
        expect(error instanceof sdk.ProtocolError && error.closeCode === code, `got ${describe(error)}, close ${error.closeCode}`);
        return error.message;
      } finally {
        await tts.close();
      }
    });
  }

  await streamCheck('stream: an unanswered upgrade times out (APITimeoutError)', async () => {
    const started = Date.now();
    const timedOut = client(OK_KEY, { scenario: 'hang', stream: { openTimeout: 1_000, query: () => ({ scenario: 'hang' }) } });
    const error = await rejection(timedOut.textToSpeech.connect({ voiceId }));
    const elapsed = Date.now() - started;
    expect(error instanceof sdk.APITimeoutError, `got ${describe(error)}`);
    expect(elapsed >= 900 && elapsed < 4_000, `after ${elapsed} ms`);
    return `after ${elapsed} ms`;
  });

  await streamCheck('stream: an aborted connect rejects with the abort reason', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await rejection(client(OK_KEY, { scenario: 'hang' }).textToSpeech.connect({ voiceId, signal: controller.signal }));
    expect(error?.name === 'AbortError', `got ${describe(error)}`);
    return describe(error);
  });

  await streamCheck('stream: a 503 handshake is retried', async () => {
    const scenario = `busy:${crypto.randomUUID()}`;
    const tts = await client(OK_KEY, { scenario, maxRetries: 2 }).textToSpeech.connect({ voiceId });
    await tts.close();
    return 'connected on the second attempt';
  });

  if (closedURL) {
    const refused = new EchoNova({ apiKey: OK_KEY, baseURL: closedURL, maxRetries: 0 });
    await streamCheck('connection refused: stream APIConnectionError', async () => {
      const error = await rejection(refused.textToSpeech.connect({ voiceId }));
      expect(error instanceof sdk.APIConnectionError && !(error instanceof sdk.APITimeoutError), `got ${describe(error)}`);
      return error.message;
    });
    await check(`connection refused: a POST ${reportsRefusal ? 'did not run' : 'may have run (the runtime cannot tell)'}`, async () => {
      const error = await rejection(refused.textToSpeech.jobs.create({ text: 'hi', voiceId }));
      expect(error instanceof sdk.APIConnectionError, `got ${describe(error)}`);
      expect(error.mayHaveExecuted === !reportsRefusal, `mayHaveExecuted ${error.mayHaveExecuted}: ${error.message}`);
      return error.message;
    });
  }

  await ok.close();
  return results;
}

/** Print results; returns true when every check passed. */
export function report(label, results, print = console.log) {
  for (const { name, ok, detail } of results) print(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  print(failed ? `${label}: ${failed} of ${results.length} checks failed` : `${label}: all ${results.length} checks passed`);
  return failed === 0;
}
