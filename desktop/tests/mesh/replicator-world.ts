// An in-memory world of devices for the replicator tests: a REAL Link, real crypto and a REAL chat store per device, joined by the in-memory relay (MemoryHub), with a
// virtual clock for the replicator's own timers and hooks on the hub to drop, duplicate, delay and reorder frames. Extends the `world(names)` pattern of link.test.ts.
// Synthetic data only; temp folders only.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { generateIdentity, setIdFor, signWith, verifySig, type DeviceIdentity } from '../../src/main/mesh/crypto/identity';
import { makeAddEntry, makeGenesisEntry, seenForNextEntry } from '../../src/main/mesh/crypto/roster';
import { newSetSecret } from '../../src/main/mesh/crypto/keys';
import { MemoryCarrier, MemoryHub } from '../../src/main/mesh/carrier-memory';
import { Link } from '../../src/main/mesh/link';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { ChatStore, type StoreOptions } from '../../src/main/mesh/store';
import { realFs, type Fs } from '../../src/main/mesh/store/fsio';
import { Replicator } from '../../src/main/mesh/replicator';
import type { Clock } from '../../src/main/mesh/replicator';
import { tmp } from './helpers';

export const CHAT = 'synthetic:chat-1';
export const wireId = (n: number | string): Buffer => createHash('sha256').update(`replicator-test-version-${n}`).digest();
export const line = (text: string, n = 0): Buffer => Buffer.from(`${JSON.stringify({ type: n % 2 ? 'assistant' : 'user', message: { content: text } })}\n`);
export const lineSet = (count: number, tag = 'm', from = 0): Buffer[] => Array.from({ length: count }, (_, i) => line(`${tag} ${from + i} ${'x'.repeat(30)}`, from + i));

/** A clock the test moves by hand: `advance` runs every timer due, yielding to real work between them. */
export class VirtualClock implements Clock {
  #t = 1_000_000;
  #timers: Array<{ at: number; fn: () => void; dead: boolean }> = [];
  now(): number { return this.#t; }
  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const t = { at: this.#t + ms, fn, dead: false };
    this.#timers.push(t);
    return { cancel: () => { t.dead = true; } };
  }
  async advance(ms: number): Promise<void> {
    const end = this.#t + ms;
    for (;;) {
      const due = this.#timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#t = Math.max(this.#t, due.at); due.dead = true; due.fn();
      await new Promise<void>((r) => setImmediate(r));
    }
    this.#t = end;
    this.#timers = this.#timers.filter((t) => !t.dead);
  }
}

export interface WDev { name: string; id: DeviceIdentity; dir: string; carrier: MemoryCarrier; link: Link; store: ChatStore; rep: Replicator; roster: RosterStore }
export interface WorldOptions { fsFor?: (name: string) => Fs | undefined; storeOpts?: StoreOptions; discoveryMs?: number; stallMs?: number; autoStart?: boolean }

const secret = newSetSecret();

export async function repWorld(names: string[], o: WorldOptions = {}) {
  const hub = new MemoryHub();
  const clock = new VirtualClock();
  const ids = Object.fromEntries(names.map((n) => [n, generateIdentity()])) as Record<string, DeviceIdentity>;
  const first = ids[names[0]];
  const setId = setIdFor(first.signKey);
  const entries = [makeGenesisEntry(first, names[0], 'linux', 1)];
  for (const n of names.slice(1)) entries.push(makeAddEntry(first, { name: n, platform: 'linux', signKey: ids[n].signKey, agreeKey: ids[n].agreeKey }, seenForNextEntry(entries, first.deviceId), 2));
  const dirs = Object.fromEntries(names.map((n) => [n, tmp(`rep-${n}-`)]));
  const devs: Record<string, WDev> = {};
  const saves = Object.fromEntries(names.map((n) => [n, { n: 0 }]));

  async function make(n: string, storeFs?: Fs, start = true): Promise<WDev> {
    const roster = new RosterStore(dirs[n]);
    await roster.load();
    if (roster.size === 0) for (const e of entries) await roster.append(e);
    const carrier = hub.members.get(n) ?? hub.carrier(n);
    carrier.deviceHex = ids[n].deviceId.toString('hex');
    const fsx = storeFs ?? o.fsFor?.(n);
    const store = await ChatStore.open(path.join(dirs[n], 'store'), { ...o.storeOpts, ...(fsx ? { fs: fsx } : {}), proofVerifier: () => true });
    let rep: Replicator | null = null;
    const link = new Link({
      identity: ids[n], setId, carrier, meshDir: dirs[n], secrets: () => new Map([[1, secret]]), signKeyFor: (d) => roster.signKeyFor(d), isRemoved: (d) => roster.isRemoved(d),
      counter: { get: () => saves[n].n, set: async (v) => { saves[n].n = Math.max(saves[n].n, v); } },
      onFrame: (f) => (rep ? rep.onFrame(f) : undefined),
    });
    await link.start([]);
    rep = await Replicator.create({
      store, link, dir: path.join(dirs[n], 'replicator'), setId, clock, ...(fsx ? { fs: fsx } : {}), discoveryMs: o.discoveryMs, stallMs: o.stallMs,
      crypto: {
        self: ids[n].deviceId, sign: (m) => signWith(ids[n], m), knows: (d) => roster.signKeyFor(d) !== undefined && !roster.isRemoved(d),
        verify: (d, m, s) => { const k = roster.signKeyFor(d); return !!k && verifySig(k, m, s); },
      },
      devices: () => names.filter((x) => x !== n).map((x) => ids[x].deviceId),
    });
    carrier.onConnected(() => rep?.hello());
    if (o.autoStart !== false && start) await rep.start();
    return { name: n, id: ids[n], dir: dirs[n], carrier, link, store, rep, roster };
  }
  for (const n of names) devs[n] = await make(n);

  const snapshot = async (): Promise<string> => {
    const parts: string[] = [String(hub.stored.length)];
    for (const n of names) {
      const d = devs[n];
      parts.push(n, String(d.carrier.passed), JSON.stringify(d.rep.counters()));
      for (const w of d.rep.versions()) { const s = await d.rep.status(w); parts.push(`${w.toString('hex').slice(0, 6)}:${s.lines}:${s.state}`); }
    }
    return parts.join('|');
  };
  const world = {
    hub, clock, devs, ids, setId, dirs, names, secret,
    /** Wait until nothing changes any more (all queues empty, no frame in flight): the "settle" for the negative. Time is real but only gates the check; progress is judged on state. */
    async settle(maxMs = 20_000, pollMs = 15, rounds = 4): Promise<void> {
      const t0 = Date.now(); let last = ''; let same = 0;
      while (Date.now() - t0 < maxMs) {
        for (const n of names) await devs[n].rep.idle();
        await new Promise((r) => setTimeout(r, pollMs));
        const now = await snapshot();
        same = now === last ? same + 1 : 0; last = now;
        if (same >= rounds) return;
      }
      throw new Error(`world did not settle in ${maxMs} ms: ${last}`);
    },
    /** Advance the virtual clock in steps, settling in between (so timers and frames interleave the way they would). */
    async elapse(ms: number, step = 5_000, fast = false): Promise<void> {
      for (let t = 0; t < ms; t += step) { await clock.advance(Math.min(step, ms - t)); await (fast ? world.settle(20_000, 4, 3) : world.settle()); }
    },
    async create(n: string, version: Buffer, over: Partial<{ chatId: string; runtime: 'claude-code' | 'native' }> = {}): Promise<void> {
      await devs[n].rep.createVersion({ version, chatId: over.chatId ?? CHAT, runtime: over.runtime ?? 'claude-code', parent: null, forkLine: null, forkHash: null, token: null });
    },
    /** The store id of the current (lowest non-retired) incarnation of `v` on device `n`, or null. */
    async localOf(n: string, v: Buffer): Promise<Buffer | null> {
      for (let inc = 0; inc < 8; inc++) {
        const local = inc === 0 ? v : createHash('sha256').update('youcoded-mesh/v1/incarnation\0').update(v).update(`\0${inc}`).digest();
        try { await devs[n].store.head(local); return local; } catch { continue; /* benign (test helper): retired or never registered, try the next incarnation */ }
      }
      return null;
    },
    async heads(n: string, v: Buffer): Promise<{ lines: number; hash: string; conv: string }> {
      const local = await world.localOf(n, v);
      if (!local) return { lines: 0, hash: '', conv: '' };
      const h = await devs[n].store.head(local);
      return { lines: h.lines, hash: h.hash, conv: h.conversationHash };
    },
    /** Every line of version `v` on device `n` (current incarnation). */
    async readAll(n: string, v: Buffer): Promise<Buffer[]> {
      const local = await world.localOf(n, v);
      if (!local) return [];
      const h = await devs[n].store.head(local);
      if (h.lines === 0) return [];
      const r = await devs[n].store.read(local, 0, 0, h.lines);
      return r === 'evicted' ? [] : r;
    },
    /** Take a device down and bring it up again over the same folder (its store reopened with the real file system). */
    async restart(n: string, opts: { graceful?: boolean; start?: boolean } = {}): Promise<WDev> {
      const d = devs[n];
      d.rep.stop(); d.link.stop();
      if (opts.graceful !== false) await d.store.close();
      else { const lp = path.join(dirs[n], 'store', 'LOCK'); if (fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ ...JSON.parse(fs.readFileSync(lp, 'utf8')), pid: 2147483646, start: 'dead' })); }
      const fresh = await make(n, realFs, opts.start !== false);
      devs[n] = fresh;
      return fresh;
    },
    /** Remove every device folder now (the fuzz runs thousands of worlds in one test; the helper only cleans after the test). */
    cleanup(): void { for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true }); },
    async stopAll(): Promise<void> { for (const n of names) { devs[n].rep.stop(); devs[n].link.stop(); try { await devs[n].store.close(); } catch { /* benign (test teardown): the store may already be closed by a restart */ } } },
  };
  return world;
}
export type World = Awaited<ReturnType<typeof repWorld>>;
export { vi };
