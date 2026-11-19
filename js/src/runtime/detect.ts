/**
 * Runtime detection, without importing anything runtime-specific.
 *
 * Only reads globals, so the same build works on Node, Bun, Deno, edge
 * runtimes and browsers.
 */

interface ProcessLike {
  env?: Record<string, string | undefined>;
  version?: string;
  versions?: Record<string, string | undefined>;
  platform?: string;
}

interface Globals {
  process?: ProcessLike;
  Deno?: { version?: { deno?: string }; build?: { os?: string } };
  window?: { document?: unknown };
  document?: unknown;
  navigator?: { userAgent?: string; product?: string };
  WorkerGlobalScope?: unknown;
  importScripts?: unknown;
  EdgeRuntime?: unknown;
  WebSocketPair?: unknown;
}

const g = (): Globals => globalThis as unknown as Globals;

/** Read an environment variable when the runtime has `process.env` (Node, Bun, Deno 2). */
export function readEnv(name: string): string | undefined {
  try {
    const value = g().process?.env?.[name];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined; // e.g. Deno without --allow-env
  }
}

/**
 * True in a browser page or a browser worker, where an API key would be
 * exposed to the people using the app. Server runtimes (Node, Bun, Deno,
 * edge functions) are not browser-like.
 */
export function isBrowserLike(): boolean {
  const globals = g();
  const page = typeof globals.window !== 'undefined' && typeof globals.document !== 'undefined' && typeof globals.navigator !== 'undefined';
  const worker = typeof globals.WorkerGlobalScope !== 'undefined' && typeof globals.importScripts === 'function';
  return page || worker;
}

/**
 * True in a React Native app. It has no `document`, so `isBrowserLike()` misses
 * it, but an API key bundled into a mobile app can be extracted just the same.
 */
export function isReactNative(): boolean {
  return g().navigator?.product === 'ReactNative';
}

export interface RuntimeInfo {
  name: 'node' | 'bun' | 'deno' | 'workerd' | 'edge' | 'browser' | 'unknown';
  version: string | null;
  platform: string | null;
}

/**
 * True in Cloudflare Workers (workerd). Checked before Node.js: with the
 * `nodejs_compat` flag a Worker has `process.versions.node` too.
 */
export function isWorkerd(): boolean {
  const globals = g();
  return globals.navigator?.userAgent === 'Cloudflare-Workers' || typeof globals.WebSocketPair === 'function';
}

export function runtimeInfo(): RuntimeInfo {
  const globals = g();
  const versions = globals.process?.versions;
  if (globals.Deno?.version?.deno) {
    return { name: 'deno', version: globals.Deno.version.deno, platform: globals.Deno.build?.os ?? null };
  }
  if (isWorkerd()) return { name: 'workerd', version: null, platform: null };
  if (versions?.['bun']) return { name: 'bun', version: versions['bun'], platform: globals.process?.platform ?? null };
  if (versions?.['node']) return { name: 'node', version: versions['node'], platform: globals.process?.platform ?? null };
  if (typeof globals.EdgeRuntime !== 'undefined') return { name: 'edge', version: null, platform: null };
  if (isBrowserLike()) return { name: 'browser', version: null, platform: null };
  return { name: 'unknown', version: null, platform: null };
}
