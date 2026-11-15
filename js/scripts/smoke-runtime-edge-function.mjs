// The Edge Function of the Vercel Edge smoke test: smoke-runtime-edge.mjs bundles it with the
// built package and runs it in Vercel's edge-runtime emulator. GET /?base=<mock URL>&closed=<refused URL>
// runs the checks. The SDK doesn't stream on Vercel Edge and there is no file system, so the
// checks expect streams and file paths to fail with UnsupportedEnvironmentError.

import * as sdk from '@echonova/ai';
import * as streaming from '@echonova/ai/streaming';
import { runChecks } from './smoke-runtime-checks.mjs';

addEventListener('fetch', (event) => {
  const params = new URL(event.request.url).searchParams;
  event.respondWith(
    runChecks({
      sdk,
      streaming,
      baseURL: params.get('base'),
      closedURL: params.get('closed'),
      files: null,
      expectRuntime: 'edge',
      streams: false,
    }).then((results) => Response.json(results)),
  );
});
