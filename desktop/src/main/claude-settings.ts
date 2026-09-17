import fs from 'fs';
import path from 'path';
import os from 'os';
import { mutateFileUnderLock } from './artifacts/cas-write';
import { getJsonPath, setJsonPath } from './safe-json-path';
import { log } from './logger';

// The ONE reader and writer of ~/.claude/settings.json.
//
// WHY (2026-09-16 audit D5 + W4): seven modules used to read and write this
// file with their own readers, writers and three contradictory rules for a
// file that does not parse (install-hooks.js threw, hook-reconciler and
// disable-prompt-suggestion wrote a fresh file over it, retention-default
// refused, claude-code-registry treated it as empty). Four of them ran back to
// back at every launch, none under the cross-process lock that PITFALLS says
// every ~/.claude JSON write takes — and the dev instance and the built app
// share this file. Everything now goes through here.
//
// THE PARSE-FAILURE RULE (Destin, 2026-09-17) — the app SELF-HEALS. When the
// file exists but does not parse as a JSON object, the first write renames it
// to `settings.json.corrupt-<timestamp>` beside itself (never deletes it),
// logs a WARN naming that backup, and proceeds as if the file were empty — so
// the launch chores write a fresh file carrying the app's hooks and the app
// works. Why not refuse: Claude Code itself starts anyway on a malformed file,
// silently ignoring it (anthropics/claude-code #2835, #24823), so a refusal
// meant a chat with no tool events and nothing on screen saying why. Silent
// hook loss is worse than a lost custom key, and the backup keeps the key
// recoverable. (Before this module, three writers each had a different rule.)
//
// Reads never repair: readSettings/getField answer `{}` for a corrupt file and
// leave it in place, because a read must have no side effect (the Preferences
// popup reads six fields in one tick, remote clients read too) and because the
// launch chores always run a write cycle before any read, so a file corrupt at
// launch is repaired before the first read. A file that goes corrupt mid-run
// is repaired by the next write; backup names carry a millisecond timestamp,
// so no later write can clobber an earlier backup.
//
// Reads are memoised on the file's (mtimeMs, size) — the memo phase 1a (W10)
// added to the Preferences handler, moved here so every reader shares it.
// Writers never touch the memo's object: mutateSettings re-reads the file
// inside the lock, and a write invalidates the memo.

type Settings = Record<string, unknown>;

export function settingsPath(): string {
  // Resolved per call, not at module load, so tests that stub os.homedir work
  // and so a home dir that changes under the process is honoured.
  return path.join(os.homedir(), '.claude', 'settings.json');
}

let memo: { path: string; mtimeMs: number; size: number; parsed: Settings } | null = null;

function isPlainObject(v: unknown): v is Settings {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse the file's text into a settings object, or null when it is not one. */
function parseSettings(raw: string): Settings | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The current settings object. `{}` when the file is missing OR unparseable
 * (a reader gets nothing either way; only the writer distinguishes the two).
 * The returned object is shared with the memo — treat it as READ-ONLY and
 * mutate through mutateSettings/setField.
 */
export function readSettings(): Settings {
  const p = settingsPath();
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    memo = null;
    return {};
  }
  if (memo && memo.path === p && memo.mtimeMs === st.mtimeMs && memo.size === st.size) return memo.parsed;
  const parsed = parseSettings(fs.readFileSync(p, 'utf8')) ?? {};
  memo = { path: p, mtimeMs: st.mtimeMs, size: st.size, parsed };
  return parsed;
}

export interface MutateSettingsResult {
  /** True iff the file was rewritten — the mutator changed something, or the
   *  file had to be repaired. */
  written: boolean;
  /** Why nothing was written, when it was not because nothing changed. */
  refused?: 'locked';
  /** The file did not parse: it was moved to `backupPath` and rewritten fresh. */
  repaired?: { backupPath: string };
}

/** `settings.json.corrupt-2026-09-17T00-45-12-345Z`: the ISO timestamp with
 *  `:` and `.` replaced, because `:` is not a legal file-name character on
 *  Windows and the file must be recoverable on every platform. */
function backupPathFor(p: string): string {
  return `${p}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Read-mutate-write under the cross-process lock. `mutate` receives the
 * parsed object (fresh, `{}` when the file is absent or was just backed up as
 * corrupt) and edits it in place; the file is rewritten when the serialised
 * result differs from what was read or when it was repaired, atomically
 * (tmp + fsync + rename, via cas-write).
 */
export async function mutateSettings(mutate: (settings: Settings) => void): Promise<MutateSettingsResult> {
  const p = settingsPath();
  let repaired: MutateSettingsResult['repaired'];
  let written = false;
  const locked = await mutateFileUnderLock(p, (onDisk) => {
    let settings: Settings = {};
    if (onDisk !== null) {
      const parsed = parseSettings(onDisk);
      if (parsed === null) {
        // Inside the lock, so no other writer can race the rename; the write
        // below then lands on a path that no longer exists, as a creation.
        const backupPath = backupPathFor(p);
        fs.renameSync(p, backupPath);
        repaired = { backupPath };
      } else {
        settings = parsed;
      }
    }
    // Compact serialisations compare CONTENT, so a file another writer
    // pretty-printed differently is not rewritten just to change whitespace.
    const before = JSON.stringify(settings);
    mutate(settings);
    const after = JSON.stringify(settings);
    if (!repaired && onDisk !== null && before === after) return null;
    written = true;
    return JSON.stringify(settings, null, 2);
  });
  if (!locked) {
    log('WARN', 'ClaudeSettings', 'settings.json is locked by another process — write skipped', { path: p });
    return { written: false, refused: 'locked' };
  }
  if (written) memo = null;
  if (repaired) {
    log('WARN', 'ClaudeSettings', 'settings.json did not parse — backed it up and wrote a fresh file', { path: p, backupPath: repaired.backupPath });
    return { written, repaired };
  }
  return { written };
}

/** One dot-path field, read through the shared memo. Throws on an unsafe
 *  segment (`__proto__` …), exactly as getJsonPath does. */
export function getField(field: string): unknown {
  return getJsonPath(readSettings(), field);
}

/** Set (or, with null/undefined, delete) one dot-path field under the lock.
 *  Resolves false when the file was locked or the field is unsafe. */
export async function setField(field: string, value: unknown): Promise<boolean> {
  try {
    const r = await mutateSettings((s) => { setJsonPath(s, field, value); });
    return !r.refused;
  } catch {
    return false;
  }
}

/** Test seam: forget the read memo (a test that rewrites the file within one
 *  mtime tick would otherwise read the previous parse). */
export function __resetSettingsMemo(): void {
  memo = null;
}
