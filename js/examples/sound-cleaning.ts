/**
 * Sound Cleaning: clean a recording, save the result, delete the job.
 *
 *     ECHONOVA_API_KEY=ek_... node --experimental-strip-types examples/sound-cleaning.ts noisy.wav clean.wav
 */

import EchoNova from '@echonova/ai';

const [source, output = 'clean.wav'] = process.argv.slice(2);
if (!source) {
  console.error('usage: node --experimental-strip-types examples/sound-cleaning.ts INPUT [OUTPUT]');
  process.exit(2);
}

const client = new EchoNova();

const job = await client.soundCleaning.clean({ file: source, targetLufs: -16, sampleRate: 48000, bitDepth: 24 });
if (job.metrics) console.log(`loudness ${job.metrics.integratedLufs} LUFS, peak ${job.metrics.truePeakDbfs} dBFS`);
await client.download(job.outputUrl, { to: output }); // the signed link expires; download it now
await client.soundCleaning.jobs.delete(job);
console.log(`saved ${output} (${job.creditsConsumed} credits)`);
