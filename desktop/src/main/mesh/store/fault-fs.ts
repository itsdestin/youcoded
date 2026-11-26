// Test shim: an Fs that "kills the process" at the Nth disk-changing operation.
//
// WHY it lives beside the code (not in a test file): the crash tests of the store and of any later
// part that sits on the store use the same shim. It is not imported by production code.
//
// Two failure modes, both over every N:
//  - `tear: false`: the Nth operation does not happen at all.
//  - `tear: true`: if the Nth operation is a write, half its bytes land first (a torn write).
// Optional `powerLoss`: after the "kill", unsynced state does not survive, which is stricter than a
// process kill. Modelled:
//  - every file is cut back to the length it had at its last fsync (never zero-extended: a truncate that
//    was not synced either happened or not, both are legal, so the shorter length is kept);
//  - DIRECTORY ENTRIES: a file or directory created, and a file renamed onto a NEW name, only survives if
//    the directory holding it was fsynced afterwards (fsyncDir). Otherwise power loss removes the created
//    entry, and undoes the rename (the old name comes back). Review M2: this is what lets the sweeps see a
//    missing parent fsync.
//  - UNSYNCED UNLINK and RENAME-OVER-EXISTING (review "crash sweep honesty"), modelled when `shadowDir`
//    is given (a folder on the same file system, outside the store): an unlink moves the file into
//    shadowDir instead of deleting it; a rename onto an existing name first moves the old target there.
//    fsyncDir of the holding directory makes the change permanent. On power loss an unsynced unlink
//    RESURRECTS the file, and with `revertOverwrites` an unsynced overwrite brings the OLD content back
//    (both outcomes are legal on a real file system, so the sweeps run both).
//  - ENOSPC (`enospcFrom: n`): from the n-th space-allocating operation on (a write, a new file, a new
//    directory) every such operation fails with code ENOSPC until the shim is discarded ("space freed");
//    with `tear` a failing write first lands half its bytes, like a real full disk. Reads, unlinks, renames,
//    truncates and fsyncs keep working, as they do on a full disk.
//  - UNSYNCED IN-PLACE OVERWRITE (review 4, `revertInPlace`): a write that lands inside bytes that were already durable (the checkpoint slot, a healed body line)
//    is not durable until that file is fsynced. On power loss the OLD bytes come back. Without this the shim could not tell whether the acknowledgement itself
//    (the checkpoint slot) was made durable, so a store that forgot its fsync passed every test.
//  - OPEN HANDLES: `openHandles` counts opened-minus-closed files, so a test can prove no path leaks one (N10).
//  - REORDERED UNSYNCED WRITES (review 5, `reorder`: a random-number function, with `powerLoss`): the shim also remembers every write since the file's last fsync. At power loss each touched
//    file keeps its synced bytes plus a RANDOM SUBSEQUENCE of those writes (none, a prefix, any subset), independently per file, so a later file's data can survive while an earlier file's is lost, a
//    written range can sit past a zero-filled hole, and a renamed-over file can hold only part of its content. Ported from the reviewer's virtual disk (store-review-5/vfs.ts), which modelled the same.
//  NOT modelled (unverified): file systems that lie about fsync.
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { Fs, FileLike } from './fsio';
import { realFs } from './fsio';

export class InjectedCrash extends Error {
  constructor(public readonly op: number, public readonly what: string) { super(`injected crash at op ${op} (${what})`); }
}

interface PendingRename { from: string; to: string; dirsLeft: Set<string> }
interface PendingShadow { path: string; shadow: string; dir: string }

/** An error shaped like the one Node raises on a full disk. */
function enospc(what: string): Error { return Object.assign(new Error(`ENOSPC: no space left on device, ${what}`), { code: 'ENOSPC' }); }

export class FaultFs implements Fs {
  ops = 0;
  crashed = false;
  private synced = new Map<string, number>(); // path -> length at last sync
  private touched = new Set<string>();
  private pendingCreates = new Set<string>();  // created, parent directory not yet fsynced
  private pendingRenames: PendingRename[] = [];
  /** Space-allocating operations so far (what `enospcFrom` counts). */
  allocs = 0;
  /** Files opened and not yet closed. */
  openHandles = 0;
  private pendingUnlinks: PendingShadow[] = [];
  private pendingOverwrites: PendingShadow[] = [];
  private shadowN = 0;
  /** Pre-images of in-place overwrites since the file's last fsync (see `revertInPlace`). */
  private undo: { path: string; pos: number; old: Buffer }[] = [];
  /** Writes since each file's last fsync, in order (only with `reorder`). */
  private pend: { path: string; pos: number; buf: Buffer }[] = [];
  constructor(private readonly failAt: number, private readonly opts: { tear?: boolean; powerLoss?: boolean; enospcFrom?: number; shadowDir?: string; revertOverwrites?: boolean; revertInPlace?: boolean; reorder?: () => number } = {}, private readonly inner: Fs = realFs) {}

  /** Count a space-allocating operation; true when the (simulated) disk is full for it. */
  private full(): boolean {
    this.allocs++;
    return this.opts.enospcFrom !== undefined && this.allocs >= this.opts.enospcFrom;
  }
  private shadowPath(): string { return nodePath.join(this.opts.shadowDir!, `s${this.shadowN++}`); }

  private tick(what: string): void {
    if (this.crashed) throw new InjectedCrash(this.ops, 'after-crash:' + what);
    this.ops++;
    if (this.ops === this.failAt) { this.crashed = true; throw new InjectedCrash(this.ops, what); }
  }

  async open(path: string, o: { create: boolean }): Promise<FileLike> {
    const isNew = o.create && !(await this.inner.exists(path));
    if (isNew) this.tick('create ' + path);
    if (isNew && this.full()) throw enospc('open ' + path);
    const f = await this.inner.open(path, o);
    // WHY the try (N10): the bookkeeping below can fail (an injected error); the real handle must not leak then.
    try {
      if (isNew) this.pendingCreates.add(path);
      // A file that already existed is durable at its current length (everything before this run was synced).
      if (!this.synced.has(path)) this.synced.set(path, await f.size());
    } catch (e) { await f.close().catch(() => undefined /* benign: test shim: closing after a failure that is rethrown right here */); throw e; }
    this.openHandles++;
    let closed = false;
    const self = this;
    const guard: FileLike = {
      async write(buf, pos) {
        if (self.crashed) throw new InjectedCrash(self.ops, 'after-crash:write');
        self.ops++;
        if (self.opts.revertInPlace) {
          const dur = self.synced.get(path) ?? 0;
          if (pos < dur) self.undo.push({ path, pos, old: await f.read(pos, Math.min(buf.length, dur - pos)) });
        }
        if (self.ops === self.failAt) {
          self.crashed = true;
          if (self.opts.tear && buf.length > 1) await f.write(buf.subarray(0, buf.length >> 1), pos);
          throw new InjectedCrash(self.ops, 'write ' + path);
        }
        if (self.full()) {
          if (self.opts.tear && buf.length > 1) { self.touched.add(path); await f.write(buf.subarray(0, buf.length >> 1), pos); }
          throw enospc('write ' + path);
        }
        self.touched.add(path);
        if (self.opts.reorder) self.pend.push({ path, pos, buf: Buffer.from(buf) });
        await f.write(buf, pos);
      },
      read: (p, l) => f.read(p, l),
      size: () => f.size(),
      async truncate(len) { self.tick('truncate ' + path); self.touched.add(path); await f.truncate(len); },
      async sync() { self.tick('fsync ' + path); await f.sync(); self.synced.set(path, await f.size()); self.touched.delete(path); self.undo = self.undo.filter((u) => u.path !== path); self.pend = self.pend.filter((w) => w.path !== path); },
      async close() { if (!closed) { closed = true; self.openHandles--; } await f.close(); },
    };
    return guard;
  }
  readFile(p: string) { return this.inner.readFile(p); }
  readdir(p: string) { return this.inner.readdir(p); }
  exists(p: string) { return this.inner.exists(p); }
  async mkdir(p: string) {
    const isNew = !(await this.inner.exists(p));
    this.tick('mkdir ' + p);
    if (isNew && this.full()) throw enospc('mkdir ' + p);
    await this.inner.mkdir(p);
    if (isNew) this.pendingCreates.add(p);
  }
  async rename(a: string, b: string) {
    this.tick('rename ' + a);
    const overwrote = await this.inner.exists(b);
    if (overwrote && this.opts.shadowDir) {
      const sh = this.shadowPath();
      await this.inner.rename(b, sh);
      this.pendingOverwrites.push({ path: b, shadow: sh, dir: nodePath.dirname(b) });
    }
    await this.inner.rename(a, b);
    // WHY (restructure: a fork is built in a work folder and renamed into place): renaming a DIRECTORY moves every file inside it, so the per-file records of what is synced, touched or not yet directory-synced must follow them, or the shim is blind to unsynced data under the new name
    const under = a + nodePath.sep;
    const mv = (x: string): string => (x.startsWith(under) ? b + nodePath.sep + x.slice(under.length) : x);
    for (const [k, v] of [...this.synced]) if (k.startsWith(under)) { this.synced.delete(k); this.synced.set(mv(k), v); }
    for (const k of [...this.touched]) if (k.startsWith(under)) { this.touched.delete(k); this.touched.add(mv(k)); }
    for (const k of [...this.pendingCreates]) if (k.startsWith(under)) { this.pendingCreates.delete(k); this.pendingCreates.add(mv(k)); }
    for (const u of this.undo) u.path = mv(u.path);
    for (const w of this.pend) w.path = mv(w.path);
    const s = this.synced.get(a);
    if (s !== undefined) { this.synced.set(b, s); this.synced.delete(a); }
    for (const u of this.undo) if (u.path === a) u.path = b;
    for (const w of this.pend) if (w.path === a) w.path = b;
    if (this.touched.delete(a)) this.touched.add(b);
    if (overwrote) { this.pendingCreates.delete(a); return; }
    if (this.pendingCreates.delete(a)) this.pendingCreates.add(b); // still a not-yet-durable creation, under its new name
    else this.pendingRenames.push({ from: a, to: b, dirsLeft: new Set([nodePath.dirname(a), nodePath.dirname(b)]) });
  }
  async unlink(p: string) {
    this.tick('unlink ' + p);
    if (this.opts.shadowDir && await this.inner.exists(p)) {
      // not deleted yet as far as the disk is concerned: kept in the shadow folder until the directory is fsynced
      const sh = this.shadowPath();
      await this.inner.rename(p, sh);
      this.pendingUnlinks.push({ path: p, shadow: sh, dir: nodePath.dirname(p) });
    } else await this.inner.unlink(p);
    this.synced.delete(p); this.touched.delete(p); this.pendingCreates.delete(p); this.pend = this.pend.filter((w) => w.path !== p);
  }
  async fsyncDir(p: string) {
    this.tick('fsyncDir ' + p); await this.inner.fsyncDir(p);
    for (const c of [...this.pendingCreates]) if (nodePath.dirname(c) === p) this.pendingCreates.delete(c);
    for (const r of this.pendingRenames) r.dirsLeft.delete(p);
    this.pendingRenames = this.pendingRenames.filter((r) => r.dirsLeft.size > 0);
    this.pendingUnlinks = this.pendingUnlinks.filter((u) => u.dir !== p);
    this.pendingOverwrites = this.pendingOverwrites.filter((u) => u.dir !== p);
  }

  /** Apply the power-loss model after a crash (see the header for exactly what is modelled). */
  async applyPowerLoss(): Promise<void> {
    if (!this.opts.powerLoss) return;
    // unsynced in-place overwrites: the old bytes come back (newest first, so overlapping writes unwind correctly)
    for (const u of [...this.undo].reverse()) {
      if (!(await this.inner.exists(u.path))) continue;
      const f = await this.inner.open(u.path, { create: false });
      await f.write(u.old, u.pos); await f.close();
    }
    this.undo = [];
    for (const p of this.touched) {
      if (!(await this.inner.exists(p))) continue;
      const f = await this.inner.open(p, { create: false });
      await f.truncate(Math.min(await f.size(), this.synced.get(p) ?? 0));
      if (this.opts.reorder) {
        // a random subsequence of this file's unsynced writes survives (style per file: none, a prefix, or any subset); a write past the end extends the file with zeros
        const mine = this.pend.filter((w) => w.path === p); const rnd = this.opts.reorder; const style = rnd();
        for (let k = 0; k < mine.length; k++) {
          const keep = style < 0.34 ? false : style < 0.67 ? k < Math.floor(rnd() * (mine.length + 1)) : rnd() < 0.5;
          if (keep) await f.write(mine[k].buf, mine[k].pos);
        }
      }
      await f.close();
    }
    this.pend = [];
    for (const r of [...this.pendingRenames].reverse()) {
      if ((await this.inner.exists(r.to)) && !(await this.inner.exists(r.from))) await this.inner.rename(r.to, r.from);
    }
    // deepest first so a directory's own entries go before the directory
    for (const p of [...this.pendingCreates].sort((x, y) => y.length - x.length)) await fsp.rm(p, { recursive: true, force: true });
    // an overwrite that was never directory-synced may show the OLD content again (a legal outcome)
    if (this.opts.revertOverwrites) {
      for (const o of [...this.pendingOverwrites].reverse()) {
        await fsp.rm(o.path, { force: true });
        await this.inner.rename(o.shadow, o.path);
      }
    }
    // an unlink that was never directory-synced: the file is back
    for (const u of [...this.pendingUnlinks].reverse()) {
      if (!(await this.inner.exists(u.path))) await this.inner.rename(u.shadow, u.path);
    }
  }
}
