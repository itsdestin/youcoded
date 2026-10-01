// Crash recovery for Office documents (finish plan Task 8): the editor's OWN recovery, kept by main.
//
// WHY: Euro-Office's bridge.js already streams every batch of edits to its host as it is made
// (save_changes, about once a second while the person types) and can replay such a log through the
// editor's own open pipeline (recovery_load → _recoveryEnqueue). Its host only had to keep the log.
// With it kept, nothing typed is lost when the app crashes, is killed, or a window closes before the
// next save — the next open of that file replays what never reached it. That made the close/quit
// "save every document first" handshake unnecessary, and it is gone (Task 8).
//
// One journal per document, in a private folder under <userData>/office-recovery/ (0700, like the
// session temp folders), named by a hash of the file's path so no folder name says where it lives:
//   info.json    the file it belongs to, its kind, and how much of the log the file already holds
//   base.bin     the editor's starting point: the Editor.bin it opened (the log replays onto it)
//   media/       that document's pictures, and every picture added while editing
//   changes.log  one line per batch: [deleteIndex | null, [change, …]] — appended, never rewritten
// WHY lazily (only on the first real edit): opening a file to read it writes nothing.
// WHY `rev` and not a count of changes: an undo shortens the list (deleteIndex) and a redo can bring
// it back to the same length; every batch that changes anything is one more revision, and the file
// holds every revision up to the one its last save was made from (`savedRev`).
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { log } from '../logger';
import type { OfficeSession } from './office-sessions';

let root: string | null = null;
/** Where journals live (registerOfficeIpc passes userData at startup). */
export function keepRecoveryIn(userData: string): void {
  root = path.join(userData, 'office-recovery');
}

interface Journal {
  dir: string;
  /** The session (token) writing it. A newer session of the same file takes it over. */
  owner: string;
  docType: string;
  /** Edits received (in memory, counted as they arrive) / held by the file / in the list now. */
  rev: number;
  savedRev: number;
  len: number;
  /** Where the editor's own numbering starts in the list. WHY: after a recovery, sdkjs counts its
   *  deleteIndex from the start of ITS session, not counting the replayed edits (measured in the dev
   *  window 2026-09-30: the first undo-trim after a recovery said 0, not 37). 0 for a fresh journal. */
  offset: number;
  /** The folder, base and info, written once (on the first edit or the first save). */
  start: Promise<void> | null;
  /** Every disk write for this journal, in arrival order. */
  chain: Promise<void>;
  /** Pictures already copied into media/. */
  media: Set<string>;
}
const journals = new Map<string, Journal>(); // by the session's (real) file path

const keyOf = (file: string) => createHash('sha256').update(file).digest('hex').slice(0, 32);
const DOC_TYPES = new Set(['word', 'cell', 'slide', 'pdf']);

function mine(s: OfficeSession): Journal | null {
  const j = journals.get(s.path);
  return j && j.owner === s.token ? j : null;
}
function queue(j: Journal, work: () => Promise<void>): Promise<void> {
  // WHY never rejecting: one failed write (a full disk) must not stop the next — and recovery is a
  // safety net; its failure is logged, never shown as a failed save.
  j.chain = j.chain.then(work).catch((e) => log('WARN', 'Office', 'recovery journal write failed', { error: String(e) }));
  return j.chain;
}
async function fileStamp(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  const st = await fsp.stat(file).catch(() => null);
  return st ? { size: st.size, mtimeMs: st.mtimeMs } : null;
}
async function writeInfo(j: Journal, s: OfficeSession): Promise<void> {
  const info = { path: s.path, docType: j.docType, savedRev: j.savedRev, file: await fileStamp(s.path) };
  // Write-then-rename: a crash mid-write must not leave half an info file (the journal would be lost).
  await fsp.writeFile(path.join(j.dir, 'info.json.part'), JSON.stringify(info));
  await fsp.rename(path.join(j.dir, 'info.json.part'), path.join(j.dir, 'info.json'));
}
async function syncMedia(j: Journal, s: OfficeSession): Promise<void> {
  // Picture files are never changed once written (office-pictures.ts writes each under a new
  // name), so a name already copied never needs copying again.
  const names = await fsp.readdir(path.join(s.temp, 'media')).catch(() => [] as string[]);
  for (const n of names) {
    if (j.media.has(n)) continue;
    await fsp.copyFile(path.join(s.temp, 'media', n), path.join(j.dir, 'media', n));
    j.media.add(n);
  }
}
function started(j: Journal, s: OfficeSession): Promise<void> {
  if (!j.start) {
    // WHY behind the chain: the previous journal of this file (a reloaded page's) may still be
    // appending to the same folder, which this replaces. And the chain waits for the start, so no
    // line is appended to a folder not made yet.
    j.start = j.chain.then(async () => {
      // A journal left from before that was not recovered (the editor began afresh) goes now.
      await fsp.rm(j.dir, { recursive: true, force: true });
      await fsp.mkdir(path.join(j.dir, 'media'), { recursive: true, mode: 0o700 });
      // Still the Editor.bin the editor opened: write_editor_bin waits for this before replacing it.
      await fsp.copyFile(path.join(s.temp, 'Editor.bin'), path.join(j.dir, 'base.bin'));
      await syncMedia(j, s);
      await writeInfo(j, s);
    });
    j.chain = j.start.catch((e) => log('WARN', 'Office', 'recovery journal could not start', { error: String(e) }));
  }
  return j.start;
}

/** The editor opened the document (recovery_begin): a fresh journal, written on its first edit. */
export function beginRecovery(s: OfficeSession, docType: unknown): void {
  if (!root) return;
  const prior = journals.get(s.path);
  journals.set(s.path, {
    dir: path.join(root, keyOf(s.path)), owner: s.token, docType: typeof docType === 'string' && DOC_TYPES.has(docType) ? docType : 'word',
    rev: 0, savedRev: 0, len: 0, offset: 0, start: null, media: new Set(),
    // After the previous journal of this file has finished writing (a reload of the same document).
    chain: prior ? prior.chain : Promise.resolve(),
  });
}

/** One batch of edits (save_changes). Counted at once — before any await — so a save asked for
 *  right after it knows exactly which edits its bytes hold (recoveryRev). */
export function recordChanges(s: OfficeSession, changes: string[], deleteIndex: number | null): void {
  const j = mine(s);
  if (!j) return;
  const before = j.len;
  // Kept as a place in the whole list, so the log reads the same whichever session wrote it.
  const at = deleteIndex === null ? null : j.offset + deleteIndex;
  if (at !== null && at >= 0 && at < j.len) j.len = at;
  j.len += changes.length;
  // A save marks where it is with an empty batch at the current length: nothing changed.
  if (changes.length === 0 && j.len === before) return;
  j.rev += 1;
  const line = JSON.stringify([at, changes]) + '\n';
  started(j, s).catch(() => {}); // logged by the chain
  void queue(j, async () => {
    await syncMedia(j, s);
    await fsp.appendFile(path.join(j.dir, 'changes.log'), line);
  });
}

/** How many edits the editor has sent so far (taken when its bytes arrive for a save). */
export function recoveryRev(s: OfficeSession): number {
  return mine(s)?.rev ?? 0;
}

/** Before the session's Editor.bin is replaced by a save's bytes: the starting point is kept. */
export async function beforeBinReplaced(s: OfficeSession): Promise<void> {
  const j = mine(s);
  // A journal that cannot start is logged (above), never a reason for the save itself to fail.
  if (j) await started(j, s).catch(() => {});
}

/** A save landed holding every edit up to `rev`: those are no longer anything to recover. */
export function markRecoverySaved(s: OfficeSession, rev: number): void {
  const j = mine(s);
  if (!j || rev <= j.savedRev) return;
  j.savedRev = rev;
  if (j.start) void queue(j, () => writeInfo(j, s));
}

interface OnDisk { info: { path: string; docType: string; savedRev: number; file: { size: number; mtimeMs: number } | null }; list: string[]; rev: number }
async function readJournal(dir: string): Promise<OnDisk | null> {
  try {
    const info = JSON.parse(await fsp.readFile(path.join(dir, 'info.json'), 'utf8'));
    if (!info || typeof info.path !== 'string' || typeof info.savedRev !== 'number') return null;
    const text = await fsp.readFile(path.join(dir, 'changes.log'), 'utf8').catch(() => '');
    let list: string[] = [];
    let rev = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let batch: unknown;
      // WHY skip a line that does not parse: a crash can cut the last append short.
      try { batch = JSON.parse(line); } catch { continue; }
      if (!Array.isArray(batch) || !Array.isArray(batch[1])) continue;
      const [d, changes] = batch as [unknown, unknown[]];
      const before = list.length;
      if (typeof d === 'number' && d >= 0 && d < list.length) list = list.slice(0, d);
      list.push(...changes.filter((c): c is string => typeof c === 'string'));
      if (changes.length > 0 || list.length !== before) rev += 1;
    }
    return { info, list, rev };
  } catch {
    return null; // no journal (the usual case), or one that cannot be read: nothing to offer
  }
}

/** recovery_candidates: this document's unsaved edits, if a journal holds any — never another
 *  file's, and never a folder (the frame learns no paths). */
export async function recoveryCandidates(s: OfficeSession): Promise<Array<{ id: string; name: string; docType: string; modifiedMs: number }>> {
  if (!root) return [];
  const dir = path.join(root, keyOf(s.path));
  await journals.get(s.path)?.chain; // a reloaded page's last edits may still be writing
  const j = await readJournal(dir);
  if (!j || j.info.path !== s.path || j.rev <= j.info.savedRev) return [];
  const st = await fsp.stat(path.join(dir, 'changes.log')).catch(() => null);
  return [{ id: keyOf(s.path), name: path.basename(s.path), docType: j.info.docType, modifiedMs: st?.mtimeMs ?? Date.now() }];
}

/**
 * recovery_load: put the journal's starting point and pictures into this session's temp folder
 * (what the editor and the office:// pictures route read) and hand the editor the bytes and the
 * edits to replay. This session takes the journal over and goes on writing it. `outsideChange`:
 * the file changed outside Office since its last save here — the editor still recovers the edits
 * (the file as it was is kept by Versions as "When you opened it"), and the strip says so.
 */
export async function loadRecovery(s: OfficeSession, id: unknown, maxBytes: number): Promise<{ id: string; data: string; name: string; path: string; docType: string; changes: string[]; outsideChange: boolean } | null> {
  if (!root || id !== keyOf(s.path)) return null;
  const dir = path.join(root, keyOf(s.path));
  await journals.get(s.path)?.chain;
  const j = await readJournal(dir);
  if (!j || j.info.path !== s.path || j.rev <= j.info.savedRev) return null;
  const base = path.join(dir, 'base.bin');
  const size = (await fsp.stat(base)).size;
  if (size > maxBytes) return null;
  await fsp.rm(path.join(s.temp, 'media'), { recursive: true, force: true });
  await fsp.cp(path.join(dir, 'media'), path.join(s.temp, 'media'), { recursive: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
  await fsp.copyFile(base, path.join(s.temp, 'Editor.bin'));
  const now = await fileStamp(s.path);
  const was = j.info.file;
  journals.set(s.path, {
    dir, owner: s.token, docType: j.info.docType, rev: j.rev, savedRev: j.info.savedRev, len: j.list.length, offset: j.list.length,
    start: Promise.resolve(), chain: Promise.resolve(), media: new Set(await fsp.readdir(path.join(dir, 'media')).catch(() => [] as string[])),
  });
  return {
    id: keyOf(s.path), data: (await fsp.readFile(base)).toString('base64'),
    // The name only: bridge.js uses the path for the document's name and extension, never to read.
    name: path.basename(s.path), path: path.basename(s.path), docType: j.info.docType, changes: j.list,
    outsideChange: !!was && !!now && (was.size !== now.size || was.mtimeMs !== now.mtimeMs),
  };
}

/** recovery_discard, Close without saving, Discard and quit: these edits are let go of on purpose.
 *  WHY the journal stops for this session too: its starting point would no longer match. */
export async function discardRecovery(s: OfficeSession): Promise<void> {
  if (!root) return;
  const j = journals.get(s.path);
  if (j && j.owner !== s.token) return;
  journals.delete(s.path);
  await j?.chain;
  await fsp.rm(path.join(root, keyOf(s.path)), { recursive: true, force: true }).catch(() => {});
}

async function settle(file: string, j: Journal): Promise<void> {
  journals.delete(file);
  await j.chain;
  // Kept while it holds edits the file does not: the next open of the file offers them back.
  if (j.rev <= j.savedRev) await fsp.rm(j.dir, { recursive: true, force: true }).catch(() => {});
}

/** The document closed (its tab, its window): an all-saved journal goes. */
export async function closeRecovery(s: OfficeSession): Promise<void> {
  const j = mine(s);
  if (j) await settle(s.path, j);
}

/** Quit: every all-saved journal goes; the rest stay for the next launch. Capped by the caller. */
export async function settleAllRecovery(): Promise<void> {
  await Promise.all([...journals.entries()].map(([file, j]) => settle(file, j)));
}

/** Tests only. */
export function resetRecoveryForTests(): void {
  journals.clear();
  root = null;
}
