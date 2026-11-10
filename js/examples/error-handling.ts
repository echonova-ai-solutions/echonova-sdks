/**
 * Handle errors, including a request whose response was lost.
 *
 * A POST that was fully sent may have run and been charged even if no response
 * arrived. The SDK never sends it again on its own; this shows how to check.
 *
 *     ECHONOVA_API_KEY=ek_... node --experimental-strip-types examples/error-handling.ts VOICE_ID
 */

import EchoNova, {
  APIConnectionError,
  APIStatusError,
  InvalidRequestError,
  RateLimitError,
  SpendingLimitError,
} from 'echonova';

const [voiceId] = process.argv.slice(2);
if (!voiceId) {
  console.error('usage: node --experimental-strip-types examples/error-handling.ts VOICE_ID');
  process.exit(2);
}
const text = 'مرحبا';

const client = new EchoNova();
try {
  const speech = await client.textToSpeech.generate({ text, voiceId });
  console.log('audio:', Boolean(speech.audioUrl));
} catch (err) {
  if (err instanceof InvalidRequestError) {
    console.log(`rejected: ${err.errorMessage} (request ${err.requestId})`);
  } else if (err instanceof SpendingLimitError) {
    console.log('the key reached its Credit Limit; raise it in the portal');
  } else if (err instanceof RateLimitError) {
    console.log(`still rate limited after retries; try again in ${err.retryAfter} s`);
  } else if (err instanceof APIConnectionError) {
    if (err.mayHaveExecuted === false) {
      console.log('the request did not run; it is safe to send it again');
    } else if (err.sentAt) {
      // true or null (unknown): it may have run and been charged
      const candidates = await client.textToSpeech.jobs.findCandidates(err.sentAt, { text });
      console.log(`no response, but ${candidates.length} matching job(s) exist; check them before retrying`);
    } else {
      console.log('the request may have run; check your recent jobs before sending it again');
    }
  } else if (err instanceof APIStatusError) {
    console.log(`${err.statusCode} ${err.errorMessage} (request ${err.requestId})`);
  } else {
    throw err;
  }
}
