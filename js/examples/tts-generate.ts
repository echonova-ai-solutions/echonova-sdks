/**
 * Text to Speech: pick a voice, synthesize a sentence, save the WAV.
 *
 *     ECHONOVA_API_KEY=ek_... node --experimental-strip-types examples/tts-generate.ts "أهلاً بك في إيكونوفا" speech.wav
 */

import EchoNova from 'echonova';

const [text = 'أهلاً بك في إيكونوفا', output = 'speech.wav'] = process.argv.slice(2);

const client = new EchoNova(); // reads ECHONOVA_API_KEY

const voices = await client.textToSpeech.voices.list(); // changes rarely: cache it in a real app
const voice = voices.items.find((v) => v.language === 'ar');
if (!voice) throw new Error('no Arabic voice is available');

const speech = await client.textToSpeech.generate({ text, voiceId: voice.id });
console.log(`${speech.durationSeconds} s of audio, ${speech.creditsConsumed} credits (request ${speech.requestId})`);
await client.download(speech.audioUrl, { to: output }); // the signed link expires; download it now
console.log(`saved ${output}`);
