// Runtime smoke test of the BUILT package in Vercel's edge-runtime emulator (run `npm run build` first).
//
// Bundles smoke-runtime-edge-function.mjs with the package the way Vercel bundles an Edge Function
// (esbuild, browser platform, conditions edge-light and browser: `vercel dev` uses edge-light on the
// browser platform, which adds browser; Next.js resolves edge-light, then webpack's browser
// conditions) and runs it as a script in the emulator against the local mock
// (smoke-runtime-server.mjs): the REST checks, and that streams and file paths fail with
// UnsupportedEnvironmentError. The emulator stands in for Vercel Edge; it is not Vercel's
// production runtime. edge-runtime is not a dependency of the package; install it anywhere and
// point ECHONOVA_SMOKE_EDGE_RUNTIME at that folder:
//
//   npm install --prefix /tmp/edge edge-runtime
//   ECHONOVA_SMOKE_EDGE_RUNTIME=/tmp/edge node scripts/smoke-runtime-edge.mjs

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { report } from './smoke-runtime-checks.mjs';
import { startMockServer } from './smoke-runtime-server.mjs';

async function loadEdgeRuntime() {
  const dir = process.env.ECHONOVA_SMOKE_EDGE_RUNTIME;
  try {
    const require = createRequire(dir ? join(dir, 'noop.js') : import.meta.url);
    const module = await import(pathToFileURL(require.resolve('edge-runtime')).href);
    const { version } = JSON.parse(readFileSync(require.resolve('edge-runtime/package.json'), 'utf8'));
    return { EdgeRuntime: module.EdgeRuntime ?? module.default.EdgeRuntime, version };
  } catch (error) {
    console.error(`edge-runtime could not be loaded${dir ? ` from ${dir}` : ''}: ${error.message}`);
    console.error('Install it (npm install --prefix /tmp/edge edge-runtime) and set ECHONOVA_SMOKE_EDGE_RUNTIME=/tmp/edge.');
    process.exit(2);
  }
}

async function closedURL() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

const { EdgeRuntime, version } = await loadEdgeRuntime();
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./smoke-runtime-edge-function.mjs', import.meta.url))],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  conditions: ['edge-light', 'browser'],
  logLevel: 'warning',
});
const code = bundled.outputFiles[0].text;

const mock = await startMockServer();
const query = `base=${encodeURIComponent(mock.url)}&closed=${encodeURIComponent(await closedURL())}`;
const label = `Vercel edge-runtime ${version}`;
let passed = false;
try {
  const runtime = new EdgeRuntime({
    initialCode: code,
    // An Edge Function on Vercel has `process.env` and nothing else of `process`, as `vercel dev` sets it up.
    extend: (context) => Object.assign(context, { process: { env: {} } }),
  });
  const response = await runtime.dispatchFetch(`http://localhost/?${query}`);
  const text = await response.text();
  let results;
  try {
    results = JSON.parse(text);
  } catch {
    results = [{ name: 'the Edge Function answered', ok: false, detail: `${response.status} ${text.slice(0, 2000)}` }];
  }
  const upgrades = mock.log.filter((entry) => entry.kind === 'ws').length;
  results.push({ name: 'no stream reached the mock', ok: upgrades === 0, detail: `${upgrades} WebSocket upgrades` });
  console.log(`runtime smoke test on ${label} against ${mock.url}`);
  passed = report(label, results);
} finally {
  await mock.close();
}
process.exit(passed ? 0 : 1);
