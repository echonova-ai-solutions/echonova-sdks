/**
 * Node built-ins (`fs`, `path`), loaded only when a file path is used.
 *
 * There is no `import 'node:fs'` anywhere in the package, so browser and edge
 * bundles never pull it in. Node 22.3+, Bun and Deno expose built-ins through
 * `process.getBuiltinModule`; older runtimes fall back to a dynamic import that
 * bundlers are told to leave alone.
 */

import { UnsupportedEnvironmentError } from '../errors.js';

/** The parts of `node:fs/promises` the SDK uses. */
export interface FileHandleLike {
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  write(data: Uint8Array): Promise<unknown>;
  truncate(length?: number): Promise<void>;
  close(): Promise<void>;
}

export interface StatsLike {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface NodeFs {
  openAsBlob?: (path: string, options?: { type?: string }) => Promise<Blob>;
  promises: {
    open(path: string, flags: string): Promise<FileHandleLike>;
    stat(path: string): Promise<StatsLike>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
  };
}

export interface NodePath {
  basename(path: string): string;
  dirname(path: string): string;
  join(...parts: string[]): string;
  extname(path: string): string;
}

interface ProcessWithBuiltins {
  getBuiltinModule?: (id: string) => unknown;
  versions?: { node?: string };
}

async function builtin<T>(name: string, why: string): Promise<T> {
  const proc = (globalThis as { process?: ProcessWithBuiltins }).process;
  const id = `node:${name}`;
  const found = typeof proc?.getBuiltinModule === 'function' ? proc.getBuiltinModule(id) : undefined;
  if (found) return found as T;
  if (proc?.versions?.node) {
    try {
      const module = (await import(/* webpackIgnore: true */ /* @vite-ignore */ id)) as { default?: T } & T;
      return module.default ?? module;
    } catch {
      // fall through to the error below
    }
  }
  throw new UnsupportedEnvironmentError(`${why} needs Node.js, Bun or Deno; this runtime has no file system access`);
}

export const nodeFs = (why: string): Promise<NodeFs> => builtin<NodeFs>('fs', why);
export const nodePath = (why: string): Promise<NodePath> => builtin<NodePath>('path', why);
