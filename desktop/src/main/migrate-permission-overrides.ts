import * as fs from 'fs';
import * as path from 'path';

// The one-time switch-off of the withdrawn protection overrides (Assistant
// settings, contract R17 — Destin chose the reset on review round 2, R2-5).
//
// The Advanced list that turned these on is gone from the app. Anyone who had
// switched one on would otherwise keep it on forever, with nothing on any screen
// to show it or undo it — a permission the user cannot see is the worst kind.
//
// WHY ITS OWN MODULE, taking the path as an argument: nothing in the test suite
// can import main.ts (it runs `app.whenReady()` at module scope), so a migration
// written inline there is a migration that can never be checked. Here it is a
// plain function over a file path, so it can be run against a copy.

export type OverrideMigration = 'migrated' | 'already-done' | 'skipped';

/** Marker written once, so a person who deliberately turns something back on
 *  later is never overruled by a second run. */
export const CLEARED_MARKER = 'permissionOverridesClearedAt';

/**
 * Turn every stored protection override off, once.
 *
 * - 'migrated'     — overrides were written false and the marker was stamped
 * - 'already-done' — the marker was already there; the file is untouched
 * - 'skipped'      — no defaults file, or it could not be read/parsed/written
 *
 * Never throws: a startup step that can take the app down with it is worse than
 * a permission left on for one more launch.
 */
export function migratePermissionOverrides(defaultsPath: string): OverrideMigration {
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
  } catch {
    return 'skipped'; // no file yet (a fresh install has nothing to clear), or unreadable
  }
  if (!parsed || typeof parsed !== 'object') return 'skipped';
  if (parsed[CLEARED_MARKER]) return 'already-done';

  const current = parsed.permissionOverrides;
  const cleared: Record<string, boolean> = {};
  if (current && typeof current === 'object') {
    for (const key of Object.keys(current)) cleared[key] = false;
  }

  const next = { ...parsed, permissionOverrides: cleared, [CLEARED_MARKER]: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(defaultsPath), { recursive: true });
    fs.writeFileSync(defaultsPath, JSON.stringify(next, null, 2));
  } catch {
    return 'skipped';
  }
  return 'migrated';
}
