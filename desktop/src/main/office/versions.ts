// Kept versions of Office files — the safety net behind autosave (build plan Task 7; design
// section 3 `versions.ts` and section 4). Autosave writes the person's real file every few
// seconds, so these copies are how a change is taken back.
//
// On disk, per file: userData/office-versions/<sha1 of the real path>/
//   index.json        { updatedAt, path, versions: [newest first] } — written only by casWrite
//   <id>.<reason>.<ext>  one whole copy per version (id = ISO time without colons + 4 hex). WHY the
//                     reason in the name: a copy a crash left out of the index is named again with
//                     its own label ("When you opened it"), not a guessed one.
//
// The priority, in order: the person's file is never lost or corrupted; a kept version is never
// lost by accident (a copy is written whole BEFORE the index names it, and the index drops a
// version BEFORE its copy is removed — a crash between the two leaves a spare copy, never an
// entry pointing at nothing); only then tidiness.
//
// All I/O is async (performance rule 1). No hashing: the "same as the newest?" check compares
// sizes first and bytes only when they match — hashing a 200 MB file would stall main.
import { randomBytes, createHash } from 'node:crypto';
import { constants as fsc, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { OfficeVersion } from '../../shared/office-types';
import { CAS_REPLACE_ANY, casWrite, renameReplacing, type CasExpectation } from '../artifacts/cas-write';
import { noteOwnWrite } from '../artifacts/project-watcher';
import { authorizeArtifactWrite } from '../artifacts/write-authorization';
import { log } from '../logger';
import { finishCopy, SAVE_DIR_MARK } from './office-commands';

// ── The owner's pruning rules, "tiered-30" (R11) ──
const KEEP_ALL_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PER_FILE = 50;
/** 1 GB across every file's versions. */
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const MSG = {
  notKept: 'That version is no longer kept.',
  damaged: "That kept copy is damaged, so it can't be restored.",
  protected: "Office can't change files in this protected folder.",
  needsConfirm: "Office can't change settings files like this one yet.",
  folderGone: "This file's folder no longer exists.",
  noPermission: "Office doesn't have permission to change this file.",
  diskFull: "The disk is full, so Office couldn't restore this version.",
  readOnly: "This file is on a read-only disk, so Office couldn't restore it.",
  general: "Office couldn't restore this version.",
} as const;

interface Entry extends OfficeVersion {
  /** The copy's extension (docx/xlsx/pptx), so the copy's name never depends on the file's. */
  ext: string;
}
interface Index {
  updatedAt: string;
  /** The file these are versions of — for a person looking at the folder; nothing reads it. */
  path: string;
  versions: Entry[];
}

const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z-[0-9a-f]{4}$/;
const EXT_RE = /^(docx|xlsx|pptx)$/;
const INDEX = 'index.json';
// A copy or `.part` this old that the index does not name was left by a crash, never by a
// snapshot still being written (those take seconds at most).
const STRAY_AGE_MS = 60 * 60 * 1000;

export function versionsDir(userData: string, filePath: string): string {
  // WHY a hash of the path, not the path: any file name becomes one safe folder name, and the
  // folder does not spell out where the person's file lives. The caller passes the REAL path
  // (the Office session's), so a file reached through a link shares its versions.
  return path.join(userData, 'office-versions', createHash('sha1').update(filePath).digest('hex'));
}

/**
 * Which versions to keep (pure). Every version from the last 24 hours; between 1 and 30 days old,
 * only the newest of each calendar day (local, as the person reads dates); nothing older; and of
 * those, at most the 50 newest.
 */
export function pruneKeep(versions: { id: string; at: string; bytes: number }[], now: Date): Set<string> {
  const newestFirst = [...versions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const keep: string[] = [];
  const daysSeen = new Set<string>();
  for (const v of newestFirst) {
    const at = new Date(v.at);
    const age = now.getTime() - at.getTime();
    // WHY an unreadable or future time counts as recent: a clock change must never be what
    // throws a version away.
    if (!Number.isFinite(age) || age <= KEEP_ALL_MS) { keep.push(v.id); continue; }
    if (age > KEEP_DAYS_MS) continue;
    const day = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
    if (daysSeen.has(day)) continue;
    daysSeen.add(day);
    keep.push(v.id);
  }
  return new Set(keep.slice(0, MAX_PER_FILE));
}

// ── One operation per file's folder at a time ──
// WHY: every window's saves, a restore and the startup prune run in this one main process; a
// chain per folder keeps a snapshot from reading the index while a prune rewrites it. casWrite's
// updatedAt check then covers anything outside this process.
const chains = new Map<string, Promise<unknown>>();
function locked<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const prior = chains.get(dir) ?? Promise.resolve();
  const p = prior.then(run, run);
  const tail = p.catch(() => undefined);
  chains.set(dir, tail);
  void tail.then(() => { if (chains.get(dir) === tail) chains.delete(dir); });
  return p;
}

const copyName = (e: { id: string; reason: string; ext: string }) => `${e.id}.${e.reason}.${e.ext}`;
const copyPath = (dir: string, e: { id: string; reason: string; ext: string }) => path.join(dir, copyName(e));
// WHY only this form: copies named `<id>.<ext>` exist only in dev profiles from before this naming,
// and are left unread (accepted) rather than guessed at.
const COPY_RE = /^(.+)\.(opened|autosave|before-restore)\.(docx|xlsx|pptx)$/;
const publicShape = (e: Entry): OfficeVersion => ({ id: e.id, at: e.at, reason: e.reason, bytes: e.bytes });
const byNewest = (a: Entry, b: Entry) => Date.parse(b.at) - Date.parse(a.at);

function isEntry(x: unknown): x is Entry {
  const e = x as Entry;
  return !!e && typeof e.id === 'string' && ID_RE.test(e.id) && typeof e.at === 'string' && typeof e.bytes === 'number'
    && typeof e.ext === 'string' && EXT_RE.test(e.ext) && (e.reason === 'opened' || e.reason === 'autosave' || e.reason === 'before-restore');
}

/** The index and the token to write it back with. A damaged index is rebuilt from the copies
 *  on disk rather than taken as empty — taking it as empty would forget every kept version. */
async function readIndex(dir: string): Promise<{ versions: Entry[]; token: CasExpectation }> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(dir, INDEX), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { versions: [], token: null };
    throw e;
  }
  try {
    const parsed = JSON.parse(text) as Partial<Index>;
    if (typeof parsed.updatedAt === 'string' && Array.isArray(parsed.versions)) {
      return { versions: parsed.versions.filter(isEntry).sort(byNewest), token: parsed.updatedAt };
    }
  } catch { /* fall through to the rebuild */ }
  log('WARN', 'Office', 'a versions index was unreadable; rebuilt it from the kept copies');
  return { versions: await adoptCopies(dir, [], 0), token: CAS_REPLACE_ANY };
}

/** Kept copies the index does not name (a crash between writing a copy and naming it), added
 *  back as ordinary versions. Only copies older than `minAgeMs`, so a snapshot another process
 *  is still naming is left to it. */
async function adoptCopies(dir: string, versions: Entry[], minAgeMs: number): Promise<Entry[]> {
  const known = new Set(versions.map(copyName));
  const out = [...versions];
  const now = Date.now();
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    const m = COPY_RE.exec(name);
    if (!m || known.has(name) || !ID_RE.test(m[1])) continue;
    const st = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (!st?.isFile() || (minAgeMs > 0 && now - st.mtimeMs < minAgeMs)) continue;
    const iso = m[1].replace(/T(\d{2})(\d{2})(\d{2})/, 'T$1:$2:$3').replace(/-[0-9a-f]{4}$/, '');
    const at = Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : new Date(st.mtimeMs).toISOString();
    out.push({ id: m[1], at, reason: m[2] as Entry['reason'], bytes: st.size, ext: m[3] });
  }
  return out.sort(byNewest);
}

/** Change the index under casWrite, retrying when another writer got there first. */
async function updateIndex(dir: string, filePath: string, change: (versions: Entry[]) => Entry[]): Promise<Entry[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { versions, token } = await readIndex(dir);
    const next = change(versions).sort(byNewest);
    // WHY a random tail on the token: two writes in the same millisecond must not carry the same
    // updatedAt, or the second writer's check would pass against the first one's index.
    const index: Index = { updatedAt: `${new Date().toISOString()}#${randomBytes(4).toString('hex')}`, path: filePath, versions: next };
    // WHY casWrite's default mode (0644) is accepted for the index: it holds only times, sizes and
    // the file's path, and it sits in this 0700 folder, which no other account can enter.
    const r = await casWrite(path.join(dir, INDEX), token, JSON.stringify(index, null, 1), (json) => (JSON.parse(json) as Index).updatedAt);
    if (r.committed) return next;
  }
  throw new Error('the versions index stayed busy');
}

function newId(now: Date): string {
  return `${now.toISOString().replace(/:/g, '')}-${randomBytes(2).toString('hex')}`;
}

async function sameAsCopy(dir: string, e: Entry, bytes: Buffer): Promise<boolean> {
  if (e.bytes !== bytes.length) return false;
  const kept = await fsp.readFile(copyPath(dir, e)).catch(() => null);
  return !!kept && kept.equals(bytes);
}

async function snapshotLocked(userData: string, filePath: string, reason: OfficeVersion['reason'], bytes: Buffer, now: Date): Promise<OfficeVersion | null> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!EXT_RE.test(ext)) return null;
  const dir = versionsDir(userData, filePath);
  // WHY 0700: the copies are the person's documents; other accounts on the machine must not
  // read them from the app's data folder.
  await fsp.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const { versions } = await readIndex(dir);
  if (versions[0] && (await sameAsCopy(dir, versions[0], bytes))) return null;
  // The editor reopening a file just restored would keep a second, identical copy of the version
  // just restored (a duplicate "When you opened it" row). Checked once, then forgotten.
  const restoredId = justRestored.get(filePath);
  if (restoredId !== undefined) {
    justRestored.delete(filePath);
    const restored = versions.find((v) => v.id === restoredId);
    if (reason === 'opened' && restored && (await sameAsCopy(dir, restored, bytes))) return null;
  }

  const entry: Entry = { id: newId(now), at: now.toISOString(), reason, bytes: bytes.length, ext };
  const dest = copyPath(dir, entry);
  const part = `${dest}.part`;
  try {
    // Whole and on disk before any index names it (fsync, then one rename). WHY inside the try: a
    // write that fails half-way (a full disk) must not leave its up-to-200 MB `.part` behind.
    const fh = await fsp.open(part, 'w', 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(part, dest);
    await updateIndex(dir, filePath, (list) => [entry, ...list.filter((v) => v.id !== entry.id)]);
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => {});
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw e;
  }
  // Design section 3: pruning runs after each snapshot (this file's rules; the 1 GB cap across
  // files runs at startup, in pruneAll). A failed prune costs disk space, never the snapshot.
  await pruneDirLocked(dir, filePath, now).catch((e) => log('WARN', 'Office', 'pruning versions failed', { error: String(e) }));
  return publicShape(entry);
}

/** Drop what the rules (and `alsoDrop`) no longer keep: index first, then the copies. */
async function pruneDirLocked(dir: string, filePath: string, now: Date, alsoDrop: ReadonlySet<string> = new Set()): Promise<Entry[]> {
  let dropped: Entry[] = [];
  const kept = await updateIndex(dir, filePath, (list) => {
    const keep = pruneKeep(list, now);
    dropped = list.filter((v) => !keep.has(v.id) || alsoDrop.has(v.id));
    return list.filter((v) => keep.has(v.id) && !alsoDrop.has(v.id));
  });
  for (const v of dropped) await fsp.rm(copyPath(dir, v), { force: true }).catch(() => {});
  return kept;
}

/** Keep a copy of `bytes` as a version of `filePath`. null when identical to the newest one. */
export async function snapshot(userData: string, filePath: string, reason: OfficeVersion['reason'], bytes: Buffer): Promise<OfficeVersion | null> {
  return locked(versionsDir(userData, filePath), () => snapshotLocked(userData, filePath, reason, bytes, new Date()));
}

/** The file's kept versions, newest first. */
export async function list(userData: string, filePath: string): Promise<OfficeVersion[]> {
  // WHY no catch: a real read error must reach the window as "couldn't load", never as an empty
  // list that tells the person their kept versions are gone. (No folder yet is simply [].)
  const { versions } = await readIndex(versionsDir(userData, filePath));
  return versions.map(publicShape);
}

// The version each file was last restored to, for the reopen's "opened" snapshot (see above).
const justRestored = new Map<string, string>();

class RestoreRefusal extends Error {}

/**
 * Put a kept version back. The file as it is now is kept first ('before-restore'); if that
 * cannot be kept, nothing is replaced. The copy is written back the way a save writes: a private
 * folder beside the file, the original's mode and group, authorized again, one rename.
 */
export async function restore(userData: string, filePath: string, id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, message: MSG.notKept };
  const dir = versionsDir(userData, filePath);
  try {
    return await locked(dir, async () => {
      const { versions } = await readIndex(dir);
      const entry = versions.find((v) => v.id === id);
      if (!entry) return { ok: false as const, message: MSG.notKept };
      // Read into memory FIRST: keeping the current file below prunes, and may let this very
      // version go (the 50 cap) — the restore must not depend on its copy still being there.
      const bytes = await fsp.readFile(copyPath(dir, entry)).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') throw new RestoreRefusal(MSG.notKept);
        throw e;
      });
      // docx, xlsx and pptx are zip files ("PK\x03\x04"); a copy that is not whole must never
      // replace the person's file.
      if (bytes.length !== entry.bytes || bytes.subarray(0, 4).toString('latin1') !== 'PK\x03\x04') throw new RestoreRefusal(MSG.damaged);
      const current = await fsp.readFile(filePath).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null; // deleted meanwhile: restoring brings it back
        throw e;
      });
      if (current) await snapshotLocked(userData, filePath, 'before-restore', current, new Date());
      await writeBack(filePath, bytes);
      justRestored.set(filePath, entry.id);
      return { ok: true as const };
    });
  } catch (e) {
    if (e instanceof RestoreRefusal) return { ok: false, message: e.message };
    const code = (e as NodeJS.ErrnoException)?.code;
    log('ERROR', 'Office', 'restoring a version failed', { error: String(e), code: code ?? null });
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, message: MSG.noPermission };
    if (code === 'ENOSPC') return { ok: false, message: MSG.diskFull };
    if (code === 'EROFS') return { ok: false, message: MSG.readOnly };
    return { ok: false, message: MSG.general };
  }
}

async function authorize(filePath: string): Promise<void> {
  const r = await authorizeArtifactWrite({ projectRoot: path.dirname(filePath), fullPath: filePath, mustStayInRoot: false });
  if (r.ok) return;
  if (r.error === 'protected-path') throw new RestoreRefusal(MSG.protected);
  if (r.error === 'needs-confirm') throw new RestoreRefusal(MSG.needsConfirm);
  throw new RestoreRefusal(MSG.folderGone);
}

// WHY the same steps as office-commands' saveFile: a restore replaces the person's file just as
// a save does, so it gets the same guarantees — a private (0700) folder beside the file, so the
// half-written copy is on the same disk and unreadable by others; the original's permissions and
// group carried over; the protected-folder check again right before the one atomic rename.
async function writeBack(target: string, bytes: Buffer): Promise<void> {
  await authorize(target);
  const orig = await fsp.stat(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  // A read-only file stays read-only: Office reports it instead of replacing it anyway.
  if (orig) await fsp.access(target, fsc.W_OK);
  const base = path.basename(target);
  const priv = await fsp.mkdtemp(path.join(path.dirname(target), `.${base}${SAVE_DIR_MARK}`));
  try {
    const tmp = path.join(priv, base);
    await fsp.writeFile(tmp, bytes);
    await finishCopy(tmp, orig);
    await authorize(target);
    noteOwnWrite(target);
    await renameReplacing(tmp, target);
  } finally {
    await fsp.rm(priv, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Tidy every file's versions: each file's own rules, then 1 GB across all files, oldest first.
 * Each file's newest version is never dropped by the shared cap — it is the one most likely to
 * be wanted, and one huge file must not leave another with nothing. Never throws: a folder that
 * cannot be tidied is logged and left as it is.
 */
export async function pruneAll(userData: string, now: Date = new Date(), maxTotalBytes: number = MAX_TOTAL_BYTES): Promise<void> {
  const base = path.join(userData, 'office-versions');
  const names = await fsp.readdir(base).catch(() => [] as string[]);
  const perDir: { dir: string; filePath: string; versions: Entry[] }[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{40}$/.test(name)) continue;
    const dir = path.join(base, name);
    try {
      const kept = await locked(dir, async () => {
        const filePath = await indexPath(dir);
        await sweepStrays(dir);
        // Spare copies (a crash between copy and index) are named again, then pruned as usual —
        // a kept version is never deleted just because its index entry was missing.
        const { versions } = await readIndex(dir);
        const adopted = await adoptCopies(dir, versions, STRAY_AGE_MS);
        if (adopted.length !== versions.length) await updateIndex(dir, filePath, (list) => mergeById(list, adopted));
        const present = await Promise.all(adopted.map(async (v) => (await fsp.stat(copyPath(dir, v)).catch(() => null)) !== null));
        const missing = new Set(adopted.filter((_, i) => !present[i]).map((v) => v.id));
        const left = await pruneDirLocked(dir, filePath, now, missing);
        // WHY only when nothing is left in it: a copy too young to adopt (or a `.part` still being
        // written) would go with the folder.
        if (left.length === 0 && (await onlyIndexLeft(dir))) await fsp.rm(dir, { recursive: true, force: true });
        return { filePath, versions: left };
      });
      if (kept.versions.length > 0) perDir.push({ dir, ...kept });
    } catch (e) {
      log('WARN', 'Office', 'tidying a file\'s versions failed', { error: String(e) });
    }
  }

  let total = perDir.reduce((n, d) => n + d.versions.reduce((m, v) => m + v.bytes, 0), 0);
  if (total <= maxTotalBytes) return;
  const candidates = perDir
    .flatMap((d) => d.versions.slice(1).map((v) => ({ d, v })))
    .sort((a, b) => Date.parse(a.v.at) - Date.parse(b.v.at));
  const drop = new Map<string, Set<string>>();
  for (const { d, v } of candidates) {
    if (total <= maxTotalBytes) break;
    total -= v.bytes;
    drop.set(d.dir, (drop.get(d.dir) ?? new Set()).add(v.id));
  }
  for (const d of perDir) {
    const ids = drop.get(d.dir);
    if (!ids) continue;
    await locked(d.dir, () => pruneDirLocked(d.dir, d.filePath, now, ids))
      .catch((e) => log('WARN', 'Office', 'trimming versions to the total limit failed', { error: String(e) }));
  }
}

function mergeById(list: Entry[], extra: Entry[]): Entry[] {
  const ids = new Set(list.map((v) => v.id));
  return [...list, ...extra.filter((v) => !ids.has(v.id))];
}

async function onlyIndexLeft(dir: string): Promise<boolean> {
  const names = await fsp.readdir(dir).catch(() => null);
  return names !== null && names.every((n) => n === INDEX || n === `${INDEX}.lock`);
}

async function indexPath(dir: string): Promise<string> {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dir, INDEX), 'utf8')) as Partial<Index>;
    return typeof parsed.path === 'string' ? parsed.path : '';
  } catch {
    return '';
  }
}

/** Half-written copies (`.part`) left by a crash (casWrite sweeps its own tmp files). */
async function sweepStrays(dir: string): Promise<void> {
  const now = Date.now();
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.part')) continue;
    const full = path.join(dir, name);
    const st = await fsp.stat(full).catch(() => null);
    if (st && now - st.mtimeMs > STRAY_AGE_MS) await fsp.rm(full, { force: true }).catch(() => {});
  }
}
