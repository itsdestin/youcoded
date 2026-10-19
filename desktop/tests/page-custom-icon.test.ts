import { describe, expect, it } from 'vitest';
import { parsePageCustomIcon } from '../src/shared/page-custom-icon';

const icon = (path: string) => ({ version: 1, paths: [path] });

describe('parsePageCustomIcon', () => {
  it.each([
    'M3 10 L12 3 L21 10', 'm.5-.5 1e1,+2. L3 4z',
    'M0 0H2v3C1 2 3 4 5 6s1 2 3 4Q1 2 3 4t5 6Z',
    'M0 0A2 3 45 0 1 4 5a2 3 0 014 5', 'M-1024 1024 M1 1',
  ])('accepts complete SVG path grammar: %s', path => {
    expect(parsePageCustomIcon(icon(path))).toEqual(icon(path));
  });

  it.each([
    '', 'L0 0', 'M', 'M1', 'M0 0L1', 'M0 0C1 2 3 4 5', 'M0 0Z1 2',
    'M0 0A-1 2 0 0 1 3 4', 'M0 0A1 2 0 2 1 3 4',
    'M0 0A1 2 0 0 1.0 3 4', 'M0 0A1 2 0 0',
    'M0 0R1 2', 'MNaN 0', 'MInfinity 0', 'M1e999 0', 'M1025 0',
    'M0 0,', 'M,0 0', 'M0,,0', 'M0 0,L1 1', 'M0 0 Z,',
    'M0 0<path/>', 'M0 0" stroke="red', 'url(https://example.com)',
    'M0 0;alert(1)', 'M0 0\u00a0L1 1',
  ])('rejects malformed or unsafe path: %s', path => {
    expect(parsePageCustomIcon(icon(path))).toBeUndefined();
  });

  it.each([undefined, null, 1, [], {}, { version: 2, paths: ['M0 0'] },
    { version: '1', paths: ['M0 0'] }, { version: 1, paths: [] },
    { version: 1, paths: [42] }, { version: 1, paths: Array(13).fill('M0 0') },
  ])('ignores missing or unsupported metadata: %j', value => {
    expect(parsePageCustomIcon(value)).toBeUndefined();
  });

  it('checks individual and total size limits before parsing', () => {
    const path = 'M0 0' + ' '.repeat(2044);
    expect(parsePageCustomIcon(icon(path))).toEqual(icon(path));
    expect(parsePageCustomIcon(icon(path + ' '))).toBeUndefined();
    expect(parsePageCustomIcon({ version: 1, paths: Array(4).fill(path) })).toBeDefined();
    expect(parsePageCustomIcon({ version: 1, paths: [...Array(4).fill(path), 'M0 0'] })).toBeUndefined();
    expect(parsePageCustomIcon({ version: 1, paths: Array(12).fill('M0 0') })).toBeDefined();
  });

  it('copies only supported metadata without keeping extra attributes', () => {
    const value = { ...icon('M0 0'), fill: 'red', onload: 'alert(1)' };
    const parsed = parsePageCustomIcon(value);
    expect(parsed).toEqual(icon('M0 0'));
    expect(parsed?.paths).not.toBe(value.paths);
  });

  it('checks complete argument groups for every command in both cases', () => {
    for (const [command, arity] of Object.entries({ M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 })) {
      for (const letter of [command, command.toLowerCase()]) {
        const args = Array(arity).fill('0').join(' ');
        expect(parsePageCustomIcon(icon(`M0 0${letter}${args} ${args}`))).toBeDefined();
        expect(parsePageCustomIcon(icon(`M0 0${letter}${Array(arity - 1).fill('0').join(' ')}`))).toBeUndefined();
      }
    }
  });

  it('uses bounded array entries rather than an overridden iterator', () => {
    const paths = ['M0 0'];
    paths[Symbol.iterator] = () => { throw new Error('Do not invoke arbitrary iterators'); };
    expect(parsePageCustomIcon({ version: 1, paths })).toEqual(icon('M0 0'));
    expect(parsePageCustomIcon(Object.assign([], icon('M0 0')))).toBeUndefined();
  });

  it('never throws for hostile object access', () => {
    expect(parsePageCustomIcon(new Proxy({}, { get() { throw new Error('bad'); } }))).toBeUndefined();
  });
});
