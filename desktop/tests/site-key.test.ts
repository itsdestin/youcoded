// What counts as "the same website" for the Ask-first website question.
import { describe, it, expect } from 'vitest';
import { siteKeyFor } from '../src/shared/site-key';

describe('siteKeyFor', () => {
  it('folds case, a leading www., a trailing dot and the port into one site', () => {
    const same = ['https://example.com/a', 'HTTP://Example.COM/b?q=1', 'https://www.example.com/', 'https://example.com.:8443/x', 'https://user:pw@www.example.com/'];
    for (const u of same) expect(siteKeyFor(u)).toBe('example.com');
  });
  it('keeps sub-sites apart: approving one never approves its neighbours', () => {
    expect(siteKeyFor('https://docs.example.com/')).toBe('docs.example.com');
    expect(siteKeyFor('https://alice.github.io/')).not.toBe(siteKeyFor('https://bob.github.io/'));
    expect(siteKeyFor('https://example.com.evil.net/')).toBe('example.com.evil.net');
  });
  it('is undefined for text that is not a web address', () => {
    for (const u of ['', 'not a url', 'example.com', undefined, 42]) expect(siteKeyFor(u)).toBeUndefined();
  });
});
