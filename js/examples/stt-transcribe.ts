/**
 * Speech to Text: transcribe a file with your own terminology and speaker labels.
 *
 *     ECHONOVA_API_KEY=ek_... node --experimental-strip-types examples/stt-transcribe.ts call.mp3
 */

import EchoNova, { type Terminology } from '@echonova/ai';

const [path] = process.argv.slice(2);
if (!path) {
  console.error('usage: node --experimental-strip-types examples/stt-transcribe.ts AUDIO_FILE');
  process.exit(2);
}

const terminology: Terminology = {
  keywords: ['KYC', { term: 'Emirates NBD', variants: ['امريتس ان بي دي'] }],
};

const client = new EchoNova();
const result = await client.speechToText.transcribe({ file: path, language: 'ar', identifySpeakers: true, terminology });

console.log(result.transcription);
if (result.terminology) console.log('with your terms:', result.terminology.corrected);
for (const segment of result.segments) {
  console.log(`${segment.start.toFixed(2).padStart(7)}  ${(segment.speaker ?? '-').padStart(6)}  ${segment.text}`);
}
console.log(`${result.creditsConsumed} credits (request ${result.requestId})`);
