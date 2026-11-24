// The permanent fuzz of the chat store, rewritten for the restructure (a version folder is append-only in history; a takeover is a FORK; a damaged version is RETIRED).
// Synthetic data only, temp folders only.
//
// One sequence = a few "episodes". An episode opens the store (possibly on a shim that kills the process at a random disk operation, or that runs out of space), runs random
// operations on a set of versions, closes (or is killed), then maybe deals ONE FAULT (or a family of older files put back together) to a random file under the root. The store is then
// reopened and checked against a model that knows, for every version, the lines that were ACKNOWLEDGED.
//
// THE ORACLE (strict, with no named excuse except the documented limits of inventory.ts):
//   every acknowledged line of every version is present and byte-identical, or its loss is reported (a typed error, head().damagedFromLine, head().rolledBack, a `damaged` version);
//   no line is ever served that is not the line that was written (including lines past what was acknowledged);
//   a version that never had a file fault (only crashes, a full disk, closes and reopens) is NEVER quarantined, flagged, rolled back or refused: no false alarm;
//   a fault in one version's files never changes another version (a fork is an independent copy);
//   every exception is a typed StoreError.
// The only excuses kept (each is a documented limit, named in the inventory.ts header, and counted in the events):
//   limit-1  `destroyed-single-copy`: a fault destroyed the only copy of some bytes and the store reported it (that IS the promise: reported, never served wrong)
//   limit-2  `evict-exempt`: a line below an eviction has no body here (it is held by a peer); it is served as `evicted`
//   limit-4  `rollback-with-record-lost`: a family of older files put back AND the high-water record (outside the folder) lost or changed too: two faults, a shorter chat cannot be told from a short chat
//
//   fast slice (normal suite): fixed seeds
//   long run (opt-in):  MESH_STORE_FUZZ=from-to  MESH_STORE_FUZZ_OUT=<file>  MESH_STORE_FUZZ_BIG=<every n-th seed uses a 10,000+ line chat>  MESH_STORE_FUZZ_SEEDS=1,2,3 runs exactly those seeds
//   crash-only (opt-in): MESH_STORE_FUZZ_CRASHONLY=1 deals no file fault at all: every check must be perfectly clean
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatStore } from './store';
import { FaultFs, InjectedCrash } from './fault-fs';
import { V, CHAT, rng, tmpRoot } from './testkit';
import { nl } from './fixtures';
import { inventoryRow, inventoryKind } from './inventory';
import { readHw } from './highwater';
import { realFs } from './fsio';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const CHAT2 = 'synthetic:chat-2';
const FAST_SEEDS = Array.from({ length: 300 }, (_, i) => 100 + i);
const OP_KINDS = ['append', 'resend', 'park', 'park-conflict', 'fork-same', 'fork-diff', 'evict', 'restore', 'scrub', 'retire-recopy', 'control', 'extra', 'reopen'];
const FAULT_KINDS = ['flip', 'overwrite', 'truncate', 'truncrec', 'zero', 'zerorange', 'delete', 'older', 'foreign', 'sibling', 'dup'];

function walk(d: string, out: string[] = []): string[] {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p); }
  return out;
}

function makeCanon(r: () => number, tag: string, n: number, small = false): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const pad = 'abcdefghijklmnopqrstuvwxyz'.repeat(8).slice(0, (small ? 40 : 60) + Math.floor(r() * (small ? 40 : 120)));
    if (i % 17 === 5) out.push(nl({ type: 'ai-title', aiTitle: `t ${tag} ${i} ${pad}` }));
    else out.push(nl({ type: i % 2 ? 'assistant' : 'user', uuid: `${tag}-${i}-${sha(Buffer.from(tag + i)).slice(0, 12)}`, message: { role: i % 2 ? 'assistant' : 'user', id: `m${i >> 1}`, stop_reason: i % 2 ? 'end_turn' : null, content: pad } }));
  }
  return out;
}

interface Ver {
  id: Buffer; hex: string; chat: string;
  lines: Buffer[];                 // the intended content: what the version is supposed to hold (acknowledged or not)
  acked: number;                   // lines acknowledged by an `ok` answer
  evicted: number;                 // the highest eviction ever asked for
  retireMaybe: boolean;            // retired by an operation that was killed before it answered: it may or may not have happened
  retired: boolean;                // set aside by the caller or quarantined by the store: its id is never served again
  faulted: boolean;                // a file fault was dealt to this version's files (or its high-water record)
  rollback: boolean;               // a family of older files was put back
  indexFaulted: boolean;           // the index file was faulted
  recordFaulted: boolean;          // the high-water record of this version was faulted
  destroyed: boolean;              // a fault destroyed the only copy of some bytes (limit 1)
  parent: Ver | null; pendingFrom?: number;   // a fork whose answer the caller never got: it exists complete or not at all
  conflicts: { from: number; lines: Buffer[]; ackedAt: number }[];   // parks with OTHER lines than the intended ones: legitimately applied only when the true lines were never acknowledged (a crash lost them first)
  recopyOf?: Ver;                  // a replacement for a retired version: it must be refilled from the retired one's acknowledged lines
}

interface FuzzResult { seed: number; violations: { kind: string; detail: unknown; log: string[] }[]; events: Record<string, number> }

async function runSequence(seed: number, o: { big?: boolean; crashOnly?: boolean } = {}): Promise<FuzzResult> {
  const big = !!o.big; const crashOnly = !!o.crashOnly;
  const r = rng(seed * 7919 + 13);
  const t = await tmpRoot(`fz${seed}-`);
  const root = t.dir;
  const viol: FuzzResult['violations'] = [];
  const events: Record<string, number> = {};
  const ev = (k: string) => { events[k] = (events[k] ?? 0) + 1; };
  const log: string[] = [];
  const O = { chunkBytes: big ? [20_000, 200_000][Math.floor(r() * 2)] : [700, 4000, 16 * 1024 * 1024][Math.floor(r() * 3)] };
  const bad = (kind: string, detail: unknown) => { viol.push({ kind, detail: { seed, ...(detail as object), O }, log: log.slice(-(Number(process.env.MESH_STORE_FUZZ_LOG) || 16)) }); };
  const canonLen = big ? 10_600 : 260;
  let idc = 10; let tagc = 0;
  const mkVer = (id: Buffer, chat: string, lines: Buffer[], parent: Ver | null): Ver => ({ id, hex: id.toString('hex'), chat, lines, acked: 0, evicted: 0, retireMaybe: false, retired: false, faulted: false, rollback: false, indexFaulted: false, recordFaulted: false, destroyed: false, parent, conflicts: [] });
  const root1 = mkVer(V(1), CHAT, makeCanon(r, `s${seed}`, canonLen, big), null);
  const other = mkVer(V(2), CHAT2, makeCanon(rng(seed * 31 + 5), `o${seed}`, 80, true), null);
  const vers: Ver[] = [root1, other];
  const ctlAcked: { chat: string; body: Buffer }[] = []; const extraAcked: Buffer[] = []; const extraWarned = new Set<string>();
  const snaps: Map<string, Buffer>[] = [];
  const verifier = () => true;
  const live = (): Ver[] => vers.filter((v) => !v.retired && v.pendingFrom === undefined && v !== other && !v.recopyOf);
  const byHex = (h: string): Ver | undefined => vers.find((v) => v.hex === h);

  const open = async (fsx?: any): Promise<ChatStore> => {
    const s = await ChatStore.open(root, { chunkBytes: O.chunkBytes, proofVerifier: verifier, fs: fsx });
    for (const v of vers) {
      if (v.parent || v.retired || v.recopyOf) continue;       // forks are created by forkVersion; recopies by the fixup below
      try { await s.registerVersion(v.id, { chatId: v.chat, runtime: 'claude-code' }); }
      catch (e: any) {
        if (e instanceof InjectedCrash) throw e;
        if (e?.code === 'damaged') { if (!v.retired) { v.retired = true; if (!v.faulted) bad('false-quarantine-at-registration', { v: v.hex.slice(0, 4) }); } continue; }
        // a crash in the very first registration leaves ONE meta copy and nothing acknowledged: a fault in it makes the id unusable; the caller starts under a new id (nothing to recopy)
        if (v.acked === 0 && ['corrupt', 'version-conflict'].includes(e?.code)) { v.retired = true; ev('registration-unreadable-before-any-data'); const nv = mkVer(V(idc++), v.chat, v.lines, v.parent); vers.push(nv); continue; }
        await s.close().catch(() => undefined); throw e;
      }
    }
    return s;
  };

  async function reopen(): Promise<ChatStore | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await open(); }
      catch (e: any) {
        if (e instanceof InjectedCrash) throw e;
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

  /** Everything the caller does to a version that was found damaged (or that it set aside): a replacement id, refilled from the acknowledged lines. */
  function planRecopy(v: Ver): void {
    if (vers.some((x) => x.recopyOf === v)) return;
    const nv = mkVer(V(idc++), v.chat, v.lines, null); nv.recopyOf = v; vers.push(nv); ev('recopy-planned');
  }
  async function runRecopies(s: ChatStore): Promise<void> {
    for (const nv of vers.filter((x) => x.recopyOf && !x.retired)) {
      const from = nv.recopyOf!; const want = Math.min(from.acked, nv.lines.length);
      try {
        if (nv.acked === 0) await s.registerVersion(nv.id, { chatId: nv.chat, runtime: 'claude-code' });
        for (let at = (await s.head(nv.id)).lines; at < want; at += 50) { const to = Math.min(want, at + 50); if (await s.append(nv.id, 0, at, nv.lines.slice(at, to)) === 'ok') nv.acked = Math.max(nv.acked, to); }
        if (nv.acked >= want) { nv.recopyOf = undefined; ev('recopied'); }
      } catch (e: any) { if (e instanceof InjectedCrash) throw e; if (!['disk-full', 'damaged', 'corrupt', 'limit'].includes(e?.code)) bad('recopy-threw-other', { code: e?.code }); else if (e?.code === 'damaged') { nv.retired = true; } }
    }
  }

  async function settleForks(s: ChatStore): Promise<void> {
    for (const c of vers.filter((x) => x.pendingFrom !== undefined)) {
      ev('fork-retried');
      try { await s.forkVersion(c.parent!.id, c.pendingFrom!, c.id); c.acked = c.pendingFrom!; c.pendingFrom = undefined; }
      catch (e: any) {
        if (e instanceof InjectedCrash) throw e;
        if (!['damaged', 'corrupt', 'evicted', 'disk-full', 'limit', 'version-conflict', 'unknown-version', 'bad-argument'].includes(e?.code)) bad('fork-threw-other', { code: e?.code, msg: String(e?.message).slice(0, 150) });
        else if (e?.code !== 'disk-full') { log.push(`fork refused ${e?.code}`); ev('fork-refused-' + e?.code); }   // stays pending: the child may still exist complete from before the refusal (check() looks)
      }
    }
  }

  const allowedOpCodes = ['damaged', 'corrupt', 'limit', 'bad-proof', 'evicted', 'parked-full', 'bad-argument', 'disk-full', 'unknown-version', 'version-conflict'];

  async function check(tag: string): Promise<void> {
    const s = await reopen(); if (!s) return;
    const rel = walk(root).map((p) => path.relative(root, p));
    for (const f of rel) if (!inventoryRow(f)) bad('file-not-in-inventory', { tag, file: f });
    let listed: Awaited<ReturnType<ChatStore['listVersions']>> = [];
    try { listed = await s.listVersions(); } catch (e: any) { bad('listVersions-threw', { tag, code: e?.code }); }
    for (const v of vers.slice()) {
      if (v.retired && v.pendingFrom === undefined) {
        // a retired id: never served again, whatever was put back into its folder
        try { await s.head(v.id); if (v.retireMaybe) { v.retired = false; v.retireMaybe = false; ev('retire-did-not-happen'); } else bad('retired-version-served', { tag, v: v.hex.slice(0, 4) }); } catch (e: any) { if (!['damaged', 'unknown-version', 'corrupt'].includes(e?.code)) bad('retired-head-threw-other', { tag, code: e?.code }); }
        continue;
      }
      if (v.recopyOf && v.acked === 0) continue;      // a replacement not filled yet: nothing is acknowledged
      const isChild = v.pendingFrom !== undefined;
      const exists = listed.some((l) => l.version.equals(v.id));
      if (isChild && !exists) { ev('fork-absent'); continue; }
      const ackedNow = isChild ? v.pendingFrom! : v.acked;
      let head: any = null;
      try { head = await s.head(v.id); }
      catch (e: any) {
        const code = e?.code ?? 'error'; ev('head-' + code);
        if (!allowedOpCodes.includes(code)) { bad('head-threw-untyped', { tag, v: v.hex.slice(0, 4), code }); continue; }
        // a refusal is a typed report: allowed only for a version a fault was dealt to (a plain crash, a full disk, a close and a reopen never cost a version)
        if (!v.faulted) bad('false-alarm-version-refused-without-any-fault', { tag, v: v.hex.slice(0, 4), code, msg: String(e?.message).slice(0, 120) });
        if (code === 'damaged') { v.retired = true; if (v !== other && ackedNow > 0) planRecopy(v); ev('quarantined-by-store'); }
        continue;
      }
      if (isChild) { v.acked = v.pendingFrom!; v.pendingFrom = undefined; ev('fork-found-complete'); if (head.lines < v.acked) bad('fork-incomplete', { tag, lines: head.lines, want: v.acked }); }
      // no false alarms: a version nothing was ever done to is never flagged
      if (!v.faulted) {
        if (head.damagedFromLine !== null) bad('false-alarm-flag-without-any-fault', { tag, v: v.hex.slice(0, 4), flagged: head.damagedFromLine });
        if (head.rolledBack) bad('false-alarm-rolled-back-without-any-fault', { tag, v: v.hex.slice(0, 4), rolledBack: head.rolledBack });
        if (head.lines < v.acked) bad('acknowledged-lines-missing-without-any-fault', { tag, v: v.hex.slice(0, 4), lines: head.lines, acked: v.acked });
      }
      if (head.evictedLines > v.evicted) bad('evicted-without-proof', { tag, evictedLines: head.evictedLines, asked: v.evicted });
      const flagged: number | null = head.damagedFromLine;
      // 1. nothing served is wrong, 2. every acknowledged line is served or its loss is reported
      let all: Buffer[] | 'evicted' | null = null;
      try { all = head.lines > head.evictedLines ? await s.read(v.id, 0, head.evictedLines, head.lines) : []; } catch (e: any) { if (e?.code !== 'corrupt') bad('read-threw-other', { tag, code: e?.code }); }
      const lineAt = async (i: number): Promise<Buffer | null | 'evicted'> => {
        if (i < head.evictedLines) return 'evicted';
        if (Array.isArray(all)) return all[i - head.evictedLines];
        try { const g = await s.read(v.id, 0, i, i + 1); return g === 'evicted' ? 'evicted' : (g as Buffer[])[0]; }
        catch (e: any) { if (e?.code !== 'corrupt') bad('read-threw-other', { tag, code: e?.code }); else { ev('read-corrupt'); if (!v.faulted) bad('corrupt-read-without-any-fault', { tag, v: v.hex.slice(0, 4), line: i }); } return null; }
      };
      for (let i = 0; i < head.lines; i++) {
        const g = await lineAt(i);
        if (g === 'evicted') { ev('evict-exempt'); continue; }
        if (g === null) continue;     // typed corrupt: a report
        const won = v.conflicts.find((c) => i >= c.from && i < c.from + c.lines.length && i >= c.ackedAt && g.equals(c.lines[i - c.from]));
        if (won) { ev('conflict-park-won'); continue; }
        if (i >= v.lines.length || !g.equals(v.lines[i])) { bad('WRONG-BYTES-SERVED', { tag, v: v.hex.slice(0, 4), line: i, headLines: head.lines, rollback: v.rollback }); break; }
      }
      for (let i = v.evicted; i < ackedNow; i++) {
        if (i < head.lines) continue;        // served above (or refused with a typed corrupt)
        // the head is shorter than what was acknowledged: the loss must be reported
        if (flagged !== null && flagged <= i) { ev('destroyed-and-reported'); break; }
        if (head.rolledBack && head.rolledBack.from <= i) { ev('rolled-back-and-reported'); break; }
        if (v.rollback && v.recordFaulted) { ev('rollback-with-record-lost'); break; }    // limit 4: two faults
        if (v.rollback && v.indexFaulted && v.evicted > 0) { ev('rollback-then-index-fault-after-eviction'); break; }   // limit 2 on top of a rolled-back folder: the evicted lines' chain values lived only in that index, so the report of the rollback cannot be re-derived (two faults)
        if (v.rollback && i >= ((await readHw(realFs, root, v.hex)).st.value?.count ?? 0) && v.acked - i < 256 + 1) { ev('rollback-to-unrecorded-head'); break; }   // limit 4: the record outside the folder is raised at a clean close and every 256 lines, so a head after its last statement is not known to it (and was never more than 255 lines ahead)
        bad('shrunk-unreported', { tag, v: v.hex.slice(0, 4), line: i, head: head.lines, flagged, rolledBack: head.rolledBack, faulted: v.faulted, rollback: v.rollback });
        break;
      }
      if (head.lines >= ackedNow && v.faulted && flagged === null && !head.rolledBack) { /* the fault cost nothing visible: fine */ }
      try { const rep = await s.verify(v.id); if (!rep.ok && !v.faulted) bad('verify-not-ok-without-any-fault', { tag, v: v.hex.slice(0, 4), rep }); } catch (e: any) { if (!v.faulted) bad('verify-threw-without-any-fault', { tag, code: e?.code }); }
      // a fault in another version's files must not change this one: a version nothing was dealt to is exactly what was written (checked above: no flags, no missing lines)
    }
    // control log and extras: a lost acknowledged entry is REPORTED, a lost extra throws
    for (const chat of new Set(ctlAcked.map((c) => c.chat))) {
      try {
        const got = await s.controlLog(chat); const dmg = await s.controlDamage(chat); const have = new Set(got.map((e) => e.id));
        for (const c of ctlAcked) if (c.chat === chat && !have.has(sha(c.body))) { if (dmg.length === 0) bad('control-entry-missing-no-damage-report', { tag }); else ev('control-entry-damaged-reported'); }
        for (const e of got) { const a = ctlAcked.find((c) => sha(c.body) === e.id); if (a && !Buffer.from(e.body).equals(a.body)) bad('control-WRONG-BYTES', { tag }); }
      } catch (e: any) { ev('control-throw-' + e?.code); if (e?.code !== 'damaged') bad('control-threw', { tag, code: e?.code }); }
    }
    for (const b of extraAcked) {
      try { const g = await s.readExtra(sha(b)); if (g === null) { if (!extraWarned.has(sha(b))) bad('extra-absent-without-report', { tag }); } else if (!g.equals(b)) bad('WRONG-EXTRA-SERVED', { tag }); }
      catch (e: any) { ev('extra-throw-' + e?.code); if (e?.code !== 'corrupt') bad('extra-threw-other', { tag, code: e?.code }); else extraWarned.add(sha(b)); }
    }
    await s.close().catch((e) => { bad('close-failed', { tag, msg: String(e?.message).slice(0, 150) }); });
  }

  /** One operation on one version. */
  async function doOp(s: ChatStore, n: number, full: boolean): Promise<void> {
    const cands = [...live(), ...(r() < 0.1 ? [other] : [])];
    if (!cands.length) return;
    const v = cands[Math.floor(r() * cands.length)];
    const hd = await s.head(v.id).catch(() => null);
    const head = hd?.lines ?? 0;
    const op = r();
    try {
      if (op < 0.40) {
        const cnt = 1 + Math.floor(r() * (big ? 1500 : 40)); const from = head;
        if (from + cnt > v.lines.length) return;
        ev('append'); log.push(`ep${n} append ${v.hex.slice(0, 4)} ${from}+${cnt}`);
        if (await s.append(v.id, 0, from, v.lines.slice(from, from + cnt)) === 'ok') v.acked = Math.max(v.acked, from + cnt);
      } else if (op < 0.48) {
        const back = Math.min(head, 1 + Math.floor(r() * 5)); const cnt = back + Math.floor(r() * 5);
        if (head - back + cnt > v.lines.length || head === 0) return;
        ev('resend'); log.push(`ep${n} resend ${v.hex.slice(0, 4)} ${head - back}+${cnt}`);
        if (await s.append(v.id, 0, head - back, v.lines.slice(head - back, head - back + cnt)) === 'ok') v.acked = Math.max(v.acked, head - back + cnt);
      } else if (op < 0.58) {
        // a park, aimed to land exactly where the head will be; sometimes with OTHER lines (a conflicting park: it must be rejected, never applied)
        const from = head + 2 + Math.floor(r() * 8); const cnt = 1 + Math.floor(r() * 5);
        if (from + cnt > v.lines.length) return;
        const conflict = r() < 0.2;
        const lines = conflict ? makeCanon(rng(seed * 13 + tagc++), `x${seed}`, cnt, true) : v.lines.slice(from, from + cnt);
        ev(conflict ? 'park-conflict' : 'park'); log.push(`ep${n} park ${v.hex.slice(0, 4)} ${from}+${cnt}${conflict ? ' conflict' : ''}`);
        if (conflict) v.conflicts.push({ from, lines, ackedAt: v.acked });
        await s.append(v.id, 0, from, lines);
      } else if (op < 0.70) {
        if (v === other || v.acked < 2) return;
        const from = 1 + Math.floor(r() * v.acked);
        const diff = r() < 0.6;
        const child = mkVer(V(idc++), v.chat, diff ? [...v.lines.slice(0, from), ...makeCanon(rng(seed * 17 + tagc++), `f${seed}`, canonLen, big).slice(from)] : v.lines, v);
        child.pendingFrom = from; vers.push(child);       // pending until the call answers; a crash leaves it pending for the retry
        ev(diff ? 'fork-diff' : 'fork-same'); log.push(`ep${n} fork ${v.hex.slice(0, 4)} at ${from} ${diff ? 'diff' : 'same'}`);
        const res = await s.forkVersion(v.id, from, child.id);
        child.acked = from; child.pendingFrom = undefined;
        if (res.lines !== from) bad('fork-answer-wrong', { lines: res.lines, from });
      } else if (op < 0.76) {
        if (head < 3 || v === other) return;
        const through = 1 + Math.floor(r() * head);
        ev('evict'); log.push(`ep${n} evict ${v.hex.slice(0, 4)} ${through}`);
        const h = await s.hashAt(v.id, 0, through); v.evicted = Math.max(v.evicted, through);
        await s.evictBody(v.id, { kind: 'holders-confirmed', version: v.hex, through, hash: h!, acks: [{ holder: 'p', version: v.hex, lines: through, hash: h!, signature: 's' }] } as any);
      } else if (op < 0.80) {
        const ee = hd?.evictedLines ?? 0; if (!ee) return;
        ev('restore'); log.push(`ep${n} restore ${v.hex.slice(0, 4)}`);
        await s.restoreBody(v.id, v.lines.slice(0, ee));
      } else if (op < 0.85) {
        ev('scrub'); await s.scrubStep(v.id, { maxBytes: 1 << 20 });
      } else if (op < 0.89) {
        if (v === other || v.acked < 1) return;
        ev('retire-recopy'); log.push(`ep${n} retire ${v.hex.slice(0, 4)}`);
        v.retired = true; planRecopy(v);      // marked BEFORE the call: a crash inside it may already have retired the id
        v.retireMaybe = true; await s.setAsideDamaged(v.id); v.retireMaybe = false;
      } else if (op < 0.95) {
        const cchat = r() < 0.3 ? CHAT2 : CHAT; const mine = ctlAcked.filter((c) => c.chat === cchat);
        const body = Buffer.from(`ctl-${seed}-${ctlAcked.length}-${Math.floor(r() * 1e9)}-${'q'.repeat(30 + Math.floor(r() * 80))}`);
        const seen = mine.length && r() < 0.8 ? [sha(mine[mine.length - 1].body)] : [];
        ev('control'); if (await s.appendControl({ id: sha(body), chat: cchat, seen, body }) === 'ok') ctlAcked.push({ chat: cchat, body });
      } else {
        const b = Buffer.from(`extra-${seed}-${extraAcked.length}-${'e'.repeat(40 + Math.floor(r() * 60))}`);
        ev('extra'); await s.putExtra(sha(b), b); extraAcked.push(b);
      }
    } catch (e: any) {
      if (e instanceof InjectedCrash) throw e;
      ev('op-throw-' + e?.code); log.push(`op threw ${e?.code}`);
      if (!allowedOpCodes.includes(e?.code)) bad('op-threw-unexpected', { code: e?.code, msg: String(e?.message).slice(0, 200) });
      else if (e?.code === 'disk-full' && !full) bad('disk-full-without-a-full-disk', {});
      else if (e?.code === 'damaged' && !v.faulted && !v.retired) bad('false-alarm-op-refused-damaged', { v: v.hex.slice(0, 4) });
      else if (['corrupt', 'unknown-version'].includes(e?.code) && !v.faulted) bad('false-alarm-op-threw-' + e?.code, { v: v.hex.slice(0, 4), msg: String(e?.message).slice(0, 120) });
    }
  }

  async function episode(n: number): Promise<void> {
    const crash = r() < 0.55;
    const failAt = 1 + Math.floor(r() * 80);
    const shadow = crash && r() < 0.4 ? (await tmpRoot(`fzs${seed}-`)) : undefined;
    const full = !crash && r() < 0.1;
    const ffs = crash ? new FaultFs(failAt, { tear: r() < 0.6, powerLoss: r() < 0.6, shadowDir: shadow?.dir, revertOverwrites: r() < 0.5, revertInPlace: r() < 0.5, reorder: !big && r() < 0.4 ? r : undefined })
      : full ? new FaultFs(0, { tear: r() < 0.5, enospcFrom: 1 + Math.floor(r() * 40) }) : undefined;
    let s: ChatStore | null = null; let crashed = false;
    try {
      s = await open(ffs); ev('reopen');
      await settleForks(s); await runRecopies(s);
      const nops = 2 + Math.floor(r() * 6);
      for (let k = 0; k < nops; k++) {
        await doOp(s, n, full);
        if (process.env.MESH_STORE_FUZZ_TRACE) for (const v of live()) { const h2 = await s.head(v.id).catch(() => null); const pd = path.join(root, 'versions', v.hex); const hwv = (await readHw(realFs, root, v.hex)).st.value; log.push(`   ${v.hex.slice(0, 4)} head ${h2?.lines} flagged ${h2?.damagedFromLine} rb ${JSON.stringify(h2?.rolledBack)} hw ${hwv?.count}/${hwv?.ladder.map((x) => x[0]).join('.')} parked [${fs.existsSync(path.join(pd, 'parked')) ? fs.readdirSync(path.join(pd, 'parked')).map((x) => parseInt(x.slice(0, 16), 10)).join(',') : ''}] rejected [${fs.existsSync(path.join(pd, 'rejected')) ? fs.readdirSync(path.join(pd, 'rejected')).map((x) => x.replace(/-[0-9a-f]{16}\.park/, '')).join(',') : ''}]`); }
      }
    } catch (e: any) {
      if (e instanceof InjectedCrash) crashed = true;
      else { ev('episode-throw-' + e?.code); log.push(`episode threw ${e?.code}`); if (!allowedOpCodes.includes(e?.code) && !['store-locked', 'store-locked-stale?'].includes(e?.code)) bad('episode-threw-untyped', { code: e?.code, msg: String(e?.message).slice(0, 200) }); }
    }
    let closedOk = false;
    if (!crashed && s) { try { await s.close(); s = null; closedOk = true; } catch (e: any) { if (e instanceof InjectedCrash) crashed = true; else { ev('episode-close-failed-' + e?.code); if (!full || e?.code !== 'disk-full') bad('close-threw', { code: e?.code, msg: String(e?.message).slice(0, 160) }); } } }
    if (crashed && ffs) {
      await ffs.applyPowerLoss();
      const lp = path.join(root, 'LOCK');
      if (fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ ...JSON.parse(fs.readFileSync(lp, 'utf8')), pid: 2147483646, start: 'dead' }));
      ev('crash');
    }
    if (shadow) await shadow.cleanup();
    // A snapshot of the whole folder as it is NOW, only after a clean close (the high-water record is raised there): the source of every "older copy" fault in later episodes
    const takeSnap = (): Map<string, Buffer> => { const m = new Map<string, Buffer>(); for (const p of walk(root)) { const rel = path.relative(root, p); if (!/^LOCK/.test(rel)) m.set(rel, fs.readFileSync(p)); } return m; };
    const cleanClose = closedOk && !full;
    if (!crashOnly) dealFaults(n, cleanClose);
    if (!crashOnly && cleanClose && r() < 0.6) { snaps.push(takeSnap()); if (snaps.length > 3) snaps.shift(); }
    await check(`after ep${n}`);
  }

  /** The version a file belongs to, or null (control, extras, FORMAT, LOCK). */
  const ownerOf = (rel: string): Ver | null => { const m = /^(?:versions\/([0-9a-f]+)\/|aside\/([0-9a-f]+)-q?\d+\/|highwater\/([0-9a-f]+)\.hw$|forks\/([0-9a-f]+)\/)/.exec(rel); const h = m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : undefined; return h ? byHex(h) ?? null : null; };

  function dealFaults(n: number, cleanClose: boolean): void {
    void cleanClose;
    // A FAMILY of older files of ONE version put back together (index / checkpoint / bodies, in pairs and triples), or the whole version folder: a restore tool at work
    if (snaps.length && r() < 0.18) {
      const sn = snaps[Math.floor(r() * snaps.length)];
      const cands = live().filter((v) => [...sn.keys()].some((p) => p.startsWith(`versions/${v.hex}/`)));
      if (cands.length) {
        const v = cands[Math.floor(r() * cands.length)]; const pre = `versions/${v.hex}/`;
        const FAMS: Record<string, (n: string) => boolean> = {
          'index+body': (x) => /^(index\.bin|body-[0-9a-f]{16}\.bin)$/.test(x), 'ck+body': (x) => /^(checkpoint\.bin|body-[0-9a-f]{16}\.bin)$/.test(x), 'index+ck': (x) => /^(index\.bin|checkpoint\.bin)$/.test(x),
          'index+ck+body': (x) => /^(index\.bin|checkpoint\.bin|body-[0-9a-f]{16}\.bin)$/.test(x), 'whole-folder': () => true,
        };
        const fams = Object.keys(FAMS); const fam = fams[Math.floor(r() * fams.length)]; const pred = FAMS[fam];
        const here = walk(root).map((p) => path.relative(root, p)).filter((p) => p.startsWith(pre) && pred(p.slice(pre.length)));
        const then = [...sn.keys()].filter((p) => p.startsWith(pre) && pred(p.slice(pre.length)));
        const changed = [...new Set([...here, ...then])].filter((p) => { const cur = fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p)) : null; const old = sn.get(p) ?? null; return !(cur === null && old === null) && !(cur && old && cur.equals(old)); });
        if (changed.length) {
          for (const p of changed) { const old = sn.get(p); if (old === undefined) fs.unlinkSync(path.join(root, p)); else { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), old); } }
          v.faulted = true; v.rollback = true; if (fam.includes('body') || fam === 'whole-folder') v.destroyed = true;
          log.push(`FAMILY ${fam} on ${v.hex.slice(0, 4)} (${changed.length} files)`); ev('fault'); ev('fault-family-' + fam);
          return;
        }
      }
    }
    if (r() >= 0.4) return;
    const pool = walk(root).filter((p) => !p.endsWith('LOCK'));
    if (!pool.length) return;
    const crit = pool.filter((p) => /index\.bin$|body-|checkpoint\.bin|log\.bin|anchor\.json|manifest\.bin|extras\/|retired\.json|marks\.bin|parked\/|highwater\//.test(p));
    const from = r() < 0.7 && crit.length ? crit : pool;
    const f = from[Math.floor(r() * from.length)]; const rel = path.relative(root, f);
    const b = fs.readFileSync(f); const pos = Math.floor(r() * Math.max(1, b.length));
    const kind = b.length === 0 ? 'flip' : FAULT_KINDS[Math.floor(r() * FAULT_KINDS.length)];
    const boundaries = (): number[] => {
      const out: number[] = [];
      if (/index\.bin$/.test(rel)) { for (let o = 36; o < b.length; o += 116) out.push(o); }
      else if (/checkpoint\.bin$/.test(rel)) { for (let o = 128; o < b.length; o += 128) out.push(o); }
      else if (/log\.bin$/.test(rel)) { let o = 0; while (o + 16 <= b.length) { out.push(o); o += 16 + b.readUInt32BE(o + 4); if (o > b.length) break; } }
      else if (/manifest\.bin$/.test(rel)) { for (let o = 37; o < b.length; o += 37) out.push(o); }
      else { for (let i = b.indexOf(0x0a); i !== -1; i = b.indexOf(0x0a, i + 1)) out.push(i + 1); }
      return out.filter((o) => o < b.length);
    };
    /** Another file of the same fine inventory kind with other bytes: another version's index, another park, another chunk, another chat's control log */
    const siblingOf = (): string | null => { const k = inventoryKind(rel); if (!k) return null; const c = pool.filter((p) => p !== f && inventoryKind(path.relative(root, p)) === k && !fs.readFileSync(p).equals(b)); return c.length ? c[Math.floor(r() * c.length)] : null; };
    let done = true;
    if (kind === 'flip' && b.length) { b[pos] ^= 1 << Math.floor(r() * 8); fs.writeFileSync(f, b); }
    else if (kind === 'overwrite' && b.length) { b[pos] = (b[pos] + 1 + Math.floor(r() * 255)) & 0xff; fs.writeFileSync(f, b); }
    else if (kind === 'truncate' && b.length > 1) fs.truncateSync(f, Math.floor(r() * (b.length - 1)) + 1 - (pos % 2));
    else if (kind === 'truncrec') { const bs = boundaries(); if (bs.length) fs.truncateSync(f, bs[Math.floor(r() * bs.length)]); else done = false; }
    else if (kind === 'zero') fs.truncateSync(f, 0);
    else if (kind === 'zerorange' && b.length) { b.fill(0, pos, Math.min(b.length, pos + 1 + Math.floor(r() * 300))); fs.writeFileSync(f, b); }
    else if (kind === 'delete') fs.unlinkSync(f);
    else if (kind === 'older') { const sn = snaps.length ? snaps[Math.floor(r() * snaps.length)] : null; const ob = sn ? sn.get(rel) : undefined; if (!sn) done = false; else if (ob === undefined) fs.unlinkSync(f); else if (ob.equals(b)) done = false; else fs.writeFileSync(f, ob); }
    else if (kind === 'foreign' || kind === 'sibling') { const d = siblingOf(); if (d) fs.copyFileSync(d, f); else done = false; }
    else if (kind === 'dup' && b.length) fs.writeFileSync(f, Buffer.concat([b, b.subarray(0, Math.min(b.length, 40))]));
    else done = false;
    if (!done) return;
    const owner = ownerOf(rel);
    if (owner) {
      owner.faulted = true;
      if (!['flip', 'overwrite', 'dup'].includes(kind) && /(^|\/)(body-[0-9a-f]{16}\.bin|parked\/|rejected\/|healed\/)/.test(rel)) owner.destroyed = true;
      if (/^highwater\//.test(rel)) owner.recordFaulted = true;
      if (/index\.bin$|replaced-index\//.test(rel)) owner.indexFaulted = true;
      if (kind === 'older' && /index\.bin$|checkpoint\.bin$|body-/.test(rel)) owner.rollback = true;
    }
    log.push(`FAULT ${kind} ${rel}@${pos}`); ev('fault'); ev('fault-' + kind); if (owner === null) ev('fault-shared-file');
    void n;
  }

  try {
    const eps = 3 + Math.floor(r() * 5);
    for (let n = 0; n < eps; n++) await episode(n);
  } catch (e: any) { bad('harness-error', { stack: String(e?.stack).slice(0, 500) }); }
  if (viol.length && process.env.MESH_STORE_FUZZ_KEEP) fs.cpSync(root, path.join(process.env.MESH_STORE_FUZZ_KEEP, `seed-${seed}`), { recursive: true });   // for post-mortems
  await t.cleanup();
  return { seed, violations: viol, events };
}

const env = process.env.MESH_STORE_FUZZ;
const explicit = process.env.MESH_STORE_FUZZ_SEEDS ? process.env.MESH_STORE_FUZZ_SEEDS.split(',').map(Number) : null;
const bigEvery = Number(process.env.MESH_STORE_FUZZ_BIG ?? 0);
const crashOnly = !!process.env.MESH_STORE_FUZZ_CRASHONLY;

/** A dead branch went unnoticed for a whole round once (an empty `else if`): every operation kind must really have run, or the run fails. */
function assertCoverage(ev: Record<string, number>, what: string): void {
  const need = crashOnly ? OP_KINDS.filter((k) => !['control'].includes(k)) : [...OP_KINDS, 'crash', 'fault', 'fork-found-complete', ...FAULT_KINDS.map((k) => 'fault-' + k), 'fault-family-index+ck+body', 'fault-family-whole-folder', 'recopied', 'quarantined-by-store'];
  const missing = need.filter((k) => !(ev[k] > 0));
  expect(missing, `${what}: operation or fault kinds that never ran (a dead branch): ${missing.join(', ')}`).toEqual([]);
}

describe('fuzz: crash points x one fault (or a family of older files) in any file x reopen, the invariant checked every time', () => {
  it('fast slice: fixed seeds violate nothing and every operation kind runs', async () => {
    const out: FuzzResult[] = [];
    for (const seed of FAST_SEEDS) out.push(await runSequence(seed));
    out.push(await runSequence(53850, { big: true }));     // a 10,000+ line chat in many body chunks
    const all = out.flatMap((x) => x.violations);
    expect(all.slice(0, 5), JSON.stringify(all.slice(0, 3))).toEqual([]);
    const ev: Record<string, number> = {}; for (const x of out) for (const [k, v] of Object.entries(x.events)) ev[k] = (ev[k] ?? 0) + v;
    assertCoverage(ev, 'fast slice');
  }, 900_000);

  it.skipIf(!env && !explicit)('LONG RUN (opt-in, MESH_STORE_FUZZ=from-to): no sequence violates the invariant, and every operation kind ran', async () => {
    const seeds = explicit ?? (() => { const [a, b] = env!.split('-').map(Number); return Array.from({ length: b - a }, (_, i) => a + i); })();
    const outFile = process.env.MESH_STORE_FUZZ_OUT;
    let badN = 0; const total: Record<string, number> = {};
    for (const seed of seeds) {
      const res = await runSequence(seed, { big: bigEvery > 0 && seed % bigEvery === 0, crashOnly });
      for (const [k, v] of Object.entries(res.events)) total[k] = (total[k] ?? 0) + v;
      if (outFile) fs.appendFileSync(outFile, JSON.stringify({ seed, viol: res.violations.length }) + '\n');
      if (res.violations.length) { badN++; if (outFile) fs.appendFileSync(outFile + '.viol', res.violations.map((v) => JSON.stringify(v)).join('\n') + '\n'); }
    }
    if (outFile) fs.writeFileSync(outFile + '.events.json', JSON.stringify(total, null, 1));
    expect(badN).toBe(0);
    if (seeds.length >= 500) assertCoverage(total, 'long run');
  }, 7 * 24 * 3600 * 1000);
});
