// Runtime smoke test of the BUILT package in Cloudflare's workerd (run `npm run build` first).
//
// Bundles smoke-runtime-worker.mjs with the package the way wrangler does (esbuild, conditions
// workerd/worker/browser) and runs it in workerd through Miniflare, without and with the
// nodejs_compat flag, against the local mock (smoke-runtime-server.mjs). Miniflare is not a
// dependency of the package; install it anywhere and point ECHONOVA_SMOKE_MINIFLARE at that folder:
//
//   npm install --prefix /tmp/workerd miniflare
//   ECHONOVA_SMOKE_MINIFLARE=/tmp/workerd node scripts/smoke-runtime-workerd.mjs
//
// ECHONOVA_SMOKE_COMPAT_DATE sets the Worker's compatibility date (default below; it must not be
// newer than the installed workerd supports).

import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { report } from './smoke-runtime-checks.mjs';
import { startMockServer } from './smoke-runtime-server.mjs';

const COMPATIBILITY_DATE = process.env.ECHONOVA_SMOKE_COMPAT_DATE ?? '2026-07-30';

async function loadMiniflare() {
  const dir = process.env.ECHONOVA_SMOKE_MINIFLARE;
  try {
    const require = createRequire(dir ? join(dir, 'noop.js') : import.meta.url);
    return await import(pathToFileURL(require.resolve('miniflare')).href);
  } catch (error) {
    console.error(`Miniflare could not be loaded${dir ? ` from ${dir}` : ''}: ${error.message}`);
    console.error('Install it (npm install --prefix /tmp/workerd miniflare) and set ECHONOVA_SMOKE_MINIFLARE=/tmp/workerd.');
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

const { Miniflare } = await loadMiniflare();
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./smoke-runtime-worker.mjs', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'],
  external: ['node:*', 'cloudflare:*'],
  logLevel: 'warning',
});
const worker = bundled.outputFiles[0].text;

const mock = await startMockServer();
const query = `base=${encodeURIComponent(mock.url)}&closed=${encodeURIComponent(await closedURL())}`;
let passed = true;
try {
  for (const flags of [[], ['nodejs_compat']]) {
    const label = `workerd (compatibility date ${COMPATIBILITY_DATE}${flags.length ? `, ${flags.join(', ')}` : ''})`;
    // Modules are listed explicitly, as wrangler does, so Miniflare doesn't scan the bundle's dynamic imports.
    const mf = new Miniflare({
      modules: [{ type: 'ESModule', path: 'worker.mjs', contents: worker }],
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: flags,
    });
    try {
      const response = await mf.dispatchFetch(`http://localhost/?${query}`);
      const text = await response.text();
      let results;
      try {
        results = JSON.parse(text);
      } catch {
        results = [{ name: 'the worker answered', ok: false, detail: `${response.status} ${text.slice(0, 2000)}` }];
      }
      console.log(`runtime smoke test on ${label} against ${mock.url}`);
      passed = report(label, results) && passed;
    } finally {
      await mf.dispose();
    }
  }
} finally {
  await mock.close();
}
process.exit(passed ? 0 : 1);
