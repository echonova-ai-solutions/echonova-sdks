// Runtime smoke test of the BUILT package (run `npm run build` first) on Node.js, Bun or Deno:
//
//   node scripts/smoke-runtime.mjs
//   bun scripts/smoke-runtime.mjs
//   deno run -A scripts/smoke-runtime.mjs
//
// It starts the local mock API (smoke-runtime-server.mjs, under Node.js: `node` must be on the
// PATH, or set ECHONOVA_SMOKE_NODE), imports '@echonova/ai' and '@echonova/ai/streaming' by name, and
// runs the checks in smoke-runtime-checks.mjs: REST, error mapping, both streams, a refused
// stream handshake, and file-path uploads and downloads. Set ECHONOVA_SMOKE_URL to use a mock
// that is already running. No network access and no API key are needed.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { OK_KEY, report, runChecks } from './smoke-runtime-checks.mjs';

function runtime() {
  if (globalThis.Deno?.version?.deno) return { name: 'deno', label: `Deno ${globalThis.Deno.version.deno}` };
  if (process.versions.bun) return { name: 'bun', label: `Bun ${process.versions.bun}` };
  return { name: 'node', label: `Node.js ${process.versions.node}` };
}

/** An http:// URL on a port where nothing listens. */
async function closedURL() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** Start the mock under Node.js in a child process; resolves to `{ url, stop() }`. */
async function startMock() {
  if (process.env.ECHONOVA_SMOKE_URL) return { url: process.env.ECHONOVA_SMOKE_URL, stop: async () => {} };
  const node = process.env.ECHONOVA_SMOKE_NODE ?? (process.versions.bun || globalThis.Deno ? 'node' : process.execPath);
  const script = fileURLToPath(new URL('./smoke-runtime-server.mjs', import.meta.url));
  const child = spawn(node, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    child.on('error', (error) => reject(new Error(`could not start the mock with ${node}: ${error.message}`)));
    child.on('exit', (code) => reject(new Error(`the mock exited with ${code} before it was ready`)));
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n')[0];
      if (out.includes('\n')) resolve(JSON.parse(line).url);
    });
  });
  child.removeAllListeners('exit');
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    });
  return { url, stop };
}

const { name, label } = runtime();
const mock = await startMock();
const dir = await mkdtemp(join(tmpdir(), 'echonova-smoke-'));
let passed = false;
try {
  const sdk = await import('@echonova/ai');
  const streaming = await import('@echonova/ai/streaming');
  const files = {
    path: (name) => join(dir, name),
    write: (path, bytes) => writeFile(path, bytes),
    read: async (path) => new Uint8Array(await readFile(path)),
  };
  const results = await runChecks({ sdk, streaming, baseURL: mock.url, files, closedURL: await closedURL(), expectRuntime: name });

  // The CommonJS build, through require().
  try {
    const require = createRequire(import.meta.url);
    const cjs = require('@echonova/ai');
    const cjsStreaming = require('@echonova/ai/streaming');
    const voices = await new cjs.EchoNova({ apiKey: OK_KEY, baseURL: mock.url }).textToSpeech.voices.list();
    if (voices.items.length !== 2 || typeof cjsStreaming.connectStt !== 'function') throw new Error('unexpected exports or result');
    if (!(new cjs.AuthenticationError() instanceof sdk.APIStatusError)) throw new Error('instanceof fails across the builds');
    results.push({ name: 'CommonJS build: require() and a REST call', ok: true, detail: '' });
  } catch (error) {
    results.push({ name: 'CommonJS build: require() and a REST call', ok: false, detail: String(error) });
  }

  console.log(`runtime smoke test on ${label} against ${mock.url}`);
  passed = report(label, results);
} finally {
  await rm(dir, { recursive: true, force: true });
  await mock.stop();
}
process.exit(passed ? 0 : 1);
