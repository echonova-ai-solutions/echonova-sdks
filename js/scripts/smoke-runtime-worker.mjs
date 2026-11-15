// The Cloudflare Worker of the workerd smoke test: smoke-runtime-workerd.mjs bundles it with the
// built package and runs it in workerd. GET /?base=<mock URL>&closed=<refused URL> runs the checks.

import * as sdk from '@echonova/ai';
import * as streaming from '@echonova/ai/streaming';
import { runChecks } from './smoke-runtime-checks.mjs';

/** With `nodejs_compat`, a Worker has `node:fs` over an in-memory file system with a writable /tmp. */
function workerFiles() {
  const fs = globalThis.process?.getBuiltinModule?.('node:fs');
  if (!fs) return null;
  return {
    path: (name) => `/tmp/${name}`,
    write: (path, bytes) => fs.promises.writeFile(path, bytes),
    read: async (path) => new Uint8Array(await fs.promises.readFile(path)),
  };
}

export default {
  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const results = await runChecks({
      sdk,
      streaming,
      baseURL: params.get('base'),
      closedURL: params.get('closed'),
      files: workerFiles(),
      expectRuntime: 'workerd',
      validatesUtf8: false,
      reportsRefusal: false,
    });
    return Response.json(results);
  },
};
