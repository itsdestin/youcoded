// Parked appends (split out of store.ts to keep it inside its line budget). An append that starts past the head is PARKED: kept on disk inside the envelope (envelope.ts: role, version key,
// and an id of POSITION and LINE HASH sealed inside the checksum) and applied when the head reaches it. A parked file that is not what its name says is moved to rejected/ (kept), never applied.
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic, mkdirDurable, type Fs } from './fsio';
import { StoreError } from './errors';
import { sealEnv, openEnv } from './envelope';
import { frameLines, unframeLines } from './records';
import { nextNumbered, type BodyTools } from './recovery';
import type { VState } from './vstate';

const MAX_REJECTED = 1024;

/**
 * Why a park was moved to rejected/ (round 7, F5): it is the first part of the file's name (`<reason>--<park name>`), so the reason survives a reopen and needs no second file. `stale-history` is a park
 * found at read time to belong to another history (a put-back copy); `takeover` and `quarantine` are the two history changes that move every old park at once; `conflict` is a park whose lines are not a
 * prefix of what the head holds; `damaged` is a park that could not be read or is not what its name says; `released` is the caller giving up on it (releaseParked).
 */
export type RejectReason = 'takeover' | 'quarantine' | 'stale-history' | 'conflict' | 'damaged' | 'released';
export const REJECT_REASONS: RejectReason[] = ['takeover', 'quarantine', 'stale-history', 'conflict', 'damaged', 'released'];
/** The reason and park name inside a rejected/ file name; a name without a reason prefix (kept by an older build) reads as `unknown`. */
export function parseRejectedName(n: string): { reason: RejectReason | 'unknown'; name: string } | null {
  const m = /^(?:(takeover|quarantine|stale-history|conflict|damaged|released)--)?(?:older-\d+-)?(\d{16}-[0-9a-f]{16}\.park)$/.exec(n);
  return m ? { reason: (m[1] as RejectReason | undefined) ?? 'unknown', name: m[2] } : null;
}

/**
 * WHY the epoch is part of the sealed id (review 6, B1): a park used to be bound to its position and lines but not to the HISTORY it was parked against, so after a takeover the old host's
 * park was drained onto the new host's lines. The id is now `<position>-<line hash>@<epoch>` (tails.ts: the epoch is read from disk and changes at every takeover), so the invariant is:
 * a parked append is only ever drained onto the history it was parked against. Every other place that touches parks (cut time, open, drain) is a second layer on top of this one.
 */
export const parkId = (name: string, epoch: string): string => `${name.slice(0, -5)}@${epoch}`;

export class Parked {
  constructor(
    private readonly fs: Fs,
    private readonly tools: BodyTools,
    private readonly cfg: { maxFiles: number; maxBytes: number; maxRejectedBytes: number; bytesUnder: (path: string) => Promise<number> },
    /** The store's overlap-checked write of lines at a position (ChatStore.applyLines). */
    private readonly apply: (st: VState, from: number, lines: Buffer[]) => Promise<'ok' | 'not-a-prefix'>,
  ) {}

  async loadIndex(st: VState): Promise<void> {
    const dir = nodePath.join(st.dir, 'parked');
    st.parked.clear(); st.parkedBytes = 0;
    for (const n of await this.fs.readdir(dir)) {
      if (!n.endsWith('.park')) continue;
      const size = await this.tools.fileSize(nodePath.join(dir, n));
      st.parked.set(n, size); st.parkedBytes += size;
    }
    st.rejected = (await this.fs.readdir(nodePath.join(st.dir, 'rejected'))).filter((n) => parseRejectedName(n) !== null).length;
  }

  /**
   * RULE FOR THE NEXT LAYER (round 7, F4; no behaviour here): the epoch sealed into a park below is the one current when the store RECEIVES it (st.epoch), not one the sender names. A late park from a host that
   * was deposed before the takeover but delivered after it is therefore sealed with the NEW history and will drain onto the new host's lines. The replicator must reject a deposed host's lines before append().
   *
   * M4: duplicate check, file count and byte total come from memory (built once at load), so a park costs
   * one file write instead of a rescan of every parked file; the count and byte caps make the total bounded.
   */
  async park(st: VState, fromLine: number, lines: Buffer[]): Promise<void> {
    const hsh = createHash('sha256'); for (const l of lines) hsh.update(l);
    // 16 digits: names sort by line number up to 2^53, past the 12 digits that broke the old ordering
    const name = `${fromLine.toString().padStart(16, '0')}-${hsh.digest('hex').slice(0, 16)}.park`;
    // WHY the envelope (review 5, F1): a park used to carry only a version tag; its POSITION lived in the file NAME alone, so a valid park placed under another park's name was drained at the
    // wrong place with no report. Now the position and the line hash (the name's stem `<position>-<hash>`) are sealed INSIDE the file with the version key, and the drain compares them
    // with the name: a file that is not the one its name says (another position, another version, another kind) is rejected, never applied.
    const data = sealEnv({ role: 'park', version: st.key, id: parkId(name, st.epoch) }, frameLines(lines));
    if (st.parked.has(name)) {
      // WHY not simply "already parked" (the file could have rotted since): an intact copy is enough, a damaged one is kept in rejected/ and replaced
      const have = await this.fs.readFile(nodePath.join(st.dir, 'parked', name));
      if (have && have.equals(data)) return;
      // WHY a typed refusal and not "ignore the failed move" (round 7, F5b): when rejected/ is full the move fails, and the write below would then REPLACE the old park file, destroying the only copy of
      // lines the caller was told were parked. The new park is refused (`limit`, nothing written, nothing overwritten); the caller keeps its lines and the old file stays where it is.
      if (have) { if (!(await this.moveAway(st, nodePath.join(st.dir, 'parked', name), name, 'damaged', true))) throw new StoreError('limit', `${st.key.slice(0, 8)}: rejected/ is full, the park that no longer matches stays in place and the new one is refused`); }
      else this.forget(st, name);
    }
    if (st.parked.size >= this.cfg.maxFiles) throw new StoreError('parked-full', `${st.key.slice(0, 8)}: ${st.parked.size} parked files`);
    if (st.parkedBytes + data.length > this.cfg.maxBytes) throw new StoreError('parked-full', st.key.slice(0, 8));
    const dir = nodePath.join(st.dir, 'parked');
    await mkdirDurable(this.fs, dir);
    // DESTRUCTIVE-OK(verified-record): the name is derived from the lines' hash, so a file of this name holds the same lines; a rotted one was moved to rejected/ above
    await writeFileAtomic(this.fs, nodePath.join(dir, name), data);
    st.parked.set(name, data.length); st.parkedBytes += data.length;
  }

  /**
   * At a takeover (tails.ts step 4): every park that does not belong to the CURRENT history is moved to rejected/ (kept, never deleted, never applied). A park that cannot be read at all is
   * moved too (it is in rejected/ for a human to find). At the rejected/ cap a park stays in parked/, where the epoch still refuses it on read.
   */
  async rejectOutsideEpoch(st: VState): Promise<void> {
    for (const name of [...st.parked.keys()].sort()) {
      const path = nodePath.join(st.dir, 'parked', name);
      const raw = await this.fs.readFile(path);
      if (raw === null) { this.forget(st, name); continue; }
      if (openEnv(raw, { role: 'park', version: st.key, id: parkId(name, st.epoch) }).kind === 'ok') continue;   // parked in this history: it stays
      await this.moveAway(st, path, name, 'takeover');
    }
  }

  /**
   * A quarantine or set-aside (asides.ts): the version's history just changed under its parks, so EVERY park goes to rejected/ with the reason `quarantine` (kept, never deleted, never applied). Works on the
   * folder alone (the version's memory was dropped). At the rejected/ cap a park stays where it is; the epoch (tails.ts readEpoch, which names the aside folder) refuses it on read anyway.
   */
  async rejectAllOnDisk(vdir: string): Promise<void> {
    const dir = nodePath.join(vdir, 'parked');
    for (const name of (await this.fs.readdir(dir)).filter((n) => n.endsWith('.park')).sort()) {
      const size = await this.tools.fileSize(nodePath.join(dir, name));
      await this.moveFile(vdir, nodePath.join(dir, name), name, size, 'quarantine', false);
    }
  }

  forget(st: VState, name: string): void {
    const size = st.parked.get(name);
    if (size !== undefined) { st.parked.delete(name); st.parkedBytes -= size; }
  }

  /** Apply every parked append the head has now reached; loop until nothing more applies. */
  async drain(st: VState): Promise<void> {
    const dir = nodePath.join(st.dir, 'parked');
    const skip = new Set<string>();
    for (;;) {
      const names = [...st.parked.keys()].filter((n) => !skip.has(n)).sort();
      let progressed = false;
      for (const name of names) {
        const from = parseInt(name.slice(0, 16), 10);
        if (from > st.count) break; // sorted by line number: the rest still have a gap
        const path = nodePath.join(dir, name);
        const raw = await this.fs.readFile(path);
        if (raw === null) { this.forget(st, name); progressed = true; continue; }   // the file is gone (parks are provisional): nothing to apply or move
        // every field is checked against what the NAME claims (envelope.ts): kind, version, and the position-and-hash id. A mismatch is a misplaced park: rejected (kept), never applied.
        const env = openEnv(raw, { role: 'park', version: st.key, id: parkId(name, st.epoch) });
        let lines = env.kind === 'ok' ? unframeLines(env.payload) : null;
        // the line hash in the id must also be the hash of the lines the file really holds (a forged or mixed-up file cannot pass with matching framing alone)
        if (lines) { const h = createHash('sha256'); for (const l of lines) h.update(l); if (h.digest('hex').slice(0, 16) !== name.slice(17, 33)) lines = null; }
        if (!lines) {
          // a park sealed for THIS version and position but another history is a stale one (a put-back copy); anything else is not what its name says
          const stale = env.kind === 'foreign' && env.seen.role === 'park' && env.seen.version === st.key && typeof env.seen.id === 'string' && env.seen.id.startsWith(name.slice(0, -5) + '@');
          if (await this.moveAway(st, path, name, stale ? 'stale-history' : 'damaged')) progressed = true; else skip.add(name);
          continue;
        }
        const res = await this.apply(st, from, lines);
        if (res === 'not-a-prefix') { if (await this.moveAway(st, path, name, 'conflict')) progressed = true; else skip.add(name); }
        // DESTRUCTIVE-OK(verified-record): the file passed its checksum and was sealed for THIS version, THIS position and THESE lines when read above, and applyLines returned `ok` (lines compared with the chain, fresh ones fsynced), so every line in it is in the version
        else { await this.fs.unlink(path); await this.fs.fsyncDir(dir); this.forget(st, name); progressed = true; }
      }
      if (!progressed) return;
    }
  }

  /**
   * A parked append that is not a prefix is KEPT (retention rule) under rejected/, never deleted, with the reason in its name. At the cap it stays in parked/ instead (it counts toward the parked cap,
   * the epoch still refuses it, and `park()` refuses a new park that would need its place). Returns whether it was moved.
   */
  moveAway(st: VState, path: string, name: string, reason: RejectReason, damaged = false): Promise<boolean> {
    return this.moveFile(st.dir, path, name, st.parked.get(name) ?? 0, reason, damaged, st);
  }

  private async moveFile(vdir: string, path: string, name: string, size: number, reason: RejectReason, damaged: boolean, st?: VState): Promise<boolean> {
    const rej = nodePath.join(vdir, 'rejected');
    await mkdirDurable(this.fs, rej);
    if ((await this.fs.readdir(rej)).length >= MAX_REJECTED) return false;
    // N11: a byte cap as well as a file cap (a junk park can be hundreds of MB); at the cap it stays in parked/, counting toward that cap
    if ((await this.cfg.bytesUnder(rej)) + size > this.cfg.maxRejectedBytes) return false;
    // WHY a free name: a rename onto an existing rejected copy would destroy it. The name is content-derived, so the same name means the same bytes, except when a copy rotted.
    let target = nodePath.join(rej, `${reason}--${name}`);
    if (damaged || await this.fs.exists(target)) target = nodePath.join(rej, await nextNumbered(this.fs, rej, `${reason}--older-`, `-${name}`, 1));
    // DESTRUCTIVE-OK(kept-copy-first): a rename to a name nothing uses; the parked bytes are kept in rejected/, never deleted
    await this.fs.rename(path, target);
    await this.fs.fsyncDir(rej); await this.fs.fsyncDir(nodePath.join(vdir, 'parked'));
    if (st) { this.forget(st, name); st.rejected++; }
    return true;
  }
}
