/**
 * Text to Speech streaming: keep one socket open, get audio while it is generated,
 * barge in, and speak a stream of text deltas (from an LLM, say) sentence by sentence.
 *
 * Audio arrives as PCM16LE mono chunks at the sample rate the server announces.
 *
 *     ECHONOVA_API_KEY=ek_... node --experimental-strip-types examples/tts-stream.ts VOICE_ID reply.wav
 */

import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import EchoNova from 'echonova';
import { pcmToWav } from 'echonova/streaming';

const [voiceId, output = 'reply.wav'] = process.argv.slice(2);
if (!voiceId) {
  console.error('usage: node --experimental-strip-types examples/tts-stream.ts VOICE_ID [OUTPUT]');
  process.exit(2);
}

/** Stand-in for an LLM streaming its reply. */
async function* llmReply(): AsyncGenerator<string> {
  for (const delta of ['بالتأكيد. ', 'سيصل طلبك ', 'غداً صباحاً', '. هل تحتاج ', 'شيئاً آخر؟']) {
    await sleep(50);
    yield delta;
  }
}

const client = new EchoNova();
const tts = await client.textToSpeech.connect({ voiceId }); // streaming code loads on first use
try {
  // One reply. A real app writes each chunk to the speaker as it arrives.
  const synth = tts.synthesize('أهلاً بك، كيف يمكنني مساعدتك اليوم؟');
  const chunks: Uint8Array[] = [];
  for await (const pcm of synth) chunks.push(pcm);
  const result = await synth.result;
  console.log(
    `${result.outcome}: ${result.durationSeconds} s at ${result.sampleRate} Hz, ` +
      `first audio after ${Math.round(synth.metrics.ttfb ?? 0)} ms, ${result.creditsConsumed} credits`,
  );
  if (result.sampleRate) await writeFile(output, pcmToWav(Buffer.concat(chunks), result.sampleRate));

  // Barge-in: leaving the loop cancels the synthesis. Only the audio already sent is charged (at least 1 credit).
  const long = tts.synthesize('هذا رد أطول قليلاً، يقاطعه المستخدم قبل أن ينتهي، فيتوقف الصوت فوراً ولا يُحتسب إلا ما أُرسل منه.');
  for await (const pcm of long) {
    console.log(`got ${pcm.length} bytes, then the user started talking`);
    break;
  }
  const stopped = await long.result;
  console.log(`barge-in: ${stopped.outcome}, ${stopped.creditsConsumed} credits`);

  // A voice agent: text deltas in, gap-free audio out, one sentence at a time.
  let bytes = 0;
  for await (const pcm of tts.speakStream(llmReply())) bytes += pcm.length;
  console.log(`spoke the reply: ${bytes} bytes of audio at ${tts.sampleRate} Hz`); // the rate of the latest start
} finally {
  await tts.close();
}
