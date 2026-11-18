import { describe, expect, it } from 'vitest';
import { numberKey, parseFloatStrict, parseIntStrict, roundHalfEven, strip, truncateCodePoints } from '../src/core/text.js';

describe('numberKey (same output as the reference SDK)', () => {
  it.each([
    [0.25, '0.25'],
    [1e-5, '1e-05'],
    [1.5e-7, '1.5e-07'],
    [0.0001, '0.0001'],
    [0.00012345, '0.00012345'],
    [123.456, '123.456'],
    [-0.5, '-0.5'],
    [1e21, '1000000000000000000000'],
    [10000, '10000'],
    [1e16, '10000000000000000'],
    [2.5e-300, '2.5e-300'],
    [0.1 + 0.2, '0.30000000000000004'],
    [-0, '0'],
    [null, '-'],
  ] as const)('%s -> %s', (value, expected) => {
    expect(numberKey(value)).toBe(expected);
  });
});

describe('roundHalfEven', () => {
  it('rounds halves to even', () => {
    expect([80.5, 81.5, 79.4, -0.5, -1.5, 2.5, 2.6].map(roundHalfEven)).toEqual([80, 82, 79, 0, -2, 2, 3]);
  });
});

describe('number parsing', () => {
  it.each([
    [' 12 ', 12],
    ['1_000', 1000],
    ['+5', 5],
    ['.5', 0.5],
    ['5.', 5],
    ['1e3', 1000],
    ['-Infinity', -Infinity],
    ['abc', null],
    ['', null],
    ['1__0', null],
    ['_1', null],
    ['0x1A', null],
  ] as const)('parseFloatStrict(%j) = %j', (text, expected) => {
    expect(parseFloatStrict(text)).toBe(expected);
  });

  it('parses nan', () => {
    expect(parseFloatStrict('NaN')).toBeNaN();
  });

  it.each([
    [' 7 ', 7],
    ['-3', -3],
    ['7.5', null],
    ['', null],
  ] as const)('parseIntStrict(%j) = %j', (text, expected) => {
    expect(parseIntStrict(text)).toBe(expected);
  });
});

describe('strip', () => {
  it('trims the same whitespace as the reference SDK', () => {
    expect(strip('\u001c\u0085 a b 　\n')).toBe('a b');
    expect(strip('﻿a')).toBe('﻿a'); // a byte order mark is not whitespace there
  });

  it('trims exactly the reference set, at either end', () => {
    const reference = /^[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;
    for (let code = 0; code <= 0xffff; code += 1) {
      const c = String.fromCharCode(code);
      const expected = reference.test(c) ? 'x' : `${c}x${c}`;
      expect(strip(`${c}x${c}`)).toBe(expected);
    }
    expect(strip(' \t ')).toBe('');
    expect(strip('')).toBe('');
  });

  it('runs in linear time on long whitespace runs', () => {
    const spaces = ' '.repeat(100_000);
    const started = performance.now();
    expect(strip(`${spaces}a${spaces}`)).toBe('a');
    expect(strip(`a${spaces}b`)).toBe(`a${spaces}b`);
    expect(strip(spaces)).toBe('');
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('truncateCodePoints', () => {
  it('never splits a surrogate pair', () => {
    expect(truncateCodePoints('😀😀😀', 2)).toBe('😀😀');
    expect(truncateCodePoints('abc', 5)).toBe('abc');
  });
});
