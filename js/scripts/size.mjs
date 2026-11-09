// Fail if the REST core grows past its size budget (minified + gzipped, no
// runtime dependencies). Run after `npm run build`.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 25 * 1024;

const result = await build({
  entryPoints: [new URL('../dist/index.js', import.meta.url).pathname],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'warning',
});
const code = result.outputFiles[0].contents;
const gzipped = gzipSync(code, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`core bundle: ${kb(code.length)} minified, ${kb(gzipped)} min+gz (budget ${kb(BUDGET_BYTES)})`);
if (gzipped > BUDGET_BYTES) {
  console.error('over the size budget');
  process.exit(1);
}
