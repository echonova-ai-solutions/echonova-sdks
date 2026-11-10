/**
 * Speech to Text as an async job, exported as subtitles and as JSON.
 *
 *     ECHONOVA_API_KEY=ek_... node --experimental-strip-types examples/stt-job-export.ts meeting.wav
 */

import { writeFile } from 'node:fs/promises';
import EchoNova from 'echonova';

const [path] = process.argv.slice(2);
if (!path) {
  console.error('usage: node --experimental-strip-types examples/stt-job-export.ts AUDIO_FILE');
  process.exit(2);
}

const client = new EchoNova();

const job = await client.speechToText.jobs.create({ file: path, language: 'en', identifySpeakers: true });
const done = await client.speechToText.jobs.wait(job); // polls every 5 s

const srt = await client.speechToText.jobs.export(done, { format: 'srt' }); // string
const srtPath = `${path.replace(/\.[^./\\]+$/, '')}.srt`;
await writeFile(srtPath, srt, 'utf8');
console.log(`saved ${srtPath}`);

const data = await client.speechToText.jobs.export(done, { format: 'json' }); // TranscriptExport
for (const speaker of data.speakers ?? []) console.log(`${speaker.label}: ${speaker.talkTime} s`);

await client.speechToText.jobs.delete(done);
