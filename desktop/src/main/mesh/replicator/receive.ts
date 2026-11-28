// Receiving `lines` (plan section 3, "Receiving lines, in order"), and EVERY outcome of the store's `append`.
//
// THE ORDER IS THE SAFETY (replicator.ts invariants 1 to 3). A batch reaches `append` only after, in this order:
//   1. the version is known and wanted (else the link keeps the frame and asks for the announcement: FrameWait);
//   2. the writer's signature over the batch's END point verifies (else FrameReject);
//   3. the batch starts at or below my head (a batch further ahead is DROPPED and re-asked for: nothing is ever parked, because a park drains without any
//      signature check and would let a forged line join the chain later);
//   4. the hash chain computed over the lines, from a trusted starting value, equals the signed value (else FrameReject);
//   5. the signed point is saved (so this device can later serve and prove it).
// Only then `append`. An ACK is sent only after `append` returned `ok` (fsynced), and names the lines held and the chain value there.
//
// WHAT "A TRUSTED STARTING VALUE" MEANS: the chain value at the batch's start. Inside one catch-up it is the signed value at the end of the previous batch from the same peer
// (the WRITER's chain, not mine). For the first batch it is my own chain value at that count, which is right unless my copy is itself wrong; then the check fails
// loudly (`chain-mismatch`) and the version is re-asked for from line 0, whose starting value is public (the seed).
import { chainStep, hex, unhex } from '../store/chain';
import { StoreError } from '../store';
import { isDiskFull } from '../store/storeutil';
import type { AppendResult, Head } from '../store';
import { FrameReject, FrameWait } from '../link';
import { reportFailure } from '../../report-failure';
import { ackBodyOf, ackMessage, headMessage, KIND_ACK, KIND_NAK, KIND_WANT, nakBodyOf, wantBodyOf, type LinesBody, type NakWhy } from './wire';
import { UNKNOWN_SPAN } from './signed-heads';
import { repairFrom, vouchLines, type PeerInfo, type RepCtx } from './ctx';
import { checkRepair, retireAndRecopy, scrubAll } from './repair';
import { REASSEMBLY_IDLE_MS } from './budget';

const REASSEMBLY_STALE_MS = 60_000;
const DISK_FULL_BACKOFF_MS = 30_000;

export function sendNak(ctx: RepCtx, peer: PeerInfo, wire: Buffer, at: number, why: NakWhy, mine: string | null = null): void {
  ctx.sendLive(KIND_NAK, nakBodyOf({ version: wire, at, why, hashAtYourCount: mine ? unhex(mine) : null }), peer.id);
}

/** Acknowledge what this device can VOUCH for, no more (review 2, finding 2): its head cut back to the first line the store reports damaged and, for a device that is not the writer, to the newest line
 *  a writer signature covers (`vouchLines`; the same cut `myEntries` makes for heads). `round` is 0, or the solicit round being answered (it is part of what is signed). */
export async function sendAck(ctx: RepCtx, peer: PeerInfo, wire: Buffer, local: Buffer, round = 0): Promise<void> {
  const desc = ctx.directory.describe(wire);
  if (!desc) return;
  const h = await ctx.store.head(local);
  const v = await vouchLines(ctx, wire, local, desc, h);
  const hash = v.lines === h.lines ? h.hash : await ctx.store.hashAt(local, 0, v.lines);
  if (hash === null) return;
  const raw = unhex(hash);
  ctx.sendLive(KIND_ACK, ackBodyOf({ version: wire, lines: v.lines, hash: raw, round, sig: ctx.crypto.sign(ackMessage(ctx.crypto.self, wire, v.lines, raw, round)) }), peer.id);
}

/** Ask the peer for the announcement of a version this device has not been told about (it answers with `rep.intro`, then I ask for the lines). */
export function askIntro(ctx: RepCtx, peer: PeerInfo, wire: Buffer): void {
  ctx.sendLive(KIND_WANT, wantBodyOf({ version: wire, haveLines: 0, haveHash: Buffer.alloc(32), through: null, intro: true, round: 0, cover: null }), peer.id);
}

/** A part of a line too large for one frame. Returns the whole line when the last part arrives, else null. Parts must come in order from part 0; anything else restarts.
 *  WHY the reservation grows with what ARRIVES (review 1, F6): reserving the whole declared size up front let one 512 KiB frame with a replayed head pin the 64 MiB budget. Now a peer pins only the
 *  bytes it actually sent, holds at most one unfinished line, and an idle one is dropped by a timer. */
function addPart(ctx: RepCtx, peer: PeerInfo, b: LinesBody): Buffer | null {
  const key = `${peer.hex}/${b.version.toString('hex')}`;
  const part = b.part as NonNullable<LinesBody['part']>;
  const drop = (k: string): void => { const x = ctx.reasm.get(k); if (!x) return; x.timer?.cancel(); ctx.reassemblyBytes.give(x.bytes); ctx.reasm.delete(k); };
  let r = ctx.reasm.get(key);
  const now = ctx.clock.now();
  if (r && (part.index === 0 || r.from !== b.from || r.of !== part.of || r.total !== part.totalBytes || r.chunks.length !== part.index || now - r.at > REASSEMBLY_STALE_MS)) { drop(key); r = undefined; } // out of order or stale: start over (a partial line is never used)
  if (!r) {
    if (part.index !== 0) { ctx.bump('part-out-of-order'); return null; }
    for (const [k, x] of [...ctx.reasm]) if (x.peer === peer.hex) drop(k); // one unfinished line per peer
    r = { from: b.from, of: part.of, total: part.totalBytes, chunks: [], bytes: 0, at: now, peer: peer.hex, timer: null };
    ctx.reasm.set(key, r);
  }
  const chunk = b.lines[0];
  if (!ctx.reassemblyBytes.take(chunk.length)) { drop(key); ctx.bump('part-over-budget'); return null; }
  r.bytes += chunk.length; r.chunks.push(chunk); r.at = now;
  r.timer?.cancel(); r.timer = ctx.clock.setTimeout(() => { if (ctx.reasm.get(key) === r) { drop(key); ctx.bump('part-idle-dropped'); } }, REASSEMBLY_IDLE_MS);
  if (r.bytes > r.total) { drop(key); throw new FrameReject('part-bytes-exceed-total'); }
  if (r.chunks.length < r.of) return null;
  const whole = Buffer.concat(r.chunks); const total = r.total;
  drop(key);
  if (whole.length !== total) throw new FrameReject('part-bytes-short');
  return whole;
}

/** Drop every half-received line (a peer left, or a reconnect). */
export function dropReassembly(ctx: RepCtx): void {
  for (const r of ctx.reasm.values()) { r.timer?.cancel(); ctx.reassemblyBytes.give(r.bytes); }
  ctx.reasm.clear();
}

export async function receiveLines(ctx: RepCtx, peer: PeerInfo, b: LinesBody): Promise<void> {
  const wire = b.version;
  const desc = ctx.directory.describe(wire);
  if (!desc || !ctx.directory.wanted(wire)) { askIntro(ctx, peer, wire); throw new FrameWait('version not announced yet'); }
  if (!ctx.crypto.knows(desc.writer)) throw new FrameWait('writer not on the roster yet');
  // 2. WHO may supply lines: only the version's named writer signs them (rule i); a copy served by anyone else is still checked against the WRITER's signature.
  if (!ctx.crypto.verify(desc.writer, headMessage(wire, b.head.lines, b.head.hash), b.head.sig)) { ctx.bump('bad-head-signature'); throw new FrameReject('bad-head-signature'); }
  let lines = b.lines;
  if (b.part) { const whole = addPart(ctx, peer, b); if (!whole) return; lines = [whole]; }
  await ctx.run(wire, () => applyLines(ctx, peer, b, lines));
}

async function applyLines(ctx: RepCtx, peer: PeerInfo, b: LinesBody, lines: Buffer[]): Promise<void> {
  const wire = b.version;
  const run = ctx.runOf(wire);
  const v = await ctx.localOf(wire);
  if (!v) { ctx.bump('lines-version-not-ready'); return; }
  const desc = v.desc;
  let head: Head;
  try { head = await ctx.store.head(v.local); } catch (e) { await storeFailed(ctx, peer, wire, e, 0); return; }
  const iAmWriter = desc.writer.equals(ctx.crypto.self);
  const end = b.from + lines.length;
  // A version with a sticky fault takes nothing more from anyone (F1/F4): the copy is kept exactly as it is, and still served.
  // (review 4, F5) ... except that a copy faulted by a second history may be taken off the fault by ONE thing: a verified writer-signed batch that starts exactly at my head with my own chain value as its
  // base. Its signed head is the chain over MY lines plus these, so the writer's current history contains my copy; the contradicting history no longer exists in the writer's signed line. Checked below,
  // after the chain is verified; anything else is refused as before.
  const staleFault = !!run.fault && (run.fault === 'writer-signed-two-histories' || run.fault === 'unsigned-lines-contradicted') && !iAmWriter && lines.length > 0 && (b.from === head.lines || b.from + lines.length === head.lines);
  if (run.fault && !staleFault) { ctx.bump('lines-refused-faulted'); return; }
  // WRITER-SIDE (review 1, F1). Lines past my own head that carry MY signature are my own lines coming back (a rolled-back or set-aside copy refilling): the signature is the proof, and they are
  // verified below exactly like any receiver's (signature, chain from a trusted base, then append). Nothing else can put lines past a writer's head, because the writer signs only what it holds.
  if (iAmWriter && end > head.lines) ctx.bump('writer-restored-from-peer');
  // 3. never park: a batch that starts past my head is dropped and the missing lines are asked for
  if (b.from > head.lines) { ctx.bump('lines-ahead-dropped'); await ctx.want(wire, peer); return; }
  // 4. the chain over these lines from a trusted starting value must equal the signed value
  let base: Buffer; let baseIsMine = false;
  // WHY the base is ALWAYS read from my own store (review 4 gap round, found by the self-fork schedules): the old shortcut took the chain value the previous batch from this device ended at. That value came from a
  // batch whose append may have been REFUSED (a contradicting history), and the next batch was then checked against the sender's chain and appended onto my different lines: a spliced copy. By now my head is
  // at least `from` (a batch that starts past my head was dropped above), so my own chain value is always there.
  {
    let h: string | null;
    try { h = await ctx.store.hashAt(v.local, 0, b.from); } catch (e) { if (e instanceof StoreError && e.code === 'evicted') { ctx.bump('lines-base-evicted'); return; } await storeFailed(ctx, peer, wire, e, b.from); return; }
    if (h === null) { ctx.bump('lines-base-missing'); await ctx.want(wire, peer); return; }
    base = unhex(h); baseIsMine = true;
  }
  let c = base;
  for (const l of lines) c = chainStep(c, l);
  if (!c.equals(b.head.hash)) {
    ctx.bump('chain-mismatch');
    if (baseIsMine && b.from > 0 && !run.rewanted.has(peer.hex)) { run.rewanted.add(peer.hex); run.diverged = 'chain-mismatch'; await ctx.want(wire, peer, { haveLines: await restartPoint(ctx, wire) }); }
    throw new FrameReject('chain-mismatch');
  }
  if (staleFault) {
    // (the base of a faulted copy is always read from MY store, see above, so the chain check already proved the batch continues MY lines)
    // a batch that ENDS at my head must also reproduce my own chain value there: then the writer's current signed head is exactly my copy (nothing to append, the fault is just stale)
    if (b.from + lines.length === head.lines && (await ctx.store.hashAt(v.local, 0, head.lines).catch(() => null /* benign: see above */)) !== hex(b.head.hash)) { ctx.bump('lines-refused-faulted'); return; }
    await ctx.clearFault(wire); ctx.bump(b.from === head.lines ? 'fault-cleared-by-extension' : 'fault-cleared-by-cover');
  }
  // 5. keep the signed point (a non-writer needs it to serve; the writer signs on demand)
  if (!iAmWriter) {
    let span = 0; for (const l of lines) span += l.length;
    // WHY the catch: this file is a write too, and a full disk fails it BEFORE the store is touched; it must end the same way (no ack, a nak, the named status), not as an unnamed handler error
    let kept: Awaited<ReturnType<typeof ctx.heads.add>>;
    try { kept = await ctx.heads.add(wire, { lines: b.head.lines, hash: b.head.hash, sig: b.head.sig, spanBytes: span > 0xfffffffe ? UNKNOWN_SPAN : span }); } catch (e) { await storeFailed(ctx, peer, wire, e, b.from); return; }
    // (review 4) a saved point is written BEFORE its lines are appended, so a kill between the two leaves a point that covers lines this copy never got. When the writer then signs ANOTHER history at that
    // count, the two points "conflict" although this copy holds neither history: the unbacked point is dropped and the new one kept, instead of the chat staying in `diverged` for good.
    if (kept === 'conflict') {
      const old = (await ctx.heads.pointsAfter(wire, b.head.lines - 1)).find((q) => q.lines === b.head.lines);
      const backed = !!old && old.lines <= head.lines && (await ctx.store.hashAt(v.local, 0, old.lines).catch(() => null /* benign: no chain value at that count: not backed */)) === hex(old.hash);
      if (old && !backed) { await ctx.heads.dropAbove(wire, Math.min(head.lines, b.head.lines - 1)); ctx.bump('unbacked-signed-point-dropped'); kept = await ctx.heads.add(wire, { lines: b.head.lines, hash: b.head.hash, sig: b.head.sig, spanBytes: span > 0xfffffffe ? UNKNOWN_SPAN : span }); }
    }
    if (kept === 'conflict') {
      run.diverged = 'writer-signed-two-histories'; ctx.bump('writer-equivocation');
      // WHY a look now: this copy has just become `diverged`; a second version the writer announced earlier may already say where the other history lives, and nothing else will look at it again (it no longer changes)
      await ctx.reconsider(wire);
      throw new FrameReject('writer-equivocation');
    }
  }
  // 6. append, and every outcome of it
  let res: AppendResult;
  try { res = await ctx.store.append(v.local, 0, b.from, lines); } catch (e) { await storeFailed(ctx, peer, wire, e, b.from); return; }
  if (res === 'ok') {
    const wasDiverged = run.diverged !== null; // (a divergence is chased to its end below, review 4, F6)
    run.diverged = null; run.stuck = null; run.retiredRecopy = false; run.unavailable.clear(); run.unavailableRounds = 0;
    // the sender holds at least what the writer signed in this batch (a signed statement, not a bare claim), so its entry is at least that
    const sk = wire.toString('hex'); const prev = peer.heads.get(sk);
    if (!prev || prev.lines <= b.head.lines) peer.heads.set(sk, { lines: b.head.lines, hash: b.head.hash.toString('hex'), state: 'ok', at: ctx.clock.now() });
    // a batch backs a claim only if it ADVANCED my verified content (review 4, F3): a replay of lines I already hold changes nothing. The absolute clock ends only when I hold what was claimed.
    if (end > head.lines) peer.claimSince.delete(sk);
    const claimed = peer.heads.get(sk);
    if (!claimed || end >= claimed.lines) peer.claimFirst.delete(sk);
    await sendAck(ctx, peer, wire, v.local);
    if (run.pull) run.pull = { ...run.pull, at: ctx.clock.now() };
    await checkRepair(ctx, wire);
    // F6 (review 4): the restart-from-zero ask that a divergence causes is answered one signed point at a time. The first points are usually lines both histories share, so the batch is a no-op for me and nothing
    // asked for the next one: both devices sat in `diverged` for good. Now the ask CONTINUES from where the batch ended for as long as that device claims more than that, until the lines part (and the
    // writer moves its lines to a second version, or a peer names its state).
    const claimedNow = peer.heads.get(wire.toString('hex'));
    // (also for a WRITER, whose own state is `pulling`, not `diverged`, because a nak never marks it so: a batch of lines it already held, answered to an ask that was made because the peer claims more, goes on)
    if ((wasDiverged || !!run.pull) && claimedNow && end < claimedNow.lines && end <= head.lines && end > b.from) { ctx.bump('diverged-ask-continued'); await ctx.want(wire, peer, { haveLines: end }); }
    await ctx.reconsider(wire);
    // WHY: an ack no longer refreshes what the writer thinks I hold (review 2, finding 6); the device's own heads do, so once this pull is finished they are sent
    if (!run.pull) ctx.advertise();
    return;
  }
  if (res === 'parked') {
    // must not happen (from <= head was checked); if it does the park is released and counted loudly
    ctx.bump('unexpected-park');
    for (const p of await ctx.store.parkedList(v.local)) await ctx.store.releaseParked(v.local, p.name);
    await ctx.want(wire, peer);
    return;
  }
  // 'not-a-prefix' under a VALID writer signature: the lines I hold at those positions differ from the writer's. Find out whether my own bytes are damaged.
  ctx.bump('not-a-prefix');
  // the batch was refused, so the signed point that came with it (saved before the append, step 5) covers lines this copy does not hold: points off this copy's chain are forgotten, or this copy would answer
  // `unavailable` for the lines it really has (review 4 gap round, found by the self-fork schedules)
  { const dropped = await ctx.heads.dropOffChain(wire, (n) => ctx.store.hashAt(v.local, 0, n)); if (dropped) ctx.bump('off-chain-signed-points-dropped'); }
  // the writer's SIGNED batch is evidence that the sender holds at least this much: it is what the recopy asks for
  const nk = wire.toString('hex'); const pv = peer.heads.get(nk);
  if (!pv || pv.lines <= b.head.lines) peer.heads.set(nk, { lines: b.head.lines, hash: b.head.hash.toString('hex'), state: 'ok', at: ctx.clock.now() });
  const dmg = await scrubAll(ctx, v.local);
  if (dmg !== null) { reportFailure({ what: 'set a damaged chat copy aside (recopied from a peer)', where: 'mesh.replicator' }); await retireAndRecopy(ctx, wire, 'damaged-bytes'); return; }
  // My bytes are intact and the writer's signed chain still contradicts them. Two cases (review 1, F1):
  //  * my lines at the point of conflict were ENDORSED by an earlier writer signature I hold (or I AM the writer): the writer signed two histories. Neither is mine to discard: the copy is kept as it
  //    is, the version goes to the sticky named fault, and the copy keeps being served (that is how it is "offered back").
  //  * they were never covered by any writer signature (foreign bytes): nothing endorsed them, so they are set aside and recopied.
  // A copy whose lines run past its newest saved signed point (the replicator folder is older than the store, or those lines never had a signature) cannot be judged here: it is KEPT and the version
  // goes to a named fault, never set aside on a guess (review 2, finding 5). Only a copy whose points reach its head can be shown to be unendorsed.
  if (iAmWriter) {
    // I signed both histories: the lines from the point where they part move to a second version of mine, and my copy of this one is brought back to the history the peers hold (selffork.ts)
    ctx.bump('writer-self-fork');
    await ctx.selfFork(wire, await conflictPoint(ctx, v.local, b.from, lines, head.lines));
    return;
  }
  const unsignable = !iAmWriter && (await vouchLines(ctx, wire, v.local, desc, head)).unsignable;
  if (unsignable) {
    await ctx.fault(wire, 'unsigned-lines-contradicted');
    sendNak(ctx, peer, wire, head.lines, 'not-a-prefix', head.hash);
    ctx.advertise();
    return;
  }
  if (await endorsedByWriter(ctx, wire, v.local, b.from, lines, head.lines, desc.writer)) {
    await ctx.fault(wire, 'writer-signed-two-histories');
    sendNak(ctx, peer, wire, head.lines, 'not-a-prefix', head.hash);
    ctx.advertise();
    return;
  }
  reportFailure({ what: 'set aside a chat copy no writer signature ever covered (recopied from a peer)', where: 'mesh.replicator' });
  await retireAndRecopy(ctx, wire, 'unendorsed-bytes');
}

/** Was my copy, at the first line where the new batch disagrees, covered by a writer signature I hold (a saved signed point above that line whose chain value is mine)? */
/** The first line where a batch (starting at `from`) parts from my copy: walk the batch along MY chain. */
async function conflictPoint(ctx: RepCtx, local: Buffer, from: number, lines: Buffer[], head: number): Promise<number> {
  let conflict = Math.max(0, from - 1);
  const start = await ctx.store.hashAt(local, 0, from);
  if (start !== null) {
    let c = unhex(start);
    for (let i = 0; i < lines.length && from + i < head; i++) {
      c = chainStep(c, lines[i]);
      if ((await ctx.store.hashAt(local, 0, from + i + 1)) !== hex(c)) { conflict = from + i; break; }
    }
  }
  return conflict;
}

async function endorsedByWriter(ctx: RepCtx, wire: Buffer, local: Buffer, from: number, lines: Buffer[], head: number, writer: Buffer): Promise<boolean> {
  try {
    // walk the batch along MY chain from `from`: the first line whose chain value differs from mine is where the two histories part
    const conflict = await conflictPoint(ctx, local, from, lines, head);
    // any saved point above the conflict that the writer signed AND that lies on my chain proves my lines there were endorsed (a point from the contradicting history does not lie on my chain)
    for (const pt of await ctx.heads.pointsAfter(wire, conflict)) {
      if (pt.lines > head || !ctx.crypto.verify(writer, headMessage(wire, pt.lines, pt.hash), pt.sig)) continue;
      if ((await ctx.store.hashAt(local, 0, pt.lines)) === hex(pt.hash)) return true;
    }
    return false;
  } catch (e) {
    if (e instanceof StoreError && e.code === 'evicted') return true; // cannot judge an evicted range: keep the copy and say so (loud) rather than discard
    throw e;
  }
}

/** A store call failed while applying a batch: each typed failure ends in a named status (invariant 9), never in silence and never in an ack. */
async function storeFailed(ctx: RepCtx, peer: PeerInfo, wire: Buffer, e: unknown, at: number): Promise<void> {
  const run = ctx.runOf(wire);
  const code = e instanceof StoreError ? e.code : isDiskFull(e) ? 'disk-full' : 'unknown';
  if (code === 'disk-full') {
    run.stuck = 'disk-full'; ctx.bump('disk-full');
    sendNak(ctx, peer, wire, at, 'disk-full');
    ctx.clock.setTimeout(() => { run.stuck = null; void ctx.reconsider(wire); }, DISK_FULL_BACKOFF_MS);
    return;
  }
  if (code === 'damaged') { await retireAndRecopy(ctx, wire, 'store-damaged'); return; }
  if (code === 'corrupt') { await checkRepair(ctx, wire); return; }
  if (code === 'closed') return;
  run.stuck = code; // limit, bad-argument, version-conflict, unknown-version, ...
  reportFailure({ what: 'apply copied chat lines', cause: e, where: 'mesh.replicator' });
}

/** Where a "start over" ask begins for `wire` (review 4 gap round, seed 17103). A version that is a fork of another begins, by construction, with the parent's first `forkLine` lines, and the announcement names
 *  their chain value; when MY copy has exactly that value at `forkLine`, those lines are not in question and the ask begins THERE. Asking from line 0 instead failed whenever the prefix held a line over the
 *  frame budget: a device that made its copy of the prefix locally (fork-local) holds no saved signed point inside it, so it could only answer `unavailable` to a request that spans the prefix, and the
 *  writer, which needs exactly such an answer to see that it signed two histories, waited for good. Anything unproven (no fork, no such line, another value) falls back to 0. */
export async function restartPoint(ctx: RepCtx, wire: Buffer): Promise<number> {
  const d = ctx.directory.describe(wire);
  if (!d || !d.parent || d.forkLine === null || !d.forkHash || d.forkLine <= 0) return 0;
  const v = await ctx.localOf(wire);
  if (!v) return 0;
  const h = await ctx.store.head(v.local).catch(() => null /* benign: no readable head; ask from the start as before */);
  if (!h || h.lines < d.forkLine) return 0;
  const at = await ctx.store.hashAt(v.local, 0, d.forkLine).catch(() => null /* benign: cannot be read; ask from the start as before */);
  return at === d.forkHash.toString('hex') ? d.forkLine : 0;
}
