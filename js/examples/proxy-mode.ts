/**
 * Proxy mode: call EchoNova through your own backend, with no EchoNova key in this process.
 *
 * Your backend forwards /v1/... to https://api.echonova.ai and adds the API key
 * (see ../../proxy-examples). This client only sends your app's own credentials.
 *
 *     APP_TOKEN=... node --experimental-strip-types examples/proxy-mode.ts https://api.example.com/echonova
 */

import EchoNova from 'echonova';

const [baseURL] = process.argv.slice(2);
const appToken = process.env['APP_TOKEN'];
if (!baseURL || !appToken) {
  console.error('usage: APP_TOKEN=... node --experimental-strip-types examples/proxy-mode.ts PROXY_URL');
  process.exit(2);
}

const client = new EchoNova({
  baseURL,
  // Called before every request. With `auth` set, ECHONOVA_API_KEY is never read.
  auth: () => ({ Authorization: `Bearer ${appToken}` }),
});

for (const voice of await client.textToSpeech.voices.list()) {
  console.log(voice.id, voice.displayName, voice.language);
}
