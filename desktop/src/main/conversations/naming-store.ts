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

  function readAt(file: string): NamingRecord | null {
    try { return parseNamingRecord(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  // Fold this id's conflict copies into `base` and delete them. Returns the
  // merged record and whether anything was folded (the caller must persist it —
  // deleting a copy without writing its content back would LOSE the name it
  // carried, which is the one outcome this whole module exists to prevent).
  function foldConflicts(provider: string, id: string, base: NamingRecord): { rec: NamingRecord; folded: string[] } {
    const folded: string[] = [];
    let rec = base;
    let entries: string[];
    try { entries = fs.readdirSync(providerDir(provider)); } catch { return { rec, folded }; }
    for (const name of entries) {
      if (!isConflictCopyName(name) || extractConflictBase(name) !== `${id}.json`) continue;
      const copy = path.join(providerDir(provider), name);
      const parsed = readAt(copy);
      // An unparseable copy is still deleted: it carries nothing we can keep,
      // and leaving it makes the engine re-offer it on every read.
      if (parsed) rec = mergeNamingRecords(rec, parsed);
      folded.push(copy);
    }
    return { rec, folded };
  }

  async function mutate(
    provider: string,
    id: string,
    fn: (cur: NamingRecord) => NamingRecord,
  ): Promise<NamingRecord> {
    const target = recordPath(provider, id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Fold BEFORE taking the lock on the canonical file: the copies are
    // separate files the lock does not cover, and folding inside the callback
    // would do disk reads while holding it.
    const { folded } = foldConflicts(provider, id, emptyNamingRecord(id, provider));
    let result: NamingRecord | undefined;
    const committed = await mutateFileUnderLock(target, (onDisk) => {
      const existing = (onDisk ? parseNamingRecord(onDisk) : null) ?? emptyNamingRecord(id, provider);
      // Re-fold inside the lock against the CURRENT on-disk record, so a copy
      // that arrived between the two reads is still merged in.
      const merged = foldConflicts(provider, id, existing).rec;
      result = fn(merged);
      return JSON.stringify(result, null, 2);
    });
    if (!committed || !result) {
      throw new Error(`naming-store: could not write ${provider}/${id} (lock timeout)`);
    }
    // Only now that the merged content is durable may the copies go.
    for (const copy of folded) { try { fs.unlinkSync(copy); } catch { /* already gone */ } }
    return result;
  }

  return {
    root: rootResolved,

    async get(provider: string, id: string): Promise<NamingRecord | null> {
      let target: string;
      try { target = recordPath(provider, id); } catch { return null; }
      const onDisk = readAt(target);
      const { rec, folded } = foldConflicts(provider, id, onDisk ?? emptyNamingRecord(id, provider));
      if (folded.length) {
        // A read that discovered conflict copies must persist the fold before
        // answering, or the next read re-does it and a crash in between drops
        // the copies' content.
        try { return await mutate(provider, id, () => rec); } catch { return rec; }
      }
      return onDisk;
    },

    mutate,

    async remove(provider: string, id: string): Promise<void> {
      try { fs.rmSync(recordPath(provider, id), { force: true }); } catch { /* nothing to remove */ }
    },
  };
}
