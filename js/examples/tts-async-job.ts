/**
 * Text to Speech as an async job: create it, wait for it, download it, delete it.
 *
 *     ECHONOVA_API_KEY=ek_... node --experimental-strip-types examples/tts-async-job.ts VOICE_ID
 */

import EchoNova from '@echonova/ai';

const [voiceId] = process.argv.slice(2);
if (!voiceId) {
  console.error('usage: node --experimental-strip-types examples/tts-async-job.ts VOICE_ID');
  process.exit(2);
}

const client = new EchoNova();

const job = await client.textToSpeech.jobs.create({ text: 'مرحبا، هذه رسالة تجريبية.', voiceId });
console.log(`job ${job.jobId} is ${job.status}`);

// Polls every 3 s, for up to 20 minutes. Without raiseOnFailure: false, a failed job throws JobFailedError.
const done = await client.textToSpeech.jobs.wait(job, { raiseOnFailure: false });
if (done.status === 'failed') {
  console.error(`the job failed: ${done.error}`);
  process.exit(1);
}
await client.textToSpeech.jobs.download(done, { to: 'job.wav' }); // gets a fresh link first
await client.textToSpeech.jobs.delete(done);
console.log('saved job.wav and deleted the job');

for await (const recent of client.textToSpeech.jobs.list({ limit: 20 })) { // iterating walks every page
  if (recent.status === 'failed') console.log('failed earlier:', recent.id, recent.error);
}
