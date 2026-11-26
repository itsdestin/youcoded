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
import type { AppendResult, Head } from '../store';
import { FrameReject, FrameWait } from '../link';
import { reportFailure } from '../../report-failure';
import { ackBodyOf, ackMessage, headMessage, KIND_ACK, KIND_NAK, KIND_WANT, nakBodyOf, wantBodyOf, type LinesBody, type NakWhy } from './wire';
import { UNKNOWN_SPAN } from './signed-heads';
import { repairFrom, type PeerInfo, type RepCtx } from './ctx';
import { checkRepair, retireAndRecopy, scrubAll } from './repair';

const REASSEMBLY_STALE_MS = 60_000;
const DISK_FULL_BACKOFF_MS = 30_000;

export function sendNak(ctx: RepCtx, peer: PeerInfo, wire: Buffer, at: number, why: NakWhy, mine: string | null = null): void {
  ctx.sendLive(KIND_NAK, nakBodyOf({ version: wire, at, why, hashAtYourCount: mine ? unhex(mine) : null }), peer.id);
}

export async function sendAck(ctx: RepCtx, peer: PeerInfo, wire: Buffer, local: Buffer): Promise<void> {
  const h = await ctx.store.head(local);
  const raw = unhex(h.hash);
  ctx.sendLive(KIND_ACK, ackBodyOf({ version: wire, lines: h.lines, hash: raw, sig: ctx.crypto.sign(ackMessage(ctx.crypto.self, wire, h.lines, raw)) }), peer.id);
}

/** Ask the peer for the announcement of a version this device has not been told about (it answers with `rep.intro`, then I ask for the lines). */
export function askIntro(ctx: RepCtx, peer: PeerInfo, wire: Buffer): void {
  ctx.sendLive(KIND_WANT, wantBodyOf({ version: wire, haveLines: 0, haveHash: Buffer.alloc(32), through: null, intro: true }), peer.id);
}

/** A part of a line too large for one frame. Returns the whole line when the last part arrives, else null. Parts must come in order from part 0; anything else restarts. */
function addPart(ctx: RepCtx, peer: PeerInfo, b: LinesBody): Buffer | null {
  const key = `${peer.hex}/${b.version.toString('hex')}`;
  const part = b.part as NonNullable<LinesBody['part']>;
  let r = ctx.reasm.get(key);
  const now = ctx.clock.now();
  if (r && (part.index === 0 || r.from !== b.from || r.of !== part.of || r.total !== part.totalBytes || r.chunks.length !== part.index || now - r.at > REASSEMBLY_STALE_MS)) {
    ctx.reassemblyBytes.give(r.bytes); ctx.reasm.delete(key); r = undefined; // out of order or stale: start over (a partial line is never used)
  }
  if (!r) {
    if (part.index !== 0) { ctx.bump('part-out-of-order'); return null; }
    if (!ctx.reassemblyBytes.take(part.totalBytes)) { ctx.bump('part-over-budget'); return null; } // reserve the WHOLE line up front: a peer cannot grow a buffer past what it declared
    r = { from: b.from, of: part.of, total: part.totalBytes, chunks: [], bytes: part.totalBytes, at: now };
    ctx.reasm.set(key, r);
  }
  r.chunks.push(b.lines[0]); r.at = now;
  const have = r.chunks.reduce((n, c) => n + c.length, 0);
  if (have > r.total) { ctx.reassemblyBytes.give(r.bytes); ctx.reasm.delete(key); throw new FrameReject('part-bytes-exceed-total'); }
  if (r.chunks.length < r.of) return null;
  ctx.reassemblyBytes.give(r.bytes); ctx.reasm.delete(key);
  if (have !== r.total) throw new FrameReject('part-bytes-short');
  return Buffer.concat(r.chunks);
}

/** Drop every half-received line (a peer left, or a reconnect). */
export function dropReassembly(ctx: RepCtx): void {
  for (const r of ctx.reasm.values()) ctx.reassemblyBytes.give(r.bytes);
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
  const refilling = repairFrom(head) !== null;
  // Only the named writer ever has lines of its own that no peer sent. Peer lines for MY version beyond my head are explained only by a store report (rule vii).
  if (iAmWriter && end > head.lines && !refilling) {
    ctx.bump('writer-ahead-unexplained'); run.stuck = 'writer-behind-unreported';
    sendNak(ctx, peer, wire, head.lines, 'not-a-prefix', head.hash);
    throw new FrameReject('writer-ahead-unexplained');
  }
  // 3. never park: a batch that starts past my head is dropped and the missing lines are asked for
  if (b.from > head.lines) { ctx.bump('lines-ahead-dropped'); await ctx.want(wire, peer); return; }
  // 4. the chain over these lines from a trusted starting value must equal the signed value
  const lastSigned = run.lastSigned.get(peer.hex);
  let base: Buffer; let baseIsMine = false;
  if (lastSigned && lastSigned.lines === b.from) base = lastSigned.hash;
  else {
    let h: string | null;
    try { h = await ctx.store.hashAt(v.local, 0, b.from); } catch (e) { if (e instanceof StoreError && e.code === 'evicted') { ctx.bump('lines-base-evicted'); return; } await storeFailed(ctx, peer, wire, e, b.from); return; }
    if (h === null) { ctx.bump('lines-base-missing'); await ctx.want(wire, peer); return; }
    base = unhex(h); baseIsMine = true;
  }
  let c = base;
  for (const l of lines) c = chainStep(c, l);
  if (!c.equals(b.head.hash)) {
    ctx.bump('chain-mismatch');
    if (baseIsMine && b.from > 0 && !run.rewanted.has(peer.hex)) { run.rewanted.add(peer.hex); run.diverged = 'chain-mismatch'; await ctx.want(wire, peer, { haveLines: 0 }); }
    throw new FrameReject('chain-mismatch');
  }
  run.lastSigned.set(peer.hex, { lines: b.head.lines, hash: b.head.hash });
  // 5. keep the signed point (a non-writer needs it to serve; the writer signs on demand)
  if (!iAmWriter) {
    let span = 0; for (const l of lines) span += l.length;
    const kept = await ctx.heads.add(wire, { lines: b.head.lines, hash: b.head.hash, sig: b.head.sig, spanBytes: span > 0xfffffffe ? UNKNOWN_SPAN : span });
    if (kept === 'conflict') { run.diverged = 'writer-signed-two-histories'; ctx.bump('writer-equivocation'); throw new FrameReject('writer-equivocation'); }
  }
  // 6. append, and every outcome of it
  let res: AppendResult;
  try { res = await ctx.store.append(v.local, 0, b.from, lines); } catch (e) { await storeFailed(ctx, peer, wire, e, b.from); return; }
  if (res === 'ok') {
    run.diverged = null; run.stuck = null; run.retiredRecopy = false;
    await sendAck(ctx, peer, wire, v.local);
    if (run.pull) run.pull = { ...run.pull, at: ctx.clock.now() };
    await checkRepair(ctx, wire);
    await ctx.reconsider(wire);
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
  const dmg = await scrubAll(ctx, v.local);
  if (dmg !== null || !iAmWriter) { reportFailure({ what: 'keep a chat copy that differs from its writer (set aside, recopied)', where: 'mesh.replicator' }); await retireAndRecopy(ctx, wire, dmg !== null ? 'damaged-bytes' : 'diverged-from-writer'); return; }
  // I am the writer, my bytes are fine, and a signed-by-me history says otherwise: never retire on a peer's word; say so
  run.stuck = 'writer-conflict';
  sendNak(ctx, peer, wire, head.lines, 'not-a-prefix', head.hash);
}

/** A store call failed while applying a batch: each typed failure ends in a named status (invariant 9), never in silence and never in an ack. */
async function storeFailed(ctx: RepCtx, peer: PeerInfo, wire: Buffer, e: unknown, at: number): Promise<void> {
  const run = ctx.runOf(wire);
  const code = e instanceof StoreError ? e.code : 'unknown';
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
