// Run the proxy: npm start (settings come from the environment).

import { createProxy } from './app.js';
import { ConfigError, settingsFromEnv } from './config.js';
import { createLogger } from './log.js';

const log = createLogger();
try {
  const proxy = createProxy(settingsFromEnv(), { logger: log });
  const server = await proxy.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '127.0.0.1');
  const stop = () => {
    server.close(); // stop accepting; finish requests in flight
    server.closeIdleConnections();
    proxy.close(); // close open streams (1012) and the upstream pool
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  log('proxy.config_error', { message: err.message }, 'error');
  process.exitCode = 2;
}
