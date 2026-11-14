// Deterministic CBOR: RFC 8949 Appendix A samples, canonical-only decoding, typed readers.
import { describe, expect, it } from 'vitest';
import { asBytes, asMap, asText, asUint, decode, encode } from './cbor';
import { MeshCryptoError } from './errors';
import { fromHex } from './bytes';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('cbor encode: RFC 8949 Appendix A samples', () => {
  const samples: [unknown, string][] = [
    [0, '00'], [1, '01'], [10, '0a'], [23, '17'], [24, '1818'], [25, '1819'], [100, '1864'], [1000, '1903e8'],
    [1000000, '1a000f4240'], [4294967296, '1b0000000100000000'], [Buffer.from('01020304', 'hex'), '4401020304'],
    ['', '60'], ['a', '6161'], ['IETF', '6449455446'], ['ü', '62c3bc'], [[], '80'], [[1, 2, 3], '83010203'],
    [[1, [2, 3], [4, 5]], '8301820203820405'], [false, 'f4'], [true, 'f5'], [null, 'f6'],
  ];
  for (const [v, h] of samples) it(`${JSON.stringify(v)} -> ${h}`, () => expect(hex(encode(v as never))).toBe(h));
  it('map keys are sorted bytewise regardless of insertion order', () => {
    expect(hex(encode({ a: 1, b: [2, 3] }))).toBe('a26161016162820203');
    expect(hex(encode({ b: 1, a: 2 }))).toBe(hex(encode({ a: 2, b: 1 })));
    expect(hex(encode({ aa: 1, b: 2 }))).toBe('a2616202626161' + '01'); // shorter key first
  });
  it('undefined members are dropped (optional fields)', () => expect(hex(encode({ a: 1, b: undefined }))).toBe('a1616101'));
  it('refuses unencodable values with invalid-argument', () => {
    for (const v of [-1, 1.5, 2 ** 53, NaN, undefined as never, (() => 1) as never]) {
      expect(() => encode(v)).toThrowError(MeshCryptoError);
    }
  });
});

describe('cbor decode refuses every non-canonical form', () => {
  const bad: Record<string, string> = {
    'non-shortest 1-byte': '1800', 'non-shortest 2-byte': '1900ff', 'non-shortest 4-byte': '1a000000ff',
    'unsorted keys': 'a2616202616101', 'duplicate keys': 'a1616101616101', 'indefinite array': '9f01ff',
    'float64': 'fb3ff0000000000000', 'float16': 'f97e00', 'tag': 'c11a514b67b0', 'indefinite bytes': '5f4101ff',
    'negative integer': '3800', 'undefined simple': 'f7', 'truncated': '4401', 'empty input': '',
    'huge declared array': '9affffffff', 'int key': 'a10101', 'invalid utf8': '62c328',
  };
  for (const [name, h] of Object.entries(bad)) {
    it(name, () => expect(() => decode(fromHex(h))).toThrowError(MeshCryptoError));
  }
  it('trailing bytes', () => expect(() => decode(fromHex('0100'))).toThrowError(/trailing/));
  it('nesting deeper than 64', () => expect(() => decode(Buffer.from('81'.repeat(100) + '00', 'hex'))).toThrowError(MeshCryptoError));
  it('round trip keeps types and bytes', () => {
    const v = { x: [1, 'a', Buffer.from('ff', 'hex')], y: null, z: { k: true } };
    const back = decode(encode(v)) as Record<string, unknown>;
    expect(back.x).toEqual([1, 'a', Buffer.from('ff', 'hex')]);
    expect(back.y).toBeNull();
    expect(encode(back as never).equals(encode(v))).toBe(true);
  });
});

describe('typed readers', () => {
  it('accept the right shape', () => {
    expect(asUint(5, 'n')).toBe(5);
    expect(asText('x', 't')).toBe('x');
    expect(asBytes(Buffer.alloc(3), 'b', 3).length).toBe(3);
    expect(asMap({ a: 1 }, 'm')).toEqual({ a: 1 });
  });
  it('reject the wrong shape with MeshCryptoError(malformed)', () => {
    const fns = [() => asUint(-1, 'n'), () => asUint('1', 'n'), () => asUint(5, 'n', 4), () => asText(3, 't'), () => asText('abc', 't', 2), () => asBytes(Buffer.alloc(2), 'b', 3), () => asMap([], 'm'), () => asMap(null, 'm'), () => asMap(Buffer.alloc(1), 'm')];
    for (const f of fns) expect(f).toThrowError(MeshCryptoError);
  });
});
