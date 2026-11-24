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

/** `unreadable`: damaged and nothing could be restored or salvaged (the only case "Start fresh" is for).
 *  `write-failed`: a repair was possible but could not be SAVED (full disk, permissions): nothing was changed, and retrying may work. */
export type ConfigFailureKind = 'unreadable' | 'write-failed';
export type BackupConfigRead = { ok: true; config: ConfigObject } | { ok: false; kind: ConfigFailureKind; reason: string };

/** Thrown by `updateBackupConfig` when the file could not be used and nothing was written. */
export class ConfigDamagedError extends Error {
  constructor(readonly kind: ConfigFailureKind = 'unreadable') {
    super(kind === 'write-failed'
      ? "The saved backup settings needed repairing but the repair couldn't be saved, so nothing was changed."
      : "The saved backup settings couldn't be read, so nothing was changed.");
    this.name = 'ConfigDamagedError';
  }
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
 * backup entry, or a readable `setup_completed: true` (anything else is not worth keeping, and migrating from older
 * keys would be a guess).
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
  // WHY also "setup_completed was readable" (review F-F): a file cut off inside the list used to give up when no backup
  // entry was complete, and an install whose setup flag WAS readable then looked brand new and re-ran the setup wizard.
  // The flag is kept; the list is then honestly empty ("0 backups", and the person is asked to check), never guessed.
  if (backups === 0 && out.setup_completed !== true) return null;
  if (!Array.isArray(out.storage_backends)) out.storage_backends = [];
  return { config: out, backups };
}

// ---------------------------------------------------------------------------
// Read, repair, write
// ---------------------------------------------------------------------------

const countBackups = (c: ConfigObject) => (Array.isArray(c.storage_backends) ? c.storage_backends.length : 0);

/** The text written to disk. WHY `storage_backends` LAST (review F-F): a cut-off file loses its tail, so the small values
 *  (`setup_completed`, the older flat keys) written first survive a cut that the long backup list does not. */
function serialize(config: ConfigObject): string {
  const { storage_backends, ...rest } = config;
  return JSON.stringify(storage_backends === undefined ? rest : { ...rest, storage_backends }, null, 2);
}

/**
 * Write `config` safely. THE INVARIANT (review F-D): at every instant the last-known-good copy holds either what the
 * live file holds or what the live file is ABOUT to hold (a change that was asked for and serialises fine) — never
 * something OLDER than the live file. So after a crash at any point, a later restore can bring back a change that was
 * made a moment late, but never a backup the person had already removed. That is why the copy is refreshed BEFORE the
 * live file is written; if the live write then fails or does not read back identically, the copy is put back to what it
 * was (a change reported as failed must not come back later).
 *
 * `explicit` = the person asked for this change (add / remove / pause / save). A silent write (a migration, the
 * setup flag) never replaces a copy that holds MORE backups than the new content (review F-A: a first-run-shaped file
 * must not overwrite a good copy that still holds the person's backups).
 */
async function writeInner(file: string, config: ConfigObject, explicit: boolean): Promise<void> {
  const text = serialize(config);
  if (classifyConfigText(text).kind !== 'ok') throw new Error('The settings could not be written safely.');
  const prev = await readText(goodPath(file));
  const prevText = 'text' in prev ? prev.text : null;
  let refreshGood = true;
  if (!explicit && prevText !== null) {
    const pc = classifyConfigText(prevText);
    if (pc.kind === 'ok' && countBackups(pc.config) > countBackups(config)) refreshGood = false;
  }
  let copied = false;
  if (refreshGood) {
    try { await atomicWrite(goodPath(file), text); copied = true; }
    catch (e) { log('WARN', 'backup-config', 'Could not refresh the last-known-good settings copy', { error: String(e) }); }
  }
  try {
    await atomicWrite(file, text);
    const landed = await readText(file);
    if (!('text' in landed) || landed.text !== text) throw new Error('The settings file did not read back as written.');
  } catch (e) {
    if (copied) {
      // Put the copy back to what it was: a change reported as failed must not return later from the copy.
      try {
        if (prevText !== null) await atomicWrite(goodPath(file), prevText);
        else await fs.promises.unlink(goodPath(file));
      } catch (e2) { log('WARN', 'backup-config', 'Could not put the settings copy back after a failed write', { error: String(e2) }); }
    }
    throw e;
  }
}

async function writeNote(file: string, note: RecoveryNote): Promise<void> {
  try { await atomicWrite(notePath(file), JSON.stringify(note, null, 2)); }
  catch (e) { log('WARN', 'backup-config', 'Could not write the recovery note', { error: String(e) }); }
}

type Judged = { text: string } | { unreadable: string } | { missing: true };

/** The file is not usable as it stands (damaged, unreadable, blank or missing beside a good copy). Try the good copy,
 *  then a salvage; otherwise report it unreadable. A repair that cannot be SAVED is `write-failed`, never "damaged". */
async function repair(file: string, judged: Judged, reason: string): Promise<BackupConfigRead> {
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
  if (!replacement) return { ok: false, kind: 'unreadable', reason };

  // Another process may have repaired it a moment ago: only touch what was judged.
  const again = await readText(file);
  const same = 'missing' in judged ? 'missing' in again
    : 'text' in judged ? 'text' in again && again.text === judged.text
    : 'unreadable' in again;
  if (!same) return readInner(file);

  let aside: string | null = null;
  if (!('missing' in judged)) {
    try { aside = await moveAside(file); }
    catch (e) {
      // Gone already: the other copy of the app repaired it between our check and our move. Read what is there now.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return readInner(file);
      return { ok: false, kind: 'write-failed', reason: `${reason}; could not move it aside: ${String((e as Error)?.message ?? e)}` };
    }
    // The move acts on the path: if what we moved is not the text we judged (someone repaired it in between), put it back.
    if ('text' in judged) {
      const moved = await readText(path.join(path.dirname(file), aside));
      if (!('text' in moved) || moved.text !== judged.text) {
        // benign: the undo is best effort; if the path was re-made meanwhile the re-read just below finds the live file
        try { await fs.promises.rename(path.join(path.dirname(file), aside), file); } catch { /* re-made meanwhile */ }
        return readInner(file);
      }
    }
  }
  try {
    await writeInner(file, replacement.config, true);
  } catch (e) {
    // Put the original back rather than leave no file at all.
    if (aside) {
      // benign: this is the undo of a failed repair; the failure itself is returned to the caller just below
      try { await fs.promises.rename(path.join(path.dirname(file), aside), file); } catch { /* nothing more to do */ }
    }
    return { ok: false, kind: 'write-failed', reason: `${reason}; could not write the repaired file: ${String((e as Error)?.message ?? e)}` };
  }
  await writeNote(file, { kind: replacement.kind, at: new Date().toISOString(), damagedCopy: aside ?? '(the file was missing)', backups: countBackups(replacement.config) });
  log('WARN', 'backup-config', `Settings file was unusable (${reason}); ${replacement.kind === 'restored' ? 'restored from the last saved copy' : 'kept what could be read'}`, { damagedCopy: aside });
  return { ok: true, config: replacement.config };
}

async function readInner(file: string): Promise<BackupConfigRead> {
  const read = await readText(file);
  // WHY a missing file with a good copy is restored too (review F-A): a stop between "damaged file moved aside" and
  // "repaired file written" leaves exactly that, and reading it as a fresh first run would let the next harmless write
  // replace the copy. A true first run has no good copy either, so "missing + good copy" is the restore case.
  if ('missing' in read) {
    const good = await readText(goodPath(file));
    if ('text' in good && classifyConfigText(good.text).kind === 'ok') return repair(file, { missing: true }, 'the file was missing');
    return { ok: true, config: {} };
  }
  if ('unreadable' in read) return repair(file, read, read.unreadable);
  const c = classifyConfigText(read.text);
  if (c.kind === 'ok') return { ok: true, config: c.config };
  if (c.kind === 'damaged') return repair(file, read, c.reason);
  // Empty: the normal first run — unless a good copy exists, then it is what a crash mid-write leaves behind.
  const good = await readText(goodPath(file));
  if ('text' in good && classifyConfigText(good.text).kind === 'ok') return repair(file, read, 'the file was empty');
  return { ok: true, config: {} };
}

/** Read the settings, repairing a damaged file first. `ok:false` means it could not be used: nothing was changed. */
export function readBackupConfig(file: string): Promise<BackupConfigRead> {
  return queued(file, () => readInner(file));
}

/**
 * Read-modify-write the settings in one step, with the same repair as a read. `mutate` edits the object it is given
 * and may return a value for the caller. Throws ConfigDamagedError — writing nothing — when the file could not be used.
 * `opts.explicit`: the person asked for this change (see writeInner); silent maintenance writes leave it off.
 */
export function updateBackupConfig<T = void>(file: string, mutate: (config: ConfigObject) => T | Promise<T>, opts: { explicit?: boolean } = {}): Promise<T> {
  return queued(file, async () => {
    const r = await readInner(file);
    if (!r.ok) throw new ConfigDamagedError(r.kind);
    const result = await mutate(r.config);
    await writeInner(file, r.config, opts.explicit === true);
    return result;
  });
}

/**
 * "Start fresh": move an unreadable file aside (kept, dated) so the person can set up again. Refuses — answers null — when
 * the file is healthy, repairable (a good copy or readable content exists) or only failed to be REPAIRED (a full disk
 * is not a damaged file; review F-C). Returns the new name when it moved the file.
 */
export function startFreshBackupConfig(file: string): Promise<string | null> {
  return queued(file, async () => {
    const r = await readInner(file);
    if (r.ok || r.kind !== 'unreadable') return null;
    // Belt and braces: never set aside a file a repair could still use.
    const good = await readText(goodPath(file));
    if ('text' in good && classifyConfigText(good.text).kind === 'ok') return null;
    const now = await readText(file);
    if ('text' in now && salvageConfigText(now.text)) return null;
    if ('missing' in now) return null;
    const aside = await moveAside(file);
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
  } catch { return null; } // benign: an unreadable note just means nothing to tell
}

export async function clearRecoveryNote(file: string): Promise<void> {
  // benign: no note file means there is nothing to clear
  try { await fs.promises.unlink(notePath(file)); } catch { /* already gone */ }
}
