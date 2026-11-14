// The permanent fuzz of the chat store (review 3, class fix A.4). Synthetic data only, temp folders only.
//
// One sequence = a few "episodes". An episode runs random operations (append, park, set a tail aside, evict, restore,
// control append, extras put, scrub, set the version aside) on a store that may be killed at a random disk operation
// (every fault mode of the shim: torn write, power loss, unsynced unlink, overwrite revert, disk full), then ONE FAULT
// is dealt to a random file chosen from EVERYTHING under the root (no exclusions): one flipped bit, one overwritten byte,
// a truncation, a zero-length file or a deleted file. Then the store is reopened and the invariant in store.ts is checked.
//
//   fast slice (normal suite): fixed seeds, incl. every seed review 3 listed for F3 and F4
//   long run (opt-in):  MESH_STORE_FUZZ=from-to  (e.g. 0-50000)  MESH_STORE_FUZZ_OUT=<file>  MESH_STORE_FUZZ_BIG=<every n-th seed uses a 10,000+ line chat>
//                       MESH_STORE_FUZZ_SEEDS=1,2,3 runs exactly those seeds
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from './store';
import { FaultFs, InjectedCrash } from './fault-fs';
import { V, CHAT, refChains, rng, tmpRoot } from './testkit';
import { nl } from './fixtures';
import { inventoryRow } from './inventory';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const key = V(1).toString('hex');

/** Seeds review 3 listed: F3 (crash plus rot in one batch) and F4 (partial.json flip). */
const REVIEW3_SEEDS = [1408, 2127, 2749, 2915, 3397, 3704, 4457, 5814, 7077, 10269, 11063, 13832, 15680, 15746, 17362, 18179, 19890, 20933, 3791, 6895, 13684, 17011];
/** Seeds the long run flagged while this fuzz was being built (2525: a checkpoint fault found at open but not repaired; the others: a read on a full disk after an interrupted set-aside). Fixed, kept as regressions. */
const REGRESSION_SEEDS = [2525, 9314, 9705, 58575, 58636];
const FAST_SEEDS = [...REVIEW3_SEEDS, ...REGRESSION_SEEDS, ...Array.from({ length: 70 }, (_, i) => 100 + i)];

function walk(d: string, out: string[] = []): string[] {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p); }
  return out;
}

function makeCanon(r: () => number, seed: number, big: boolean): Buffer[] {
  const out: Buffer[] = [];
  const n = big ? 10_300 + Math.floor(r() * 900) : 260;
  for (let i = 0; i < n; i++) {
    const pad = 'abcdefghijklmnopqrstuvwxyz'.repeat(8).slice(0, (big ? 40 : 60) + Math.floor(r() * (big ? 40 : 120)));
    if (i % 17 === 5) out.push(nl({ type: 'ai-title', aiTitle: `t ${seed} ${i} ${pad}` }));
    else out.push(nl({ type: i % 2 ? 'assistant' : 'user', uuid: `s${seed}-${i}-${sha(Buffer.from(String(i + seed))).slice(0, 12)}`, message: { role: i % 2 ? 'assistant' : 'user', id: `m${i >> 1}`, stop_reason: i % 2 ? 'end_turn' : null, content: pad } }));
  }
  return out;
}

/** Files whose bytes exist nowhere else: a fault in one DESTROYS those bytes (the store can only report it). */
const SINGLE_COPY = /(^|\/)(body-[0-9a-f]{16}\.bin|torn\/\d{6}-body|healed\/|tails\/|parked\/|rejected\/|extras\/|extras-bad\/|control\/)/;

interface FuzzResult { seed: number; violations: { kind: string; detail: unknown; log: string[] }[]; events: Record<string, number> }

async function runSequence(seed: number, o: { legacy?: boolean; big?: boolean } = {}): Promise<FuzzResult> {
  const legacy = !!o.legacy; const big = !!o.big;
  const r = rng(seed * 7919 + 13);
  const canon = makeCanon(r, seed, big);
  const ref = refChains(canon);
  const t = await tmpRoot(`fz${seed}-`);
  const root = t.dir;
  const viol: FuzzResult['violations'] = [];
  const events: Record<string, number> = {};
  const ev = (k: string) => { events[k] = (events[k] ?? 0) + 1; };
  const log: string[] = [];
  const O = {
    chunkBytes: big ? [20_000, 200_000][Math.floor(r() * 2)] : [700, 4000, 16 * 1024 * 1024][Math.floor(r() * 3)],
    checkpointEvery: [32, 32, 8][Math.floor(r() * 3)],
  };
  let ackedMax = 0, exemptFrom = Infinity, rotted = false, lossy = false;
  const parkedAcked: { from: number; n: number }[] = [];
  const ctlAcked: Buffer[] = []; const extraAcked: Buffer[] = [];
  let evictedAny = false; let evictedMax = 0; let controlHit = false; let extrasHit = false;
  const verifier = () => true;
  const open = async (fsx?: any) => {
    const s = await ChatStore.open(root, { chunkBytes: O.chunkBytes, proofVerifier: verifier, fs: fsx });
    try { await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); }
    catch (e: any) {
      // A crash in the middle of the very first registration leaves ONE meta copy (nothing is acknowledged yet); a fault in that copy is two faults.
      // The documented remedy for a version whose registration is unreadable is setAsideDamaged, then register again. Only allowed while nothing was acknowledged.
      if (e?.code === 'corrupt' && ackedMax === 0 && ctlAcked.length === 0 && parkedAcked.length === 0) { await s.setAsideDamaged(V(1)); await s.registerVersion(V(1), { chatId: CHAT, runtime: 'claude-code' }); ev('registration-unreadable-before-any-data'); return s; }
      await s.close().catch(() => undefined); throw e;
    }
    return s;
  };
  const bad = (kind: string, detail: unknown) => { viol.push({ kind, detail: { seed, ...(detail as object), O }, log: log.slice(-14) }); };
  // WHY: a fault in a single-copy file can destroy the bytes of a line. The line is then allowed to be absent, but only when reported.
  const present = (needle: Buffer, files: Buffer[]): boolean => {
    if (files.some((f) => f.includes(needle))) return true;
    if (!rotted || needle.length < 82) return false;       // first and last 40 bytes must not overlap, so one rotted byte cannot spoil both
    const a = needle.subarray(0, 40), b = needle.subarray(needle.length - 40);
    return files.some((f) => f.includes(a)) || files.some((f) => f.includes(b));
  };

  async function reopen(): Promise<ChatStore | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await open(); }
      catch (e: any) {
        // a rotted LOCK file reads as "unreadable and recent": the store refuses for 30 s and then takes it over. Model the wait.
        if ((e?.code === 'store-locked' || e?.code === 'store-locked-stale?') && fs.existsSync(path.join(root, 'LOCK')) && attempt === 0) {
          const old = new Date(Date.now() - 120_000); fs.utimesSync(path.join(root, 'LOCK'), old, old);
          if (e?.code === 'store-locked-stale?') { try { await ChatStore.open(root, { breakLockToken: e.evidence?.breakLockToken }).then((s) => s.close()); } catch { /* retry below reports it */ } }
          ev('lock-wait'); continue;
        }
        bad('open-failed', { code: e?.code, msg: String(e?.message).slice(0, 200) });
        return null;
      }
    }
    return null;
  }

  async function check(tag: string): Promise<void> {
    const s = await reopen(); if (!s) return;
    const rel = walk(root).map((p) => path.relative(root, p));
    for (const f of rel) if (!inventoryRow(f)) bad('file-not-in-inventory', { tag, file: f });
    const files = walk(root).map((p) => fs.readFileSync(p));
    let head: any = null; let state = 'ok';
    try { head = await s.head(V(1)); } catch (e: any) { state = e?.code ?? 'error'; ev('head-' + state); log.push(`head threw ${state}`); }
    if (head) {
      if (head.hash !== ref.raw[head.lines]) bad('head-diverged-from-canonical', { tag, lines: head.lines, damagedFromLine: head.damagedFromLine });
      const flagged: number | null = head.damagedFromLine;
      if (!rotted && !lossy && flagged !== null) bad('false-alarm-without-any-fault', { tag, flagged });
      for (let i = 0; i < ackedMax; i++) {
        if (i < evictedMax) { ev('evict-exempt'); continue; }
        if (i < head.lines) {
          let got: any;
          try { got = await s.read(V(1), 0, i, i + 1); }
          catch (e: any) { ev('read-throw-' + e?.code); if (e?.code !== 'corrupt') bad('read-threw-other', { tag, i, code: e?.code }); else if (!rotted && !lossy) bad('corrupt-read-without-any-fault', { tag, i }); continue; }
          if (got === 'evicted') { ev('read-evicted'); continue; }
          if (!(got as Buffer[])[0].equals(canon[i])) bad('WRONG-BYTES-SERVED', { tag, line: i, headLines: head.lines });
        } else {
          if (i < exemptFrom && flagged === null && !lossy) { bad('shrunk-unreported', { tag, line: i, head: head.lines }); continue; }
          if (!present(canon[i], files)) {
            // destroyed by the fault itself: allowed only when reported
            if (lossy && flagged !== null && flagged <= i) { ev('destroyed-and-reported'); continue; }
            if (i >= exemptFrom && lossy) { ev('destroyed-after-setaside'); continue; }
            bad('line-absent-everywhere', { tag, line: i, head: head.lines, rotted, flagged }); continue;
          }
          ev('absent-but-kept');
        }
      }
      if (head.lines >= ackedMax) exemptFrom = Infinity;
      try { const v = await s.verify(V(1)); if (!v.ok) ev('verify-notok'); } catch { ev('verify-threw'); }
    } else {
      for (let i = evictedMax; i < ackedMax; i++) if (!present(canon[i], files)) { if (lossy) { ev('destroyed-version-unreadable'); break; } bad('line-absent-everywhere(version-unreadable)', { tag, line: i, state, rotted }); break; }
      if (state === 'damaged') { try { await s.setAsideDamaged(V(1)); ev('setaside-after-damaged'); exemptFrom = 0; } catch (e: any) { bad('setAsideDamaged-failed', { tag, code: e?.code }); } }
      else if (state === 'corrupt' && !(rotted || lossy)) bad('unreadable-without-any-fault', { tag, state });
      else ev('unreadable-' + state);
    }
    for (const p of parkedAcked) for (let k = 0; k < p.n; k++) if (p.from + k >= evictedMax && p.from + k >= (head?.lines ?? 0) && !present(canon[p.from + k], files)) { if (!lossy) bad('parked-line-absent', { tag, line: p.from + k }); break; }
    // control log and extras
    try {
      const got = await s.controlLog(CHAT); const dmg = await s.controlDamage(CHAT);
      const have = new Set(got.map((e) => e.id));
      for (const b of ctlAcked) if (!have.has(sha(b))) { if (dmg.length === 0 && !controlHit) bad('control-entry-missing-no-damage-report', { tag, id: sha(b).slice(0, 8) }); else ev('control-entry-damaged-reported'); }
    } catch (e: any) { ev('control-throw-' + e?.code); if (e?.code !== 'damaged') bad('control-threw', { tag, code: e?.code, msg: String(e?.message).slice(0, 120) }); }
    for (const b of extraAcked) {
      try { const g = await s.readExtra(sha(b)); if (g === null) { if (!extrasHit) bad('extra-absent', { tag }); } else if (!g.equals(b)) bad('WRONG-EXTRA-SERVED', { tag }); }
      catch (e: any) { ev('extra-throw-' + e?.code); if (e?.code !== 'corrupt') bad('extra-threw-other', { tag, code: e?.code }); }
    }
    await s.close().catch((e) => { bad('close-failed', { tag, msg: String(e?.message).slice(0, 150) }); });
  }

  async function episode(n: number): Promise<void> {
    const crash = r() < 0.55;
    const failAt = 1 + Math.floor(r() * 60);
    const shadow = crash && r() < 0.4 ? (await tmpRoot(`fzs${seed}-`)) : undefined;
    const full = !legacy && !crash && r() < 0.1;       // a full disk instead of a crash
    const ffs = crash ? new FaultFs(failAt, { tear: r() < 0.6, powerLoss: r() < 0.6, shadowDir: shadow?.dir, revertOverwrites: r() < 0.5 })
      : full ? new FaultFs(0, { tear: r() < 0.5, enospcFrom: 1 + Math.floor(r() * 40) }) : undefined;
    let s: ChatStore | null = null; let crashed = false;
    try {
      s = await open(ffs);
      const nops = 2 + Math.floor(r() * 6);
      for (let k = 0; k < nops; k++) {
        const op = r();
        const hd = await s.head(V(1)).catch(() => null);
        const head = hd?.lines ?? 0;
        try {
          if (op < 0.5) {
            const back = r() < 0.2 ? Math.min(head, Math.floor(r() * 5)) : 0;
            const from = head - back; const cnt = 1 + Math.floor(r() * (big ? 1500 : 40));
            if (from + cnt > canon.length) continue;
            log.push(`ep${n} append ${from}+${cnt}`);
            const res = await s.append(V(1), 0, from, canon.slice(from, from + cnt));
            if (res === 'ok') ackedMax = Math.max(ackedMax, from + cnt); else if (res === 'not-a-prefix') { ev('not-a-prefix'); bad('append-not-a-prefix', { from, head, damagedFromLine: hd?.damagedFromLine }); }
          } else if (op < 0.62) {
            const from = head + 2 + Math.floor(r() * 8); const cnt = 1 + Math.floor(r() * 5);
            if (from + cnt > canon.length) continue;
            log.push(`ep${n} park ${from}+${cnt}`);
            const res = await s.append(V(1), 0, from, canon.slice(from, from + cnt));
            if (res === 'parked') parkedAcked.push({ from, n: cnt });
          } else if (op < 0.70) {
            if (head < 3) continue;
            const from = Math.floor(r() * head);
            log.push(`ep${n} setAsideTail ${from}`);
            exemptFrom = Math.min(exemptFrom, from);
            await s.setAsideTail(r().toString(16).slice(2, 14).padEnd(12, 'a'), V(1), from);
          } else if (op < 0.78) {
            if (head < 3 || !hd) continue;
            const through = 1 + Math.floor(r() * head);
            log.push(`ep${n} evict ${through}`);
            const h = await s.hashAt(V(1), 0, through); evictedMax = Math.max(evictedMax, through);
            await s.evictBody(V(1), { kind: 'holders-confirmed', version: key, through, hash: h!, acks: [{ holder: 'p', version: key, lines: through, hash: h!, signature: 's' }] } as any);
            evictedAny = true;
          } else if (op < 0.84) {
            if (!evictedAny) continue;
            log.push(`ep${n} restore`);
            const ee = hd?.evictedLines ?? 0; if (ee) await s.restoreBody(V(1), canon.slice(0, ee));
          } else if (op < 0.92) {
            const body = Buffer.from(`ctl-${seed}-${ctlAcked.length}-${Math.floor(r() * 1e9)}-${'q'.repeat(30 + Math.floor(r() * 80))}`);
            const seen = ctlAcked.length && r() < 0.8 ? [sha(ctlAcked[ctlAcked.length - 1])] : [];
            log.push(`ep${n} control`);
            const res = await s.appendControl({ id: sha(body), chat: CHAT, seen, body });
            if (res === 'ok') ctlAcked.push(body);
          } else if (op < 0.96) {
            const b = Buffer.from(`extra-${seed}-${extraAcked.length}-${'e'.repeat(40 + Math.floor(r() * 60))}`);
            log.push(`ep${n} extra`);
            await s.putExtra(sha(b), b); extraAcked.push(b);
          } else if (op < 0.985 || legacy) { log.push(`ep${n} scrub`); await s.scrubStep(V(1), { maxBytes: 1 << 20 }); }
          else if (!legacy) { log.push(`ep${n} setAsideDamaged`); exemptFrom = 0; await s.setAsideDamaged(V(1)); }
          // reads must keep working on a full disk (F7): a read that writes something that can fail is a bug. (Repairing a DAMAGED version needs space, so only a version nothing has damaged must always be readable.)
          if (full && ffs?.allocs && ffs.allocs >= 1) { try { await s.head(V(1)); if ((hd?.lines ?? 0) > 0) await s.read(V(1), 0, 0, 1); } catch (e: any) { if (e?.code === 'disk-full' && !rotted && !lossy) bad('read-failed-with-disk-full', { op }); } }
        } catch (e: any) {
          if (e instanceof InjectedCrash) throw e;
          ev('op-throw-' + e?.code); log.push(`op threw ${e?.code}`);
          if (!['damaged', 'corrupt', 'limit', 'bad-proof', 'evicted', 'parked-full', 'bad-argument', 'disk-full'].includes(e?.code)) bad('op-threw-unexpected', { code: e?.code, msg: String(e?.message).slice(0, 200) });
          if (e?.code === 'disk-full' && !full) bad('disk-full-without-a-full-disk', {});
        }
      }
    } catch (e: any) {
      if (e instanceof InjectedCrash) crashed = true;
      else { ev('episode-throw-' + e?.code); log.push(`episode threw ${e?.code}`); }
    }
    if (!crashed && s && ffs) { try { await s.close(); s = null; } catch (e: any) { if (e instanceof InjectedCrash) crashed = true; else { ev('episode-close-failed-' + e?.code); log.push('CLOSEFAIL ' + String(e?.message).slice(0, 120)); if (!full || e?.code !== 'disk-full') bad('close-threw', { code: e?.code, msg: String(e?.message).slice(0, 150) }); } } }
    if (crashed && ffs) {
      await ffs.applyPowerLoss();
      const lp = path.join(root, 'LOCK');
      if (fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ ...JSON.parse(fs.readFileSync(lp, 'utf8')), pid: 2147483646, start: 'dead' }));
      ev('crash');
    } else if (s) { await s.close().catch((e: any) => { ev('episode-close-failed-' + e?.code); log.push('CLOSEFAIL ' + String(e?.message).slice(0, 160)); if (!full || e?.code !== 'disk-full') bad('close-threw', { code: e?.code, msg: String(e?.message).slice(0, 150) }); }); }
    if (shadow) await shadow.cleanup();
    // ONE FAULT in a random file of the whole folder
    if (r() < 0.4) {
      const all = walk(root).filter((p) => fs.statSync(p).size > 0 || !legacy);
      const pool = legacy ? all.filter((p) => !p.endsWith('LOCK') && !/(^|\/)(FORMAT|meta\.json|evicted\.json)$/.test(p) && fs.statSync(p).size > 0) : all;
      if (pool.length) {
        const crit = pool.filter((p) => /index\.bin$|body-|checkpoint\.bin|log\.bin|extras\//.test(p));
        const from = r() < 0.7 && crit.length ? crit : pool;
        const f = from[Math.floor(r() * from.length)];
        const rel = path.relative(root, f);
        const b = fs.readFileSync(f); const pos = Math.floor(r() * Math.max(1, b.length));
        const kind = legacy || b.length === 0 ? 'flip' : ['flip', 'flip', 'overwrite', 'truncate', 'zero', 'delete'][Math.floor(r() * 6)];
        if (kind === 'flip' && b.length) { b[pos] ^= 1 << Math.floor(r() * 8); fs.writeFileSync(f, b); }
        else if (kind === 'overwrite' && b.length) { b[pos] = (b[pos] + 1 + Math.floor(r() * 255)) & 0xff; fs.writeFileSync(f, b); }
        else if (kind === 'truncate' && b.length > 1) fs.truncateSync(f, Math.floor(r() * (b.length - 1)) + 1 - (pos % 2));
        else if (kind === 'zero') fs.truncateSync(f, 0);
        else if (kind === 'delete') fs.unlinkSync(f);
        const destroys = kind === 'truncate' || kind === 'zero' || kind === 'delete';
        rotted = true; if (destroys && SINGLE_COPY.test(rel)) lossy = true;
        if (/control\//.test(rel)) controlHit = true; if (/extras/.test(rel)) extrasHit = true;
        if (/aside\/|torn\/|healed\/|replaced-index\//.test(rel)) ev('rot-in-kept-copy');
        log.push(`FAULT ${kind} ${rel}@${pos}`); ev('rot'); ev('rot-' + kind);
      }
    }
    await check(`after ep${n}`);
  }

  try {
    const eps = 3 + Math.floor(r() * 5);
    for (let n = 0; n < eps; n++) await episode(n);
  } catch (e: any) { bad('harness-error', { stack: String(e?.stack).slice(0, 500) }); }
  await t.cleanup();
  return { seed, violations: viol, events };
}

const env = process.env.MESH_STORE_FUZZ;
const explicit = process.env.MESH_STORE_FUZZ_SEEDS ? process.env.MESH_STORE_FUZZ_SEEDS.split(',').map(Number) : null;
const bigEvery = Number(process.env.MESH_STORE_FUZZ_BIG ?? 0);

describe('fuzz: crash points x one fault in any file x reopen, invariant checked every time', () => {
  it('fast slice: fixed seeds (review 3 F3 and F4 seeds included) violate nothing', async () => {
    const out: FuzzResult[] = [];
    // review 3 seeds run with the reviewer's own generator (bit flips only), so their crash-plus-rot batches recur; every seed also runs with the full fault set
    for (const seed of FAST_SEEDS) {
      out.push(await runSequence(seed, { legacy: REVIEW3_SEEDS.includes(seed) }));
      if (seed < 130 || REVIEW3_SEEDS.includes(seed)) out.push(await runSequence(seed));
    }
    out.push(await runSequence(53850, { big: true }));     // a 10,000+ line chat in many body chunks
    const all = out.flatMap((x) => x.violations);
    expect(all.slice(0, 5), JSON.stringify(all.slice(0, 3))).toEqual([]);
    const ev: Record<string, number> = {}; for (const x of out) for (const [k, v] of Object.entries(x.events)) ev[k] = (ev[k] ?? 0) + v;
    // the slice must actually exercise the hard paths, or it proves nothing
    expect(ev['crash'] ?? 0).toBeGreaterThan(20); expect(ev['rot'] ?? 0).toBeGreaterThan(20);
  }, 600_000);

  it.skipIf(!env && !explicit)('LONG RUN (opt-in, MESH_STORE_FUZZ=from-to): no sequence violates the invariant', async () => {
    const seeds = explicit ?? (() => { const [a, b] = env!.split('-').map(Number); return Array.from({ length: b - a }, (_, i) => a + i); })();
    const outFile = process.env.MESH_STORE_FUZZ_OUT;
    let bad = 0;
    for (const seed of seeds) {
      const res = await runSequence(seed, { big: bigEvery > 0 && seed % bigEvery === 0 });
      if (outFile) fs.appendFileSync(outFile, JSON.stringify({ seed, events: res.events, viol: res.violations.length }) + '\n');
      if (res.violations.length) { bad++; if (outFile) fs.appendFileSync(outFile + '.viol', res.violations.map((v) => JSON.stringify(v)).join('\n') + '\n'); }
    }
    expect(bad).toBe(0);
  }, 7 * 24 * 3600 * 1000);
});
