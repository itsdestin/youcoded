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
// THE PARSE-FAILURE RULE — refuse to write when the file exists but does not
// parse. settings.json carries the user's hooks, enabledPlugins, permissions
// and statusLine; a writer that "recovers" by replacing a corrupt file with
// just its own key silently wipes all of that (retention-default.ts's
// convention, kept because it is the only one that cannot destroy user
// configuration). A refused write is logged at WARN so it is diagnosable; the
// user (or Claude Code, which refuses to start on the same file) repairs it.
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
  /** True iff the file was rewritten — the mutator changed something. */
  written: boolean;
  /** Why nothing was written, when it was not because nothing changed. */
  refused?: 'unparseable' | 'locked';
}

/**
 * Read-mutate-write under the cross-process lock. `mutate` receives the
 * parsed object (fresh, `{}` when the file is absent) and edits it in place;
 * the file is rewritten only when the serialised result differs from what
 * was read, atomically (tmp + fsync + rename, via cas-write).
 */
export async function mutateSettings(mutate: (settings: Settings) => void): Promise<MutateSettingsResult> {
  const p = settingsPath();
  let refused: MutateSettingsResult['refused'];
  let written = false;
  const locked = await mutateFileUnderLock(p, (onDisk) => {
    let settings: Settings = {};
    if (onDisk !== null) {
      const parsed = parseSettings(onDisk);
      if (parsed === null) {
        refused = 'unparseable';
        return null;
      }
      settings = parsed;
    }
    // Compact serialisations compare CONTENT, so a file another writer
    // pretty-printed differently is not rewritten just to change whitespace.
    const before = JSON.stringify(settings);
    mutate(settings);
    const after = JSON.stringify(settings);
    if (onDisk !== null && before === after) return null;
    written = true;
    return JSON.stringify(settings, null, 2);
  });
  if (!locked) {
    log('WARN', 'ClaudeSettings', 'settings.json is locked by another process — write skipped', { path: p });
    return { written: false, refused: 'locked' };
  }
  if (refused) {
    log('WARN', 'ClaudeSettings', 'settings.json exists but does not parse — refusing to overwrite it', { path: p });
    return { written: false, refused };
  }
  if (written) memo = null;
  return { written };
}

/** One dot-path field, read through the shared memo. Throws on an unsafe
 *  segment (`__proto__` …), exactly as getJsonPath does. */
export function getField(field: string): unknown {
  return getJsonPath(readSettings(), field);
}

/** Set (or, with null/undefined, delete) one dot-path field under the lock.
 *  Resolves false when the write was refused or the field is unsafe. */
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
