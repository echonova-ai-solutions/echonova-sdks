// Fail if the SDK grows past its size budgets (minified + gzipped). Run after `npm run build`.
//  - REST: what `import { EchoNova } from 'echonova'` costs. Streaming is reached only through
//    import(), so it is left out here, as it is for anyone who never opens a stream.
//  - Streaming: the lazily loaded part, measured on its own ('ws' is external; browsers use WebSocket).
//    The Cloudflare Workers transport is a chunk of its own that only Workers load, so it is left out.
//  - Streaming on Workers: the same plus that chunk.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const BUDGETS = { rest: 25 * 1024, streaming: 25 * 1024, 'streaming on Workers': 26 * 1024 };
const dist = (file) => new URL(`../dist/${file}`, import.meta.url).pathname;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

// Keep dynamically imported modules (the streaming chunk, the Workers transport) out of a measurement.
const skipDynamicImports = (only = /.*/) => ({
  name: 'skip-dynamic-imports',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) =>
      args.kind === 'dynamic-import' && only.test(args.path) ? { path: args.path, external: true } : undefined,
    );
  },
});

async function measure(name, entry, plugins) {
  const result = await build({
    entryPoints: [dist(entry)],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'neutral',
    external: ['ws'],
    plugins,
    write: false,
    logLevel: 'warning',
    logOverride: { 'ignored-bare-import': 'silent' }, // chunk-ordering imports of side-effect-free chunks
  });
  const code = result.outputFiles[0].contents;
  const gzipped = gzipSync(code, { level: 9 }).length;
  console.log(`${name} bundle: ${kb(code.length)} minified, ${kb(gzipped)} min+gz (budget ${kb(BUDGETS[name])})`);
  return gzipped <= BUDGETS[name];
}

const ok = [
  await measure('rest', 'index.js', [skipDynamicImports()]),
  await measure('streaming', 'streaming.js', [skipDynamicImports(/ws-workers/)]),
  await measure('streaming on Workers', 'streaming.js', []),
];
if (!ok.every(Boolean)) {
  console.error('over the size budget');
  process.exit(1);
}
