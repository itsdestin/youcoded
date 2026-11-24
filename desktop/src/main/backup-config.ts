// backup-config.ts — the ONE owner of ~/.claude/toolkit-state/config.json (the file that holds the saved backup
// destinations, `setup_completed`, and a few other settings).
//
// WHY one owner (backup fixes 2026-11-18, B-2): three code paths used to read and write this file on their own
// (sync-state.ts, sync-service.ts, first-run.ts), each with its own idea of "damaged", and a damaged file could only be
// left alone, never repaired. Everything now goes through here, so "damaged" has exactly one meaning and recovery has
// exactly one implementation:
//
//   1. every successful write keeps a last-known-good copy beside the file (`config.json.good`), written the same
//      safe way and only after the new content has been read back and parsed;
//   2. a damaged file is restored from that copy automatically; the damaged one is moved aside under a dated name
//      (never deleted) and a small note is left so the app can tell the person once;
//   3. with no good copy, whatever can be read WITHOUT GUESSING is kept — only values that are complete in the text
//      (a backup entry cut off halfway is dropped, never completed) — and the person is asked to check the list;
//   4. with nothing readable, nothing is written and the caller is told the file is damaged; `startFresh` moves it aside
//      when the person asks.
//
// "Empty" is a missing file, a zero-byte file or a blank one: the normal first run (unless a good copy exists, in
// which case a blank file is what a crash mid-write leaves behind and the copy is restored). Anything else that
// cannot be read or parsed as an object is damaged.
import fs from 'fs';
import path from 'path';
import { atomicWrite } from './atomic-write';
import { log } from './logger';

export type ConfigObject = Record<string, any>;

/** The one definition of what a config file's text means. */
export type ConfigText =
  | { kind: 'empty' }
  | { kind: 'ok'; config: ConfigObject }
  | { kind: 'damaged'; reason: string };

export function classifyConfigText(raw: string): ConfigText {
  if (!raw.trim()) return { kind: 'empty' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { kind: 'ok', config: parsed };
    return { kind: 'damaged', reason: 'not an object' };
  } catch (e) {
    return { kind: 'damaged', reason: String((e as Error)?.message ?? e) };
  }
}

/** What the person is told after the app repaired the file on its own. Kept in a small file until dismissed. */
export interface RecoveryNote {
  kind: 'restored' | 'salvaged';
  /** ISO time of the repair. */
  at: string;
  /** File name (not path) the damaged original was moved to. */
  damagedCopy: string;
  /** How many backup destinations the repaired file holds. */
  backups: number;
}

export type BackupConfigRead = { ok: true; config: ConfigObject } | { ok: false; reason: string };

/** Thrown by `updateBackupConfig` when the file is damaged and nothing could be repaired: nothing was written. */
export class ConfigDamagedError extends Error {
  constructor() { super("The saved backup settings couldn't be read, so nothing was changed."); this.name = 'ConfigDamagedError'; }
}

const goodPath = (file: string) => `${file}.good`;
const notePath = (file: string) => `${file}.recovered.json`;

// One read-modify-write (or repair) at a time per file, in this process. WHY: two repairs racing would both move the
// "damaged" file aside, and the second would move the first one's freshly repaired file; two read-modify-writes would
// lose one change. Across processes (a dev copy beside the installed app) the repair re-checks before it moves anything.
const queues = new Map<string, Promise<unknown>>();
function queued<T>(file: string, job: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
  queues.set(key, run.then(() => undefined, () => undefined));
  return run;
}

async function readText(file: string): Promise<{ text: string } | { missing: true } | { unreadable: string }> {
  try { return { text: await fs.promises.readFile(file, 'utf8') }; }
  catch (e: any) { return e?.code === 'ENOENT' ? { missing: true } : { unreadable: String(e?.message ?? e) }; }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Move the damaged file next to itself under a dated name; never overwrites an earlier one. Returns the new name. */
async function moveAside(file: string): Promise<string> {
  const base = `${path.basename(file)}.damaged-${stamp(new Date())}`;
  for (let n = 0; ; n++) {
    const name = n === 0 ? base : `${base}-${n}`;
    const target = path.join(path.dirname(file), name);
    // benign: access() failing means the dated name is free, which is the answer we want
    try { await fs.promises.access(target); continue; } catch { /* free */ }
    await fs.promises.rename(file, target);
    return name;
  }
}

// ---------------------------------------------------------------------------
// Salvage: read what is COMPLETE in a cut-off file, and nothing else.
// ---------------------------------------------------------------------------

const WS = /\s/;
function skipWs(s: string, i: number): number { while (i < s.length && WS.test(s[i])) i++; return i; }

/** The end (exclusive) of a complete string literal starting at `i` (which holds the opening quote), or -1 if cut off. */
function stringEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') return j + 1;
  }
  return -1;
}

/** The end (exclusive) of a complete JSON value starting at `i`, or -1 when the text ends before the value does.
 *  A number or word counts only when something follows it: "12" at the very end could have been "123". */
function valueEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return stringEnd(s, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (ch === '"') { const e = stringEnd(s, j); if (e < 0) return -1; j = e - 1; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return j + 1; }
    }
    return -1;
  }
  let j = i;
  while (j < s.length && !/[,}\]\s]/.test(s[j])) j++;
  return j >= s.length || j === i ? -1 : j;
}

const parseAt = (s: string, i: number, end: number): { ok: true; value: any } | { ok: false } => {
  try { return { ok: true, value: JSON.parse(s.slice(i, end)) }; } catch { return { ok: false }; }
};

const isBackupEntry = (v: any) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'string' && typeof v.type === 'string';

/**
 * Keep what can be read from a cut-off settings file. Only values that are COMPLETE in the text are kept, in order,
 * up to the first break; a backup entry cut off halfway is dropped, never completed. Needs at least one complete
 * backup entry (without one there is nothing worth keeping, and migrating from older keys would be a guess).
 */
export function salvageConfigText(raw: string): { config: ConfigObject; backups: number } | null {
  let i = skipWs(raw, 0);
  if (raw[i] !== '{') return null;
  i++;
  const out: ConfigObject = {};
  for (;;) {
    i = skipWs(raw, i);
    if (raw[i] === ',') { i++; continue; }
    if (raw[i] !== '"') break;
    const kEnd = stringEnd(raw, i);
    if (kEnd < 0) break;
    const key = parseAt(raw, i, kEnd);
    if (!key.ok || typeof key.value !== 'string') break;
    i = skipWs(raw, kEnd);
    if (raw[i] !== ':') break;
    i = skipWs(raw, i + 1);
    if (key.value === 'storage_backends' && raw[i] === '[') {
      const list: any[] = [];
      let j = i + 1;
      let closed = false;
      for (;;) {
        j = skipWs(raw, j);
        if (raw[j] === ',') { j++; continue; }
        if (raw[j] === ']') { closed = true; j++; break; }
        const e = valueEnd(raw, j);
        if (e < 0) break;
        const v = parseAt(raw, j, e);
        if (!v.ok) break;
        if (isBackupEntry(v.value)) list.push(v.value);
        j = e;
      }
      out.storage_backends = list;
      if (!closed) break; // cut off inside the list: nothing after it can be trusted
      i = j;
      continue;
    }
    const e = valueEnd(raw, i);
    if (e < 0) break;
    const v = parseAt(raw, i, e);
    if (!v.ok) break;
    out[key.value] = v.value;
    i = e;
  }
  const backups = Array.isArray(out.storage_backends) ? out.storage_backends.length : 0;
  return backups > 0 ? { config: out, backups } : null;
}

// ---------------------------------------------------------------------------
// Read, repair, write
// ---------------------------------------------------------------------------

const countBackups = (c: ConfigObject) => (Array.isArray(c.storage_backends) ? c.storage_backends.length : 0);

/** Write `config` safely: serialise, check that the text parses back, write it atomically, read the file back, and only
 *  then refresh the last-known-good copy. Throws if the main write fails; a failed copy is only logged. */
async function writeInner(file: string, config: ConfigObject): Promise<void> {
  const text = JSON.stringify(config, null, 2);
  if (classifyConfigText(text).kind !== 'ok') throw new Error('The settings could not be written safely.');
  await atomicWrite(file, text);
  const landed = await readText(file);
  if (!('text' in landed) || landed.text !== text) return; // do not bless a copy of something that did not land
  try { await atomicWrite(goodPath(file), text); }
  catch (e) { log('WARN', 'backup-config', 'Could not refresh the last-known-good settings copy', { error: String(e) }); }
}

async function writeNote(file: string, note: RecoveryNote): Promise<void> {
  try { await atomicWrite(notePath(file), JSON.stringify(note, null, 2)); }
  catch (e) { log('WARN', 'backup-config', 'Could not write the recovery note', { error: String(e) }); }
}

/** The file is not usable as it stands. Try the good copy, then a salvage; otherwise report it damaged. */
async function repair(file: string, judged: { text: string } | { unreadable: string }, reason: string): Promise<BackupConfigRead> {
  let replacement: { config: ConfigObject; kind: RecoveryNote['kind'] } | null = null;
  const good = await readText(goodPath(file));
  if ('text' in good) {
    const c = classifyConfigText(good.text);
    if (c.kind === 'ok') replacement = { config: c.config, kind: 'restored' };
  }
  if (!replacement && 'text' in judged) {
    const s = salvageConfigText(judged.text);
    if (s) replacement = { config: s.config, kind: 'salvaged' };
  }
  if (!replacement) return { ok: false, reason };

  // Another process may have repaired it a moment ago: only move aside what was judged.
  const again = await readText(file);
  const same = 'text' in judged ? 'text' in again && again.text === judged.text : 'unreadable' in again;
  if (!same) return readInner(file);

  let aside: string;
  try { aside = await moveAside(file); }
  catch (e) { return { ok: false, reason: `${reason}; could not move it aside: ${String((e as Error)?.message ?? e)}` }; }
  try {
    await writeInner(file, replacement.config);
  } catch (e) {
    // Put the original back rather than leave no file at all.
    // benign: this is the undo of a failed repair; the failure itself is returned to the caller just below
    try { await fs.promises.rename(path.join(path.dirname(file), aside), file); } catch { /* nothing more to do */ }
    return { ok: false, reason: `${reason}; could not write the repaired file: ${String((e as Error)?.message ?? e)}` };
  }
  await writeNote(file, { kind: replacement.kind, at: new Date().toISOString(), damagedCopy: aside, backups: countBackups(replacement.config) });
  log('WARN', 'backup-config', `Settings file was damaged (${reason}); ${replacement.kind === 'restored' ? 'restored from the last saved copy' : 'kept what could be read'}`, { damagedCopy: aside });
  return { ok: true, config: replacement.config };
}

async function readInner(file: string): Promise<BackupConfigRead> {
  const read = await readText(file);
  if ('missing' in read) return { ok: true, config: {} };
  if ('unreadable' in read) return repair(file, read, read.unreadable);
  const c = classifyConfigText(read.text);
  if (c.kind === 'ok') return { ok: true, config: c.config };
  if (c.kind === 'damaged') return repair(file, read, c.reason);
  // Empty: the normal first run — unless a good copy exists, then it is what a crash mid-write leaves behind.
  const good = await readText(goodPath(file));
  if ('text' in good && classifyConfigText(good.text).kind === 'ok') return repair(file, read, 'the file was empty');
  return { ok: true, config: {} };
}

/** Read the settings, repairing a damaged file first. `ok:false` means damaged and not repairable: nothing was changed. */
export function readBackupConfig(file: string): Promise<BackupConfigRead> {
  return queued(file, () => readInner(file));
}

/**
 * Read-modify-write the settings in one step, with the same repair as a read. `mutate` edits the object it is given
 * (or returns a replacement) and may return a value for the caller. Throws ConfigDamagedError — writing nothing —
 * when the file is damaged and could not be repaired.
 */
export function updateBackupConfig<T = void>(file: string, mutate: (config: ConfigObject) => T | Promise<T>): Promise<T> {
  return queued(file, async () => {
    const r = await readInner(file);
    if (!r.ok) throw new ConfigDamagedError();
    const result = await mutate(r.config);
    await writeInner(file, r.config);
    return result;
  });
}

/**
 * "Start fresh": move a damaged file aside (kept, dated) so the person can set up again. Refuses when the file is
 * healthy or repairable — it never moves a usable file. Returns the new name, or null when there was nothing to do.
 */
export function startFreshBackupConfig(file: string): Promise<string | null> {
  return queued(file, async () => {
    if ((await readInner(file)).ok) return null;
    const aside = await moveAside(file);
    // The good copy (if any) was unreadable too, or repair would have used it; leave it be.
    log('WARN', 'backup-config', 'Settings file moved aside at the person\'s request', { damagedCopy: aside });
    return aside;
  });
}

/** The note about a repair the person has not been told about yet, if any. */
export async function readRecoveryNote(file: string): Promise<RecoveryNote | null> {
  const r = await readText(notePath(file));
  if (!('text' in r)) return null;
  try {
    const n = JSON.parse(r.text);
    return n && (n.kind === 'restored' || n.kind === 'salvaged') && typeof n.damagedCopy === 'string' ? n : null;
  } catch { return null; }
}

export async function clearRecoveryNote(file: string): Promise<void> {
  // benign: no note file means there is nothing to clear
  try { await fs.promises.unlink(notePath(file)); } catch { /* already gone */ }
}
