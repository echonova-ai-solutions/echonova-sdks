// The recorded API traffic in spec/fixtures/rest/ and spec/fixtures/ws/, and what every SDK must
// do with it (spec/fixtures/expected.json; its `$comment` defines the vocabulary).
import { readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { expect, it } from 'vitest';
import { SPEC_DIR, loadSpec } from '../helpers.js';

export interface RestExpectation {
  ok?: true;
  /** The error class the SDK raises. */
  error?: string;
  note?: string;
}

export interface WsExpectation {
  /** Recorded requestId (r1, r2, ...) -> completed, cancelled, superseded, failed:<class> or lost:<class>. */
  requests?: Record<string, string>;
  session_error?: string;
  handshake_error?: string;
  pong?: boolean;
  /** How many transcript events, or `in order`. */
  transcripts?: number | 'in order';
  ended?: string;
  saved?: boolean;
  events?: string[];
  note?: string;
}

export interface Expected {
  $comment: string;
  rest: Record<string, RestExpectation>;
  ws: Record<string, WsExpectation>;
}

export const EXPECTED = loadSpec<Expected>('fixtures/expected.json');

type Kind = 'rest' | 'ws';
const EXTENSION: Record<Kind, string> = { rest: '.json', ws: '.jsonl' };

/** The fixtures on disk, by name (`tts/sync_ok`), sorted. */
export function fixtureNames(kind: Kind): string[] {
  const ext = EXTENSION[kind];
  const files = readdirSync(new URL(`fixtures/${kind}/`, SPEC_DIR), { recursive: true, encoding: 'utf8' });
  return files
    .map((file) => file.split(sep).join('/'))
    .filter((file) => file.endsWith(ext))
    .map((file) => file.slice(0, -ext.length))
    .sort();
}

export function readFixture(kind: Kind, name: string): string {
  return readFileSync(new URL(`fixtures/${kind}/${name}${EXTENSION[kind]}`, SPEC_DIR), 'utf8');
}

/** A test that fails when a fixture has no expectation, or an expectation has no fixture. */
export function itCoversEveryFixture(kind: Kind): void {
  it(`pairs every ${kind} fixture with an expectation`, () => {
    const onDisk = fixtureNames(kind);
    const expected = Object.keys(EXPECTED[kind]).sort();
    expect(onDisk.length).toBeGreaterThan(0);
    expect(
      onDisk.filter((name) => !expected.includes(name)),
      'fixtures with no entry in expected.json',
    ).toEqual([]);
    expect(
      expected.filter((name) => !onDisk.includes(name)),
      'entries in expected.json with no fixture',
    ).toEqual([]);
  });
}
