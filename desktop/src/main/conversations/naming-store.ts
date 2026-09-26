// desktop/src/main/conversations/naming-store.ts
//
// IO shell for session name OWNERSHIP. One JSON file per conversation at
// <namesRoot>/<provider>/<id>.json; all decisions live in naming-core.ts.
//
// WHY a directory of its own, beside Personal/Conversations rather than inside
// it: the conversation store's own scans, its conflict healer and its record
// parser all operate on that directory's fixed record shape, and older clients
// rewrite anything they find there through a field whitelist. This directory is
// one no older build opens, reads or rewrites, so a name the user chose cannot
// be dropped by a peer that has never heard of naming. Sync carries it because
// the transport stages the whole Personal worktree, not an allowlist of names.
//
// Conflict copies: the sync engine writes '<base> (from <device>, <date>).json'
// beside the original. Both names are folded on read through the same
// commutative merge, then the copies are deleted — the same fold the
// conversation store's healer performs, minus the quarantine dance, because
// this record's merge has no activity ranking to get wrong.
import fs from 'node:fs';
import path from 'node:path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import { isConflictCopyName, extractConflictBase } from './store-core';
import {
  NamingRecord, emptyNamingRecord, parseNamingRecord, mergeNamingRecords,
} from './naming-core';

/** Revalidate a proposed publication against the authoritative sidecar after
 * the writer's await. A newer automatic review must be allowed to replace an
 * older one, but the older writer must never project its stale result afterward. */
export async function mayPublishAutomaticName(input: {
  read: () => Promise<NamingRecord | null>;
  hasTitle: () => Promise<boolean>;
  name: string;
  expectedAutoAt?: string;
  opening?: boolean;
  enabled: () => boolean;
}): Promise<boolean> {
  if (!input.enabled()) return false;
  const rec = await input.read();
  if (rec?.manual || (input.expectedAutoAt !== undefined &&
      (!rec || rec.auto !== input.name || rec.autoAt !== input.expectedAutoAt))) return false;
  // Only the opening placeholder refuses a legacy title. Scheduled AI reviews
  // intentionally replace earlier automatic names; they must not use this gate.
  if (input.opening && await input.hasTitle()) return false;
  return input.enabled();
}

/** Per-process projection ordering; never holds the cross-process disk lock. */
export function createTitleQueue() {
  const pending = new Map<string, Promise<void>>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = pending.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    pending.set(key, current);
    try {
      if (previous) await previous;
      return await work();
    } finally {
      if (pending.get(key) === current) pending.delete(key);
      release();
    }
  };
}

export interface NamingStore {
  get(provider: string, id: string): Promise<NamingRecord | null>;
  /** Read-modify-write one record under the cross-process lock. */
  mutate(provider: string, id: string, fn: (cur: NamingRecord) => NamingRecord): Promise<NamingRecord>;
  remove(provider: string, id: string): Promise<void>;
  root: string;
}

// Same allowlist as conversation-store: `provider` and `id` become path
// segments and this store sits behind IPC, so a raw '../../escape' must be
// refused rather than resolved. CC ids are UUIDs and pass untouched.
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const isSafeSegment = (s: string) =>
  SAFE_SEGMENT_RE.test(s) && s !== '.' && s !== '..' && !WINDOWS_RESERVED.test(s);

export function createNamingStore(namesRoot: string): NamingStore {
  const rootResolved = path.resolve(namesRoot);

  function providerDir(provider: string): string {
    const dir = path.resolve(rootResolved, provider);
    if (!isSafeSegment(provider) || !dir.startsWith(rootResolved + path.sep)) {
      throw new Error(`naming-store: invalid provider '${provider}'`);
    }
    return dir;
  }

  function recordPath(provider: string, id: string): string {
    const dir = providerDir(provider);
    const target = path.resolve(dir, `${id}.json`);
    if (!isSafeSegment(id) || !target.startsWith(dir + path.sep)) {
      throw new Error(`naming-store: invalid conversation id '${id}'`);
    }
    return target;
  }

  // WHY async (2026-09-24 main-blocking triage #16/#17/#3): get() runs on
  // every completed reply (the per-turn auto-naming check) and a sync read or
  // listing here froze every window for the duration of the disk call.
  async function readAt(file: string): Promise<NamingRecord | null> {
    try { return parseNamingRecord(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
  }

  // ---- Conflict-copy index ------------------------------------------------
  // WHY an in-memory index instead of listing the folder every time: the
  // folder holds one file per conversation ever named, and get() used to list
  // ALL of it once per reply just to learn that (almost always) no
  // '<id> (from <device>, <date>).json' copy exists. Now one cheap stat of the
  // folder answers "has anything been added, removed or renamed since the last
  // listing?" — the OS bumps a folder's modified time on every such change,
  // whoever makes it (the sync engine, another app instance, our own writes) —
  // and the folder is re-listed only when it has.
  //
  // The one way a stat could lie is a coarse clock: on a filesystem that
  // records times in whole seconds (or FAT's two), a copy landing in the same
  // tick as the change the listing already saw leaves the time unchanged. So a
  // listing is only trusted when the folder's last change was comfortably
  // older (RACY_MS) than the moment we looked — git's "racily clean" rule. A
  // recently changed folder is simply re-listed next time, i.e. the old
  // behaviour, never a missed copy. A clock that runs backwards likewise just
  // falls back to listing.
  const RACY_MS = 3000;
  interface DirIndex { mtimeMs: number; trusted: boolean; copies: Map<string, string[]> }
  const dirIndex = new Map<string, DirIndex>();
  // Single-flight: overlapping callers (a streaming reply's naming check plus a
  // rename click) share one stat+listing instead of racing two.
  const listing = new Map<string, Promise<Map<string, string[]>>>();

  function conflictCopiesIn(dir: string): Promise<Map<string, string[]>> {
    const running = listing.get(dir);
    if (running) return running;
    const run = (async () => {
      const lookedAt = Date.now();
      let mtimeMs: number;
      try { mtimeMs = (await fs.promises.stat(dir)).mtimeMs; } catch {
        dirIndex.delete(dir);
        return new Map<string, string[]>();
      }
      const cached = dirIndex.get(dir);
      if (cached && cached.trusted && cached.mtimeMs === mtimeMs) return cached.copies;
      let entries: string[];
      try { entries = await fs.promises.readdir(dir); } catch {
        dirIndex.delete(dir);
        return new Map<string, string[]>();
      }
      const copies = new Map<string, string[]>();
      for (const name of entries) {
        if (!isConflictCopyName(name)) continue;
        const base = extractConflictBase(name);
        if (!base) continue;
        const list = copies.get(base);
        if (list) list.push(name); else copies.set(base, [name]);
      }
      // The stat came BEFORE the listing, so a change in between is either in
      // this listing or bumps the time past the recorded one — never lost.
      dirIndex.set(dir, { mtimeMs, trusted: mtimeMs <= lookedAt - RACY_MS, copies });
      return copies;
    })();
    listing.set(dir, run);
    const clear = () => { if (listing.get(dir) === run) listing.delete(dir); };
    run.then(clear, clear);
    return run;
  }

  interface ReadCopy { file: string; parsed: NamingRecord | null }

  // This id's conflict copies and their contents. A copy that vanished since
  // the listing (someone else already folded it) is skipped, not "deleted".
  async function readConflictCopies(provider: string, id: string): Promise<ReadCopy[]> {
    let dir: string;
    try { dir = providerDir(provider); } catch { return []; }
    const names = (await conflictCopiesIn(dir)).get(`${id}.json`) ?? [];
    const out: ReadCopy[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      let raw: string;
      try { raw = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
      let parsed: NamingRecord | null = null;
      try { parsed = parseNamingRecord(raw); } catch { parsed = null; }
      out.push({ file, parsed });
    }
    return out;
  }

  // Fold this id's conflict copies into `base`. Returns the merged record and
  // the copies folded (the caller must persist it — deleting a copy without
  // writing its content back would LOSE the name it carried, which is the one
  // outcome this whole module exists to prevent). Pure and synchronous so it
  // can run inside mutateFileUnderLock's synchronous callback.
  function foldConflicts(base: NamingRecord, copies: ReadCopy[]): { rec: NamingRecord; folded: string[] } {
    const folded: string[] = [];
    let rec = base;
    for (const { file, parsed } of copies) {
      // An unparseable copy is still deleted: it carries nothing we can keep,
      // and leaving it makes the engine re-offer it on every read.
      if (parsed) rec = mergeNamingRecords(rec, parsed);
      folded.push(file);
    }
    return { rec, folded };
  }

  async function mutate(
    provider: string,
    id: string,
    fn: (cur: NamingRecord) => NamingRecord,
  ): Promise<NamingRecord> {
    const target = recordPath(provider, id);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    // WHY the copies are read before the lock rather than inside it: the
    // lock's callback is synchronous, and listing/reading synchronously there
    // is exactly the main-thread stall this store must not cause. Nothing is
    // lost by it: only copies whose content is MERGED INTO the written record
    // are deleted below, and the merge is commutative, so folding a copy into
    // whatever the lock hands back gives the same record as folding it inside.
    // A copy that lands after this read is left on disk and folded by the
    // next read — never deleted unseen.
    const copies = await readConflictCopies(provider, id);
    let result: NamingRecord | undefined;
    let folded: string[] = [];
    const committed = await mutateFileUnderLock(target, (onDisk) => {
      const existing = (onDisk ? parseNamingRecord(onDisk) : null) ?? emptyNamingRecord(id, provider);
      const fold = foldConflicts(existing, copies);
      folded = fold.folded;
      result = fn(fold.rec);
      // WHY: a conditional initial title that lost the lock must not rewrite
      // an unchanged record. Still persist any conflict copies folded here.
      if (result === fold.rec && !folded.length) return null;
      return JSON.stringify(result, null, 2);
    });
    if (!committed || !result) {
      throw new Error(`naming-store: could not write ${provider}/${id} (lock timeout)`);
    }
    // Only now that the merged content is durable may the copies go.
    for (const copy of folded) { try { await fs.promises.unlink(copy); } catch { /* already gone */ } }
    // WHY: the deletes bump the folder's time anyway; dropping the index
    // outright also covers a clock too coarse to show it.
    if (folded.length) dirIndex.delete(path.dirname(target));
    return result;
  }

  return {
    root: rootResolved,

    async get(provider: string, id: string): Promise<NamingRecord | null> {
      let target: string;
      try { target = recordPath(provider, id); } catch { return null; }
      const onDisk = await readAt(target);
      const copies = await readConflictCopies(provider, id);
      const { rec, folded } = foldConflicts(onDisk ?? emptyNamingRecord(id, provider), copies);
      if (folded.length) {
        // A read that discovered conflict copies must persist the fold before
        // answering, or the next read re-does it and a crash in between drops
        // the copies' content.
        //
        // MERGE what the lock hands back — never `() => rec`. `rec` was read
        // outside the lock, so writing it verbatim would silently discard
        // anything another process wrote in between, which is the exact data
        // loss this whole store exists to prevent.
        try { return await mutate(provider, id, (cur) => mergeNamingRecords(cur, rec)); } catch { return rec; }
      }
      return onDisk;
    },

    mutate,

    async remove(provider: string, id: string): Promise<void> {
      try { await fs.promises.rm(recordPath(provider, id), { force: true }); } catch { /* nothing to remove */ }
    },
  };
}
