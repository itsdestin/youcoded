// Seeded fuzz for the replicator, with its OWN oracle: a plain array of lines per version, written ONLY by this file's own `appendLocal` calls.
// Nothing in the oracle comes from a store, a replicator or a hash. A seed picks a random sequence of operations on three devices (appends by each version's
// writer, devices going offline and online, restarts with and without a clean close, noisy links, a relay that forgets frames, a folder put back to an earlier state,
// a rotted byte, forged messages from a paired device, one takeover), then lets everything settle and checks the promises of plan section 6:
//   P1  every device's readable lines of a version are a prefix of the oracle: no line exists that no writer appended, and no line differs;
//   P2  every device that calls a version `in-sync` holds exactly the oracle (all of it);
//   P3  a line a device once ACKNOWLEDGED (as another device saw it) is still readable there, or that device names a status that is not `in-sync` (no silent loss);
//   P4  no version is `in-sync` while the store reports a refill, and no peer line is ever parked.
// Anything else is a failure naming the seed. EXCUSES: a device that ends in a named non-`in-sync` state is reported (never silently passed) and counted; each
// excuse must map to a documented store limit (see `EXCUSE_LIMITS`); an unmapped one fails the seed.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { repWorld, wireId, lineSet, line, CHAT, type World } from './replicator-world';
import { chatGroup } from '../../src/main/mesh/replicator/ctx';
import { chainStep, deriveForkId } from '../../src/main/mesh/store';
import { headMessage, headsBodyOf, introBodyOf, KIND_ACK, KIND_HEADS, KIND_LINES, KIND_NAK, linesBody, nakBodyOf, ackBodyOf, ackMessage } from '../../src/main/mesh/replicator/wire';
import { signWith } from '../../src/main/mesh/crypto/identity';

/** Documented store limits (inventory.ts) that may leave a device in a named non-in-sync state at the end of a run. Key = the status reason or state. */
export const EXCUSE_LIMITS: Record<string, string> = {
  'state:diverged': 'a peer\'s unverifiable claim of another history is kept and named (inventory limit 4 / plan invariant 5): never settled by length',
  'state:refilling': 'a rolled-back or rotted copy still repairing when the run ended (inventory rules iii-v): named, never in-sync',
  'state:pulling': 'a request outstanding to a peer that answered nothing (plan: receiver-driven, re-asked on a timer)',
  'state:comparing': 'no peer has said anything about the version since the last restart',
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface SeedReport { seed: number; ops: Record<string, number>; excuses: string[]; steps: number }
const NAMES = ['A', 'B', 'C'];

export async function runSeed(seed: number, steps = 22): Promise<SeedReport> {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const world = await repWorld(NAMES, { discoveryMs: 20_000, stallMs: 8_000 });
  const ops: Record<string, number> = {};
  const excuses: string[] = [];
  const oracle = new Map<string, Buffer[]>();
  const writer = new Map<string, string>(); // version hex -> writer device
  const vs: Buffer[] = [];
  const snaps = new Map<string, { dev: string; v: Buffer; dir: string }>();
  const acked: Array<{ holder: string; v: Buffer; lines: number }> = [];
  const online = new Set(NAMES);
  let noisy = false; let counter = 0; let forked = false;
  const trace: string[] = [];
  const note = (k: string): void => { ops[k] = (ops[k] ?? 0) + 1; trace.push(k); };
  const fail = (msg: string): never => { throw new Error(`replicator fuzz seed ${seed}: ${msg} [ops: ${trace.join(',')}]`); };
  try {
    for (const [i, wr] of ['A', 'B'].entries()) {
      const v = wireId(`fuzz-${seed}-${i}`);
      await world.devs[wr].rep.createVersion({ version: v, chatId: i === 0 ? CHAT : `${CHAT}-2`, runtime: 'claude-code', parent: null, forkLine: null, forkHash: null, token: null });
      vs.push(v); oracle.set(v.toString('hex'), []); writer.set(v.toString('hex'), wr);
    }
    const watchAcks = (): void => { for (const d of NAMES) for (const v of vs) for (const a of world.devs[d].rep.peerAcks(v)) { const holder = NAMES.find((n) => world.ids[n].deviceId.toString('hex') === a.holder); if (holder) acked.push({ holder, v, lines: a.lines }); } };
    const setNoise = (on: boolean): void => {
      noisy = on;
      world.hub.holdFilter = on ? () => { const r = rand(); return r < 0.15 ? 'drop' : r < 0.25 ? 'dup' : 'store'; } : null;
      for (const n of NAMES) world.devs[n].carrier.passFilter = on ? () => { const r = rand(); return r < 0.15 ? 'drop' : r < 0.25 ? 'dup' : r < 0.5 ? Math.floor(rand() * 20) : 'deliver'; } : null;
    };
    for (let s = 0; s < steps; s++) {
      const r = rand() * 100;
      if (r < 34) { // the writer appends one to four lines
        const v = pick(vs); const wr = writer.get(v.toString('hex')) as string;
        const ls = lineSet(1 + Math.floor(rand() * 4), `s${seed}-${counter++}`, oracle.get(v.toString('hex'))?.length ?? 0);
        await world.devs[wr].rep.appendLocal(v, ls).then(() => oracle.get(v.toString('hex'))?.push(...ls), (e) => { if (!/refilling/.test(String(e))) throw e; });
        note('append');
      } else if (r < 42) { const d = pick(NAMES); if (online.has(d)) { world.devs[d].carrier.setOnline(false); online.delete(d); } else { world.devs[d].carrier.setOnline(true); online.add(d); } note('toggle-link'); }
      else if (r < 48) { const d = pick(NAMES); await world.restart(d, { graceful: rand() < 0.5 }); if (!online.has(d)) world.devs[d].carrier.setOnline(false); note('restart'); }
      else if (r < 64) { await world.elapse(1_000 + Math.floor(rand() * 40_000), 10_000, true); note('elapse'); }
      else if (r < 68) { setNoise(!noisy); note('noise'); }
      else if (r < 71) { world.hub.releaseThrough(chatGroup(world.setId, CHAT), 1_000_000); note('relay-forgets'); }
      else if (r < 75) { // remember a non-writer's folder
        const v = pick(vs); const d = pick(NAMES.filter((n) => n !== writer.get(v.toString('hex'))));
        const local = await world.localOf(d, v);
        if (local) { const src = nodePath.join(world.dirs[d], 'store', 'versions', local.toString('hex')); const dst = `${world.dirs[d]}-snap-${counter++}`; if (fs.existsSync(src) && local.equals(v)) { world.devs[d].rep.stop(); world.devs[d].link.stop(); await world.devs[d].store.close(); fs.cpSync(src, dst, { recursive: true }); await world.restart(d); snaps.set(`${d}/${v.toString('hex')}`, { dev: d, v, dir: dst }); } }
        note('snapshot');
      } else if (r < 79) { // put it back
        const e = [...snaps.entries()][0];
        if (e) { const [key, sn] = e; snaps.delete(key); const dst = nodePath.join(world.dirs[sn.dev], 'store', 'versions', sn.v.toString('hex')); world.devs[sn.dev].rep.stop(); world.devs[sn.dev].link.stop(); await world.devs[sn.dev].store.close(); if (fs.existsSync(dst)) { fs.rmSync(dst, { recursive: true }); fs.cpSync(sn.dir, dst, { recursive: true }); } await world.restart(sn.dev, { graceful: true }); if (!online.has(sn.dev)) world.devs[sn.dev].carrier.setOnline(false); note('rollback'); }
      } else if (r < 83) { // a rotted byte in a non-writer's copy
        const v = pick(vs); const d = pick(NAMES.filter((n) => n !== writer.get(v.toString('hex'))));
        const local = await world.localOf(d, v);
        if (local && local.equals(v)) {
          const body = nodePath.join(world.dirs[d], 'store', 'versions', v.toString('hex'), 'body-0000000000000000.bin');
          if (fs.existsSync(body) && fs.statSync(body).size > 40) {
            world.devs[d].rep.stop(); world.devs[d].link.stop(); await world.devs[d].store.close();
            const raw = fs.readFileSync(body); raw[Math.floor(rand() * (raw.length - 1))] ^= 0xff; fs.writeFileSync(body, raw);
            const dev = await world.restart(d, { graceful: true });
            // what a reader (a screen, an adapter) does: read the lines; a `corrupt` answer is reported to the replicator, the only way the store tells damage past its scrub mark
            const hd = await dev.store.head(local);
            if (hd.lines > 0) await dev.store.read(local, 0, 0, hd.lines).catch(async (e: { code?: string }) => { if (e?.code === 'corrupt') await dev.rep.reportCorrupt(v); });
            dev.rep.hello(); if (!online.has(d)) dev.carrier.setOnline(false); note('rot');
          }
        }
      } else if (r < 91) { // a paired device forges, lies and replays
        const liar = pick(NAMES); const v = pick(vs); const dev = world.devs[liar];
        const kind = Math.floor(rand() * 4);
        if (kind === 0) dev.link.sendLive({ group: 'rep.live', kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: [{ version: v, lines: Math.floor(rand() * 500), hash: randomBytes(32), conversationHash: randomBytes(32), stamp: 1, state: 'ok' }] }) });
        else if (kind === 1) dev.link.sendLive({ group: 'rep.live', kind: KIND_NAK, body: nakBodyOf({ version: v, at: Math.floor(rand() * 20), why: pick(['not-a-prefix', 'gap', 'unavailable', 'evicted'] as const), hashAtYourCount: rand() < 0.5 ? randomBytes(32) : null }) });
        else if (kind === 2) { const h = randomBytes(32); dev.link.sendLive({ group: 'rep.live', kind: KIND_ACK, body: ackBodyOf({ version: v, lines: Math.floor(rand() * 50), hash: h, sig: signWith(world.ids[liar], ackMessage(world.ids[liar].deviceId, v, 1, h)) }) }); }
        else { const forged = [line(`forged ${counter++}`, 0)]; const h = chainStep(Buffer.alloc(32, 1), forged[0]); void dev.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, body: linesBody({ version: v, from: Math.floor(rand() * 5), lines: forged, head: { lines: 0, hash: h, sig: signWith(world.ids[liar], headMessage(v, 1, h)) } }) }).catch(() => undefined /* benign (fuzz): the forger is offline; nothing was sent */); }
        note(`forge-${kind}`);
      } else if (r < 94 && !forked) { // one takeover of the first version by B at B's current head
        const v = vs[0]; const local = await world.localOf('B', v);
        if (local) {
          const h = await world.devs.B.store.head(local);
          if (h.lines > 0 && h.lines <= (oracle.get(v.toString('hex'))?.length ?? 0)) {
            const token = `fz-${seed}`; const child = deriveForkId(v, h.lines, h.hash, token);
            await world.devs.B.rep.createVersion({ version: child, chatId: CHAT, runtime: 'claude-code', parent: v, forkLine: h.lines, forkHash: Buffer.from(h.hash, 'hex'), token });
            vs.push(child); oracle.set(child.toString('hex'), (oracle.get(v.toString('hex')) as Buffer[]).slice(0, h.lines)); writer.set(child.toString('hex'), 'B'); forked = true; note('takeover');
          }
        }
      } else { watchAcks(); note('look'); }
      watchAcks();
    }
    // ---- quiescence: noise off, everybody online, time passes until the devices agree (at most a few virtual minutes)
    setNoise(false);
    for (const n of NAMES) { world.devs[n].carrier.passFilter = null; if (!online.has(n)) world.devs[n].carrier.setOnline(true); }
    for (const n of NAMES) world.devs[n].rep.hello();
    for (let round = 0; round < 12; round++) {
      await world.elapse(30_000, 10_000, true);
      // WHY also the status: a rotted copy has the same head as a healthy one; "equal heads" alone would stop waiting before its repair ran
      const agree = await Promise.all(vs.map(async (v) => { const hs = await Promise.all(NAMES.map((n) => world.heads(n, v))); const sts = await Promise.all(NAMES.map((n) => world.devs[n].rep.status(v))); return hs.every((h) => h.hash === hs[0].hash && h.lines === (oracle.get(v.toString('hex'))?.length ?? -1)) && sts.every((x) => x.state !== 'refilling' && x.state !== 'pulling' && x.state !== 'retired-recopy'); }));
      if (agree.every(Boolean)) break;
    }
    await world.settle();
    watchAcks();
    // ---- the promises
    for (const v of vs) {
      const O = oracle.get(v.toString('hex')) as Buffer[];
      for (const n of NAMES) {
        const dev = world.devs[n]; const st = await dev.rep.status(v);
        const local = await world.localOf(n, v);
        if (!local) { if (st.state === 'in-sync') fail(`${n} calls version ${v.toString('hex').slice(0, 6)} in-sync with nothing registered`); continue; }
        const h = await dev.store.head(local);
        if (h.lines > O.length) fail(`${n} holds ${h.lines} lines of ${v.toString('hex').slice(0, 6)}; only ${O.length} were ever appended (P1)`);
        let readable = h.lines; const dmg = Math.min(h.damagedFromLine ?? Infinity, h.rolledBack?.from ?? Infinity, h.partial?.from ?? Infinity);
        if (dmg !== Infinity) readable = Math.min(readable, dmg);
        const got = readable > 0 ? await dev.store.read(local, 0, 0, readable).catch(() => 'unreadable' as const) : [];
        if (got === 'unreadable') { if (st.state === 'in-sync') { let firstBad = -1; for (let i = 0; i < readable; i++) { const r1 = await dev.store.read(local, 0, i, i + 1).catch(() => 'bad'); if (r1 === 'bad') { firstBad = i; break; } } fail(`${n} reads corrupt (first bad line ${firstBad}) but says in-sync (P3/P4) head=${JSON.stringify(h)} counters=${JSON.stringify(dev.rep.counters())}`); }; }
        else if (got !== 'evicted') for (let i = 0; i < readable; i++) if (!got[i].equals(O[i])) fail(`${n} line ${i} of ${v.toString('hex').slice(0, 6)} differs from what the writer appended (P1)`);
        if (st.state === 'in-sync') {
          if (h.lines !== O.length || readable !== h.lines) fail(`${n} says in-sync but holds ${h.lines}/${O.length} lines, readable ${readable} (P2)`);
          if (dmg !== Infinity) fail(`${n} says in-sync while the store reports a refill (P4)`);
        } else {
          const key = `state:${st.state}`; excuses.push(`${n}:${v.toString('hex').slice(0, 6)}:${st.state}:${st.reason ?? ''}`);
          if (!EXCUSE_LIMITS[key] && st.state !== 'stuck') fail(`${n} ends ${st.state} (${st.reason}) with no documented limit that explains it`);
          if (st.state === 'stuck') fail(`${n} ends stuck (${st.reason})`);
        }
        const parked = await dev.store.parkedList(local);
        if (parked.length) fail(`${n} holds ${parked.length} parked peer lines (P4)`);
      }
    }
    for (const a of acked) {
      const dev = world.devs[a.holder]; const st = await dev.rep.status(a.v); const local = await world.localOf(a.holder, a.v);
      const have = local ? (await dev.store.head(local)).lines : 0;
      if (have < a.lines && st.state === 'in-sync') fail(`${a.holder} acknowledged ${a.lines} lines of ${a.v.toString('hex').slice(0, 6)}, holds ${have} and says in-sync (P3)`);
    }
    return { seed, ops, excuses, steps };
  } finally {
    for (const s of snaps.values()) fs.rmSync(s.dir, { recursive: true, force: true });
    await world.stopAll(); world.cleanup();
    void introBodyOf;
  }
}
export type { World };
