/**
 * Speech to Text streaming: send live PCM audio and print each transcript as its segment is cut.
 *
 * A microphone is simulated by sending a mono 16-bit WAV file in 100 ms frames at
 * real-time speed. With --long it uses transcribeStream(), which rolls over to a new
 * session before the session limit and reconnects after a dropped connection.
 *
 *     ECHONOVA_API_KEY=ek_... node --experimental-strip-types examples/stt-stream.ts call.wav [ar|en] [--long]
 */

import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import EchoNova from 'echonova';
import { iterFrames, parseWav } from 'echonova/streaming';

const args = process.argv.slice(2).filter((arg) => arg !== '--long');
const long = process.argv.includes('--long');
const [path, language = 'ar'] = args;
if (!path) {
  console.error('usage: node --experimental-strip-types examples/stt-stream.ts WAV_FILE [ar|en] [--long]');
  process.exit(2);
}

// Streams take raw PCM16LE mono. Convert other files first, e.g. ffmpeg -i in.mp3 -ac 1 -ar 16000 -c:a pcm_s16le out.wav
const audio = parseWav(await readFile(path));

/** Stand-in for a microphone. */
async function* microphone(): AsyncGenerator<Uint8Array> {
  for (const frame of iterFrames(audio.pcm, audio.sampleRate, 100)) {
    yield frame;
    await sleep(100);
  }
}

const client = new EchoNova();

if (long) {
  const options = { sampleRate: audio.sampleRate, language };
  for await (const event of client.speechToText.transcribeStream(microphone(), options)) {
    if (event.type === 'transcript') console.log(`[${event.index}] ${event.text}`);
    else if (event.type === 'reconnected') console.log(`new session (${event.reason})`);
    else if (event.type === 'session.saved') console.log(`saved as job ${event.jobId} (${event.status})`);
  }
} else {
  const stt = await client.speechToText.connect({ sampleRate: audio.sampleRate, language });
  try {
    const feeding = stt.feedFrom(microphone()); // sends the audio, then stop()
    for await (const event of stt) {
      if (event.type === 'transcript') console.log(`[${event.index}] ${event.text}`);
      else if (event.type === 'error') console.warn(`a segment failed: ${event.code} ${event.message}`);
    }
    const summary = await feeding;
    console.log(`${summary.totalSeconds} s, ${summary.creditsConsumed} credits; job ${summary.jobId} (${summary.savedStatus})`);
  } finally {
    await stt.close();
  }
}
