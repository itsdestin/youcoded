// Model-based convergence fuzz for the device layer (second-round review, class "the roster and the shared secret were patched case by case").
//
// WHAT IS SIMULATED: 2-6 devices, an optional hostile member (with ghost devices it controls) and a relay that delays, drops, duplicates,
// reorders and (hostile mode) withholds selectively. Operations: pair a new device, rename, remove (including concurrent, mutual and
// removal-by-a-member-being-removed), crash and restart from durable state (the outbox and the parked entries are lost, the roster log and the
// saved secrets survive), offline periods, time passing.
// WHAT IS REAL: RosterStore (in memory), RosterVerifier, DeviceCore (parking, anti-entropy, generations, who makes the next secret, takeover),
// the generation statements and HPKE sealing, entry signatures, and FrameSender/FrameReceiver for the final "can they read each other" check.
// WHAT IS NOT: sockets and files, and the sealing of CONTROL frames (the link seals them under a secret every member holds; here they travel
// as decoded values, authenticated by the sender id the way the link authenticates them).
// After quiescence (everything delivered, everyone online) six properties are checked; see `check()`.
import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import { toHex } from '../../src/main/mesh/crypto/bytes';
import { decode, encode } from '../../src/main/mesh/crypto/cbor';
import { FrameReceiver, FrameSender } from '../../src/main/mesh/crypto/frames';
import { encodeStatement } from '../../src/main/mesh/crypto/generation';
import { identityFromSecrets, setIdFor, type DeviceIdentity } from '../../src/main/mesh/crypto/identity';
import { sealSecretTo } from '../../src/main/mesh/crypto/keygen';
import { makeAddEntry, makeGenesisEntry, makeRemoveEntry, makeRenameEntry, seenForNextEntry, type MutualRule, type SignedEntry } from '../../src/main/mesh/crypto/roster';
import { DeviceCore, GenBook, type Out } from '../../src/main/mesh/device-core';
import { RosterStore } from '../../src/main/mesh/roster-store';
import { KIND_HEADS, KIND_NEED, KIND_REMOVAL, KIND_ROSTER, headsBody, needBody, noteBody, removalBody, rosterBody } from '../../src/main/mesh/wire';

export type Scenario = 'random' | 'n1' | 'n2' | 'n3' | 'n7' | 'n8';
export interface RunOptions { seed: number; scenario?: Scenario; hostile?: boolean; mutual?: MutualRule; mutation?: string; steps?: number }
export interface RunResult { trace: string[]; dump: string[]; seed: number; scenario: Scenario; violations: string[]; devices: number; steps: number; rounds: number }

const TAKEOVER = 100;
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Msg { kind: string; body: ReturnType<typeof decode>; from: Buffer; to?: Buffer }
const isInert = (d: { roster: RosterStore; id: DeviceIdentity }): boolean => d.roster.isRemoved(d.id.deviceId);
interface Dev {
  name: string;
  id: DeviceIdentity;
  hex: string;
  honest: boolean;
  silent: boolean; // a ghost: receives and keeps what it learns, never speaks
  roster: RosterStore;
  book: GenBook;
  core: DeviceCore;
  inbox: Array<{ at: number; msg: Msg }>;
  parked: Msg[];
  online: boolean;
  outbox: Out[];
  created: SignedEntry[];
  withheld: SignedEntry[];
}

class Sim {
  readonly r: () => number;
  now = 1000;
  chaos = true;
  setId!: Buffer;
  readonly devs: Dev[] = [];
  readonly issuedRemovals = new Map<string, { by: string; target: string }>();
  readonly allEntries = new Map<string, SignedEntry>();
  withholdFrom = new Set<string>(); // hostile relay: messages TO these devices are held back while set
  dropP = 0.12;
  dupP = 0.1;
  rounds = 0;
  readonly trace: string[] = [];
  n7Ghost: string | null = null;
  n7Add: SignedEntry | null = null;
  n7Admitter: string | null = null;
  hostileId: string | null = null;
  constructor(readonly o: RunOptions) {
    this.r = rng(o.seed);
  }
  pick<T>(xs: T[]): T {
    return xs[Math.floor(this.r() * xs.length)];
  }
  p(x: number): boolean {
    return this.r() < x;
  }

  // ---- device lifecycle
  // Identities come from the schedule's own random stream, so a seed replays exactly (entry ids decide the canonical order).
  ident(): DeviceIdentity {
    const b = (): Buffer => Buffer.from(Array.from({ length: 32 }, () => Math.floor(this.r() * 256)));
    return identityFromSecrets(b(), b());
  }
  async newDev(name: string, honest = true, silent = false, id: DeviceIdentity = this.ident()): Promise<Dev> {
    const roster = new RosterStore('mem', () => this.now, { memory: true, mutual: this.o.mutual });
    const book = new GenBook();
    const d: Dev = { name, id, hex: toHex(id.deviceId), honest, silent, roster, book, core: undefined as never, inbox: [], parked: [], online: true, outbox: [], created: [], withheld: [] };
    this.mkCore(d);
    this.devs.push(d);
    return d;
  }
  mkCore(d: Dev): void {
    d.core = new DeviceCore({ identity: d.id, setId: this.setId, roster: d.roster, book: d.book, takeoverMs: TAKEOVER });
  }
  crash(d: Dev): void {
    this.trace.push(`crash ${d.name}`);
    // volatile: parked entries, the outbox, "who a secret was sealed to", first-seen times. Durable: roster entries, saved secrets, link-parked frames.
    d.book.sealedTo.clear();
    d.outbox = [];
    this.mkCore(d);
  }
  active(d: Dev): boolean {
    return d.roster.activeDevices().some((x) => toHex(x.deviceId) === d.hex);
  }

  // ---- the relay
  send(from: Dev, outs: Out[]): void {
    for (const o of outs) {
      if (!from.online) { from.outbox.push(o); continue; }
      const msg: Msg = { kind: o.kind, body: decode(encode(o.body)), from: from.id.deviceId, to: o.to };
      for (const d of this.devs) {
        if (d === from) continue;
        if (o.to && !o.to.equals(d.id.deviceId)) continue;
        if (this.chaos && this.p(this.dropP) && !this.o.mutation?.includes('nodrop')) continue; // lost (heals through anti-entropy)
        const copies = this.chaos && this.p(this.dupP) ? 2 : 1;
        for (let i = 0; i < copies; i++) d.inbox.push({ at: this.now + (this.chaos ? Math.floor(this.r() * 250) : 0), msg });
      }
    }
  }
  flushOutbox(d: Dev): void {
    if (!d.online || d.outbox.length === 0) return;
    const o = d.outbox;
    d.outbox = [];
    this.send(d, o);
  }
  async handle(d: Dev, msg: Msg): Promise<void> {
    if (!d.roster.knownSignKeyFor(msg.from)) {
      // unknown signer: the link parks it until the roster may have grown
      if (d.parked.filter((m) => m.from.equals(msg.from)).length < 16) d.parked.push(msg);
      return;
    }
    const t0 = performance.now();
    const r = await d.core.onMessage(msg.kind, msg.body, msg.from, this.now);
    this.maxMs = Math.max(this.maxMs, performance.now() - t0);
    if (!d.silent) this.send(d, r.out);
    if (r.wait) {
      if (d.parked.filter((m) => m.from.equals(msg.from)).length < 16) d.parked.push(msg);
      return;
    }
    if (r.changed) await this.after(d);
  }
  async after(d: Dev, announce = false): Promise<void> {
    if (d.silent) return;
    const t = await d.core.tick(this.now, announce);
    this.send(d, t.out);
    // the link judges its waiting frames again whenever the roster or the secrets may have changed
    if (!this.retrying.has(d) && d.parked.length) {
      this.retrying.add(d);
      try { for (const m of d.parked.splice(0)) await this.handle(d, m); } finally { this.retrying.delete(d); }
    }
  }
  readonly retrying = new Set<Dev>();
  /** (ix) the slowest single delivered frame (CPU of the device layer, one frame in). */
  maxMs = 0;
  async deliverOne(d: Dev): Promise<boolean> {
    if (!d.online) return false;
    if (this.withholdFrom.has(d.hex)) return false;
    const ready = d.inbox.filter((x) => x.at <= this.now);
    if (ready.length === 0) return false;
    const x = this.chaos ? this.pick(ready) : ready[0];
    d.inbox.splice(d.inbox.indexOf(x), 1);
    await this.handle(d, x.msg);
    return true;
  }

  // ---- operations
  async addDevice(host: Dev, name: string): Promise<Dev | null> {
    if (this.devs.filter((x) => x.honest && !x.silent).length >= 6) return null;
    if (!this.active(host) || isInert(host)) return null;
    const id = this.ident();
    const e = makeAddEntry(host.id, { name, platform: 'linux', signKey: id.signKey, agreeKey: id.agreeKey }, seenForNextEntry(host.roster.entries, host.id.deviceId), this.now);
    this.trace.push(`add ${host.name} -> ${name}`);
    // WHY (third review): a device may admit at most MAX_ADMISSIONS_PER_SIGNER devices and a set holds at most MAX_SET_DEVICES; the service refuses beyond that, so the model does too
    try { await host.roster.append(e); } catch { return null; }
    host.created.push(e);
    this.allEntries.set(toHex(e.id), e);
    const d = await this.newDev(name, true, false, id);
    // the welcome: the host's whole roster and every secret it holds, with statements
    for (const x of host.roster.entries) await d.roster.append(x);
    d.core.adoptWelcome(host.book.secrets(), new Map([...host.book.held].filter(([, h]) => h.stmt).map(([l, h]) => [l, encodeStatement(h.stmt as never)])));
    this.send(host, [{ kind: KIND_ROSTER, body: rosterBody([e]) }]);
    await this.after(host);
    await this.after(d, true);
    return d;
  }
  async rename(d: Dev): Promise<void> {
    if (!this.active(d) || isInert(d)) return;
    this.trace.push(`rename ${d.name}`);
    const e = makeRenameEntry(d.id, `${d.name}-${Math.floor(this.r() * 1e6)}`, seenForNextEntry(d.roster.entries, d.id.deviceId), this.now);
    await d.roster.append(e);
    d.created.push(e);
    this.allEntries.set(toHex(e.id), e);
    this.send(d, [{ kind: KIND_ROSTER, body: rosterBody([e]) }]);
    await this.after(d);
  }
  async remove(d: Dev, target: Dev): Promise<void> {
    if (isInert(d) || !this.active(d) || d === target) return;
    if (!d.roster.activeDevices().some((x) => toHex(x.deviceId) === target.hex)) return;
    this.trace.push(`remove ${d.name} -> ${target.name}`);
    const e = makeRemoveEntry(d.id, target.id.deviceId, seenForNextEntry(d.roster.entries, d.id.deviceId), this.now);
    await d.roster.append(e);
    d.created.push(e);
    this.allEntries.set(toHex(e.id), e);
    this.issuedRemovals.set(toHex(e.id), { by: d.hex, target: target.hex });
    this.send(d, [{ kind: KIND_ROSTER, body: rosterBody([e]) }]);
    await this.after(d, true);
  }
  honestActive(): Dev[] {
    return this.devs.filter((d) => d.honest && !d.silent && !isInert(d) && this.active(d));
  }

  // ---- hostile member
  async hostileMove(h: Dev, force?: number, victim?: Dev): Promise<void> {
    const honest = this.devs.filter((d) => d.honest && !d.silent);
    const k = force ?? Math.floor(this.r() * 12);
    if (k === 0 && honest.length) {
      // forged entries naming an honest device (bad signature), 70 in one frame: must cost that device nothing (N2)
      const vd = victim ?? this.pick(honest);
      const real = [...vd.roster.entries].reverse().find((e) => e.device.equals(vd.id.deviceId)) ?? vd.roster.entries.slice(-1)[0];
      if (real) this.send(h, [{ kind: KIND_ROSTER, body: rosterBody(Array.from({ length: 70 }, () => ({ ...real, id: randomBytes(32), signature: randomBytes(64) }))) }]);
    } else if (k === 1) {
      // a ghost: valid signature, a device only the hostile member holds. Sometimes withheld (delivered after its remover acted).
      const id = this.ident();
      const e = makeAddEntry(h.id, { name: 'ghost', platform: 'linux', signKey: id.signKey, agreeKey: id.agreeKey }, seenForNextEntry(h.roster.entries, h.id.deviceId), this.now);
      try { await h.roster.append(e); } catch { return; }
      this.allEntries.set(toHex(e.id), e);
      const g = await this.newDev('ghost', false, true, id);
      for (const x of h.roster.entries) await g.roster.append(x).catch(() => undefined);
      g.core.adoptWelcome(h.book.secrets(), new Map());
      if (this.p(0.5)) h.withheld.push(e); else this.send(h, [{ kind: KIND_ROSTER, body: rosterBody([e]) }]);
    } else if (k === 2 && h.withheld.length) {
      this.send(h, [{ kind: KIND_ROSTER, body: rosterBody(h.withheld.splice(0)) }]);
    } else if (k === 3) {
      // a partial or garbage generation: a real signed statement of the hostile member, secret sealed to a subset or random junk
      const cur = h.core.currentLabel();
      const held = cur === null ? null : h.book.held.get(cur);
      if (held?.stmt) {
        const sealed = new Map<string, Buffer>();
        for (const dv of h.roster.activeDevices()) {
          if (toHex(dv.deviceId) === h.hex || this.p(0.5)) continue;
          sealed.set(toHex(dv.deviceId), this.p(0.5) ? randomBytes(120) : sealSecretTo(dv.agreeKey, this.setId, held.stmt.label, held.secret, h.id.deviceId, dv.deviceId));
        }
        this.send(h, [{ kind: KIND_REMOVAL, body: removalBody({ entries: [], stmt: encodeStatement(held.stmt), sealed }) }]);
      }
    } else if (k === 4) {
      this.send(h, [{ kind: KIND_NEED, body: needBody(Array.from({ length: 20 }, () => randomBytes(32)), [1, 77, 123456]) }]);
    } else if (k === 5) {
      const old = this.pick([...h.roster.entries]);
      if (old) this.send(h, [{ kind: KIND_ROSTER, body: rosterBody([old]) }]);
    } else if (k === 7) {
      // FLOOD (third review): a chain of junk removals (made-up ids and real devices) signed in one go and delivered at once, to defeat the removal cap
      const batch: SignedEntry[] = [];
      const targets = [...this.devs.map((q) => q.id.deviceId), ...Array.from({ length: 4 }, () => this.ident().deviceId)];
      for (let i = 0; i < 40; i++) {
        const e = makeRemoveEntry(h.id, this.pick(targets), seenForNextEntry([...h.roster.entries, ...batch], h.id.deviceId), this.now);
        try { await h.roster.append(e); batch.push(e); } catch { break; }
        this.allEntries.set(toHex(e.id), e);
      }
      for (let i = 0; i < batch.length; i += 20) this.send(h, [{ kind: KIND_ROSTER, body: rosterBody(batch.slice(i, i + 20)) }]);
    } else if (k === 8 && honest.length) {
      // PRE-SIGNED (third review): the hostile member signs "I remove an honest device" and a rename now, withholds them, and releases them later (k=2)
      const t = this.pick(honest);
      for (const e of [makeRemoveEntry(h.id, t.id.deviceId, seenForNextEntry(h.roster.entries, h.id.deviceId), this.now), makeRenameEntry(h.id, 'stash', seenForNextEntry(h.roster.entries, h.id.deviceId), this.now)]) {
        try { await h.roster.append(e); } catch { continue; }
        this.allEntries.set(toHex(e.id), e);
        h.withheld.push(e);
      }
    } else if (k === 9) {
      // AMPLIFICATION (third review): heads and need frames in bulk from the hostile member
      for (let i = 0; i < 12; i++) this.send(h, [{ kind: KIND_HEADS, body: headsBody([], []) }, { kind: KIND_NEED, body: needBody(h.roster.heads().length ? h.roster.heads() : [randomBytes(32)]) }]);
    } else if (k === 10) {
      // GHOST MASS (third review): several ghosts admitted offline, each signing renames, all withheld and released together
      const stash: SignedEntry[] = [];
      let chain = [...h.roster.entries];
      for (let i = 0; i < 5; i++) {
        const id = this.ident();
        const add = makeAddEntry(h.id, { name: 'ghost', platform: 'linux', signKey: id.signKey, agreeKey: id.agreeKey }, seenForNextEntry(chain, h.id.deviceId), this.now);
        try { await h.roster.append(add); } catch { break; }
        chain = [...chain, add]; stash.push(add); this.allEntries.set(toHex(add.id), add);
        for (let j = 0; j < 6; j++) { const rn = makeRenameEntry(id, 'g' + j, seenForNextEntry(chain, id.deviceId), this.now); chain = [...chain, rn]; stash.push(rn); }
      }
      h.withheld.push(...stash);
    } else if (k === 6 && honest.length && this.o.hostile) {
      this.withholdFrom.clear();
      if (this.p(0.5)) this.withholdFrom.add(this.pick(honest).hex);
    }
  }

  // ---- quiescence
  async quiesce(): Promise<boolean> {
    this.chaos = false;
    this.withholdFrom.clear();
    for (const d of this.devs) { d.online = true; this.flushOutbox(d); }
    let stable = 0;
    let last = '';
    for (let round = 0; round < 80; round++) {
      this.rounds = round;
      // WHY 10 s a round (third review): heads repeat every 30 s in the service (every 3rd round here), and a peer is answered at most REPLY_ENTRIES entries
      // per 30 s; the old 0.8 s round made the reply budget look 12x tighter than it is.
      this.now += 10_000;
      for (const d of this.devs) if (d.honest && !d.silent) await this.after(d, round % 3 === 0 || round < 6); // quiet (self-removed) devices tick too: they must still ask for what they lack
      let moved = true;
      let guard = 0;
      while (moved && guard++ < 5000) {
        moved = false;
        for (const d of this.devs) { if (await this.deliverOne(d)) moved = true; }
      }
      const sig = this.devs.filter((d) => d.honest && !d.silent).map((d) => `${d.roster.size}:${d.book.held.size}:${d.parked.length}:${d.core.parked.size}`).join('|');
      if (sig === last) { if (++stable >= 4) return true; } else { stable = 0; last = sig; }
    }
    return false;
  }

  // ---- the six properties
  digest(d: Dev): string {
    const v = d.roster.verified;
    return JSON.stringify({
      ids: d.roster.entries.map((e) => toHex(e.id)).sort(),
      active: d.roster.activeDevices().map((x) => `${toHex(x.deviceId)}:${x.name}`).sort(),
      removed: [...d.roster.removedIds()].sort(),
      voided: [...d.roster.voidedIds()].sort(),
      confirmed: [...d.roster.confirmedIds()].sort(),
      n: v ? v.devices.size : 0,
    });
  }
  async check(quiet: boolean): Promise<string[]> {
    const bad: string[] = [];
    if (!quiet) bad.push('(vi) no quiescence: something is still moving or waiting after 80 rounds');
    const honest = this.devs.filter((d) => d.honest && !d.silent);
    // A device that has learned it was removed stops acting (as the service does), so "remaining" = honest devices still acting. A device
    // removed in somebody's view that has not learned of it yet would be a (vi) failure: after quiescence everyone has everything.
    const live = honest.filter((d) => !isInert(d));
    // The roster everyone should hold is the one most live devices hold; a live device that this roster does not list as a member is an
    // ORPHAN (its pairing was voided because its host was removed at the same moment, the N7 rule) and is not asked to converge.
    // The roster everyone should hold is the state of ALL entries held by live devices together (the state is a function of the set, so this is
    // what a device that held everything would compute); a live device it does not list as a member is an ORPHAN (its pairing was voided
    // because its host was removed at the same moment, the N7 rule, and it is not asked to converge).
    const allEntries = new Map<string, SignedEntry>();
    for (const d of honest) for (const e of d.roster.entries) allEntries.set(toHex(e.id), e);
    const union = new RosterStore('mem', () => this.now, { memory: true, mutual: this.o.mutual });
    let todo = [...allEntries.values()];
    for (let i = 0; i < 80 && todo.length; i++) {
      const next: SignedEntry[] = [];
      for (const e of todo) { try { await union.append(e); } catch { next.push(e); } }
      if (next.length === todo.length) break;
      todo = next;
    }
    const truth: { roster: RosterStore } | undefined = honest.length ? { roster: union } : undefined;
    const remaining = truth ? live.filter((d) => truth.roster.activeDevices().some((x) => toHex(x.deviceId) === d.hex)) : [];
    // (i) identical roster state among honest remaining members
    if (remaining.length > 1) {
      const ds = new Set(remaining.map((d) => this.digest(d)));
      if (ds.size > 1) bad.push(`(i) roster state differs between honest remaining members: ${remaining.map((d) => d.name + '=' + this.digest(d).length).join(',')}`);
    }
    if (remaining.length > 0) {
      // order independence: the same SET in another order and with duplicates gives the same state
      const ref = remaining[0];
      // a RANDOM CAUSAL order (every entry after the entries it cites, otherwise random): Kahn's algorithm with a random pick among the ready ones
      const all = [...ref.roster.entries];
      const byId = new Map(all.map((e) => [toHex(e.id), e]));
      const waitingOn = new Map<string, number>();
      const children = new Map<string, SignedEntry[]>();
      const ready: SignedEntry[] = [];
      for (const e of all) {
        const deps = e.seen.map((x) => toHex(x)).filter((x) => byId.has(x));
        waitingOn.set(toHex(e.id), deps.length);
        for (const dp of deps) children.set(dp, [...(children.get(dp) ?? []), e]);
        if (deps.length === 0) ready.push(e);
      }
      const shuffled: SignedEntry[] = [];
      while (ready.length) {
        const e = ready.splice(Math.floor(this.r() * ready.length), 1)[0];
        shuffled.push(e);
        for (const c of children.get(toHex(e.id)) ?? []) { const w = (waitingOn.get(toHex(c.id)) as number) - 1; waitingOn.set(toHex(c.id), w); if (w === 0) ready.push(c); }
      }
      const s = new RosterStore('mem', () => this.now, { memory: true, mutual: this.o.mutual });
      const pending: SignedEntry[] = [];
      for (const e of shuffled) { try { await s.append(e); } catch (err) { pending.push(e); if (process.env.DBGF) require('fs').appendFileSync(process.env.DBGF, `${e.kind} by ${toHex(e.device).slice(0, 4)}: ${(err as Error).message}\n`); } }
      for (const e of shuffled.slice(0, 5)) await s.append(e).catch(() => undefined); // duplicates
      const probe: Dev = { ...ref, roster: s } as Dev;
      if (pending.length === 0 && this.digest(probe) !== this.digest(ref)) bad.push('(i) the state depends on the order entries arrived in');
      if (pending.length) bad.push('(i) entries a device holds could not be re-applied in another order');
    }
    // (ii) one current generation, and the members can read each other
    const cur = new Set(remaining.map((d) => d.core.currentLabel()));
    if (remaining.length > 0 && (cur.size !== 1 || cur.has(null))) bad.push(`(ii) honest remaining members do not share one current generation: ${remaining.map((d) => d.name + '=' + d.core.currentLabel()).join(',')}`);
    else if (remaining.length > 1) {
      const label = [...cur][0] as number;
      for (const s of remaining) {
        const sender = new FrameSender({ identity: s.id, setId: this.setId, padding: 'buckets' });
        const secret = s.book.held.get(label)!.secret;
        const wire = sender.seal({ secret, gen: label, group: 'n', kind: 'note', body: noteBody('hello'), to: null });
        for (const r of remaining) {
          if (r === s) continue;
          const rx = new FrameReceiver({ setId: this.setId, selfDeviceId: r.id.deviceId, secretFor: (g) => r.book.held.get(g)?.secret, signKeyFor: (id) => r.roster.signKeyFor(id) });
          try { rx.open(wire); } catch (e) { bad.push(`(ii) ${r.name} cannot read ${s.name}: ${(e as { code?: string }).code}`); }
        }
      }
    }
    // (iii) nobody outside the remaining set holds the current secret or can read what is sealed under it
    if (remaining.length > 0 && cur.size === 1 && !cur.has(null)) {
      const label = [...cur][0] as number;
      const secret = remaining[0].book.held.get(label)!.secret;
      for (const d of this.devs) {
        if (remaining.includes(d) || (truth && truth.roster.activeDevices().some((x) => toHex(x.deviceId) === d.hex))) continue;
        if (d.book.held.has(label)) bad.push(`(iii) ${d.name} (${d.honest ? 'honest' : 'hostile'}, not a remaining member) holds the current generation`);
        else {
          const sender = new FrameSender({ identity: remaining[0].id, setId: this.setId, padding: 'buckets' });
          const wire = sender.seal({ secret, gen: label, group: 'n', kind: 'note', body: noteBody('secret'), to: null });
          const rx = new FrameReceiver({ setId: this.setId, secretFor: (g) => d.book.held.get(g)?.secret, signKeyFor: () => remaining[0].id.signKey });
          try { rx.open(wire); bad.push(`(iii) ${d.name} could read a frame sealed under the current generation`); } catch { /* expected */ }
        }
      }
    }
    // (vii) N7: a ghost admitted at the same moment as its admitter's removal is not a member
    if (this.n7Ghost && this.n7Add && this.n7Admitter && truth?.roster.verified) {
      const tv = truth.roster.verified;
      const rem = truth.roster.removalIdsOf(this.n7Admitter);
      const seenByRemoval = rem.some((id) => tv.happenedBefore((this.n7Add as SignedEntry).id, Buffer.from(id, 'hex')));
      if (rem.length > 0 && !seenByRemoval && truth.roster.activeDevices().some((x) => toHex(x.deviceId) === this.n7Ghost)) bad.push("(vii) the ghost admitted concurrently with its admitter's removal is a member");
    }
    // (iv) no valid entry of an honest device that is still a member was ignored, and nothing waits
    for (const d of remaining) {
      for (const e of d.created) {
        for (const r of remaining) {
          if (!r.roster.has(e.id)) bad.push(`(iv) ${r.name} never received ${d.name}'s entry`);
          else if (r.roster.voidedIds().has(toHex(e.id)) && !(e.kind === 'remove' && ['overridden-by-senior', 'unknown-target'].includes(r.roster.verified?.facts.get(toHex(e.id))?.why ?? ''))) bad.push(`(iv) ${d.name}'s entry was ignored (void) although ${d.name} was never removed`);
        }
      }
      for (const pe of d.core.parked.values()) for (const anc of pe.entry.seen) if (!d.roster.has(anc) && remaining.some((r) => r !== d && r.roster.has(anc))) bad.push(`(vi) ${d.name} waits for an entry that another remaining member holds`);
      if (d.parked.length > 0) {
        const unknown = d.parked.filter((m) => d.roster.knownSignKeyFor(m.from) === undefined && remaining.some((r) => r.roster.knownSignKeyFor(m.from) !== undefined));
        if (unknown.length) bad.push(`(vi) ${d.name} has ${unknown.length} waiting frames from signers other members know`);
      }
    }
    // (v) an honest device is out only through a real removal entry by a member
    if (truth) {
      for (const d of honest) {
        if (!isInert(d)) continue;
        if (truth.roster.activeDevices().some((x) => toHex(x.deviceId) === d.hex)) { bad.push(`(v) ${d.name} stopped itself although the roster still lists it as a member`); continue; }
        if (!truth.roster.removedIds().has(d.hex)) continue; // an orphan (never a member in the final roster)
        const rid = truth.roster.removalIdsOf(d.hex);
        if (rid.length === 0) bad.push(`(v) ${d.name} is out but no removal entry names it`);
        for (const id of rid) {
          if (this.issuedRemovals.has(id)) continue;
          // Third review: the hostile member signs removals too. One of its removals of an honest device may stand only in the DOCUMENTED cases:
          // (1) policy, finding 4: it was made before, and seen by, an honest removal of the hostile member (or the hostile member is still a member);
          // (2) the mutual-removal rule: it targets the device that removed the hostile member, concurrently with that removal.
          const ent = allEntries.get(id);
          const hv = truth.roster.verified;
          if (ent && this.hostileId && toHex(ent.device) === this.hostileId && hv) {
            const hostileOut = truth.roster.removedIds().has(this.hostileId);
            const hRem = truth.roster.removalIdsOf(this.hostileId);
            const seenByHRemoval = hRem.some((h) => hv.happenedBefore(ent.id, Buffer.from(h, 'hex')));
            const removersOfH = new Set([...this.issuedRemovals.values()].filter((x) => x.target === this.hostileId).map((x) => x.by));
            if (!hostileOut || seenByHRemoval || removersOfH.has(d.hex)) continue;
          }
          bad.push(`(v) a removal of ${d.name} exists that nobody issued`);
        }
      }
    }
    // (vii) third review: an honest removal of the hostile member by any honest device always takes effect once delivered, under the default rules,
    // except in the exactly-documented mutual-removal case (the hostile member also removed that device concurrently, and the earlier-admitted device stays)
    if (truth?.roster.verified && this.hostileId) {
      const H = this.hostileId;
      const honestRemovals = [...this.issuedRemovals.values()].filter((x) => x.target === H && this.devs.find((q) => q.hex === x.by)?.honest);
      if (honestRemovals.length && truth.roster.activeDevices().some((x) => toHex(x.deviceId) === H)) {
        const excused = this.o.mutual === 'first-admitted' && truth.roster.entries.some((e) => e.kind === 'remove' && toHex(e.device) === H && honestRemovals.some((x) => toHex((e.body as { target: Uint8Array }).target) === x.by));
        if (!excused) bad.push('(vii) an honest removal of the hostile member did not take effect');
      }
      // (viii) no honest device permanently ignores another honest device: every entry an honest device created is held by every remaining one ((iv)),
      // and none of them is still "flagged" for rate after the hour has passed and one more entry arrived
    }
    // (ix) the per-frame cost stays under a stated bound (1.5 s of CPU for one frame in, generous for a loaded machine; measured about 40 ms for 2,000 entries)
    if (this.maxMs > 1500) bad.push(`(ix) one frame cost ${this.maxMs.toFixed(0)} ms`);
    // (vi) progress: everyone remaining has a current generation (checked in (ii)) and nothing is parked (above)
    return bad;
  }
}

export async function runSchedule(o: RunOptions): Promise<RunResult> {
  const sim = new Sim(o);
  const scenario: Scenario = o.scenario ?? 'random';
  const violations: string[] = [];
  const hostile = o.hostile === true || scenario === 'n2' || scenario === 'n7';
  const initial = scenario === 'n3' ? 5 : scenario === 'random' ? 2 + Math.floor(sim.r() * 3) : scenario === 'n1' ? 3 : 4;
  // clean start: the creator and its pairings, everything delivered
  const g = sim.ident();
  sim.setId = setIdFor(g.signKey);
  const A = await sim.newDev('A', true, false, g);
  const genesis = makeGenesisEntry(g, 'A', 'linux', sim.now);
  await A.roster.append(genesis);
  A.created.push(genesis);
  sim.allEntries.set(toHex(genesis.id), genesis);
  A.core.genesis();
  sim.chaos = false;
  const members: Dev[] = [A];
  for (let i = 1; i < initial; i++) {
    const d = await sim.addDevice(sim.pick(members), String.fromCharCode(65 + i));
    if (d) members.push(d);
  }
  let H: Dev | null = null;
  if (hostile) {
    const host = A;
    H = await sim.addDevice(host, 'H');
    if (H) { H.honest = false; H.created = []; sim.hostileId = H.hex; }
  }
  await sim.quiesce();
  sim.chaos = true;
  let steps = 0;
  const honestOnes = (): Dev[] => sim.devs.filter((d) => d.honest && !d.silent);
  // scripted preludes: the exact interleavings the review found
  const [a, b, c, d4] = honestOnes();
  if (scenario === 'n1' && c) {
    a.online = false;
    await sim.rename(a); // created, never sent
    sim.crash(a); // the outbox is lost
    a.online = true;
    await sim.remove(a, c);
  } else if (scenario === 'n2' && H && a) {
    sim.dropP = 0;
    await sim.hostileMove(H, 0, a); // 70 forged entries naming an honest device
    sim.dropP = 0.12;
    await sim.remove(a, H);
  } else if (scenario === 'n3' && d4) {
    const e = honestOnes()[4];
    await Promise.all([sim.remove(a, c), sim.remove(b, d4)]);
    void e;
  } else if (scenario === 'n7' && H && a) {
    const id = sim.ident();
    const e = makeAddEntry(H.id, { name: 'ghost', platform: 'linux', signKey: id.signKey, agreeKey: id.agreeKey }, seenForNextEntry(H.roster.entries, H.id.deviceId), sim.now);
    const okAdd = await H.roster.append(e).then(() => true, () => false);
    if (okAdd) {
      const gh = await sim.newDev('ghost', false, true, id);
      sim.n7Ghost = gh.hex;
      sim.n7Add = e;
      sim.n7Admitter = H.hex;
      for (const x of H.roster.entries) await gh.roster.append(x).catch(() => undefined);
      gh.core.adoptWelcome(H.book.secrets(), new Map());
      sim.allEntries.set(toHex(e.id), e);
      await sim.remove(a, H); // concurrent with the ghost add, which is delivered afterwards
      sim.send(H, [{ kind: KIND_ROSTER, body: rosterBody([e]) }]);
    }
  } else if (scenario === 'n8' && b) {
    // a pairing finishes while its host is offline for ages; the host must never undo it by itself
    const nd = await sim.addDevice(a, 'N');
    a.online = false;
    sim.now += 10_000_000;
    void nd;
  }
  const total = o.steps ?? 18 + Math.floor(sim.r() * 22);
  while (steps++ < total) {
    const live = sim.devs.filter((d) => d.honest && !d.silent && !isInert(d));
    const x = sim.r();
    if (live.length === 0) break;
    if (x < 0.4) await sim.deliverOne(sim.pick(sim.devs));
    else if (x < 0.5) { sim.now += Math.floor(sim.r() * 150); for (const d of sim.devs) if (d.honest && !d.silent && d.online) await sim.after(d, sim.p(0.3)); }
    else if (x < 0.56) await sim.addDevice(sim.pick(live), 'N' + steps);
    else if (x < 0.64) await sim.rename(sim.pick(live));
    else if (x < 0.76) { const from = sim.pick(live); const act = from.roster.activeDevices().map((v) => toHex(v.deviceId)); const t = sim.devs.find((q) => q.hex === sim.pick(act) && q.honest && !q.silent); if (t) await sim.remove(from, t); }
    else if (x < 0.82) sim.crash(sim.pick(sim.devs.filter((q) => !q.silent)));
    else if (x < 0.88) { const q = sim.pick(sim.devs.filter((v) => !v.silent)); q.online = !q.online; if (q.online) sim.flushOutbox(q); }
    else if (x < 0.95 && H) await sim.hostileMove(H);
    else for (const d of sim.devs) sim.flushOutbox(d);
  }
  // the honest members deal with the hostile one, as a user would, then everything settles
  let quiet = false;
  if (H) {
    // the honest members deal with the hostile one, as a user would (until the roster really shows it removed), then everything settles
    sim.chaos = false;
    for (const d of sim.devs) { d.online = true; sim.flushOutbox(d); }
    for (let attempt = 0; attempt < 4; attempt++) {
      quiet = await sim.quiesce();
      const act = sim.honestActive();
      if (!act.length || !act[0].roster.activeDevices().some((x) => toHex(x.deviceId) === H!.hex)) break;
      await sim.remove(act[0], H);
    }
  }
  quiet = await sim.quiesce();
  violations.push(...(await sim.check(quiet)));
  const dump = sim.devs.map((d) => `${d.name} ${d.honest ? 'H' : 'X'}${d.silent ? 's' : ''}${isInert(d) ? 'i' : ''} size=${d.roster.size} active=[${d.roster.activeDevices().map((x) => x.name).join(',')}] removed=${[...d.roster.removedIds()].map((x) => sim.devs.find((q) => q.hex === x)?.name ?? x.slice(0, 4)).join(',')} gens=${d.book.held.size} cur=${d.core.currentLabel()} waiting=${d.parked.length} parked=${d.core.parked.size}`);
  for (const d of sim.devs) for (const pe of d.core.parked.values()) {
    const miss = pe.entry.seen.filter((x) => !d.roster.has(x)).map((x) => toHex(x).slice(0, 6) + ' held by ' + sim.devs.filter((q) => q.roster.has(x)).map((q) => q.name).join('/'));
    dump.push(`  ${d.name} wants=${d.core.wanted().map((x) => toHex(x).slice(0, 6))} inbox=${d.inbox.length} online=${d.online} wantedSent=${d.core.wantedSent}`);
    dump.push(`  ${d.name} parks ${pe.entry.kind} by ${sim.devs.find((q) => q.hex === toHex(pe.entry.device))?.name} missing ${miss.join(';')}`);
  }
  const nm = (h: string): string => sim.devs.find((q) => q.hex === h)?.name ?? h.slice(0, 4);
  const refd = sim.devs.find((q) => q.honest && !q.silent && !isInert(q));
  if (refd) {
    const f = refd.roster.verified?.facts;
    for (const e of refd.roster.entries) {
      const fx = f?.get(toHex(e.id));
      if (e.kind === 'remove' || fx?.void) dump.push(`  ${e.kind} by ${nm(toHex(e.device))} ${e.kind === 'remove' ? '-> ' + nm(toHex((e.body as { target: Uint8Array }).target)) : ''} void=${fx?.void} why=${fx?.why} idx=${fx?.index}`);
    }
  }
  return { trace: sim.trace, dump, seed: o.seed, scenario, violations, devices: sim.devs.length, steps: total, rounds: sim.rounds };
}
