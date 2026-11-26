// Building the child folder of a fork (split out of store.ts to keep it inside its line budget). The meaning, the caller's duties and the CRASH TABLE are written above ChatStore.forkVersion.
// Everything here happens in forks/<childhex>/ (a folder nothing lists, loads or reads) until ONE directory rename makes the child exist.
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirDurable, type Fs } from './fsio';
import { writeSideFor } from './sidefile';
import { writeCheckpoint } from './checkpoint';
import { versionTag } from './chain';
import { REC, indexHeader, recPos, type Rec } from './records';
import type { VState } from './vstate';

export interface ForkEnv {
  fs: Fs; root: string; stamp: number; chunkBytes: number; now: number;
  /** Lines [from, to) of the parent, each checked against its chain value (a rotted line throws `corrupt`). */
  readRange: (st: VState, from: number, to: number) => Promise<Buffer[]>;
  mustRec: (b: Buffer, pos: number) => Rec;
  ixPath: (dir: string) => string;
  chunkPath: (dir: string, start: number) => string;
}

/** Empty a fork work folder of whatever a stopped attempt left (the files are copies of data the parent still holds; the folder itself stays). */
export async function clearForkFiles(fs: Fs, work: string): Promise<void> {
  // DESTRUCTIVE-OK(scratch): files of an unfinished, invisible work folder; the parent holds every line they contain
  for (const n of await fs.readdir(work)) await fs.unlink(nodePath.join(work, n));
}

/** Steps 1 to 3 of the crash table: work folder, meta, the verified prefix (index records, bodies), checkpoint, then the one atomic rename into versions/. The parent `st` is only read. */
export async function buildFork(e: ForkEnv, st: VState, ck: string, fromLine: number): Promise<void> {
  const { fs } = e;
  // step 1: a fresh work folder. WHY under forks/<childhex> (basename = the final key): every envelope and tag of the child is sealed with the folder name, so the work folder must carry the final name.
  const forks = nodePath.join(e.root, 'forks'); const work = nodePath.join(forks, ck);
  await mkdirDurable(fs, work);
  await clearForkFiles(fs, work);
  // step 2: meta (two copies), then the verified prefix. Each line is read WITH its chain check, so a rotted line stops the fork instead of being copied.
  const meta = { format: 1, chatId: st.meta.chatId, runtime: st.meta.runtime, parent: st.key, createdMs: e.now };
  await writeSideFor(fs, nodePath.join(work, 'meta.json'), { role: 'meta', key: ck }, meta); // DESTRUCTIVE-OK(verified-record): a NEW file in a work folder that was just emptied
  await writeSideFor(fs, nodePath.join(work, 'meta.copy'), { role: 'meta', key: ck }, meta); // DESTRUCTIVE-OK(verified-record): a NEW file in a work folder that was just emptied
  const xf = await fs.open(e.ixPath(work), { create: true });
  let chunkStart = 0; let chunkFile: Awaited<ReturnType<Fs['open']>> | null = null;
  let lastRec: Rec | null = null;
  try {
    await xf.write(indexHeader(e.stamp, versionTag(ck)), 0);
    const pf = await fs.open(e.ixPath(st.dir), { create: false });
    try {
      for (let a = 0; a < fromLine; a += 256) {
        const b = Math.min(fromLine, a + 256);
        const lines = await e.readRange(st, a, b);
        const recs = await pf.read(recPos(a), (b - a) * REC);
        await xf.write(recs, recPos(a));        // the chain values do not depend on the version id, so the parent's records are valid in the child as they are
        for (let k = 0; k < b - a; k++) {
          const r = e.mustRec(recs, k * REC);
          // the same chunk rule as an append: a new chunk file starts once the active one holds chunkBytes
          if (!chunkFile || r.offset - chunkStart >= e.chunkBytes) { if (chunkFile) { await chunkFile.sync(); await chunkFile.close(); } chunkStart = r.offset; chunkFile = await fs.open(e.chunkPath(work, chunkStart), { create: true }); }
          await chunkFile.write(lines[k], r.offset - chunkStart);
          lastRec = r;
        }
      }
    } finally { await pf.close(); }
    if (chunkFile) await chunkFile.sync();
    await xf.sync();
  } finally { await chunkFile?.close().catch(() => undefined /* benign: closing after an error that is already propagating; the work folder is invisible and is cleared by the next attempt */); await xf.close(); }
  // DESTRUCTIVE-OK(verified-record): the first statement of a NEW folder; its chain values are those of the verified index record
  await writeCheckpoint(fs, work, { count: fromLine, stamp: e.stamp, evLines: 0, evBytes: 0, boundary: null, lostRecs: 0, staleBad: null, h: lastRec ? lastRec.h : Buffer.from(st.seeds.raw), c: lastRec ? lastRec.c : Buffer.from(st.seeds.conversation) });
  await fs.fsyncDir(work); await fs.fsyncDir(forks);
  // step 3: the one atomic step that makes the child exist
  await mkdirDurable(fs, nodePath.join(e.root, 'versions'));
  // DESTRUCTIVE-OK(kept-copy-first): the target does not exist (checked by the caller, and nothing else writes under the store lock)
  await fs.rename(work, nodePath.join(e.root, 'versions', ck));
  await fs.fsyncDir(nodePath.join(e.root, 'versions')); await fs.fsyncDir(forks);
}

/**
 * The rule every device uses to name the child of a takeover (see forkVersion): SHA-256 over a label, the parent id, the fork line, the chain value at that line and `takeoverToken`, a string all
 * devices already agree on for THIS takeover (the id of the control-log entry that records it). Same inputs give the same 32-byte id on every device, so two devices never create two siblings
 * for one takeover; a different takeover (another token) of the same parent and line gets another id.
 */
export function deriveForkId(parent: Uint8Array, fromLine: number, chainHashAtFromLine: string, takeoverToken: string): Buffer {
  return createHash('sha256').update('youcoded-mesh/v1/fork-id\0').update(Buffer.from(parent)).update(`\0${fromLine}\0${chainHashAtFromLine}\0${takeoverToken}`).digest();
}
