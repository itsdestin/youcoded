import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveStaticFile, isWithinDir } from '../src/main/remote-static-path';

const DIR = path.resolve('/opt/app/renderer');

describe('resolveStaticFile — the unauthenticated static handler (2026-09-10 security review)', () => {
  it('resolves an ordinary asset inside the directory', () => {
    expect(resolveStaticFile('/assets/main.js', DIR)).toBe(path.join(DIR, 'assets/main.js'));
  });

  it('strips a query string before decoding', () => {
    expect(resolveStaticFile('/assets/main.js?v=2', DIR)).toBe(path.join(DIR, 'assets/main.js'));
  });

  it('returns null for a malformed percent-encoding instead of throwing (the /% crash)', () => {
    // decodeURIComponent('%') throws "URI malformed"; the old handler did this in
    // the main process, which has no uncaughtException handler.
    expect(() => resolveStaticFile('/%', DIR)).not.toThrow();
    expect(resolveStaticFile('/%', DIR)).toBeNull();
    expect(resolveStaticFile('/%zz', DIR)).toBeNull();
  });

  it('a traversal attempt is contained inside the directory, never above it', () => {
    // normalize + strip leading `..` clamps every escape back under staticDir,
    // so these resolve to a (usually missing) file INSIDE the dir — never /etc/passwd.
    for (const p of [
      resolveStaticFile('/../secret.txt', DIR),
      resolveStaticFile('/..%2f..%2fetc%2fpasswd', DIR),
      resolveStaticFile('/%2e%2e/%2e%2e/%2e%2e/etc/passwd', DIR),
    ]) {
      expect(p).not.toBeNull();
      expect(isWithinDir(p!, DIR)).toBe(true);
    }
  });
});

describe('isWithinDir', () => {
  it('a sibling directory sharing a name prefix is NOT inside', () => {
    // The old `startsWith(staticDir)` check passed `/opt/app/renderer-x`.
    expect(isWithinDir('/opt/app/renderer-x/main.js', DIR)).toBe(false);
    expect(isWithinDir(path.join(DIR, 'main.js'), DIR)).toBe(true);
    expect(isWithinDir(DIR, DIR)).toBe(true);
  });
});
