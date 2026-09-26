// Pure helpers for the sync-spaces subsystem. NO fs/os imports — keeps this
// unit-testable without mocks (same rule as local-theme-synthesizer).

// Why: a name created on macOS/Linux must not break a Windows device later.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVALID_CHARS = /[<>:"|?*\x00-\x1f/\\]/;

/** Returns an error message, or null when the name is safe on every platform. */
export function validateSyncName(name: string): string | null {
  if (!name || name === '.' || name === '..') return 'Name is empty or invalid';
  if (WINDOWS_RESERVED.test(name)) return `"${name}" is a reserved name on Windows`;
  if (INVALID_CHARS.test(name)) return 'Name contains a character not allowed on all platforms (< > : " | ? * / \\)';
  if (/[. ]$/.test(name)) return 'Name cannot end with a dot or space (Windows restriction)';
  if (name.length > 100) return 'Name is too long (max 100 characters)';
  return null;
}

// Secrets. Unlike the rest of DEFAULT_IGNORES these are ENFORCED at staging
// (git-transport stageAll): info/exclude alone loses to a project's own
// .gitignore — `!.env` there re-included a real .env into the upload.
const NEVER_SYNC: string[] = [
  '.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '*.credentials.json',
];

// Spec §8 default ignore set: build junk + secrets. gitignore syntax — written
// into each hidden repo's info/exclude (never into the user's tree).
export const DEFAULT_IGNORES: string[] = [
  // Leases/ — ephemeral session-holder heartbeats, rewritten every 30s per open
  // session (lease-client RENEW_MS). They are NOT user data and must never be
  // versioned: while they lived in the space, 93% of every file-change in the
  // real Personal repo was a lease renew — 30k commits / 673 MB, which starved
  // real conversation syncs badly enough that a device fell 3 days behind and
  // could not catch up (2026-07-30). The writer now targets userData; this entry
  // is the belt-and-braces guard for legacy dirs and any future stray writer.
  'Leases/',
  'node_modules/', '.git/', '.youcoded/', 'dist/', 'build/', 'out/', 'target/',
  '.venv/', 'venv/', '__pycache__/', '.pytest_cache/', '.gradle/',
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
  // Abandoned "+ Add file" import temp (artifacts/import-file.ts copies to
  // `.youcoded-import-<pid>-<ts>-<name>.part` in the destination folder, then
  // renames over the target). A crashed import strands one INSIDE the project
  // tree. project-file-discovery hides it from Project Files, but that is a
  // SEPARATE ignore list — without this entry sync would happily transport the
  // debris to every other device, where it is invisible in the UI yet present
  // on disk forever.
  '.youcoded-import-*.part',
  ...NEVER_SYNC,
];

/** True when a relative path matches the DEFAULT_IGNORES set. Interprets the
 *  gitignore-style entries for non-git consumers (the iCloud backup filter):
 *  'name/' matches a path segment anywhere; 'name' matches a basename exactly;
 *  simple '*' globs match against the basename. Why: backups must scrub the
 *  same secrets/junk the sync layer scrubs — a narrower filter here would leak
 *  keys into backups that sync deliberately never transports. */
export function isIgnoredPath(relPath: string): boolean {
  return matchesAny(relPath, DEFAULT_IGNORES);
}

// "name (from Laptop, 2026-07-03).ext" → "name.ext" (see conflictCopyName).
const CONFLICT_SUFFIX = / \(from .+, \d{4}-\d{2}-\d{2}\)/;

/** True when a relative path is a secret that must never leave this device.
 *  WHY the conflict-suffix strip: a "(from …)" copy of .env holds the same
 *  secret, and its name no longer matches '.env'. */
export function isNeverSyncPath(relPath: string): boolean {
  return matchesAny(relPath, NEVER_SYNC) || matchesAny(relPath.replace(CONFLICT_SUFFIX, ''), NEVER_SYNC);
}

function matchesAny(relPath: string, patterns: string[]): boolean {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1);
      if (segments.slice(0, -1).includes(dir) || base === dir) return true;
    } else if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      if (re.test(base)) return true;
    } else if (base === pattern) {
      return true;
    }
  }
  return false;
}

/** Spec §7: files over this cap don't live-sync (daily backup covers them). */
export const MAX_SYNC_FILE_BYTES = 50 * 1024 * 1024;

// Spec §18 watcher-scale guardrail, applied at IMPORT time: folders with more
// files than this are refused with a clear message instead of silently hanging
// chokidar. An engine-level guardrail (for folders that GROW past the cap
// after import) is Plan 1b scope. Count excludes DEFAULT_IGNORES (node_modules
// etc.) — those never sync, so they shouldn't disqualify a folder either.
export const MAX_IMPORT_FILE_COUNT = 20_000;

/** Spec §8: "notes (from Laptop, 2026-07-03).md" — the visible conflict copy. */
export function conflictCopyName(relPath: string, deviceName: string, when: Date): string {
  const date = when.toISOString().slice(0, 10);
  const dot = relPath.lastIndexOf('.');
  const slash = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
  const suffix = ` (from ${deviceName}, ${date})`;
  if (dot > slash + 1) return `${relPath.slice(0, dot)}${suffix}${relPath.slice(dot)}`;
  return `${relPath}${suffix}`;
}

/** Case-insensitive collision groups — these break macOS/Windows checkouts. */
export function findCaseCollisions(paths: string[]): string[][] {
  const byLower = new Map<string, string[]>();
  for (const p of paths) {
    const k = p.toLowerCase();
    byLower.set(k, [...(byLower.get(k) ?? []), p]);
  }
  return [...byLower.values()].filter(g => g.length > 1);
}
