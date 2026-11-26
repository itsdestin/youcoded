// Serving: answering a peer's `want` ("everything after N") from the store in bounded batches, and the writer's live push (plan section 3, "Serving a want").
//
// THE RULES THAT KEEP IT SAFE
//  * Check before sending: the peer's claimed prefix (its count and chain value) must equal MY chain value at that count, else `nak not-a-prefix` with mine.
//  * Never serve beyond a signature: every batch ends where a writer signature covers the chain value. The writer signs on demand; anyone else serves only up to a signed
//    point it holds (signed-heads.ts), whose signature is checked again here, and whose value must equal my own chain at that count.
//  * Bounded: a window of 4 frames per session, 4 sessions, a shared read budget, at most 6 holds a second for catch-up, frames of at most 1 MiB.
//  * No retry state: a lost frame is the receiver's to ask for again (it drives). A session that sees no ack for 30 s is dropped.
import { hex, unhex } from '../store/chain';
import { StoreError } from '../store';
import type { Head } from '../store';
import { reportFailure } from '../../report-failure';
import { MAX_SESSIONS, WINDOW_FRAMES } from './budget';
import { chatGroup, repairFrom, type PeerInfo, type RepCtx, type ServeSession } from './ctx';
import { sendNak } from './receive';
import { headMessage, KIND_INTRO, KIND_LINES, linesBody, MAX_LINES_PER_FRAME, introBodyOf, PART_BYTES, PAYLOAD_BUDGET_BYTES, type AckBody, type NakWhy, type SignedHead, type WantBody, ackMessage } from './wire';

const SESSION_STALL_MS = 30_000;
const READ_STEP = 32;

interface Batch { lines: Buffer[]; end: number; head: SignedHead }

const keyOf = (peerHex: string, wire: Buffer): string => `${peerHex}/${wire.toString('hex')}`;

/** Build one batch starting at `from`, ending at a signed point and at or below `cap` (the writer's end is free; a non-writer's is its next held point). */
async function buildBatch(ctx: RepCtx, wire: Buffer, local: Buffer, writer: Buffer, from: number, cap: number, head: Head): Promise<Batch | { nak: NakWhy }> {
  const me = writer.equals(ctx.crypto.self);
  if (me) {
    const lines: Buffer[] = []; let bytes = 0; let end = from;
    outer: while (end < cap && lines.length < MAX_LINES_PER_FRAME) {
      const step = Math.min(READ_STEP, cap - end, MAX_LINES_PER_FRAME - lines.length);
      const got = await ctx.store.read(local, 0, end, end + step);
      if (got === 'evicted') return { nak: 'evicted' };
      for (const l of got) {
        if (lines.length > 0 && bytes + l.length > PAYLOAD_BUDGET_BYTES) break outer;
        lines.push(l); bytes += l.length; end++;
        if (l.length > PAYLOAD_BUDGET_BYTES) break outer; // an oversized line travels alone, in parts
      }
    }
    const h = await ctx.store.hashAt(local, 0, end);
    if (h === null) return { nak: 'unavailable' };
    const raw = unhex(h);
    return { lines, end, head: { lines: end, hash: raw, sig: ctx.crypto.sign(headMessage(wire, end, raw)) } };
  }
  const pt = await ctx.heads.nextAfter(wire, from);
  if (!pt || pt.lines > head.lines) return { nak: 'unavailable' };
  if (!ctx.crypto.verify(writer, headMessage(wire, pt.lines, pt.hash), pt.sig)) { ctx.bump('saved-point-bad-signature'); return { nak: 'unavailable' }; }
  if ((await ctx.store.hashAt(local, 0, pt.lines)) !== hex(pt.hash)) { ctx.runOf(wire).diverged = 'my-chain-differs-from-signed-point'; return { nak: 'unavailable' }; }
  if (pt.lines - from > MAX_LINES_PER_FRAME) return { nak: 'unavailable' };
  const got = await ctx.store.read(local, 0, from, pt.lines);
  if (got === 'evicted') return { nak: 'evicted' };
  const bytes = got.reduce((n, l) => n + l.length, 0);
  if (got.length > 1 && bytes > PAYLOAD_BUDGET_BYTES) return { nak: 'unavailable' };
  return { lines: got, end: pt.lines, head: { lines: pt.lines, hash: pt.hash, sig: pt.sig } };
}

/** Hand one batch to the durable lane (a line over the budget goes alone, in parts). Resolves when the carrier stored every frame. */
async function sendBatch(ctx: RepCtx, wire: Buffer, chatId: string, to: Buffer | undefined, from: number, b: Batch): Promise<void> {
  const group = chatGroup(ctx.setId, chatId);
  if (b.lines.length === 1 && b.lines[0].length > PAYLOAD_BUDGET_BYTES) {
    const l = b.lines[0]; const of = Math.ceil(l.length / PART_BYTES);
    for (let i = 0; i < of; i++) {
      await ctx.link.sendDurable({ group, kind: KIND_LINES, line: true, ...(to ? { to } : {}), body: linesBody({ version: wire, from, lines: [l.subarray(i * PART_BYTES, (i + 1) * PART_BYTES)], head: b.head, part: { index: i, of, totalBytes: l.length } }) });
    }
    return;
  }
  await ctx.link.sendDurable({ group, kind: KIND_LINES, line: true, ...(to ? { to } : {}), body: linesBody({ version: wire, from, lines: b.lines, head: b.head }) });
}

/** A peer's `want`. */
export async function onWant(ctx: RepCtx, peer: PeerInfo, w: WantBody): Promise<void> {
  const wire = w.version;
  if (w.intro) { const i = ctx.directory.intro(wire); if (i) ctx.sendLive(KIND_INTRO, introBodyOf(i), peer.id); return; }
  await ctx.run(wire, async () => {
    const desc = ctx.directory.describe(wire);
    if (!desc) { sendNak(ctx, peer, wire, 0, 'unknown-version'); return; }
    const v = await ctx.localOf(wire);
    if (!v) { sendNak(ctx, peer, wire, 0, 'unavailable'); return; }
    let head: Head;
    try { head = await ctx.store.head(v.local); } catch (e) { sendNak(ctx, peer, wire, 0, e instanceof StoreError && e.code === 'damaged' ? 'unavailable' : 'unavailable'); return; }
    // while this copy is being repaired it cannot vouch for anything: say so, truthfully
    if (repairFrom(head) !== null) { sendNak(ctx, peer, wire, head.lines, 'unavailable'); return; }
    if (w.haveLines > head.lines) { sendNak(ctx, peer, wire, head.lines, 'gap'); return; }
    let mine: string | null;
    try { mine = await ctx.store.hashAt(v.local, 0, w.haveLines); } catch (e) { if (e instanceof StoreError && e.code === 'evicted') { sendNak(ctx, peer, wire, w.haveLines, 'evicted'); return; } throw e; }
    if (mine !== hex(w.haveHash)) { sendNak(ctx, peer, wire, w.haveLines, 'not-a-prefix', mine); return; }
    let through = Math.min(w.through ?? head.lines, head.lines);
    if (!desc.writer.equals(ctx.crypto.self)) { const newest = await ctx.heads.newest(wire); through = Math.min(through, newest ? newest.lines : 0); }
    if (w.haveLines >= through) { if (w.haveLines >= head.lines) return; sendNak(ctx, peer, wire, w.haveLines, 'unavailable'); return; }
    const key = keyOf(peer.hex, wire);
    const old = ctx.sessions.get(key);
    if (!old && ctx.sessions.size >= MAX_SESSIONS) { ctx.bump('serve-session-limit'); sendNak(ctx, peer, wire, w.haveLines, 'unavailable'); return; }
    old?.timer?.cancel();
    const s: ServeSession = { peer: peer.hex, wire, next: w.haveLines, acked: w.haveLines, through, inFlight: [], lastProgress: ctx.clock.now(), timer: null, pumping: false };
    ctx.sessions.set(key, s);
    armSession(ctx, key);
  });
  await pump(ctx, keyOf(peer.hex, wire));
}

function armSession(ctx: RepCtx, key: string): void {
  const s = ctx.sessions.get(key);
  if (!s) return;
  s.timer?.cancel();
  s.timer = ctx.clock.setTimeout(() => {
    const cur = ctx.sessions.get(key);
    if (cur !== s) return;
    if (ctx.clock.now() - s.lastProgress >= SESSION_STALL_MS) { ctx.sessions.delete(key); ctx.bump('serve-stalled'); } else armSession(ctx, key);
  }, SESSION_STALL_MS);
}

async function pump(ctx: RepCtx, key: string): Promise<void> {
  const s = ctx.sessions.get(key);
  if (!s || s.pumping) return;
  s.pumping = true;
  try {
    while (ctx.sessions.get(key) === s && s.inFlight.length < WINDOW_FRAMES && s.next < s.through) {
      if (!ctx.holds.take()) { ctx.clock.setTimeout(() => { void pump(ctx, key); }, Math.max(50, ctx.holds.retryInMs)); return; }
      const peer = ctx.peers.get(s.peer);
      const batch = await ctx.run(s.wire, async () => {
        const v = await ctx.localOf(s.wire);
        if (!v || !peer) return null;
        const head = await ctx.store.head(v.local);
        return { v, r: await buildBatch(ctx, s.wire, v.local, v.desc.writer, s.next, s.through, head) };
      }).catch((e: unknown) => { reportFailure({ what: 'read chat lines to send to another device', cause: e, where: 'mesh.replicator' }); return null; });
      if (!batch || !peer) { ctx.sessions.delete(key); return; }
      if ('nak' in batch.r) { sendNak(ctx, peer, s.wire, s.next, batch.r.nak); ctx.sessions.delete(key); return; }
      const bytes = batch.r.lines.reduce((n, l) => n + l.length, 0);
      if (!ctx.readBytes.take(bytes)) { ctx.clock.setTimeout(() => { void pump(ctx, key); }, 500); return; }
      const from = s.next; s.next = batch.r.end; s.inFlight.push({ end: batch.r.end, bytes });
      try { await sendBatch(ctx, s.wire, batch.v.desc.chatId, peer.id, from, batch.r); } catch (e) {
        ctx.sessions.delete(key); reportFailure({ what: 'send chat lines to another device', cause: e, where: 'mesh.replicator' }); return;
      } finally { ctx.readBytes.give(bytes); }
    }
  } finally { s.pumping = false; }
}

/** A peer's signed ack. Recorded only when it verifies AND matches my chain; the value may fall as well as rise (a peer can roll back). */
export async function onAck(ctx: RepCtx, peer: PeerInfo, a: AckBody): Promise<void> {
  if (!ctx.crypto.verify(peer.id, ackMessage(peer.id, a.version, a.lines, a.hash), a.sig)) { ctx.bump('ack-bad-signature'); return; }
  const wireHex = a.version.toString('hex');
  const v = await ctx.run(a.version, async () => {
    const x = await ctx.localOf(a.version);
    if (!x) return null;
    let mine: string | null = null;
    try { mine = await ctx.store.hashAt(x.local, 0, a.lines); } catch (e) { if (!(e instanceof StoreError && e.code === 'evicted')) throw e; mine = 'evicted'; }
    return { x, mine };
  }).catch((e: unknown) => { reportFailure({ what: 'check an acknowledgement from another device', cause: e, where: 'mesh.replicator' }); return null; });
  if (!v) return;
  // WHY the chain check: an ack by count alone would credit a peer holding DIFFERENT lines (invariant 4); an evicted value cannot be checked, so it is not credited either
  if (v.mine !== a.hash.toString('hex')) { ctx.bump('ack-not-on-my-chain'); peer.acks.delete(wireHex); return; }
  peer.acks.set(wireHex, { lines: a.lines, hash: a.hash.toString('hex'), sig: a.sig }); // set, never max(): it may be lower than before
  const key = keyOf(peer.hex, a.version);
  const s = ctx.sessions.get(key);
  if (s) {
    // the peer's count FELL below what it had acknowledged in this session: it rolled back. Drop the session; its next want starts again from what it now holds.
    if (a.lines < s.acked) { s.timer?.cancel(); ctx.sessions.delete(key); ctx.bump('peer-ack-fell'); return; }
    s.acked = a.lines;
    s.inFlight = s.inFlight.filter((f) => f.end > a.lines);
    if (a.lines > s.next) s.next = a.lines;
    s.lastProgress = ctx.clock.now();
    if (s.next >= s.through && s.inFlight.length === 0) { s.timer?.cancel(); ctx.sessions.delete(key); } else await pump(ctx, key);
  }
}

/** The writer's live push: every line appended since the last push goes to every device on the durable lane, so an offline device finds it waiting. Coalesces calls made in the same turn. */
export async function pushNew(ctx: RepCtx, wire: Buffer): Promise<void> {
  const run = ctx.runOf(wire);
  if (run.pushing) return;
  run.pushing = true;
  try {
    for (;;) {
      const step = await ctx.run(wire, async () => {
        const v = await ctx.localOf(wire);
        if (!v) return null;
        const head = await ctx.store.head(v.local);
        const from = run.pushedThrough ?? head.lines;
        if (from >= head.lines || repairFrom(head) !== null) { run.pushedThrough = Math.max(from, run.pushedThrough ?? 0); return null; }
        const r = await buildBatch(ctx, wire, v.local, v.desc.writer, from, head.lines, head);
        return { v, from, r };
      });
      if (!step || 'nak' in step.r) return;
      if (!ctx.pushRate.take()) { ctx.clock.setTimeout(() => { void pushNew(ctx, wire).catch((e: unknown) => reportFailure({ what: 'push new chat lines', cause: e, where: 'mesh.replicator' })); }, Math.max(20, ctx.pushRate.retryInMs)); return; }
      run.pushedThrough = step.r.end;
      await sendBatch(ctx, wire, step.v.desc.chatId, undefined, step.from, step.r);
    }
  } finally { run.pushing = false; }
}
