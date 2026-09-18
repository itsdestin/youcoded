import { describe, it, expect } from 'vitest';
import {
  validateSyncName, DEFAULT_IGNORES, MAX_SYNC_FILE_BYTES,
  conflictCopyName, findCaseCollisions, isIgnoredPath,
} from '../src/main/sync-spaces/guards';

describe('validateSyncName', () => {
  it('accepts normal names', () => {
    expect(validateSyncName('budget-app')).toBeNull();
    expect(validateSyncName('My Notes 2026')).toBeNull();
  });
  it('rejects Windows reserved device names (any case, with extension)', () => {
    expect(validateSyncName('CON')).toMatch(/reserved/i);
    expect(validateSyncName('aux.txt')).toMatch(/reserved/i);
    expect(validateSyncName('com1')).toMatch(/reserved/i);
  });
  it('rejects characters invalid on Windows', () => {
    for (const bad of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
      expect(validateSyncName(bad)).toMatch(/character/i);
    }
  });
  it('rejects empty, dot-only, and trailing dot/space names', () => {
    expect(validateSyncName('')).toBeTruthy();
    expect(validateSyncName('.')).toBeTruthy();
    expect(validateSyncName('name.')).toBeTruthy();
    expect(validateSyncName('name ')).toBeTruthy();
  });
});

describe('DEFAULT_IGNORES', () => {
  it('covers the credential + junk set', () => {
    for (const p of ['node_modules/', '.youcoded/', '.git/', '.env', '*.pem', '.DS_Store']) {
      expect(DEFAULT_IGNORES).toContain(p);
    }
  });
});

describe('DEFAULT_IGNORES — ephemeral lease heartbeats', () => {
  // Leases are a 30s-per-open-session heartbeat (lease-client RENEW_MS). They
  // used to live INSIDE the personal sync space, so every renew became a git
  // commit: 93% of all file-changes in the real Personal repo were lease writes,
  // driving it to 30k commits / 673 MB and starving genuine conversation syncs.
  // The writer now targets userData, and this entry is the belt-and-braces guard
  // so a legacy or stray Leases/ dir under a space can never be shipped again.
  it('ignores lease heartbeat files under a space', () => {
    expect(DEFAULT_IGNORES).toContain('Leases/');
    expect(isIgnoredPath('Leases/8f3a-1234.json')).toBe(true);
    expect(isIgnoredPath('Personal/Leases/8f3a-1234.json')).toBe(true);
  });

  it('does NOT ignore a user file or folder merely NAMED like it', () => {
    expect(isIgnoredPath('Leases.md')).toBe(false);
    expect(isIgnoredPath('docs/Leases-2026.xlsx')).toBe(false);
  });
});

describe('DEFAULT_IGNORES — import temps', () => {
  // Two INDEPENDENT ignore lists cover the "+ Add file" import temp: discovery's
  // isNoiseFile (hides it from Project Files) and this one (stops sync shipping
  // it). Updating only the first would leave the debris invisible in the UI but
  // replicated to every device forever.
  it('ignores an abandoned import temp anywhere in the tree', () => {
    expect(isIgnoredPath('.youcoded-import-1234-5678-budget.xlsx.part')).toBe(true);
    expect(isIgnoredPath('docs/.youcoded-import-1-2-notes.md.part')).toBe(true);
  });

  it('does NOT ignore a user file that merely ends in .part', () => {
    expect(isIgnoredPath('chapter.part')).toBe(false);
    expect(isIgnoredPath('docs/thesis.part')).toBe(false);
  });
});

describe('isIgnoredPath', () => {
  it('matches directory patterns anywhere in the path', () => {
    expect(isIgnoredPath('node_modules/x/i.js')).toBe(true);
    expect(isIgnoredPath('dist/bundle.js')).toBe(true);
    expect(isIgnoredPath('sub/__pycache__/mod.pyc')).toBe(true);
    // The directory itself (no children yet) is also ignored.
    expect(isIgnoredPath('node_modules')).toBe(true);
  });
  it('matches exact-basename patterns at any depth', () => {
    expect(isIgnoredPath('.env')).toBe(true);
    expect(isIgnoredPath('sub/dir/.env')).toBe(true);
    expect(isIgnoredPath('.DS_Store')).toBe(true);
  });
  it('matches * glob patterns against the basename (secrets)', () => {
    expect(isIgnoredPath('secrets/server.pem')).toBe(true);
    expect(isIgnoredPath('id_rsa')).toBe(true);
    expect(isIgnoredPath('id_rsa.pub')).toBe(true);
    expect(isIgnoredPath('.env.local')).toBe(true);
    expect(isIgnoredPath('app/gcp.credentials.json')).toBe(true);
  });
  it('does not match ordinary project files', () => {
    expect(isIgnoredPath('docs/notes.md')).toBe(false);
    expect(isIgnoredPath('src/main.ts')).toBe(false);
    // '.environment' is NOT '.env' (exact) nor '.env.*' (needs a dot after
    // env) — same as gitignore semantics, so backups match sync exactly.
    expect(isIgnoredPath('.environment')).toBe(false);
  });
  it('never ignores the space root itself (relative path is empty)', () => {
    expect(isIgnoredPath('')).toBe(false);
  });
});

describe('MAX_SYNC_FILE_BYTES', () => {
  it('is 50MB', () => expect(MAX_SYNC_FILE_BYTES).toBe(50 * 1024 * 1024));
});

describe('conflictCopyName', () => {
  const d = new Date('2026-07-03T14:00:00Z');
  it('inserts device + date before the extension', () => {
    expect(conflictCopyName('docs/notes.md', 'Laptop', d))
      .toBe('docs/notes (from Laptop, 2026-07-03).md');
  });
  it('handles extensionless files', () => {
    expect(conflictCopyName('Makefile', 'Laptop', d))
      .toBe('Makefile (from Laptop, 2026-07-03)');
  });
});

describe('findCaseCollisions', () => {
  it('groups paths differing only by case', () => {
    expect(findCaseCollisions(['a/Readme.md', 'a/readme.md', 'b/x.ts']))
      .toEqual([['a/Readme.md', 'a/readme.md']]);
  });
  it('returns empty when no collisions', () => {
    expect(findCaseCollisions(['a.ts', 'b.ts'])).toEqual([]);
  });
});
