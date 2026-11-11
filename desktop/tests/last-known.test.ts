import { describe, it, expect } from 'vitest';
import { mergeWithLastKnown } from '../src/main/last-known';

const ctx = {
  present: (raw: string | null) => raw != null,
  parse: (raw: string | null) => { const n = parseInt(raw as string, 10); return isNaN(n) ? undefined : n; },
};

describe('mergeWithLastKnown', () => {
  it('uses a fresh read and remembers it', () => {
    const last: Record<string, string> = {};
    expect(mergeWithLastKnown([{ desktopId: 'a', raw: 'main' }], last)).toEqual({ a: 'main' });
    expect(last).toEqual({ a: 'main' });
  });
  it('falls back to the remembered value when the read is empty', () => {
    const last = { a: 'main' };
    expect(mergeWithLastKnown([{ desktopId: 'a', raw: null }, { desktopId: 'b', raw: null }], last))
      .toEqual({ a: 'main' });
  });
  it('treats an empty string as missing by default (branch/stats)', () => {
    expect(mergeWithLastKnown([{ desktopId: 'a', raw: '' }], { a: 'old' })).toEqual({ a: 'old' });
  });
  it('context %: parses numbers, empty string is a read but not a number, null falls back', () => {
    const last: Record<string, number> = { a: 40, b: 50, c: 60 };
    const out = mergeWithLastKnown(
      [{ desktopId: 'a', raw: '73' }, { desktopId: 'b', raw: 'junk' }, { desktopId: 'c', raw: null }], last, ctx);
    // junk: present but unparseable -> no entry and NO fallback, last untouched
    expect(out).toEqual({ a: 73, c: 60 });
    expect(last).toEqual({ a: 73, b: 50, c: 60 });
    expect(mergeWithLastKnown([{ desktopId: 'a', raw: '' }], { a: 1 }, ctx)).toEqual({});
  });
  it('0 percent is kept (not mistaken for missing)', () => {
    expect(mergeWithLastKnown([{ desktopId: 'a', raw: '0' }], {}, ctx)).toEqual({ a: 0 });
  });
});
