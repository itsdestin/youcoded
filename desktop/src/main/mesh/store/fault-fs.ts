// Test shim: an Fs that "kills the process" at the Nth disk-changing operation.
//
// WHY it lives beside the code (not in a test file): the crash tests of the store and of any later
// part that sits on the store use the same shim. It is not imported by production code.
//
// Two failure modes, both over every N:
//  - `tear: false`: the Nth operation does not happen at all.
//  - `tear: true`: if the Nth operation is a write, half its bytes land first (a torn write).
// Optional `powerLoss`: after the "kill", every file is cut back to the length it had at its last
// fsync (unsynced data does not survive a power cut), which is stricter than a process kill.
import type { Fs, FileLike } from './fsio';
import { realFs } from './fsio';

export class InjectedCrash extends Error {
  constructor(public readonly op: number, public readonly what: string) { super(`injected crash at op ${op} (${what})`); }
}

export class FaultFs implements Fs {
  ops = 0;
  crashed = false;
  private synced = new Map<string, number>(); // path -> length at last sync
  private touched = new Set<string>();
  constructor(private readonly failAt: number, private readonly opts: { tear?: boolean; powerLoss?: boolean } = {}, private readonly inner: Fs = realFs) {}

  private tick(what: string): void {
    if (this.crashed) throw new InjectedCrash(this.ops, 'after-crash:' + what);
    this.ops++;
    if (this.ops === this.failAt) { this.crashed = true; throw new InjectedCrash(this.ops, what); }
  }

  async open(path: string, o: { create: boolean }): Promise<FileLike> {
    if (o.create && !(await this.inner.exists(path))) this.tick('create ' + path);
    const f = await this.inner.open(path, o);
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
  async mkdir(p: string) { this.tick('mkdir ' + p); await this.inner.mkdir(p); }
  async rename(a: string, b: string) {
    this.tick('rename ' + a);
    await this.inner.rename(a, b);
    const s = this.synced.get(a);
    if (s !== undefined) { this.synced.set(b, s); this.synced.delete(a); }
    if (this.touched.delete(a)) this.touched.add(b);
  }
  async unlink(p: string) { this.tick('unlink ' + p); await this.inner.unlink(p); this.synced.delete(p); this.touched.delete(p); }
  async fsyncDir(p: string) { this.tick('fsyncDir ' + p); await this.inner.fsyncDir(p); }

  /** Apply the power-loss model after a crash: cut every file written since its last fsync back. */
  async applyPowerLoss(): Promise<void> {
    if (!this.opts.powerLoss) return;
    for (const p of this.touched) {
      if (!(await this.inner.exists(p))) continue;
      const f = await this.inner.open(p, { create: false });
      await f.truncate(this.synced.get(p) ?? 0);
      await f.close();
    }
  }
}
