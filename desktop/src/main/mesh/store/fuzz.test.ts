// The permanent fuzz of the chat store (review 3, class fix A.4). Synthetic data only, temp folders only.
//
// One sequence = a few "episodes". An episode runs random operations (append, park, set a tail aside, evict, restore,
// control append, extras put, scrub, set the version aside) on a store that may be killed at a random disk operation
// (every fault mode of the shim: torn write, power loss, unsynced unlink, overwrite revert, disk full), then ONE FAULT
// is dealt to a random file chosen from EVERYTHING under the root (no exclusions): one flipped bit, one overwritten byte,
// a truncation, a zero-length file or a deleted file. Then the store is reopened and the invariant in store.ts is checked.
//
// Review 5 added three things (store-review-5 was the model):
//   sibling     the file is replaced by ANOTHER file of the same inventory kind (another position, another id, another chunk): the shape that hid parked appends and tails for five rounds
//   rollback    a whole chat folder is put back as it was at an earlier clean close (a backup restore); oracle: every line acknowledged before that close is served or REPORTED
//               (head.damagedFromLine / head.rolledBack), never silent, and nothing under the folder is deleted by the store because of it; a rolledBack report with no rollback is a false alarm
//   reorder     the crash shim lets a random subsequence of each file's unsynced writes survive, independently per file (fault-fs.ts `reorder`), so a later file can survive while an earlier one is lost
// Review 4 widened this to the class "a file that is internally VALID but is the WRONG one" (the checksums cannot see it): besides bad bytes the fault set now has
//   older    the file is replaced by its own copy from an earlier moment of the same run (a restored backup, a rollback)
//   foreign  the file is replaced by the same file of ANOTHER chat (a second version and a second control log live in every folder)
//   truncrec the file is cut at a CLEAN boundary (a record, a slot, a line), so nothing in it fails a checksum
//   zerorange a range of the same size is zeroed
// for EVERY file of the real folder (control log, extras and the small state files included), and nothing is excused except "the only copy of those bytes was
// destroyed, and the store REPORTED it". The oracle also refuses: lines called evicted that no evict ever covered, a control entry or a set-aside tail or an extra
// that is gone without a report, one fault that makes a whole version unreadable (outside the documented limits in inventory.ts), and a fault in the other chat's
// files that changes this chat in any way.
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
import { inventoryRow, inventoryKind } from './inventory';
import { readHw } from './highwater';
import { realFs } from './fsio';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const key = V(1).toString('hex');

/** Seeds review 3 listed: F3 (crash plus rot in one batch) and F4 (partial.json flip). */
const REVIEW3_SEEDS = [1408, 2127, 2749, 2915, 3397, 3704, 4457, 5814, 7077, 10269, 11063, 13832, 15680, 15746, 17362, 18179, 19890, 20933, 3791, 6895, 13684, 17011];
/** Seeds the long run flagged while this fuzz was being built (2525: a checkpoint fault found at open but not repaired; the others: a read on a full disk after an interrupted set-aside). Fixed, kept as regressions. */
const REGRESSION_SEEDS = [2525, 9314, 9705, 58575, 58636,
  // round 7 (found once pair faults, rollbacks after a divergence and the evict branch ran): 705/1169/428/700/382 a pending takeover or older bodies; 1317/3119 an older checkpoint behind a cut-down index;
  // 974/1647/10334 an older index or bodies behind a lowered checkpoint; 2882 a catch-up blessing old content; 9330/3803 a stopped takeover and a bare aside folder; 5380/7893 an identical rewrite
  705, 1169, 428, 700, 382, 1317, 3119, 974, 1647, 10334, 2882, 9330, 3803, 5380, 7893, 1400, 986, 9679];
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

/**
 * Files whose bytes exist nowhere else: a fault in one DESTROYS those bytes. Review 4: the control log and the extras are NOT in this list any more. Their loss is
 * reported too (an independent record: control anchor, extras manifest), so a silent loss there is a failure of the run like any other.
 * (Parked appends are provisional by definition: the caller keeps ownership of those lines until the head passes them.)
 */
const SINGLE_COPY = /(^|\/)(body-[0-9a-f]{16}\.bin|torn\/\d{6}-body|healed\/|tails\/|parked\/|rejected\/|extras-bad\/)/;
const CHAT2 = 'synthetic:chat-2';
const key2 = V(2).toString('hex');

interface FuzzResult { seed: number; violations: { kind: string; detail: unknown; log: string[] }[]; events: Record<string, number> }

async function runSequence(seed: number, o: { legacy?: boolean; big?: boolean } = {}): Promise<FuzzResult> {
  const legacy = !!o.legacy; const big = !!o.big;
  const r = rng(seed * 7919 + 13);
  // WHY `let` (review 6): the history can now DIVERGE. A takeover (setAsideTail) may be followed by a different continuation (`alt`, same shape, other bytes) from the cut on, so `canon` is the history
  // the CURRENT host writes and `ref` its chain values; both are replaced when a takeover is known to have finished. Lines before the cut are common to both histories.
  let canon = makeCanon(r, seed, big);
  let ref = refChains(canon);
  const alt = !legacy && !big ? makeCanon(rng(seed * 17 + 3), seed + 99999, false) : [];
  let firstDiverge = Infinity;                                            // the first line at which any divergent takeover started its new history
  let diverged = false;                                                    // a divergent takeover finished: whole-folder rollbacks of an older state are no longer a clean test (their lines are another history)
  let pending: { id: string; from: number; lines: Buffer[]; diverge: boolean } | null = null;   // a takeover whose answer the caller never got (a crash): it is retried first, like the real caller must
  const canon2 = legacy ? [] : makeCanon(rng(seed * 31 + 5), seed + 7777, false).slice(0, 80);   // the OTHER chat (review 4): the donor of every foreign file
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
  let sameRewriteTakeover = false;                                         // round 7: a takeover with lines to cut finished and the new host continues with byte-identical lines (see the excuse in check())
  let staleIndexInjected = false;                                          // round 7: an OLDER index.bin (single fault, or in a pair) was put back AFTER a divergent takeover, so it may describe the replaced history; cleared when the version is emptied (setAsideDamaged) or the head is canonical again. The excuse below names this cause and is checked against it
  let pairInjected = false;                                                // round 7: a PAIR of older files (index/checkpoint/bodies) was put back after a divergent takeover or a quarantine; cleared like staleIndexInjected
  let lostReported = false;                                                // round 7: head().lostTakeovers was above 0 at some check: the loss of takeover evidence HAS been reported (a later check on a version that is `damaged` cannot read it again)
  let lostTakeoverFault = false;                                           // round 7: a fault or a rollback that can remove takeover evidence (tails/ or a rolled-back folder) was dealt: head().lostTakeovers may then be above 0
  let closedAckedMax = 0; let rollbackDone = false; let hwFaulted = false; let rollbackActive = false;   // a fault hit the high-water record: a rollback on top of it is two faults, and the record can only under-report
     // acknowledged count at the last CLEAN close (the high-water record is raised there); whether a whole-folder rollback was dealt
  let ack2Max = 0; let faultsSinceClean = 0; let faultNote = ''; let faultOnIndexAfterEviction = false;
  const snaps: Map<string, Buffer>[] = [];
  const snapClosed = new Map<Map<string, Buffer>, number>();   // per snapshot: the acknowledged count if the episode ended in a clean close, else -1
  const tailsAcked: { id: string; from: number; lines: Buffer[] }[] = [];
  const tailFaults = new Map<string, number>();   // faults per set-aside id: a tail and its `.done` mark are one pair, and two faults on one pair are not promised
  const extraReportedBad = new Set<string>();   // a rotted extra is reported (`corrupt`) ONCE and then reads as absent until a peer's copy is put: that is a report, not a silent loss
  const parkedAcked: { from: number; n: number; lines: Buffer[] }[] = [];
  const ctlAcked: { chat: string; body: Buffer }[] = []; const extraAcked: Buffer[] = [];
  let evictedAny = false; let evictedMax = 0;
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
    // the other chat; its own faults are its own business (a fault in its files must never change THIS chat: checked below)
    if (!legacy) { try { await s.registerVersion(V(2), { chatId: CHAT2, runtime: 'claude-code' }); } catch { ev('v2-register-failed'); } }
    return s;
  };
  const bad = (kind: string, detail: unknown) => { viol.push({ kind, detail: { seed, ...(detail as object), O }, log: log.slice(-(Number(process.env.MESH_STORE_FUZZ_LOG) || 14)) }); };
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
    if (process.env.MESH_STORE_FUZZ_SNAPDIR) fs.cpSync(root, path.join(process.env.MESH_STORE_FUZZ_SNAPDIR, `seed-${seed}-${tag.replace(/\W+/g, '_')}`), { recursive: true });   // post-mortems: the folder as the store is about to see it
    const s = await reopen(); if (!s) return;
    const rel = walk(root).map((p) => path.relative(root, p));
    for (const f of rel) if (!inventoryRow(f)) bad('file-not-in-inventory', { tag, file: f });
    const files = walk(root).map((p) => fs.readFileSync(p));
    let head: any = null; let state = 'ok'; let verifyOk = true; const nBad0 = viol.length;
    try { head = await s.head(V(1)); } catch (e: any) { state = e?.code ?? 'error'; ev('head-' + state); log.push(`head threw ${state}`); }
    if (head) {
      // WHY the one narrow excuse (review 6): an OLDER index.bin from before a takeover, put into a version that was emptied since (setAsideDamaged), still states the OLD history's head. The store
      // reports every line as damaged from 0 (its bodies are not there), which is at or before the first line where the two histories differ, so a caller refetches from there; and no line is
      // served from it (the read oracle below stays strict). Any head that differs WITHOUT such a report is still a violation.
      // Round 7 (review 7, item 5): the excuse now CHECKS the cause it names: the fault just dealt was an older index.bin (faultNote), the version was emptied after a divergent takeover, and the store flagged damage from 0..first divergence.
      // (`Math.max(firstDiverge, evictedLines)`: lines below the evicted boundary have no body to be flagged, so the first line the store CAN flag is the boundary; the older index's evicted-prefix chain values
      // are the documented limit 2 of inventory.ts, the head hash differs from every peer's, and the flag is raised.)
      const staleIndexCause = diverged && staleIndexInjected;
      // a pair of older files can leave the head on the other history, FLAGGED (the store keeps the version and says from which line it cannot vouch): reported, so not a quiet answer; the read oracle below stays strict
      const pairCause = pairInjected && head.damagedFromLine !== null;
      if (head.lostTakeovers > 0) lostReported = true;
      // Round 7 (F3): a rollback or loss of tails/ across a takeover is REPORTED by head().lostTakeovers (the count outside the folder), which is the promise for that case; the lines served are then not trusted.
      const reportedLostTakeover = head.lostTakeovers > 0 && (rollbackDone || lostTakeoverFault);
      if (head.hash !== ref.raw[head.lines]) { if (diverged && head.damagedFromLine !== null && head.damagedFromLine <= Math.max(firstDiverge, head.evictedLines) && staleIndexCause) ev('stale-history-head-reported'); else if (pairCause) ev('pair-head-flagged'); else if (reportedLostTakeover) ev('head-of-another-history-lost-takeover-reported'); else bad('head-diverged-from-canonical', { tag, lines: head.lines, damagedFromLine: head.damagedFromLine, faultNote, lostTakeovers: head.lostTakeovers }); }
      if (head.hash === ref.raw[head.lines]) { staleIndexInjected = false; pairInjected = false; }   // the version shows the canonical history again: the cause is spent
      if (head.lostTakeovers > 0 && !rotted && !lossy) bad('false-alarm-lost-takeovers-without-any-fault', { tag, lost: head.lostTakeovers });
      if (head.lostTakeovers > 0 && !reportedLostTakeover) bad('lost-takeovers-reported-for-no-reason-we-dealt', { tag, lost: head.lostTakeovers, fault: faultNote });
      const flagged: number | null = head.damagedFromLine;
      // review 4 (F1, F4, F5): a line may only read as evicted when an evictBody call covered it. A deleted chunk, an older marker, a foreign file must never do it.
      if (head.evictedLines > evictedMax) bad('evicted-without-proof', { tag, evictedLines: head.evictedLines, evictedMax, fault: faultNote });
      if (!rotted && !lossy && flagged !== null) bad('false-alarm-without-any-fault', { tag, flagged });
      if (head.rolledBack && !rollbackDone && !rotted && !lossy) bad('rolled-back-reported-with-no-rollback-and-no-fault', { tag, rolledBack: head.rolledBack, fault: faultNote });
      for (let i = 0; i < ackedMax; i++) {
        if (i < evictedMax) { ev('evict-exempt'); continue; }
        if (i < head.lines) {
          let got: any;
          try { got = await s.read(V(1), 0, i, i + 1); }
          catch (e: any) { ev('read-throw-' + e?.code); if (e?.code !== 'corrupt') bad('read-threw-other', { tag, i, code: e?.code }); else if (!rotted && !lossy) bad('corrupt-read-without-any-fault', { tag, i }); continue; }
          if (got === 'evicted') { ev('read-evicted'); continue; }
          if (!(got as Buffer[])[0].equals(canon[i])) { if (reportedLostTakeover) ev('wrong-bytes-with-a-report'); else bad('WRONG-BYTES-SERVED', { tag, line: i, headLines: head.lines, fault: faultNote }); }
        } else {
          if (i < exemptFrom && flagged === null && !lossy) { bad('shrunk-unreported', { tag, line: i, head: head.lines }); continue; }
          if (!present(canon[i], files)) {
            // destroyed by the fault itself: allowed only when reported
            if (lossy && ((flagged !== null && flagged <= i) || reportedLostTakeover)) { ev('destroyed-and-reported'); continue; }
            if (i >= exemptFrom && lossy) { ev('destroyed-after-setaside'); continue; }
            bad('line-absent-everywhere', { tag, line: i, head: head.lines, rotted, flagged }); continue;
          }
          ev('absent-but-kept');
        }
      }
      // WHY `!pending`: a takeover that crashed may still cut at its retry, so its excuse (lines may shrink, they are in the tail) must outlive a check that happened before the retry
      if (head.lines >= ackedMax && !pending) { exemptFrom = Infinity; rollbackActive = false; }
      try { const v = await s.verify(V(1)); if (!v.ok) { ev('verify-notok'); verifyOk = false; } } catch { ev('verify-threw'); verifyOk = false; }
    } else {
      for (let i = evictedMax; i < ackedMax; i++) if (!present(canon[i], files)) { if (lossy) { ev('destroyed-version-unreadable'); break; } bad('line-absent-everywhere(version-unreadable)', { tag, line: i, state, rotted }); break; }
      // review 4: ONE fault must never make a whole version unreadable, except in the documented limits of inventory.ts (the evicted lines' chain values live only in the index)
      // Round 7: ONE documented cost. When the new host rewrote byte-IDENTICAL lines after a takeover (a same-history takeover) and a crash then left the index ahead of the checkpoint, the lines
      // are indistinguishable from an older copy put back (equal chain values mean equal lines; only WHEN they were written differs). The store stays loud rather than guess (store.ts, the check after
      // settleIndex), so the version is quarantined with that exact reason; it is excused here only for that reason and only when such a takeover really happened.
      let undecidableIdentical = false;
      try { undecidableIdentical = sameRewriteTakeover && state === 'damaged' && fs.readFileSync(path.join(root, 'versions', key, 'marks.bin')).includes('older files put back'); } catch { /* no marks file: not this case */ }
      if (undecidableIdentical) ev('undecidable-identical-rewrite-quarantined');
      if (faultsSinceClean === 1 && !lossy && !faultOnIndexAfterEviction && !/aside\.intent/.test(faultNote) && state !== 'ok' && !undecidableIdentical) bad('single-fault-version-unavailable', { tag, state, fault: faultNote });
      if (state === 'damaged') { try { await s.setAsideDamaged(V(1)); ev('setaside-after-damaged'); exemptFrom = 0; pending = null; staleIndexInjected = false; pairInjected = false; /* WHY: a takeover still waiting for its retry is moot on a version that was restarted empty (its lines are in aside/) */ } catch (e: any) { bad('setAsideDamaged-failed', { tag, code: e?.code }); } }
      else if (state === 'corrupt' && !(rotted || lossy)) bad('unreadable-without-any-fault', { tag, state });
      else ev('unreadable-' + state);
    }
    for (const p of parkedAcked) for (let k = 0; k < p.n; k++) if (p.from + k >= evictedMax && p.from + k >= (head?.lines ?? 0) && !present(p.lines[k], files)) { if (!lossy) bad('parked-line-absent', { tag, line: p.from + k }); break; }
    // control log and extras: NO excused losses (review 4, F2): a lost acknowledged entry must be REPORTED, a lost extra must throw
    for (const chat of new Set(ctlAcked.map((c) => c.chat))) {
      try {
        const got = await s.controlLog(chat); const dmg = await s.controlDamage(chat);
        const have = new Set(got.map((e) => e.id));
        for (const c of ctlAcked) if (c.chat === chat && !have.has(sha(c.body))) { if (dmg.length === 0) bad('control-entry-missing-no-damage-report', { tag, id: sha(c.body).slice(0, 8), fault: faultNote }); else ev('control-entry-damaged-reported'); }
        for (const e of got) { const a = ctlAcked.find((c) => sha(c.body) === e.id); if (a && !Buffer.from(e.body).equals(a.body)) bad('control-WRONG-BYTES', { tag }); if (a && a.chat !== chat) bad('control-entry-served-for-the-wrong-chat', { tag }); }
      } catch (e: any) { ev('control-throw-' + e?.code); if (e?.code !== 'damaged') bad('control-threw', { tag, code: e?.code, msg: String(e?.message).slice(0, 120) }); }
    }
    for (const b of extraAcked) {
      try { const g = await s.readExtra(sha(b)); if (g === null) { if (!extraReportedBad.has(sha(b))) bad('extra-absent-without-report', { tag, fault: faultNote }); } else if (!g.equals(b)) bad('WRONG-EXTRA-SERVED', { tag }); }
      catch (e: any) { ev('extra-throw-' + e?.code); if (e?.code !== 'corrupt') bad('extra-threw-other', { tag, code: e?.code }); else extraReportedBad.add(sha(b)); }
    }
    // set-aside tails: the only copy of the cut lines. Either every line is right or the read throws `corrupt`; never null, never wrong, never fewer without a throw
    for (const ta of tailsAcked) {
      try {
        const t = await s.tail(ta.id);
        if (t === null) { if (lostReported || (head && head.lostTakeovers > 0)) ev('tail-gone-reported-by-lostTakeovers'); else if ((tailFaults.get(ta.id) ?? 0) <= 1 && !rollbackDone) bad('tail-vanished-without-report', { tag, id: ta.id, fault: faultNote }); }
        else {
          for (let i = 0; i < t.lines.length; i++) if (!t.lines[i].equals(ta.lines[i] ?? Buffer.alloc(0))) bad('tail-WRONG-BYTES', { tag, i });
          // review 6 (B2): a tail that is served must be COMPLETE; a shorter one means a retry wrote an empty tail over a lost one
          if (t.lines.length !== ta.lines.length && (tailFaults.get(ta.id) ?? 0) <= 1) bad('tail-SHORT-served-without-report', { tag, id: ta.id, got: t.lines.length, want: ta.lines.length, fault: faultNote });
          ev('tail-served');
        }
      } catch (e: any) { ev('tail-throw-' + e?.code); if (e?.code !== 'corrupt') bad('tail-threw-other', { tag, code: e?.code }); }
    }
    // the OTHER chat: never wrong bytes, only typed errors, whatever was done to the files
    if (!legacy && ack2Max > 0) {
      try {
        const h2 = await s.head(V(2));
        for (let i = 0; i < Math.min(ack2Max, h2.lines); i++) {
          try { const g = await s.read(V(2), 0, i, i + 1); if (g !== 'evicted' && !(g as Buffer[])[0].equals(canon2[i])) bad('WRONG-BYTES-SERVED(other chat)', { tag, i }); }
          catch (e: any) { if (!['corrupt', 'evicted', 'damaged'].includes(e?.code)) bad('other-chat-read-threw-other', { tag, code: e?.code }); }
        }
      } catch (e: any) { if (!['corrupt', 'damaged', 'unknown-version', 'store-locked'].includes(e?.code)) bad('other-chat-head-threw-other', { tag, code: e?.code }); }
    }
    if (head && head.damagedFromLine === null && verifyOk && viol.length === nBad0) faultsSinceClean = 0;   // a clean check: the next fault is a first fault again
    await s.close().catch((e) => { bad('close-failed', { tag, msg: String(e?.message).slice(0, 150) }); });
    // WHY these two excuses now EXPIRE (review 6, oracle-excuse judgement): `rollbackActive` only covers a second fault dealt in the SAME episode as the rollback (the first check after it has run: the
    // first report was promised there, and nothing later is excused by it). `hwFaulted` lasts only until the high-water record is intact again and states at least the head the store just showed, i.e.
    // until the store has repaired or re-noted it; after that a rollback is a plain first fault again.
    rollbackActive = false;
    if (hwFaulted && head) { try { const v = (await readHw(realFs, root, key)).st.value; if (v && v.count >= head.lines) { hwFaulted = false; ev('hw-excuse-expired'); } } catch { /* unreadable: stays excused */ } }
  }

  /** Run (or retry) the takeover in `pending` until it is answered; a crash leaves it pending for the next episode. A typed refusal (`corrupt`: a lost tail was REPORTED) ends it unanswered. */
  async function settleTakeover(s: ChatStore): Promise<void> {
    const p = pending; if (!p) return;
    try { await s.setAsideTail(p.id, V(1), p.from); }
    catch (e: any) {
      if (e instanceof InjectedCrash) throw e;
      ev('takeover-refused-' + e?.code); log.push(`takeover refused ${e?.code}`); pending = null;   // reported, not silent: the old history stays the model (a cut that did happen is consistent with it)
      if (!['corrupt', 'damaged', 'evicted', 'limit', 'disk-full', 'bad-argument'].includes(e?.code)) bad('takeover-threw-other', { code: e?.code, msg: String(e?.message).slice(0, 150) });
      return;
    }
    // WHY (round 7): the store lowers the high-water record to the cut point on purpose (highwater.ts lowerHw), so lines past a takeover's cut are no longer covered by what the last clean close recorded
    closedAckedMax = Math.min(closedAckedMax, p.from);
    pending = null; tailsAcked.push({ id: p.id, from: p.from, lines: p.lines });
    // a takeover whose continuation is byte-for-byte the lines it cut (a same-history takeover, or a `diverge` onto `alt` when the chat already followed `alt` there) is the documented identical-rewrite case
    const nextCanon = p.diverge ? [...canon.slice(0, p.from), ...alt.slice(p.from)] : canon;
    if (p.lines.length > 0 && p.lines.every((l, i) => nextCanon[p.from + i] !== undefined && nextCanon[p.from + i].equals(l))) sameRewriteTakeover = true;
    if (p.diverge) {
      canon = [...canon.slice(0, p.from), ...alt.slice(p.from)]; ref = refChains(canon); diverged = true; firstDiverge = Math.min(firstDiverge, p.from); ackedMax = Math.min(ackedMax, p.from); ev('takeover-diverged');
    } else ev('takeover-same-history');
  }

  async function episode(n: number): Promise<void> {
    const crash = r() < 0.55;
    const failAt = 1 + Math.floor(r() * 60);
    const shadow = crash && r() < 0.4 ? (await tmpRoot(`fzs${seed}-`)) : undefined;
    const full = !legacy && !crash && r() < 0.1;       // a full disk instead of a crash
    const ffs = crash ? new FaultFs(failAt, { tear: r() < 0.6, powerLoss: r() < 0.6, shadowDir: shadow?.dir, revertOverwrites: r() < 0.5, revertInPlace: r() < 0.5, reorder: !big && r() < 0.4 ? r : undefined })
      : full ? new FaultFs(0, { tear: r() < 0.5, enospcFrom: 1 + Math.floor(r() * 40) }) : undefined;
    let s: ChatStore | null = null; let crashed = false;
    try {
      s = await open(ffs);
      if (pending) { ev('takeover-retried'); await settleTakeover(s); }
      const nops = 2 + Math.floor(r() * 6);
      for (let k = 0; k < nops; k++) {
        const op = r();
        const hd = await s.head(V(1)).catch(() => null);
        const head = hd?.lines ?? 0;
        try {
          if (!legacy && op >= 0.5 && op < 0.54) {
            const h2 = await s.head(V(2)).catch(() => null); const n2 = h2?.lines ?? 0; const c2 = 1 + Math.floor(r() * 12);
            if (n2 + c2 <= canon2.length) { log.push(`ep${n} append2 ${n2}+${c2}`); try { const res2 = await s.append(V(2), 0, n2, canon2.slice(n2, n2 + c2)); if (res2 === 'ok') ack2Max = Math.max(ack2Max, n2 + c2); } catch (e2: any) { if (e2 instanceof InjectedCrash || !['unknown-version', 'damaged', 'corrupt', 'disk-full', 'limit', 'parked-full'].includes(e2?.code)) throw e2; ev('other-chat-append-' + e2?.code); } }
          } else if (op < 0.5) {
            const back = r() < 0.2 ? Math.min(head, Math.floor(r() * 5)) : 0;
            // WHY aimed (review 6): a stale park can only leak into the next history when the head lands EXACTLY on its position; at random that is about 1 in 40, too rare to see in a few thousand
            // seeds. Half the time, when a park sits ahead of the head, the append is sized to end exactly at it.
            const ahead = parkedAcked.filter((x) => x.from > head && x.from - head <= 40);
            const aim = !big && !back && ahead.length && r() < 0.5 ? ahead[Math.floor(r() * ahead.length)].from - head : 0;
            const from = head - back; const cnt = aim || 1 + Math.floor(r() * (big ? 1500 : 40));
            if (from + cnt > canon.length) continue;
            log.push(`ep${n} append ${from}+${cnt}`);
            const res = await s.append(V(1), 0, from, canon.slice(from, from + cnt));
            if (res === 'ok') ackedMax = Math.max(ackedMax, from + cnt); else if (res === 'not-a-prefix') { ev('not-a-prefix'); if ((staleIndexInjected || pairInjected) && hd && hd.damagedFromLine !== null) ev('not-a-prefix-on-a-flagged-stale-index'); else if (hd && hd.lostTakeovers > 0 && (rollbackDone || lostTakeoverFault)) ev('not-a-prefix-on-a-folder-with-lost-takeovers'); else bad('append-not-a-prefix', { from, head, damagedFromLine: hd?.damagedFromLine }); }
          } else if (op < 0.62 && op >= 0.54) {
            const from = head + 2 + Math.floor(r() * 8); const cnt = 1 + Math.floor(r() * 5);
            if (from + cnt > canon.length) continue;
            log.push(`ep${n} park ${from}+${cnt}`);
            const res = await s.append(V(1), 0, from, canon.slice(from, from + cnt));
            if (res === 'parked') parkedAcked.push({ from, n: cnt, lines: canon.slice(from, from + cnt) });
          } else if (op < 0.70) {
            if (head < 3) continue;
            const from = Math.floor(r() * head);
            const tid = r().toString(16).slice(2, 14).padEnd(12, 'a');
            // review 6: most takeovers now continue with ANOTHER history (alt) from the cut on, so a park or tail of the old history that leaks into the new one is visible to the oracle
            const diverge = !legacy && !big && head < alt.length && r() < 0.6;
            log.push(`ep${n} setAsideTail ${from} ${diverge ? 'diverge' : 'same'}`);
            exemptFrom = Math.min(exemptFrom, from);
            pending = { id: tid, from, lines: canon.slice(from, head), diverge };
            await settleTakeover(s);
          } else if (op < 0.78) {   // WHY one branch (round 7): this line used to be written twice, which made the first `else if` an EMPTY block, so evict and restore never ran in this fuzz after round 6
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
            const cchat = !legacy && r() < 0.3 ? CHAT2 : CHAT;
            const mine = ctlAcked.filter((c) => c.chat === cchat);
            const body = Buffer.from(`ctl-${seed}-${ctlAcked.length}-${Math.floor(r() * 1e9)}-${'q'.repeat(30 + Math.floor(r() * 80))}`);
            const seen = mine.length && r() < 0.8 ? [sha(mine[mine.length - 1].body)] : [];
            log.push(`ep${n} control`);
            const res = await s.appendControl({ id: sha(body), chat: cchat, seen, body });
            if (res === 'ok') ctlAcked.push({ chat: cchat, body });
          } else if (op < 0.96) {
            const b = Buffer.from(`extra-${seed}-${extraAcked.length}-${'e'.repeat(40 + Math.floor(r() * 60))}`);
            log.push(`ep${n} extra`);
            await s.putExtra(sha(b), b); extraAcked.push(b);
          } else if (op < 0.985 || legacy) { log.push(`ep${n} scrub`); await s.scrubStep(V(1), { maxBytes: 1 << 20 }); }
          else if (!legacy) { log.push(`ep${n} setAsideDamaged`); exemptFrom = 0; await s.setAsideDamaged(V(1)); pending = null; staleIndexInjected = false; pairInjected = false; }
          // reads must keep working on a full disk (F7): a read that writes something that can fail is a bug. (Repairing a DAMAGED version needs space, so only a version nothing has damaged must always be readable.)
          if (full && ffs?.allocs && ffs.allocs >= 1) { try { await s.head(V(1)); if ((hd?.lines ?? 0) > 0) await s.read(V(1), 0, 0, 1); } catch (e: any) { if (e?.code === 'disk-full' && !rotted && !lossy) bad('read-failed-with-disk-full', { op }); } }
          if (process.env.MESH_STORE_FUZZ_TRACE) { const vd = path.join(root, 'versions', key); log.push('   files: ' + (fs.existsSync(vd) ? fs.readdirSync(vd).filter((x) => /^(body|index|checkpoint)/.test(x)).map((x) => `${x.replace(/body-0*/, 'b')}=${fs.statSync(path.join(vd, x)).size}`).join(' ') : '-')); }
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
    let closedOk = false;   // the close below finished (it raises the high-water record to what was acknowledged); a close that is itself killed raises nothing
    if (!crashed && s && ffs) { try { await s.close(); s = null; closedOk = true; } catch (e: any) { if (e instanceof InjectedCrash) crashed = true; else { ev('episode-close-failed-' + e?.code); log.push('CLOSEFAIL ' + String(e?.message).slice(0, 120)); if (!full || e?.code !== 'disk-full') bad('close-threw', { code: e?.code, msg: String(e?.message).slice(0, 150) }); } } }
    if (crashed && ffs) {
      await ffs.applyPowerLoss();
      const lp = path.join(root, 'LOCK');
      if (fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ ...JSON.parse(fs.readFileSync(lp, 'utf8')), pid: 2147483646, start: 'dead' }));
      ev('crash');
    } else if (s) { await s.close().then(() => { closedOk = true; }).catch((e: any) => { ev('episode-close-failed-' + e?.code); log.push('CLOSEFAIL ' + String(e?.message).slice(0, 160)); if (!full || e?.code !== 'disk-full') bad('close-threw', { code: e?.code, msg: String(e?.message).slice(0, 150) }); }); }
    if (shadow) await shadow.cleanup();
    if (closedOk && !full) closedAckedMax = Math.max(closedAckedMax, ackedMax);
    // A snapshot of the whole folder as it is NOW (before any fault of this episode): the source of "older copy" faults in later episodes
    const snapshotRoot = (): Map<string, Buffer> => { const m = new Map<string, Buffer>(); for (const p of walk(root)) { const rel = path.relative(root, p); if (!/^LOCK/.test(rel)) m.set(rel, fs.readFileSync(p)); } return m; };
    // (taken BEFORE this episode's fault, so an "older copy" is a true earlier state; the newest one equals the present and is skipped)
    if (!legacy && r() < 0.6) { const sn = snapshotRoot(); snaps.push(sn); snapClosed.set(sn, closedOk && !full ? ackedMax : -1); if (snaps.length > 3) snaps.shift(); }
    // WHOLE-FOLDER ROLLBACK (review 5, F3): chat 1's folder is replaced by its state at an earlier clean close. Only snapshots taken after a clean close count (the high-water record is raised there).
    let rolledThisEpisode = false;
    // WHY no `!diverged` any more (round 7, review 7 item 6a): after the first divergent takeover this fuzz stopped dealing rollbacks, which is exactly where review 7's F1 lived. A rollback across a takeover is now
    // dealt like any other; its promise is the one in the oracle above (head().lostTakeovers, because the takeover count lives outside the folder).
    if (!legacy && !big && snaps.length && r() < 0.05) {
      const sn = snaps[Math.floor(r() * snaps.length)];
      const pre = `versions/${key}/`; const here = walk(root).map((p) => path.relative(root, p)).filter((p) => p.startsWith(pre));
      const then = [...sn.keys()].filter((p) => p.startsWith(pre));
      if (then.length && snapClosed.get(sn) !== undefined && snapClosed.get(sn)! >= 0) {
        for (const p of here) fs.unlinkSync(path.join(root, p));
        for (const p of then) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), sn.get(p)!); }
        // WHY `lossyBefore` (round 7): once an earlier destructive fault has made the version unreadable (`corrupt`), the high-water record cannot be raised (it is advisory and a failing read is swallowed), so a rollback after it is a second fault on a record that never saw the growth: only the first report is promised
        const lossyBefore = lossy;
        rotted = true; lossy = true; rollbackDone = true; rollbackActive = true; lostTakeoverFault = true; rolledThisEpisode = true; faultsSinceClean++; faultNote = 'rollback'; exemptFrom = hwFaulted || lossyBefore ? 0 : Math.min(exemptFrom, closedAckedMax);
        pending = null;   // WHY: a takeover that was still waiting for its retry is moot on a folder put back to before it (its `from` would be clamped to the shorter head and write a legitimately empty tail)
        log.push(`ROLLBACK to a snapshot with ${then.length} files; closedAckedMax=${closedAckedMax}`); ev('rot'); ev('rollback');
      }
    }
    // TWO FILES OF ONE VERSION replaced by OLDER VALID COPIES TOGETHER (round 7, review 7 item 6b): a restore tool that puts back two files at once. Families: index+bodies, checkpoint+bodies, index+checkpoint,
    // tail+`.begun` (the markers of a takeover), and the whole tails/ folder. Each file is replaced by its copy from an earlier snapshot, or removed when the snapshot had none. A single fault never looked like this.
    // Promise: nothing is served from the wrong history without a typed error or a flag (`damaged`, damagedFromLine, rolledBack, lostTakeovers); the ordinary oracle above checks exactly that.
    // (not in an episode that already dealt a whole-folder rollback: a rollback plus a pair plus the single fault is three faults on one folder, beyond what any promise here covers)
    let pairDone = false;
    // (and not once a tail has already been damaged by a fault: the takeover evidence the store uses to tell old files from new is then itself gone, which makes a pair three faults)
    if (!legacy && !big && snaps.length && !rolledThisEpisode && tailFaults.size === 0 && r() < 0.15) {
      const sn = snaps[Math.floor(r() * snaps.length)];
      const FAMS: Record<string, (n: string) => boolean> = {
        'index+body': (n) => /^(index\.bin|body-[0-9a-f]{16}\.bin)$/.test(n),
        'ck+body': (n) => /^(checkpoint\.bin|body-[0-9a-f]{16}\.bin)$/.test(n),
        'index+ck': (n) => /^(index\.bin|checkpoint\.bin)$/.test(n),
        'tail+begun': (n) => /^tails\/[0-9a-f]+\.(tail|begun)$/.test(n),
        'tails-dir': (n) => n.startsWith('tails/'),
      };
      const famNames = Object.keys(FAMS); const fam = famNames[Math.floor(r() * famNames.length)];
      const pre = `versions/${key}/`; const pred = FAMS[fam];
      const here = walk(root).map((p) => path.relative(root, p)).filter((p) => p.startsWith(pre) && pred(p.slice(pre.length)));
      const then = [...sn.keys()].filter((p) => p.startsWith(pre) && pred(p.slice(pre.length)));
      const changed = [...new Set([...here, ...then])].filter((p) => { const cur = fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p)) : null; const old = sn.get(p) ?? null; return !(cur === null && old === null) && !(cur && old && cur.equals(old)); });
      if (changed.length) {
        for (const p of changed) { const old = sn.get(p); if (old === undefined) fs.unlinkSync(path.join(root, p)); else { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), old); } }
        rotted = true; if (fam.includes('body') || fam.startsWith('tail')) lossy = true; if (fam.startsWith('tail')) lostTakeoverFault = true;
        if (diverged && fam.startsWith('index')) staleIndexInjected = true;
        if (fam === 'index+body' || fam === 'ck+body' || fam === 'index+ck') pairInjected = true;
        if (!fam.startsWith('tail')) pending = null;   // WHY: like a rollback, a takeover still waiting for its retry is moot when the head is put back to before it (its `from` would be clamped to the shorter head and write a legitimately shorter tail)
        if (fam === 'index+ck' || fam === 'ck+body') { rollbackActive = true; exemptFrom = hwFaulted ? 0 : Math.min(exemptFrom, closedAckedMax); }   // an older index AND checkpoint (the bodies stay), or an older checkpoint AND bodies (the index stays ahead and is cut back to them), is a rolled-back HEAD: promised like a rollback, i.e. reported when the head is below what the high-water record saw at the last clean close
        faultsSinceClean += 2; faultNote = `pair ${fam}`; pairDone = true; log.push(`PAIR FAULT ${fam} (${changed.length} files)`); ev('rot'); ev('pair-' + fam);
      }
    }
    // ONE FAULT in a random file of the whole folder
    if (!pairDone && r() < 0.4) {
      const all = walk(root).filter((p) => fs.statSync(p).size > 0 || !legacy);
      const pool = legacy ? all.filter((p) => !p.endsWith('LOCK') && !/(^|\/)(FORMAT|meta\.json|evicted\.json)$/.test(p) && fs.statSync(p).size > 0) : all;
      if (pool.length) {
        const crit = pool.filter((p) => /index\.bin$|body-|checkpoint\.bin|log\.bin|anchor\.json|manifest\.bin|extras\/|tails\/|evicted\.json|damaged\.json|aside\.intent/.test(p));
        // review 6 (B2): right after a crash inside a takeover, aim most faults at the takeover's own files (tail, markers), so "a lost tail meets a missing marker" really happens
        const tailPool = pending ? pool.filter((p) => /\/tails\//.test(p)) : [];
        const from = tailPool.length && r() < 0.7 ? tailPool : r() < 0.7 && crit.length ? crit : pool;
        const f = from[Math.floor(r() * from.length)];
        const rel = path.relative(root, f);
        const b = fs.readFileSync(f); const pos = Math.floor(r() * Math.max(1, b.length));
        const KINDS = ['flip', 'flip', 'overwrite', 'truncate', 'truncrec', 'zero', 'zerorange', 'delete', 'older', 'older', 'foreign', 'foreign', 'dup', 'sibling', 'sibling'];
        let kind = legacy || b.length === 0 ? 'flip' : KINDS[Math.floor(r() * KINDS.length)];
        // clean boundaries of a file: the places a cut leaves every remaining record whole
        const boundaries = (): number[] => {
          const out: number[] = [];
          if (/index\.bin$/.test(rel)) { for (let o = 36; o < b.length; o += 116) out.push(o); }
          else if (/checkpoint\.bin$/.test(rel)) { for (let o = 128; o < b.length; o += 128) out.push(o); }
          else if (/log\.bin$/.test(rel)) { let o = 0; while (o + 16 <= b.length) { out.push(o); o += 16 + b.readUInt32BE(o + 4); if (o > b.length) break; } }
          else if (/manifest\.bin$/.test(rel)) { for (let o = 37; o < b.length; o += 37) out.push(o); }
          else { for (let i = b.indexOf(0x0a); i !== -1; i = b.indexOf(0x0a, i + 1)) out.push(i + 1); }
          return out.filter((o) => o < b.length);
        };
        /** The same file of ANOTHER chat (second version, second control log, another extra's bytes), or null when there is none */
        const donorOf = (): string | null => {
          const alt = (needle: string, repl: string): string | null => { if (!rel.includes(needle)) return null; const d = path.join(root, rel.replace(needle, repl)); return fs.existsSync(d) && d !== f ? d : null; };
          const v = alt(`versions/${key}/`, `versions/${key2}/`) ?? alt(`versions/${key2}/`, `versions/${key}/`);
          if (v) return v;
          const ctl = /^control\/([0-9a-f]{64})\//.exec(rel);
          if (ctl) { const others = fs.readdirSync(path.join(root, 'control')).filter((d) => d !== ctl[1]); for (const o of others) { const d = path.join(root, rel.replace(ctl[1], o)); if (fs.existsSync(d)) return d; } return null; }
          if (/^extras\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(rel)) { const o = pool.filter((p) => p !== f && /^extras\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(path.relative(root, p))); return o.length ? o[Math.floor(r() * o.length)] : null; }
          return null;
        };
        /** Another file of the same fine inventory kind with other bytes (another park, another tail, another chunk), preferring the same folder */
        const siblingOf = (): string | null => {
          const k = inventoryKind(rel); if (!k) return null;
          const c = pool.filter((p) => p !== f && inventoryKind(path.relative(root, p)) === k && !fs.readFileSync(p).equals(b));
          return c.length ? c[Math.floor(r() * c.length)] : null;
        };
        let done = true;
        if (kind === 'flip' && b.length) { b[pos] ^= 1 << Math.floor(r() * 8); fs.writeFileSync(f, b); }
        else if (kind === 'overwrite' && b.length) { b[pos] = (b[pos] + 1 + Math.floor(r() * 255)) & 0xff; fs.writeFileSync(f, b); }
        else if (kind === 'truncate' && b.length > 1) fs.truncateSync(f, Math.floor(r() * (b.length - 1)) + 1 - (pos % 2));
        else if (kind === 'truncrec') { const bs = boundaries(); if (bs.length) fs.truncateSync(f, bs[Math.floor(r() * bs.length)]); else done = false; }
        else if (kind === 'zero') fs.truncateSync(f, 0);
        else if (kind === 'zerorange' && b.length) { const a0 = pos; b.fill(0, a0, Math.min(b.length, a0 + 1 + Math.floor(r() * 300))); fs.writeFileSync(f, b); }
        else if (kind === 'delete') fs.unlinkSync(f);
        else if (kind === 'older') {
          const sn = snaps.length ? snaps[Math.floor(r() * snaps.length)] : null; const ob = sn ? sn.get(rel) : undefined;
          if (!sn) done = false; else if (ob === undefined) fs.unlinkSync(f); else if (ob.equals(b)) done = false; else fs.writeFileSync(f, ob);
        }
        else if (kind === 'foreign') { const d = donorOf(); if (d && !fs.readFileSync(d).equals(b)) fs.copyFileSync(d, f); else done = false; }
        else if (kind === 'sibling') { const d = siblingOf(); if (d) fs.copyFileSync(d, f); else done = false; }
        else if (kind === 'dup' && b.length) fs.writeFileSync(f, Buffer.concat([b, b.subarray(0, Math.min(b.length, 40))]));
        else done = false;
        if (done) {
          // flip/overwrite/dup leave most bytes in place; every other kind can destroy the only copy of bytes
          const destroys = !['flip', 'overwrite', 'dup'].includes(kind);
          // a fault in the OTHER chat's own files is not a fault of THIS chat: it must change nothing here, so it does not set the flags that excuse anything
          const otherChat = !legacy && (rel.includes(`versions/${key2}/`) || rel.includes(`aside/${key2}-`));
          if (/^highwater\//.test(rel)) { hwFaulted = true; if (rollbackDone) exemptFrom = 0; }
          if (rollbackActive && !otherChat) exemptFrom = 0;   // a second fault in the folder that was just rolled back is two faults on top of a lost state: only the first report is promised
          if (!otherChat && kind === 'older' && /index\.bin$/.test(rel) && diverged) staleIndexInjected = true;
          if (!otherChat) { rotted = true; if (destroys && SINGLE_COPY.test(rel)) lossy = true; faultsSinceClean++; faultNote = `${kind} ${rel}`; }
          else ev('fault-in-other-chat');
          const tm = /tails\/([0-9a-f]+)\.(tail|done|begun)$/.exec(rel); if (tm) { tailFaults.set(tm[1], (tailFaults.get(tm[1]) ?? 0) + 1); if (tm[2] !== 'tail' || (tailFaults.get(tm[1]) ?? 0) >= 2) lostTakeoverFault = true; }   // round 7: losing a takeover's only marker (or two files of one takeover) is what head().lostTakeovers reports
          if (/versions\/[0-9a-f]+\/(index\.bin|replaced-index\/)/.test(rel) && evictedMax > 0) faultOnIndexAfterEviction = true;   // (an evict that crashed may still have recorded itself)
          if (/aside\/|torn\/|healed\/|replaced-index\//.test(rel)) ev('rot-in-kept-copy');
          log.push(`FAULT ${kind} ${rel}@${pos}`); ev('rot'); ev('rot-' + kind);
        }
      }
    }
    await check(`after ep${n}`);
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
