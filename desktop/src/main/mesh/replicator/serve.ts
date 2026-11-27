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
import { MAX_SESSIONS, MAX_SESSIONS_PER_PEER, WINDOW_FRAMES } from './budget';
import { UNKNOWN_SPAN } from './signed-heads';
import { chatGroup, repairFrom, type PeerInfo, type RepCtx, type ServeSession } from './ctx';
import { sendAck, sendNak } from './receive';
import { onCorruptRead } from './repair';
import { headMessage, KIND_INTRO, KIND_LINES, linesBody, MAX_LINES_PER_FRAME, introBodyOf, PART_BYTES, PAYLOAD_BUDGET_BYTES, type AckBody, type NakWhy, type SignedHead, type WantBody, ackMessage } from './wire';

const SESSION_STALL_MS = 30_000;
const READ_STEP = 32;

interface Batch { lines: Buffer[]; end: number; head: SignedHead }

const keyOf = (peerHex: string, wire: Buffer): string => `${peerHex}/${wire.toString('hex')}`;

/** Build one batch starting at `from`, ending at a signed point and at or below `cap` (the writer's end is free; a non-writer's is its next held point). */
async function buildBatch(ctx: RepCtx, wire: Buffer, local: Buffer, writer: Buffer, from: number, cap: number, head: Head, cover: { lines: number; hash: Buffer; sig: Buffer } | null): Promise<Batch | { nak: NakWhy }> {
  try { return await buildBatchOnce(ctx, wire, local, writer, from, cap, head, cover); } catch (e) {
    // a corrupt read is the damage signal: this copy cannot serve (say so), and it starts repairing itself (plan: "read throws corrupt: enter refilling and send nak unavailable")
    if (e instanceof StoreError && e.code === 'corrupt') { await onCorruptRead(ctx, wire, local); return { nak: 'unavailable' }; }
    throw e;
  }
}
async function buildBatchOnce(ctx: RepCtx, wire: Buffer, local: Buffer, writer: Buffer, from: number, cap: number, head: Head, cover: { lines: number; hash: Buffer; sig: Buffer } | null): Promise<Batch | { nak: NakWhy }> {
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
  // the first saved point above `from` that the writer signed and that lies on MY chain (a writer that signed two histories leaves points that do not)
  let pt: Awaited<ReturnType<typeof ctx.heads.nextAfter>> = null;
  for (const c of await ctx.heads.pointsAfter(wire, from)) {
    if (c.lines > head.lines) break;
    if (!ctx.crypto.verify(writer, headMessage(wire, c.lines, c.hash), c.sig)) { ctx.bump('saved-point-bad-signature'); continue; }
    if ((await ctx.store.hashAt(local, 0, c.lines)) !== hex(c.hash)) { ctx.bump('saved-point-not-on-my-chain'); continue; }
    pt = c; break;
  }
  // finding 3: no saved point of mine reaches past `from`, but the ASKER holds a writer-signed point above its head and I hold the very lines it covers (same chain value there): serve up to it. The
  // asker checks the lines against that signature; I vouch for nothing, and no one appends a line that no writer signature covers.
  if (!pt && cover && cover.lines > from && cover.lines <= head.lines && cover.lines <= cap && ctx.crypto.verify(writer, headMessage(wire, cover.lines, cover.hash), cover.sig) && (await ctx.store.hashAt(local, 0, cover.lines)) === hex(cover.hash)) {
    pt = { lines: cover.lines, hash: cover.hash, sig: cover.sig, spanBytes: UNKNOWN_SPAN }; ctx.bump('served-to-cover');
  }
  if (!pt) return { nak: 'unavailable' };
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
  // F6: a version nobody announced to me gets one cheap nak and creates no queue, run or session
  if (!ctx.directory.describe(wire)) { sendNak(ctx, peer, wire, 0, 'unknown-version'); return; }
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
    // (no clamp to my newest signed point here: review 1 showed it redundant. buildBatch serves only up to a signed point on my chain and answers `unavailable` otherwise, so the clamp could only repeat that.)
    if (w.haveLines >= through) {
      // level with me: say so with a signed ack of my head (this is how a device asks "do you still hold these lines?", F2); behind my signed points: say I cannot help
      if (w.haveLines >= head.lines) { await sendAck(ctx, peer, wire, v.local, w.round); return; }
      sendNak(ctx, peer, wire, w.haveLines, 'unavailable'); return;
    }
    const key = keyOf(peer.hex, wire);
    const old = ctx.sessions.get(key);
    const ofPeer = [...ctx.sessions.values()].filter((x) => x.peer === peer.hex).length; // F6: one device cannot fill every session
    if (!old && (ctx.sessions.size >= MAX_SESSIONS || ofPeer >= MAX_SESSIONS_PER_PEER)) { ctx.bump('serve-session-limit'); sendNak(ctx, peer, wire, w.haveLines, 'unavailable'); return; }
    old?.timer?.cancel();
    const s: ServeSession = { cover: w.cover, peer: peer.hex, wire, next: w.haveLines, acked: w.haveLines, through, inFlight: [], lastProgress: ctx.clock.now(), timer: null, pumping: false };
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
        return { v, r: await buildBatch(ctx, s.wire, v.local, v.desc.writer, s.next, s.through, head, s.cover ?? null) };
      }).catch((e: unknown) => { reportFailure({ what: 'read chat lines to send to another device', cause: e, where: 'mesh.replicator' }); return null; });
      if (!batch || !peer) { ctx.sessions.delete(key); return; }
      if ('nak' in batch.r) { sendNak(ctx, peer, s.wire, s.next, batch.r.nak); ctx.sessions.delete(key); return; }
      const bytes = batch.r.lines.reduce((n, l) => n + l.length, 0);
      if (!ctx.readBytes.take(bytes)) { ctx.runOf(s.wire).serveWait = true; ctx.bump('serve-read-budget-wait'); ctx.clock.setTimeout(() => { void pump(ctx, key); }, 500); return; }
      ctx.runOf(s.wire).serveWait = false;
      const from = s.next; s.next = batch.r.end; s.inFlight.push({ end: batch.r.end, bytes });
      try { await sendBatch(ctx, s.wire, batch.v.desc.chatId, peer.id, from, batch.r); } catch (e) {
        ctx.sessions.delete(key); reportFailure({ what: 'send chat lines to another device', cause: e, where: 'mesh.replicator' }); return;
      } finally { ctx.readBytes.give(bytes); }
    }
  } finally { s.pumping = false; }
}

/** A peer's signed ack. Recorded only when it verifies AND matches my chain; the value may fall as well as rise (a peer can roll back). */
export async function onAck(ctx: RepCtx, peer: PeerInfo, a: AckBody): Promise<void> {
  if (!ctx.directory.describe(a.version)) { ctx.bump('ack-unknown-version-ignored'); return; } // F6
  if (!ctx.crypto.verify(peer.id, ackMessage(peer.id, a.version, a.lines, a.hash, a.round), a.sig)) { ctx.bump('ack-bad-signature'); return; }
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
  const now = ctx.clock.now();
  // WHY the round is checked: an ack that names a solicit round I never sent is not credited as an answer to one (it cannot be older than that solicit; a number I did not send proves nothing)
  const run = ctx.runOf(a.version);
  if (a.round > run.solicitRound) { ctx.bump('ack-round-unknown'); return; }
  peer.acks.set(wireHex, { lines: a.lines, hash: a.hash.toString('hex'), sig: a.sig, at: now, round: a.round }); // set, never max(): it may be lower than before
  // (review 2, findings 2 and 6: an ack no longer refreshes the sender's heads. A repairing device acks only what it can vouch for, and a refresh made BY the ack made the ack its own proof.)
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
        const from = Math.min(run.pushedThrough ?? head.lines, head.lines); // after a refill the head may be below what was pushed before
        if (from >= head.lines || repairFrom(head) !== null) { run.pushedThrough = Math.max(from, run.pushedThrough ?? 0); return null; }
        const r = await buildBatch(ctx, wire, v.local, v.desc.writer, from, head.lines, head, null);
        return { v, from, r };
      });
      if (!step || 'nak' in step.r) return;
      if (!ctx.pushRate.take()) { ctx.clock.setTimeout(() => { void pushNew(ctx, wire).catch((e: unknown) => reportFailure({ what: 'push new chat lines', cause: e, where: 'mesh.replicator' })); }, Math.max(20, ctx.pushRate.retryInMs)); return; }
      run.pushedThrough = step.r.end;
      await sendBatch(ctx, wire, step.v.desc.chatId, undefined, step.from, step.r);
    }
  } finally { run.pushing = false; }
}
