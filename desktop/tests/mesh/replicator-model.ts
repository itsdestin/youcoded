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
import { createHash, randomBytes } from 'node:crypto';
import { isSelfForkToken } from '../../src/main/mesh/replicator/selffork';
import { deriveRootId } from '../../src/main/mesh/replicator/directory';
import { repWorld, wireId, lineSet, line, CHAT, type World } from './replicator-world';
import { chatGroup } from '../../src/main/mesh/replicator/ctx';
import { incarnationId } from '../../src/main/mesh/replicator/idmap';
import { chainStep, deriveForkId } from '../../src/main/mesh/store';
import { introMessage, headMessage, headsBodyOf, introBodyOf, KIND_ACK, KIND_HEADS, KIND_INTRO, KIND_LINES, KIND_NAK, linesBody, nakBodyOf, ackBodyOf, ackMessage } from '../../src/main/mesh/replicator/wire';
import { signWith } from '../../src/main/mesh/crypto/identity';

/** Documented store limits (inventory.ts) that may leave a device in a named non-in-sync state at the end of a run. Key = the status reason or state. */
export const EXCUSE_LIMITS: Record<string, string> = {
  'state:diverged': 'a peer\'s unverifiable claim of another history is kept and named (inventory limit 4 / plan invariant 5): never settled by length',
  'state:refilling': 'a rolled-back or rotted copy still repairing when the run ended (inventory rules iii-v): named, never in-sync',
  'state:pulling': 'a request outstanding to a peer that answered nothing (plan: receiver-driven, re-asked on a timer)',
  'state:comparing': 'no peer has said anything about the version since the last restart',
  'state:all-copies-damaged': 'every device that held the lines is itself repairing or retired, so nothing can refill anything (inventory limit 1); loud on every device, never in-sync',
  'state:faulted': 'a hostile announcement of an existing version id contradicted the real one: named, sticky, durable (review 1, F4)',
  'state:stale': 'no peer has spoken in ten virtual minutes (review 1, F7)',
  'state:peer-repairing': 'a peer said it was repairing and has not said otherwise yet (F7)',
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
  const world = await repWorld(NAMES, { discoveryMs: 20_000, stallMs: 8_000, scrubEveryMs: 60_000, bound: true });
  const told = new Set<string>(); const toldBy = new Map<string, string>(); // the ledger: every line the adapter was told `saved` for, and the chat it was told for
  /** second versions made by self-forks, with the chat they came from (the root in `vs`) */
  const kidsOf = (): Array<[Buffer, string]> => {
    const seen = new Map<string, [Buffer, string]>(); const parentOf = new Map<string, string>();
    for (const n of NAMES) for (const f of world.devs[n].rep.selfForks()) parentOf.set(f.movedTo.toString('hex'), f.version.toString('hex'));
    for (const n of NAMES) for (const wv of world.devs[n].rep.versions()) { const d = world.devs[n].rep.describe(wv); if (d?.parent && isSelfForkToken(d.writer, d.token)) parentOf.set(wv.toString('hex'), d.parent.toString('hex')); }
    const rootOf = (hex: string): string => { let h = hex; for (let i = 0; i < 20 && parentOf.has(h); i++) h = parentOf.get(h) as string; return h; };
    for (const [kid] of parentOf) { const root = rootOf(kid); if (vs.some((y) => y.toString('hex') === root)) seen.set(kid, [Buffer.from(kid, 'hex'), root]); }
    return [...seen.values()];
  };
  // ---- review 4 (gap round): schedules that really MAKE self-forks. The writer's whole profile is saved now and then ("wsnap"); later it is put back AFTER the peers hold newer signed lines, chats alone, and meets
  // the peers again ("rollback-meet"). Variants: plain; chatting on in a second version and rolling back again (a second version moved itself); the same backup again; a takeover child already made from V; the
  // move interrupted by a kill and a second rollback before it resumes.
  const wsnaps: Array<{ dev: string; dir: string; lines: Map<string, number> }> = [];
  const rolled = new Set<string>();
  const headLines = async (n: string, v: Buffer): Promise<number> => { const l = await world.localOf(n, v); return l ? (await world.devs[n].store.head(l)).lines : 0; };
  const mineOf = (wr: string): Array<{ v: Buffer; root: string }> => [...vs.filter((v) => writer.get(v.toString('hex')) === wr).map((v) => ({ v, root: v.toString('hex') })), ...kidsOf().filter(([, root]) => writer.get(root) === wr).map(([k, root]) => ({ v: k, root }))];
  const stopDevice = async (d: string): Promise<void> => { await world.devs[d].rep.idle(); world.devs[d].rep.stop(); world.devs[d].link.stop(); await world.devs[d].store.close(); };
  const putBack = async (wr: string, s2: { dir: string }): Promise<void> => {
    await stopDevice(wr);
    for (const k of ['store', 'replicator', 'witness']) { fs.rmSync(nodePath.join(world.dirs[wr], k), { recursive: true, force: true }); if (fs.existsSync(nodePath.join(s2.dir, k))) fs.cpSync(nodePath.join(s2.dir, k), nodePath.join(world.dirs[wr], k), { recursive: true }); }
    const lp = nodePath.join(world.dirs[wr], 'store', 'LOCK'); if (fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ ...JSON.parse(fs.readFileSync(lp, 'utf8')), pid: 2147483646, start: 'dead' }));
    await world.restart(wr, { graceful: false });
  };
  const lostIntro = new Set<string>(); // devices whose replicator folder (with the announcements in it) was put back
  const fsnaps: Array<{ dev: string; dir: string }> = []; // review 2: whole-folder snapshots (store, replicator, witness) of any device
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
  const note = (k: string): void => { ops[k] = (ops[k] ?? 0) + 1; trace.push(k); if (process.env.MESH_REPLICATOR_FUZZ_TRACE) fs.appendFileSync(process.env.MESH_REPLICATOR_FUZZ_TRACE, `seed ${seed} step ${trace.length}: ${k} t=${Date.now() % 1_000_000}\n`); };
  const fail = (msg: string): never => { throw new Error(`replicator fuzz seed ${seed}: ${msg} [ops: ${trace.join(',')}]`); };
  try {
    try {
    for (const [i, wr] of ['A', 'B'].entries()) {
      // review 2, finding 4: a root id is bound to its writer, so a hijacking announcement below can never take effect
      const chatId = i === 0 ? CHAT : `${CHAT}-2`; const nonce = createHash('sha256').update(`fuzz-${seed}-${i}`).digest().subarray(0, 16);
      const v = deriveRootId(world.setId, chatId, world.ids[wr].deviceId, nonce);
      await world.devs[wr].rep.createVersion({ version: v, chatId, runtime: 'claude-code', parent: null, forkLine: null, forkHash: null, token: null, nonce });
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
      const x = rand();
      const rb = rand();
      if (rb < 0.16) {
        const writers = NAMES.filter((n) => vs.some((v) => writer.get(v.toString('hex')) === n) && online.has(n));
        if (!writers.length) { note('rollback-skipped'); }
        else {
          const wr = pick(writers); const mine = mineOf(wr); const have = wsnaps.filter((q) => q.dev === wr);
          if (!have.length || rand() < 0.35) {
            // a profile snapshot of the writer (all three folders), with how many lines of each chat it held
            const dir = `${world.dirs[wr]}-wsnapp-${counter++}`; await stopDevice(wr); fs.mkdirSync(dir, { recursive: true });
            for (const k of ['store', 'replicator', 'witness']) if (fs.existsSync(nodePath.join(world.dirs[wr], k))) fs.cpSync(nodePath.join(world.dirs[wr], k), nodePath.join(dir, k), { recursive: true });
            await world.restart(wr, { graceful: true }); if (!online.has(wr)) world.devs[wr].carrier.setOnline(false);
            const lines = new Map<string, number>(); for (const m of mine) lines.set(m.v.toString('hex'), await headLines(wr, m.v));
            wsnaps.push({ dev: wr, dir, lines }); note('wsnap');
          } else {
            const snapS = pick(have); const lostNow: Array<{ v: Buffer; root: string }> = [];
            for (const m of mine) if ((await headLines(wr, m.v)) > (snapS.lines.get(m.v.toString('hex')) ?? 0)) lostNow.push(m);
            // the lines the restore takes away must be held by an online peer (store limit 4: a copy that exists nowhere is gone, which this oracle cannot express)
            const isSafe = async (): Promise<boolean> => {
              let ok = true;
              for (const m of mineOf(wr)) { const now = await headLines(wr, m.v); if (!NAMES.filter((n) => n !== wr).some((n) => online.has(n)) || !(await Promise.all(NAMES.filter((n) => n !== wr && online.has(n)).map((n) => headLines(n, m.v)))).some((h) => h >= now)) ok = false; }
              return ok;
            };
            const safe = lostNow.length > 0 && (await isSafe());
            if (!safe) note('rollback-skipped');
            else {
              const wasOnline = NAMES.filter((n) => online.has(n)); const variant = pick(['plain', 'again', 'interrupt', 'kid', 'v2'] as const);
              const target = (variant === 'kid' ? lostNow.filter((m) => m.v.toString('hex') !== m.root) : []).concat(lostNow)[0] ?? lostNow[0];
              const toldNow: string[] = [];
              const meet = async (snapUse = snapS, tgt = target): Promise<void> => {
                for (const n of NAMES) if (n !== wr) world.devs[n].carrier.setOnline(false);
                await putBack(wr, snapUse); await world.elapse(8_000, 2_000, true);
                const head = await headLines(wr, tgt.v);
                const ls = lineSet(1 + Math.floor(rand() * 3), `rb${seed}-${counter++}`, head);
                await world.append(wr, tgt.v, ls).then((r) => { ops[`meet-append-${tgt === target ? 'root' : 'v2'}-${r.result}`] = (ops[`meet-append-${tgt === target ? 'root' : 'v2'}-${r.result}`] ?? 0) + 1; if (r.result !== 'saved') return; for (const l of ls) { told.add(l.toString()); toldBy.set(l.toString(), tgt.root); toldNow.push(l.toString()); } rolled.add(tgt.root); }, (e) => { ops[`meet-append-${tgt === target ? 'root' : 'v2'}-threw`] = (ops[`meet-append-${tgt === target ? 'root' : 'v2'}-threw`] ?? 0) + 1; if (!/refilling|version-not-ready|writer-|unknown version|self-fork/.test(String(e))) throw e; });
                for (const n of wasOnline) if (n !== wr) world.devs[n].carrier.setOnline(true);
              };
              await meet();
              // the second rollback of 'interrupt' comes before the lines of the first were copied anywhere: the user's own restore destroys them (held by nobody, store limit 4), so they leave the union check (their
              // text stays "told", a copy elsewhere is still not foreign)
              if (variant === 'interrupt') { await world.elapse(1_500, 500, true); await world.restart(wr, { graceful: false }); await putBack(wr, snapS); for (const l of toldNow) toldBy.delete(l); }
              await world.elapse(150_000, 10_000, true);
              if (variant === 'v2') {
                // chat on in the second version the move made, save the profile, chat once more there, put the saved profile back, chat alone in the second version, meet: the second version moves ITSELF
                const kid = mineOf(wr).find((m) => m.v.toString('hex') !== m.root);
                ops['v2-kid-found'] = (ops['v2-kid-found'] ?? 0) + (kid ? 1 : 0); ops['v2-meet-tried'] = (ops['v2-meet-tried'] ?? 0) + 1;
                if (kid && online.has(wr)) {
                  const dir3 = `${world.dirs[wr]}-wsnapp-${counter++}`; await stopDevice(wr); fs.mkdirSync(dir3, { recursive: true });
                  for (const k of ['store', 'replicator', 'witness']) if (fs.existsSync(nodePath.join(world.dirs[wr], k))) fs.cpSync(nodePath.join(world.dirs[wr], k), nodePath.join(dir3, k), { recursive: true });
                  await world.restart(wr, { graceful: true });
                  const s3 = { dev: wr, dir: dir3, lines: new Map<string, number>() }; wsnaps.push(s3);
                  await world.elapse(8_000, 2_000, true); // WHY: a just-restarted writer refuses until its gate opens; without this wait the "chat" here was refused and nothing ever disagreed
                  const h3 = await headLines(wr, kid.v); const l3 = lineSet(2, `v2a${seed}-${counter++}`, h3);
                  await world.append(wr, kid.v, l3).then((r) => { ops[`v2-chat-${r.result}`] = (ops[`v2-chat-${r.result}`] ?? 0) + 1; if (r.result !== 'saved') return; for (const l of l3) { told.add(l.toString()); toldBy.set(l.toString(), kid.root); } }, (e) => { if (!/refilling|version-not-ready|writer-|unknown version|self-fork/.test(String(e))) throw e; });
                  await world.elapse(60_000, 10_000, true);
                  if (await isSafe()) {
                    await meet(s3, kid); await world.elapse(150_000, 10_000, true);
                    const moved = world.devs[wr].rep.selfForks().some((f) => f.version.equals(kid.v)); const stt = await world.devs[wr].rep.status(kid.v);
                    ops[`v2-after-meet-${moved ? 'moved' : 'notmoved'}-${stt.state}`] = (ops[`v2-after-meet-${moved ? 'moved' : 'notmoved'}-${stt.state}`] ?? 0) + 1;
                    if (process.env.MESH_REPLICATOR_V2DBG && !moved) fs.appendFileSync(process.env.MESH_REPLICATOR_V2DBG, `texts ${JSON.stringify(await Promise.all(NAMES.map(async (n) => { const lc = await world.localOf(n, kid.v); const rd = lc ? await world.devs[n].store.read(lc, 0, 0, (await world.devs[n].store.head(lc)).lines) : null; return Array.isArray(rd) ? rd.map((l: Buffer) => l.toString().slice(0, 14)) : null; })))} s3lines ${JSON.stringify(Array.from(s3.lines))} l3 ${JSON.stringify(l3.map((l) => l.toString().slice(-26)))} peerCounters ${JSON.stringify(NAMES.filter((n) => n !== wr).map((n) => world.devs[n].rep.counters()))} seed ${seed} kid ${kid.v.toString('hex').slice(0, 6)} writerHead ${await headLines(wr, kid.v)} peers ${JSON.stringify(await Promise.all(NAMES.filter((n) => n !== wr).map(async (n) => [n, online.has(n), await headLines(n, kid.v)])))} counters ${JSON.stringify(world.devs[wr].rep.counters())}\n`);
                  } else ops['v2-meet-unsafe'] = (ops['v2-meet-unsafe'] ?? 0) + 1;
                }
              }
              if (variant === 'again' && (await isSafe())) { await meet(); await world.elapse(150_000, 10_000, true); }
              if (!online.has(wr)) world.devs[wr].carrier.setOnline(false);
              note(`rollback-meet-${variant}`);
            }
          }
        }
      } else if (x < 0.12) { // review 2: whole-folder rollbacks of any device, own-record rot and truncation
        const kinds = ['fsnap', 'fsnap', 'restore-store', 'restore-replicator', 'restore-both', 'restore-all', 'rot-own', 'trunc-own', 'trunc-witness'] as const;
        const kind = pick(kinds); const d = pick(NAMES);
        const writesSomething = vs.some((v) => writer.get(v.toString('hex')) === d);
        const stopDev = async (): Promise<void> => { await world.devs[d].rep.idle(); world.devs[d].rep.stop(); world.devs[d].link.stop(); await world.devs[d].store.close(); };
        const files = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => nodePath.join(dir, f)) : []);
        if (kind === 'fsnap') {
          const dir = `${world.dirs[d]}-fsnap-${counter++}`; await stopDev();
          fs.mkdirSync(dir, { recursive: true }); for (const k of ['store', 'replicator', 'witness']) if (fs.existsSync(nodePath.join(world.dirs[d], k))) fs.cpSync(nodePath.join(world.dirs[d], k), nodePath.join(dir, k), { recursive: true });
          await world.restart(d, { graceful: true }); if (!online.has(d)) world.devs[d].carrier.setOnline(false);
          fsnaps.push({ dev: d, dir }); note('fsnap');
        } else if (kind.startsWith('restore')) {
          const e = fsnaps.shift();
          // restoring EVERYTHING of a device that is a writer is the documented limit (store inventory limit 4): the model does not do it
          // a store put back on a WRITER loses lines for good unless an online peer holds every line it ever acknowledged (store limit 4: the model cannot express that loss), so then the model skips it
          let lossless = true;
          if (e && kind !== 'restore-replicator') for (const v of vs) {
            // (writer or not: putting a store back on the LAST device that holds the lines destroys them, store limit 4, which this oracle cannot express)
            const O = oracle.get(v.toString('hex')) as Buffer[]; if (!O.length) continue;
            const held = await Promise.all(NAMES.filter((n) => n !== e.dev).map(async (n) => (online.has(n) ? (await world.heads(n, v)).lines : 0)));
            if (!held.some((n) => n === O.length) || !online.has(e.dev)) lossless = false;
          }
          // (a whole-profile restore of a WRITER is now part of the model: review 3. Lines it re-uses positions of end up in a second version; the oracle below is the ledger of lines told saved)
          if (e && lossless) {
            const parts = kind === 'restore-store' ? ['store'] : kind === 'restore-replicator' ? ['replicator'] : kind === 'restore-both' ? ['store', 'replicator'] : ['store', 'replicator', 'witness'];
            const dd = e.dev; await world.devs[dd].rep.idle(); world.devs[dd].rep.stop(); world.devs[dd].link.stop(); await world.devs[dd].store.close();
            for (const k of parts) { fs.rmSync(nodePath.join(world.dirs[dd], k), { recursive: true, force: true }); if (fs.existsSync(nodePath.join(e.dir, k))) fs.cpSync(nodePath.join(e.dir, k), nodePath.join(world.dirs[dd], k), { recursive: true }); }
            const lp = nodePath.join(world.dirs[dd], 'store', 'LOCK'); if (fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ ...JSON.parse(fs.readFileSync(lp, 'utf8')), pid: 2147483646, start: 'dead' }));
            fs.rmSync(e.dir, { recursive: true, force: true });
            await world.restart(dd, { graceful: false }); if (!online.has(dd)) world.devs[dd].carrier.setOnline(false);
            if (kind !== 'restore-store') lostIntro.add(dd);
            note(kind);
          } else if (e) { fs.rmSync(e.dir, { recursive: true, force: true }); note('restore-skipped'); }
        } else if (writesSomething) {
          await stopDev();
          const targets = kind === 'trunc-witness' ? files(nodePath.join(world.dirs[d], 'witness')) : kind === 'trunc-own' ? files(nodePath.join(world.dirs[d], 'replicator', 'own')) : [...files(nodePath.join(world.dirs[d], 'replicator', 'own')), ...files(nodePath.join(world.dirs[d], 'witness'))];
          for (const f of targets) { const raw = fs.readFileSync(f); if (kind === 'rot-own') { raw[Math.floor(rand() * raw.length)] ^= 0xff; fs.writeFileSync(f, raw); } else fs.writeFileSync(f, raw.subarray(0, 39)); }
          await world.restart(d, { graceful: false }); if (!online.has(d)) world.devs[d].carrier.setOnline(false);
          note(kind);
        }
      } else if (x < 0.15) { // review 3: idle for a long (virtual) time, then chat: the gate must never have expired
        const v = pick(vs); const wr = writer.get(v.toString('hex')) as string;
        await world.elapse((11 + Math.floor(rand() * 30)) * 60_000, 120_000, true);
        const ls = lineSet(1 + Math.floor(rand() * 3), `i${seed}-${counter++}`, oracle.get(v.toString('hex'))?.length ?? 0);
        await world.append(wr, v, ls).then(() => { oracle.get(v.toString('hex'))?.push(...ls); for (const l of ls) { told.add(l.toString()); toldBy.set(l.toString(), v.toString('hex')); } }, (e) => { if (!/refilling|version-not-ready|writer-|unknown version/.test(String(e))) throw e; });
        note('idle-then-chat');
      } else if (x < 0.19) { // review 3: one flipped bit in ANY file the replicator owns (own records, witness, announcements, signed points, faults, self-fork notes)
        const d = pick(NAMES); await world.devs[d].rep.idle(); world.devs[d].rep.stop(); world.devs[d].link.stop(); await world.devs[d].store.close();
        const all: string[] = []; const walk = (dir: string): void => { if (!fs.existsSync(dir)) return; for (const f of fs.readdirSync(dir)) { const pth = nodePath.join(dir, f); if (fs.statSync(pth).isDirectory()) walk(pth); else all.push(pth); } };
        walk(nodePath.join(world.dirs[d], 'replicator')); walk(nodePath.join(world.dirs[d], 'witness'));
        if (all.length) { const f = pick(all); const raw = fs.readFileSync(f); if (raw.length) { raw[Math.floor(rand() * raw.length)] ^= 1 << Math.floor(rand() * 8); fs.writeFileSync(f, raw); } }
        await world.restart(d, { graceful: false }); if (!online.has(d)) world.devs[d].carrier.setOnline(false);
        note('rot-any-file');
      } else if (r < 34 && x >= 0.19 && rand() < 0.2 && kidsOf().length) { // review 4: the writer chats on in a second version too (so a second version can itself be rolled back and moved)
        const [kid, root] = pick(kidsOf()); const wr = writer.get(root) as string;
        const ls = lineSet(1 + Math.floor(rand() * 3), `k${seed}-${counter++}`, 0);
        const head = await world.devs[wr].store.head(await world.local(wr, kid)).catch(() => null);
        if (head) await world.append(wr, kid, ls.map((l, i) => lineSet(1, `k${seed}-${counter}-${i}`, head.lines + i)[0])).then(() => { for (let i = 0; i < ls.length; i++) { const l = lineSet(1, `k${seed}-${counter}-${i}`, head.lines + i)[0]; told.add(l.toString()); toldBy.set(l.toString(), root); } counter++; }, (e) => { if (!/refilling|version-not-ready|writer-|unknown version|self-fork/.test(String(e))) throw e; });
        note('append-second-version');
      } else if (r < 34) { // the writer appends one to four lines
        const v = pick(vs); const wr = writer.get(v.toString('hex')) as string;
        const ls = lineSet(1 + Math.floor(rand() * 4), `s${seed}-${counter++}`, oracle.get(v.toString('hex'))?.length ?? 0);
        await world.append(wr, v, ls).then(() => { oracle.get(v.toString('hex'))?.push(...ls); for (const l of ls) { told.add(l.toString()); toldBy.set(l.toString(), v.toString('hex')); } }, (e) => { if (!/refilling|version-not-ready|writer-|unknown version/.test(String(e))) throw e; });
        note('append');
      } else if (r < 42) { const d = pick(NAMES); if (online.has(d)) { world.devs[d].carrier.setOnline(false); online.delete(d); } else { world.devs[d].carrier.setOnline(true); online.add(d); } note('toggle-link'); }
      else if (r < 48) { const d = pick(NAMES); await world.restart(d, { graceful: rand() < 0.5 }); if (!online.has(d)) world.devs[d].carrier.setOnline(false); note('restart'); }
      else if (r < 64) { await world.elapse(1_000 + Math.floor(rand() * 40_000), 10_000, true); note('elapse'); }
      else if (r < 68) { setNoise(!noisy); note('noise'); }
      else if (r < 71) { world.hub.releaseThrough(chatGroup(world.setId, CHAT), 1_000_000); note('relay-forgets'); }
      else if (r < 75) { // remember a non-writer's folder
        const v = pick(vs); const d = pick(NAMES.filter((n) => n !== writer.get(v.toString('hex'))));
        const local = await world.localOf(d, v);
        if (local) { const src = nodePath.join(world.dirs[d], 'store', 'versions', local.toString('hex')); const dst = `${world.dirs[d]}-snap-${counter++}`; if (fs.existsSync(src) && local.equals(incarnationId(v, 0))) { world.devs[d].rep.stop(); world.devs[d].link.stop(); await world.devs[d].store.close(); fs.cpSync(src, dst, { recursive: true }); await world.restart(d); snaps.set(`${d}/${v.toString('hex')}`, { dev: d, v, dir: dst }); } }
        note('snapshot');
      } else if (r < 79) { // put it back
        const e = [...snaps.entries()][0];
        if (e) { const [key, sn] = e; snaps.delete(key); const dst = nodePath.join(world.dirs[sn.dev], 'store', 'versions', incarnationId(sn.v, 0).toString('hex')); world.devs[sn.dev].rep.stop(); world.devs[sn.dev].link.stop(); await world.devs[sn.dev].store.close(); if (fs.existsSync(dst)) { fs.rmSync(dst, { recursive: true }); fs.cpSync(sn.dir, dst, { recursive: true }); } await world.restart(sn.dev, { graceful: true }); if (!online.has(sn.dev)) world.devs[sn.dev].carrier.setOnline(false); note('rollback'); }
      } else if (r < 83) { // a rotted byte in a non-writer's copy
        const v = pick(vs); const d = pick(NAMES.filter((n) => n !== writer.get(v.toString('hex'))));
        const local = await world.localOf(d, v);
        if (local && local.equals(incarnationId(v, 0))) {
          const body = nodePath.join(world.dirs[d], 'store', 'versions', incarnationId(v, 0).toString('hex'), 'body-0000000000000000.bin');
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
        else if (kind === 2) { const h = randomBytes(32); dev.link.sendLive({ group: 'rep.live', kind: KIND_ACK, body: ackBodyOf({ version: v, lines: Math.floor(rand() * 50), hash: h, round: 0, sig: signWith(world.ids[liar], ackMessage(world.ids[liar].deviceId, v, 1, h)) }) }); }
        else { const forged = [line(`forged ${counter++}`, 0)]; const h = chainStep(Buffer.alloc(32, 1), forged[0]); void dev.link.sendDurable({ group: chatGroup(world.setId, CHAT), kind: KIND_LINES, line: true, body: linesBody({ version: v, from: Math.floor(rand() * 5), lines: forged, head: { lines: 0, hash: h, sig: signWith(world.ids[liar], headMessage(v, 1, h)) } }) }).catch(() => undefined /* benign (fuzz): the forger is offline; nothing was sent */); }
        note(`forge-${kind}`);
      } else if (r < 94 && !forked) { // one takeover of the first version by B at B's current head
        const v = vs[0]; const local = await world.localOf('B', v);
        if (local) {
          const h = await world.devs.B.store.head(local);
          if (h.lines > 0 && h.lines <= (oracle.get(v.toString('hex'))?.length ?? 0)) {
            const token = `${world.ids.B.deviceId.toString('hex')}:fz-${seed}`; const child = deriveForkId(v, h.lines, h.hash, token);
            await world.devs.B.rep.createVersion({ version: child, chatId: CHAT, runtime: 'claude-code', parent: v, forkLine: h.lines, forkHash: Buffer.from(h.hash, 'hex'), token });
            vs.push(child); oracle.set(child.toString('hex'), (oracle.get(v.toString('hex')) as Buffer[]).slice(0, h.lines)); writer.set(child.toString('hex'), 'B'); forked = true; note('takeover');
          }
        }
      } else if (r < 96) { // review 1: the WRITER loses its copy, or its whole store folder is put back; it must recover its own signed lines from peers and never start a second history
        const v = pick(vs); const wr = writer.get(v.toString('hex')) as string;
        const O = oracle.get(v.toString('hex')) as Buffer[];
        const others = NAMES.filter((n) => n !== wr);
        const held = await Promise.all(others.map(async (n) => (await world.heads(n, v)).lines));
        // only when a peer that is online holds every line the writer ever acknowledged: otherwise the lines would be gone for good (store limit 4), which this oracle cannot express
        // (a chat that was rolled back and chatted on has more told lines than `O` counts, so this older op cannot judge whether a peer holds them all: it leaves such a chat alone)
        const safe = !rolled.has(v.toString('hex')) && kidsOf().every(([, root]) => root !== v.toString('hex')) && O.length > 0 && others.some((n, i) => online.has(n) && held[i] === O.length) && online.has(wr);
        if (safe && rand() < 0.5) {
          const local = await world.localOf(wr, v);
          if (local) { await world.devs[wr].store.setAsideDamaged(local).catch(() => undefined /* benign (fuzz): already retired */); await world.devs[wr].rep.reportCorrupt(v); note('writer-retire'); }
        } else if (safe) {
          await world.devs[wr].rep.idle(); world.devs[wr].rep.stop(); world.devs[wr].link.stop(); await world.devs[wr].store.close();
          const root = nodePath.join(world.dirs[wr], 'store'); const snap = `${world.dirs[wr]}-wsnap-${counter++}`;
          fs.cpSync(root, snap, { recursive: true });
          // a few lines more, so the put-back copy is genuinely older than what peers hold
          await world.restart(wr); const extra = lineSet(2, `ws${seed}-${counter++}`, O.length);
          const ok = await world.append(wr, v, extra).then(() => true, (e) => { if (!/refilling|version-not-ready|writer-|unknown version/.test(String(e))) throw e; return false; });
          if (ok) { O.push(...extra); for (const l of extra) { told.add(l.toString()); toldBy.set(l.toString(), v.toString('hex')); } }
          await world.elapse(30_000, 10_000, true);
          // the put-back is only a recoverable fault if an online peer holds every line the writer has acknowledged by now (the extra lines too); otherwise nothing is rolled back
          const heldNow = await Promise.all(others.map(async (n) => (await world.heads(n, v)).lines));
          const covered = others.some((n, i) => online.has(n) && heldNow[i] === O.length) && online.has(wr);
          if (!covered) { fs.rmSync(snap, { recursive: true, force: true }); note('writer-rollback-skipped'); continue; }
          await world.devs[wr].rep.idle(); world.devs[wr].rep.stop(); world.devs[wr].link.stop(); await world.devs[wr].store.close();
          fs.rmSync(root, { recursive: true, force: true }); fs.cpSync(snap, root, { recursive: true }); fs.rmSync(snap, { recursive: true, force: true });
          await world.restart(wr); if (!online.has(wr)) world.devs[wr].carrier.setOnline(false);
          // the first exchange with the peers: the window before it cannot be closed by any device (store limit 4), so the model lets it happen before the next append
          world.devs[wr].rep.hello(); await world.elapse(60_000, 10_000, true);
          note('writer-rollback');
        }
      } else if (r < 98) { // a paired device announces an EXISTING version as its own, to everyone, or floods heads naming thousands of unknown versions
        const liar = pick(NAMES); const v = pick(vs);
        if (rand() < 0.5) {
          const b = { version: v, chatId: 'lie', runtime: 'claude-code' as const, parent: null, forkLine: null, forkHash: null, token: null, writer: world.ids[liar].deviceId };
          world.devs[liar].link.sendLive({ group: 'rep.live', kind: KIND_INTRO, body: introBodyOf({ ...b, sig: signWith(world.ids[liar], introMessage(b)) }) });
          note('intro-conflict');
        } else {
          const entries = Array.from({ length: 2000 }, (_, i) => ({ version: wireId(`flood-${seed}-${counter}-${i}`), lines: 5, hash: Buffer.alloc(32, 1), conversationHash: Buffer.alloc(32), stamp: 0, state: 'ok' as const })); counter++;
          world.devs[liar].link.sendLive({ group: 'rep.live', kind: KIND_HEADS, body: headsBodyOf({ page: 0, of: 1, ask: false, heads: entries }) });
          note('heads-flood');
        }
      } else { watchAcks(); note('look'); }
      // review 1, F5: now and then the writer appends one line above the old 16 MiB read budget (rare: it is slow)
      if (rand() < 0.0006) {
        const v = pick(vs); const wr = writer.get(v.toString('hex')) as string; const O = oracle.get(v.toString('hex')) as Buffer[];
        const big = Buffer.concat([Buffer.from('{"type":"user","message":{"content":"'), Buffer.alloc(17 * 1024 * 1024, 0x62), Buffer.from('"}}\n')]);
        const ok = await world.append(wr, v, [big]).then(() => true, (e) => { if (!/refilling|version-not-ready|writer-|unknown version/.test(String(e))) throw e; return false; });
        if (ok) { O.push(big); told.add(big.toString()); toldBy.set(big.toString(), v.toString('hex')); }
        note('big-line');
      }
      watchAcks();
    }
    // ---- quiescence: noise off, everybody online, time passes until the devices agree (at most a few virtual minutes)
    setNoise(false);
    for (const n of NAMES) { world.devs[n].carrier.passFilter = null; if (!online.has(n)) world.devs[n].carrier.setOnline(true); }
    for (const n of NAMES) world.devs[n].rep.hello();
    for (let round = 0; round < 12; round++) {
      // WHY a reader pass: the store tells damage past its scrub mark only when something READS it, and a restart forgets a damage that was known but not yet repaired.
      // What a screen or an adapter will do (read, and report a `corrupt` answer) is done here for every device and version, every round.
      for (const n of NAMES) for (const v of vs) {
        const dev = world.devs[n]; const local = await world.localOf(n, v);
        if (!local) continue;
        const hd = await dev.store.head(local);
        for (let at = 0; at < hd.lines; at += 64) {
          const bad = await dev.store.read(local, 0, at, Math.min(hd.lines, at + 64)).then(() => false, (e: { code?: string }) => e?.code === 'corrupt');
          if (bad) { await dev.rep.reportCorrupt(v); break; }
        }
      }
      await world.elapse(30_000, 10_000, true);
      world.hub.stored.length = 0; // test-only memory: the hub keeps every sealed frame ever stored (a retransmitted 17 MiB line adds up); nothing here reads it
      // WHY also the status: a rotted copy has the same head as a healthy one; "equal heads" alone would stop waiting before its repair ran
      const agree = await Promise.all(vs.map(async (v) => { const hs = await Promise.all(NAMES.map((n) => world.heads(n, v))); const sts = await Promise.all(NAMES.map((n) => world.devs[n].rep.status(v))); return hs.every((h) => h.hash === hs[0].hash && h.lines === (oracle.get(v.toString('hex'))?.length ?? -1)) && sts.every((x) => x.state !== 'refilling' && x.state !== 'pulling' && x.state !== 'retired-recopy' && x.state !== 'serving'); }));
      if (agree.every(Boolean)) break;
    }
    await world.settle();
    watchAcks();
    // ---- review 3: the ledger of lines told saved, for chats whose writer moved lines into a second version (a self-fork): both versions are checked together
    const forks = new Map<string, Buffer[]>();
    for (const n of NAMES) for (const f of world.devs[n].rep.selfForks()) { const k = f.version.toString('hex'); const arr = forks.get(k) ?? []; if (!arr.some((y) => y.equals(f.movedTo))) arr.push(f.movedTo); forks.set(k, arr); }
    // (the second versions are also found through the announcements every device holds: a move whose note was lost with a restored folder still left its version on the peers)
    for (const n of NAMES) for (const wv of world.devs[n].rep.versions()) { const d = world.devs[n].rep.describe(wv); if (d?.parent && isSelfForkToken(d.writer, d.token)) { const k = d.parent.toString('hex'); const arr = forks.get(k) ?? []; if (!arr.some((y) => y.equals(wv))) arr.push(wv); forks.set(k, arr); } }
    for (const r of rolled) if (!forks.has(r)) forks.set(r, []); // a chat whose writer was rolled back and chatted on is checked by the ledger even when no move was needed
    for (const arr of forks.values()) ops['self-forks-made'] = (ops['self-forks-made'] ?? 0) + arr.length;
    for (const k of forks.keys()) if (!vs.some((y) => y.toString('hex') === k)) ops['self-fork-of-a-second-version'] = (ops['self-fork-of-a-second-version'] ?? 0) + 1;
    const linesOf = async (n: string, v: Buffer): Promise<{ lines: string[]; state: string; reason: string | null } | null> => {
      const local = await world.localOf(n, v); if (!local) return null;
      const st = await world.devs[n].rep.status(v); const h = await world.devs[n].store.head(local);
      const upto = Math.min(h.lines, h.damagedFromLine ?? Infinity, h.rolledBack?.from ?? Infinity, h.partial?.from ?? Infinity);
      const got = upto > 0 ? await world.devs[n].store.read(local, 0, 0, upto).catch(() => 'unreadable' as const) : [];
      return { lines: got === 'unreadable' || got === 'evicted' ? [] : got.map((l) => l.toString()), state: st.state, reason: st.reason };
    };
    for (const [vk, kids] of forks) {
      const V = vs.find((y) => y.toString('hex') === vk); if (!V) continue; // (second versions that were themselves moved are reached through their root)
      const group: Buffer[] = []; const collect = (x: Buffer): void => { group.push(x); for (const c of forks.get(x.toString('hex')) ?? []) collect(c); }; collect(V); void kids;
      const per = new Map<string, Array<{ lines: string[]; state: string; reason: string | null } | null>>();
      for (const n of NAMES) per.set(n, await Promise.all(group.map((gv) => linesOf(n, gv))));
      if (process.env.MESH_REPLICATOR_DUMP) {
        const tagOf = (l: string): string => (l.match(/(\w+-\d+) (\d+)/) ?? ['?'])[0];
        for (const n of NAMES) fs.appendFileSync(process.env.MESH_REPLICATOR_DUMP, `seed ${seed} ${n} statuses ${JSON.stringify(await Promise.all(group.map(async (gv) => world.devs[n].rep.status(gv).then((x) => x.state + '/' + x.reason))))} counters ${JSON.stringify(world.devs[n].rep.counters())} forks ${JSON.stringify(world.devs[n].rep.selfForks().map((f) => [f.version.toString('hex').slice(0, 6), f.from, f.movedTo.toString('hex').slice(0, 6)]))} versions ${JSON.stringify(await Promise.all(group.map(async (gv, gi) => [gv.toString('hex').slice(0, 6), (per.get(n)?.[gi]?.lines ?? []).map(tagOf), per.get(n)?.[gi]?.state])))}\n`);
      }
      group.forEach((gv, gi) => {
        const calm: string[] = [];
        for (const n of NAMES) {
          const r = per.get(n)?.[gi]; if (!r) continue;
          for (const l of r.lines) if (!told.has(l)) fail(`${n} holds a line in ${gv.toString('hex').slice(0, 6)} that nobody was ever told saved for (ledger)`);
          if (r.state === 'in-sync') calm.push(r.lines.join('\n'));
          else if (r.state === 'diverged' && /writer-two-histories/.test(r.reason ?? '')) fail(`${n} still waits for the writer on ${gv.toString('hex').slice(0, 6)} although the writer is back and everything is online`);
        }
        if (new Set(calm).size > 1) fail(`devices that say in-sync differ on ${gv.toString('hex').slice(0, 6)} (ledger)`);
      });
      for (const [line, owner] of toldBy) {
        if (owner !== vk) continue;
        for (const n of NAMES) {
          const rs = per.get(n) ?? []; if (!rs.length || !rs.every((r) => r && r.state === 'in-sync')) continue; // a device in a named state is excused by that state
          if (!rs.some((r) => r?.lines.includes(line))) fail(`a line told saved (${line.slice(-40).replace(/\s+/g, ' ')}) is held by ${n} in neither ${vk.slice(0, 6)} nor its second version (ledger); version #${vs.indexOf(V)}; holders ${JSON.stringify(NAMES.map((x) => [x, group.map((_, gi) => (per.get(x)?.[gi]?.lines.includes(line) ? 1 : 0) + ':' + per.get(x)?.[gi]?.state + ':' + per.get(x)?.[gi]?.lines.length)]))}; group ${group.length}`);
        }
      }
    }
    // ---- the promises
    for (const v of vs) {
      if (forks.has(v.toString('hex'))) continue; // checked above together with its second version
      const O = oracle.get(v.toString('hex')) as Buffer[];
      for (const n of NAMES) {
        const dev = world.devs[n]; const st = await dev.rep.status(v);
        const local = await world.localOf(n, v);
        // status and the store listing are two separate reads: a retire finishing between them (a background step) is not a wrong answer, so only two `in-sync` answers around the listing count
        if (!local) { if (st.state === 'in-sync' && (await dev.rep.status(v)).state === 'in-sync') fail(`${n} calls version ${v.toString('hex').slice(0, 6)} in-sync with nothing registered`); continue; }
        const h = await dev.store.head(local);
        if (h.lines > O.length) fail(`${n} holds ${h.lines} lines of ${v.toString('hex').slice(0, 6)}; only ${O.length} were ever appended (P1)`);
        let readable = h.lines; const dmg = Math.min(h.damagedFromLine ?? Infinity, h.rolledBack?.from ?? Infinity, h.partial?.from ?? Infinity);
        if (dmg !== Infinity) readable = Math.min(readable, dmg);
        const got = readable > 0 ? await dev.store.read(local, 0, 0, readable).catch(() => 'unreadable' as const) : [];
        if (got === 'unreadable') { if (st.state === 'in-sync') { let firstBad = -1; for (let i = 0; i < readable; i++) { const r1 = await dev.store.read(local, 0, i, i + 1).catch(() => 'bad'); if (r1 === 'bad') { firstBad = i; break; } } fail(`${n} reads corrupt (first bad line ${firstBad}) but says in-sync (P3/P4) head=${JSON.stringify(h)} counters=${JSON.stringify(dev.rep.counters())}`); }; }
        else if (got !== 'evicted') for (let i = 0; i < readable; i++) if (!got[i].equals(O[i])) fail(`${n} line ${i} of ${v.toString('hex').slice(0, 6)} (version #${vs.indexOf(v)}, writer ${writer.get(v.toString('hex'))}, oracle ${O.length}, holds ${h.lines}) differs from what the writer appended (P1): got ${got[i].toString().slice(0, 70)} want ${O[i].toString().slice(0, 70)} counters ${JSON.stringify(dev.rep.counters())} incarnations ${(await Promise.all([0, 1, 2, 3].map(async (k) => `${k}:` + (await world.devs[writer.get(v.toString('hex')) as string].store.head(incarnationId(v, k)).then((x) => `${x.lines}L dmg=${x.damagedFromLine} rb=${JSON.stringify(x.rolledBack)}`, (e: { code?: string }) => e.code ?? 'err')))) ).join(' ')}`);
        if (st.state === 'in-sync') {
          if (h.lines !== O.length || readable !== h.lines) fail(`${n} says in-sync but holds ${h.lines}/${O.length} lines, readable ${readable} (P2); version #${vs.indexOf(v)} writer ${writer.get(v.toString('hex'))} holds ${(await Promise.all(NAMES.map(async (x) => `${x}:${(await world.heads(x, v)).lines}/${(await world.devs[x].rep.status(v)).state}`))).join(' ')} peers ${JSON.stringify(dev.rep.peerView(v))} counters ${JSON.stringify(dev.rep.counters())}`);
          if (dmg !== Infinity) fail(`${n} says in-sync while the store reports a refill (P4)`);
        } else {
          // every device that held the lines is itself repairing or retired: all copies were damaged one fault at a time, each fault harmless alone (inventory limit 1: a fault that destroys the ONLY copy destroys it). Loud on every device, never in-sync.
          const others = await Promise.all(NAMES.filter((x) => x !== n).map((x) => world.devs[x].rep.status(v)));
          const allDamaged = (st.state === 'retired-recopy' || st.state === 'refilling') && others.every((x) => ['refilling', 'retired-recopy', 'stuck', 'faulted', 'peer-repairing'].includes(x.state));
          // a replicator folder put back forgets announcements it never passed on: the device says `unknown` (named), never anything calmer; the peers that know the version teach it again when they are heard
          if (st.state === 'unknown' && lostIntro.has(n)) { excuses.push(`${n}:limit:announcement-lost-with-the-replicator-folder`); continue; }
          const key = allDamaged ? 'state:all-copies-damaged' : `state:${st.state}`; excuses.push(`${n}:${v.toString('hex').slice(0, 6)}:${st.state}:${st.reason ?? ''}`);
          if (!EXCUSE_LIMITS[key] && st.state !== 'stuck') fail(`${n} ends ${st.state} (${st.reason}) with no documented limit that explains it; version #${vs.indexOf(v)} writer ${writer.get(v.toString('hex'))} oracle ${O.length} lines, ${n} holds ${h.lines} (inc ${st.incarnation}) counters ${JSON.stringify(dev.rep.counters())} peers ${JSON.stringify(dev.rep.peerView(v))}`);
          // review 2: both of a writer's own records rotted is a NAMED, loud stop (it cannot tell what it has signed); the model damages them on purpose, so only that exact reason is excused
          if (st.state === 'stuck' && /^own-record/.test(st.reason ?? '') && writer.get(v.toString('hex')) === n) excuses.push(`${n}:limit:own-records-damaged-on-purpose`);
          else if (st.state === 'stuck') fail(`${n} ends stuck (${st.reason})`);
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
    } catch (e) { if (e instanceof Error && !e.message.startsWith('replicator fuzz seed')) throw new Error(`replicator fuzz seed ${seed}: ${e.message} [ops: ${trace.join(',')}]`, { cause: e }); throw e; }
  } finally {
    for (const s of snaps.values()) fs.rmSync(s.dir, { recursive: true, force: true });
    await world.stopAll(); world.cleanup();
    void introBodyOf;
  }
}
export type { World };
