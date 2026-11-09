import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', streaming: 'src/streaming/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  // Streaming is loaded with import() and shared code lives in chunks, so REST-only users never load it.
  splitting: true,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
