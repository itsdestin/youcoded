import { describe, it, expect } from 'vitest';
import { themeFingerprint, themeFilesChanged } from '../src/shared/theme-fingerprint';

describe('themeFingerprint', () => {
  it('is stable regardless of key order or hash case', () => {
    const a = themeFingerprint({ fileHashes: { 'manifest.json': 'AB', 'assets/m.svg': 'cd' } });
    const b = themeFingerprint({ fileHashes: { 'assets/m.svg': 'CD', 'manifest.json': 'ab' } });
    expect(a).toBe(b);
    expect(a).toMatch(/^fh:/);
  });
  it('changes when any one file changes', () => {
    const a = themeFingerprint({ fileHashes: { 'manifest.json': 'aa', 'assets/m.svg': 'bb' } });
    const b = themeFingerprint({ fileHashes: { 'manifest.json': 'aa', 'assets/m.svg': 'bc' } });
    expect(a).not.toBe(b);
  });
  it('falls back to contentHash, and is undefined with no evidence', () => {
    expect(themeFingerprint({ contentHash: 'sha256:ABC' })).toBe('ch:sha256:abc');
    expect(themeFingerprint({ fileHashes: {} })).toBeUndefined();
    expect(themeFingerprint({})).toBeUndefined();
    expect(themeFingerprint(null)).toBeUndefined();
  });
});

describe('themeFilesChanged', () => {
  it('flags only a real difference between same-kind stamps', () => {
    expect(themeFilesChanged('fh:1', 'fh:2')).toBe(true);
    expect(themeFilesChanged('fh:1', 'fh:1')).toBe(false);
  });
  it('stays quiet for installs with no recorded stamp or entries with no hashes', () => {
    expect(themeFilesChanged(undefined, 'fh:2')).toBe(false);
    expect(themeFilesChanged('fh:1', undefined)).toBe(false);
  });
  it('stays quiet when the kind of evidence changed (contentHash -> fileHashes)', () => {
    expect(themeFilesChanged('ch:sha256:a', 'fh:2')).toBe(false);
  });
});
