// Spike: can a Node WebSocket client read a rejected handshake (status, headers, body)?
//
// The SDK maps a refused stream connection (401, 402, 403, 429, 503...) through the
// same error rules as REST, so it needs the HTTP response behind the failed upgrade.
// The `ws` package exposes it through the 'unexpected-response' event; Node's built-in
// WebSocket does not.
//
// Makes ONE connection with no Authorization header, so it is rejected before any
// work or billing:
//
//     node scripts/spike-handshake.mjs
//
// Expected: 401 with the JSON error envelope and an X-Request-Id header.

import WebSocket from 'ws';

const url = process.argv[2] ?? 'wss://api.echonova.ai/v1/text-to-speech/stream';
const INTERESTING = ['content-type', 'x-request-id', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining'];

const result = await new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { headers: { 'User-Agent': 'echonova-js-spike' }, handshakeTimeout: 10_000 });
  ws.on('unexpected-response', (request, response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      request.destroy();
      resolve({
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: Object.fromEntries(INTERESTING.filter((h) => h in response.headers).map((h) => [h, response.headers[h]])),
        body: Buffer.concat(chunks).toString('utf8'),
      });
    });
    response.on('error', reject);
  });
  ws.on('open', () => {
    ws.close(1000);
    reject(new Error('the handshake was accepted without credentials (unexpected)'));
  });
  ws.on('error', (error) => {
    if (error.message.startsWith('Unexpected server response')) return; // reported via 'unexpected-response'
    reject(error);
  });
});

let envelope = null;
try {
  envelope = JSON.parse(result.body);
} catch {
  // not JSON: printed raw below
}

console.log(`status:  ${result.status} ${result.statusText}`);
console.log(`headers: ${JSON.stringify(result.headers)}`);
console.log(`body:    ${envelope ? JSON.stringify(envelope) : result.body.slice(0, 500)}`);
console.log(
  `readable: status=${typeof result.status === 'number'} request_id=${Boolean(result.headers['x-request-id'])} ` +
    `envelope=${Boolean(envelope && 'errorMessage' in envelope)}`,
);
