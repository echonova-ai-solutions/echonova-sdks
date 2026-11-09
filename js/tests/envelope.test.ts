import { describe, expect, it } from 'vitest';
import {
  header,
  headersToRecord,
  MalformedEnvelopeError,
  parseErrorBody,
  parseHttpDate,
  parseRetryAfter,
  unwrapSuccess,
} from '../src/core/envelope.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('unwrapSuccess', () => {
  it('returns data', () => {
    const body = JSON.stringify({ data: { jobId: 'a1' }, success: true, statusCode: 200, errorMessage: null });
    expect(unwrapSuccess(bytes(body))).toEqual({ jobId: 'a1' });
    expect(unwrapSuccess(body)).toEqual({ jobId: 'a1' });
    expect(unwrapSuccess(bytes(body).buffer as ArrayBuffer)).toEqual({ jobId: 'a1' });
  });

  it('keeps null data and unknown fields', () => {
    expect(unwrapSuccess('{"data": null, "success": true, "extra": 1}')).toBeNull();
    expect(unwrapSuccess('{"data": {"a": 1, "newField": [1]}}')).toEqual({ a: 1, newField: [1] });
  });

  it.each(['<html>oops</html>', '[1, 2]', '{"jobId": "a1"}', '{"data": null, "success": false}', '', 'null', '"data"'])(
    'rejects %j',
    (body) => {
      expect(() => unwrapSuccess(bytes(body))).toThrow(MalformedEnvelopeError);
    },
  );

  it('accepts a UTF-8 byte order mark and rejects invalid UTF-8', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('{"data": 1}')]);
    expect(unwrapSuccess(bom)).toBe(1);
    const invalid = new Uint8Array([...bytes('{"data": "'), 0xff, ...bytes('"}')]);
    expect(() => unwrapSuccess(invalid)).toThrow(MalformedEnvelopeError);
  });
});

describe('parseErrorBody', () => {
  it('keeps unknown fields out of the way and the message whole', () => {
    const body = JSON.stringify({ data: null, success: false, statusCode: 400, errorMessage: 'a, b', docs: 'd', newField: 1 });
    const parsed = parseErrorBody(bytes(body));
    expect(parsed).toMatchObject({ isJson: true, errorMessage: 'a, b', docsUrl: 'd', errorCode: null });
    expect(parsed.rawBody).toBe(body);
  });

  it('treats a JSON object with only success as the envelope', () => {
    expect(parseErrorBody('{"success": false}')).toMatchObject({ isJson: true, errorMessage: null });
  });

  it('ignores non-string fields', () => {
    const parsed = parseErrorBody('{"errorMessage": 5, "errorCode": {}, "docs": null}');
    expect(parsed).toMatchObject({ isJson: true, errorMessage: null, errorCode: null, docsUrl: null });
  });

  it('treats other JSON as not the envelope', () => {
    expect(parseErrorBody('{"message": "x"}')).toMatchObject({ isJson: false, errorMessage: '{"message": "x"}' });
    expect(parseErrorBody('[1]').isJson).toBe(false);
  });

  it('trims a non-JSON body into the message', () => {
    const parsed = parseErrorBody(bytes('  no healthy upstream  '));
    expect(parsed).toMatchObject({ isJson: false, errorMessage: 'no healthy upstream', rawBody: '  no healthy upstream  ' });
  });

  it('handles an empty body', () => {
    expect(parseErrorBody(new Uint8Array())).toEqual({
      isJson: false,
      errorMessage: null,
      errorCode: null,
      docsUrl: null,
      rawBody: null,
    });
    expect(parseErrorBody('   ').errorMessage).toBeNull();
  });

  it('caps the raw body at 4 KiB and the message at 500 characters', () => {
    const parsed = parseErrorBody('x'.repeat(10_000));
    expect(parsed.rawBody).toHaveLength(4096);
    expect(parsed.errorMessage).toHaveLength(500);
  });

  it('counts the message limit in code points', () => {
    const parsed = parseErrorBody('😀'.repeat(600));
    expect(Array.from(parsed.errorMessage ?? '')).toHaveLength(500);
  });

  it('replaces a multi-byte character cut at the 4 KiB limit', () => {
    const body = new Uint8Array([...bytes('a'.repeat(4095)), 0xc3, 0xa9]);
    expect(parseErrorBody(body).rawBody?.endsWith('�')).toBe(true);
  });
});

describe('parseRetryAfter', () => {
  it.each([
    ['30', 30],
    ['0', 0],
    ['1.5', 1.5],
    [' 12 ', 12],
    ['1e1', 10],
    ['-4', 0],
    ['inf', Infinity],
    ['nan', 0],
    ['soon', null],
    ['', null],
    ['0x10', null],
  ] as const)('%j -> %j', (value, expected) => {
    expect(parseRetryAfter(value)).toBe(expected);
  });

  it('returns null when absent', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });

  it('reads an HTTP date relative to now', () => {
    const now = new Date(Date.UTC(2026, 10, 5, 12, 0, 0));
    expect(parseRetryAfter('Thu, 05 Nov 2026 12:00:45 GMT', { now })).toBe(45);
    expect(parseRetryAfter('Thu, 05 Nov 2026 11:00:00 GMT', { now })).toBe(0);
  });
});

describe('parseHttpDate', () => {
  it.each([
    ['Thu, 05 Nov 2026 12:00:45 GMT', Date.UTC(2026, 10, 5, 12, 0, 45)],
    ['05 Nov 2026 12:00 +0100', Date.UTC(2026, 10, 5, 11, 0, 0)],
    ['Thursday, 05-Nov-26 12:00:45 GMT', Date.UTC(2026, 10, 5, 12, 0, 45)],
    ['Thu, 05 Nov 2026 12:00:45', Date.UTC(2026, 10, 5, 12, 0, 45)],
    ['Thu, 05 Nov 2026 07:00:45 EST', Date.UTC(2026, 10, 5, 12, 0, 45)],
  ] as const)('%s', (text, expected) => {
    expect(parseHttpDate(text)).toBe(expected);
  });

  it('rejects other text', () => {
    expect(parseHttpDate('2026-11-05T12:00:00Z')).toBeNull();
    expect(parseHttpDate('05 Foo 2026 12:00:00 GMT')).toBeNull();
  });
});

describe('header', () => {
  it('is case-insensitive over records', () => {
    expect(header({ 'X-Request-Id': 'abc' }, 'x-request-id')).toBe('abc');
    expect(header({ 'x-request-id': 'abc' }, 'X-Request-Id')).toBe('abc');
    expect(header({}, 'x-request-id')).toBeNull();
    expect(header(null, 'x-request-id')).toBeNull();
  });

  it('reads Fetch Headers, Maps and entry lists', () => {
    expect(header(new Headers({ 'X-Request-Id': 'abc' }), 'X-REQUEST-ID')).toBe('abc');
    expect(header(new Map([['X-Request-Id', 'abc']]), 'x-request-id')).toBe('abc');
    expect(header([['X-Request-Id', 'abc']], 'x-request-id')).toBe('abc');
  });

  it('joins repeated values like Node does and skips missing ones', () => {
    expect(header({ 'x-a': ['1', '2'] }, 'X-A')).toBe('1, 2');
    expect(header({ 'x-a': undefined, 'X-A': 'v' }, 'x-a')).toBe('v');
  });

  it('returns an empty value as-is', () => {
    expect(header({ 'X-A': '' }, 'x-a')).toBe('');
  });

  it('copies headers into a record', () => {
    expect(headersToRecord(new Headers({ 'X-A': '1' }))).toEqual({ 'x-a': '1' });
    expect(headersToRecord({ 'X-A': '1', 'X-B': ['2', '3'], 'X-C': undefined })).toEqual({ 'X-A': '1', 'X-B': '2, 3' });
  });
});
