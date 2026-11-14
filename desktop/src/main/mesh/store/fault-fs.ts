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
//  NOT modelled (unverified): a rename ONTO an existing name (either old or new content is legal and the
//  shim keeps the new), an unlink that was never directory-synced (the file could come back), and
//  reordering of unsynced writes between files.
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { Fs, FileLike } from './fsio';
import { realFs } from './fsio';

export class InjectedCrash extends Error {
  constructor(public readonly op: number, public readonly what: string) { super(`injected crash at op ${op} (${what})`); }
}

interface PendingRename { from: string; to: string; dirsLeft: Set<string> }

export class FaultFs implements Fs {
  ops = 0;
  crashed = false;
  private synced = new Map<string, number>(); // path -> length at last sync
  private touched = new Set<string>();
  private pendingCreates = new Set<string>();  // created, parent directory not yet fsynced
  private pendingRenames: PendingRename[] = [];
  constructor(private readonly failAt: number, private readonly opts: { tear?: boolean; powerLoss?: boolean } = {}, private readonly inner: Fs = realFs) {}

  private tick(what: string): void {
    if (this.crashed) throw new InjectedCrash(this.ops, 'after-crash:' + what);
    this.ops++;
    if (this.ops === this.failAt) { this.crashed = true; throw new InjectedCrash(this.ops, what); }
  }

  async open(path: string, o: { create: boolean }): Promise<FileLike> {
    const isNew = o.create && !(await this.inner.exists(path));
    if (isNew) this.tick('create ' + path);
    const f = await this.inner.open(path, o);
    if (isNew) this.pendingCreates.add(path);
    // A file that already existed is durable at its current length (everything before this run was synced).
    if (!this.synced.has(path)) this.synced.set(path, await f.size());
    const self = this;
    const guard: FileLike = {
      async write(buf, pos) {
        if (self.crashed) throw new InjectedCrash(self.ops, 'after-crash:write');
        self.ops++;
        if (self.ops === self.failAt) {
          self.crashed = true;
          if (self.opts.tear && buf.length > 1) await f.write(buf.subarray(0, buf.length >> 1), pos);
          throw new InjectedCrash(self.ops, 'write ' + path);
        }
        self.touched.add(path);
        await f.write(buf, pos);
      },
      read: (p, l) => f.read(p, l),
      size: () => f.size(),
      async truncate(len) { self.tick('truncate ' + path); self.touched.add(path); await f.truncate(len); },
      async sync() { self.tick('fsync ' + path); await f.sync(); self.synced.set(path, await f.size()); self.touched.delete(path); },
      close: () => f.close(),
    };
    return guard;
  }
  readFile(p: string) { return this.inner.readFile(p); }
  readdir(p: string) { return this.inner.readdir(p); }
  exists(p: string) { return this.inner.exists(p); }
  async mkdir(p: string) {
    const isNew = !(await this.inner.exists(p));
    this.tick('mkdir ' + p); await this.inner.mkdir(p);
    if (isNew) this.pendingCreates.add(p);
  }
  async rename(a: string, b: string) {
    this.tick('rename ' + a);
    const overwrote = await this.inner.exists(b);
    await this.inner.rename(a, b);
    const s = this.synced.get(a);
    if (s !== undefined) { this.synced.set(b, s); this.synced.delete(a); }
    if (this.touched.delete(a)) this.touched.add(b);
    if (overwrote) { this.pendingCreates.delete(a); return; }
    if (this.pendingCreates.delete(a)) this.pendingCreates.add(b); // still a not-yet-durable creation, under its new name
    else this.pendingRenames.push({ from: a, to: b, dirsLeft: new Set([nodePath.dirname(a), nodePath.dirname(b)]) });
  }
  async unlink(p: string) { this.tick('unlink ' + p); await this.inner.unlink(p); this.synced.delete(p); this.touched.delete(p); this.pendingCreates.delete(p); }
  async fsyncDir(p: string) {
    this.tick('fsyncDir ' + p); await this.inner.fsyncDir(p);
    for (const c of [...this.pendingCreates]) if (nodePath.dirname(c) === p) this.pendingCreates.delete(c);
    for (const r of this.pendingRenames) r.dirsLeft.delete(p);
    this.pendingRenames = this.pendingRenames.filter((r) => r.dirsLeft.size > 0);
  }

  /** Apply the power-loss model after a crash (see the header for exactly what is modelled). */
  async applyPowerLoss(): Promise<void> {
    if (!this.opts.powerLoss) return;
    for (const p of this.touched) {
      if (!(await this.inner.exists(p))) continue;
      const f = await this.inner.open(p, { create: false });
      await f.truncate(Math.min(await f.size(), this.synced.get(p) ?? 0));
      await f.close();
    }
    for (const r of [...this.pendingRenames].reverse()) {
      if ((await this.inner.exists(r.to)) && !(await this.inner.exists(r.from))) await this.inner.rename(r.to, r.from);
    }
    // deepest first so a directory's own entries go before the directory
    for (const p of [...this.pendingCreates].sort((x, y) => y.length - x.length)) await fsp.rm(p, { recursive: true, force: true });
  }
}
