// Repair: what the replicator does when the store REPORTS trouble (plan section 3, "Rollback or damage report", "Rejected parks", and the retire-and-recopy path).
//
// The store never fetches and never repairs from outside its folder; it only reports (inventory.ts rules (iii) to (v)). Everything here is the caller's half:
//  * a rollback or damage report: release every park, advertise only the point I can vouch for, ask for [from, end) including lines I never saw acknowledged,
//    and clear the state ONLY when the store itself says so (head().partial, rolledBack and damagedFromLine all null AND a read of the range succeeds);
//  * a version that cannot be trusted (`not-a-prefix` under a valid writer signature with damaged bytes, or the typed `damaged` throw): retire the local id and
//    recopy under the next incarnation (idmap.ts). Nothing is deleted: the store moves the files aside.
import { StoreError } from '../store';
import type { Head } from '../store';
import { reportFailure } from '../../report-failure';
import type { RepCtx } from './ctx';
import { repairFrom } from './ctx';

const SCRUB_SLICE_BYTES = 4 * 1024 * 1024;
const READ_SLICE_LINES = 128;

/** Run the integrity scrub in slices until it has covered the version or found damage; yields between slices so the main thread is never held (plan risk 6). Returns the first damaged line or null. */
export async function scrubAll(ctx: RepCtx, local: Buffer): Promise<number | null> {
  for (let guard = 0; guard < 1_000_000; guard++) {
    const r = await ctx.store.scrubStep(local, { maxBytes: SCRUB_SLICE_BYTES });
    if (r.damagedFromLine !== null) return r.damagedFromLine;
    if (r.verifiedLines >= r.total) return null;
    await new Promise<void>((res) => setImmediate(res)); // WHY: one slice per turn of the event loop
  }
  throw new Error('scrub did not finish'); // cannot happen with a finite version; loud rather than an endless loop
}

/** Set the damaged copy aside (the store keeps every byte) and start the next incarnation from nothing. */
export async function retireAndRecopy(ctx: RepCtx, wire: Buffer, why: string): Promise<void> {
  const run = ctx.runOf(wire);
  const cur = await ctx.ids.current(wire);
  // Nothing registered at the current incarnation: the copy that was found damaged has already been retired and replaced under us (the store retired it, or another step did). There is nothing to
  // set aside, and marking the NEXT, never-registered incarnation retired would skip it and leave two live copies (fuzz seed 605068).
  if (!cur.registered) { ctx.bump('retire-already-done'); await ctx.reconsider(wire); return; }
  if (cur.registered) {
    try { await ctx.store.setAsideDamaged(cur.local); } catch (e) {
      // an id that is already retired answers the same: idempotent. Anything else is a real failure and stays loud.
      if (!(e instanceof StoreError && e.code === 'damaged')) { run.stuck = 'cannot-set-aside'; reportFailure({ what: 'set a damaged chat copy aside', cause: e, where: 'mesh.replicator' }); return; }
    }
  }
  ctx.ids.retired(wire, cur.incarnation);
  run.recopies++; run.retiredRecopy = true; run.refill = null; run.lastSigned.clear(); run.seenRejected = 0; run.caughtUp = false;
  ctx.bump('retired-recopy');
  ctx.heads.forget(wire);
  // the new incarnation is registered lazily by localOf; then everything is asked for again from line 0
  await ctx.reconsider(wire); // registers the new, empty incarnation
  // WHY at once (review 1, F2): the other devices still list the retired copy's acknowledgement until they hear what this device holds now; the new copy is empty, and saying so drops it immediately
  ctx.advertise();
}

/** After any append or at a tick: look at what the store says about this version and act on it. Never throws; a failure is named in the version's status. */
export async function checkRepair(ctx: RepCtx, wire: Buffer): Promise<void> {
  const run = ctx.runOf(wire);
  const v = await ctx.localOf(wire);
  if (!v) return;
  let head: Head;
  try { head = await ctx.store.head(v.local); } catch (e) {
    if (e instanceof StoreError && e.code === 'damaged') { await retireAndRecopy(ctx, wire, 'store-damaged'); return; }
    run.stuck = e instanceof StoreError ? e.code : 'store-error';
    reportFailure({ what: 'read a chat copy before repairing it', cause: e, where: 'mesh.replicator' });
    return;
  }
  run.lastHead = { lines: head.lines, incarnation: v.incarnation };
  // 1. parks are never kept for peer lines (invariant 2): drain whatever the store holds so a stale park cannot refill an acknowledged position (rule v)
  const parked = await ctx.store.parkedList(v.local);
  for (const p of parked) { await ctx.store.releaseParked(v.local, p.name); ctx.bump('park-released'); }
  // 2. parks the store refused: ask again for the lines they carried, from the peer that has them
  if (head.rejectedParks > run.seenRejected) {
    const rej = await ctx.store.rejectedList(v.local);
    run.seenRejected = head.rejectedParks;
    const lowest = rej.reduce<number | null>((m, r) => (m === null ? r.fromLine : Math.min(m, r.fromLine)), null);
    if (lowest !== null) { ctx.bump('rejected-park-reasked'); if (lowest < head.lines) run.refill = run.refill ?? { from: lowest, end: head.lines }; }
  }
  // 3. rollback / damage / set-aside report (rule v): refill from `from` through the source's head
  const from = repairFrom(head);
  if (from !== null) {
    const end = Math.max(head.partial?.end ?? 0, head.rolledBack?.had ?? 0, head.lines);
    run.refill = { from, end };
    run.stuck = null;
    ctx.advertise();
    await ctx.reconsider(wire);
    return;
  }
  // 4. clear ONLY on store evidence: the store reports nothing AND the whole range reads back
  if (run.refill) {
    const r = run.refill;
    try {
      // WHY the WHOLE version and not just [from, end): a second fault below the line the store first named (it reports the FIRST damaged line) is invisible to the report, and a refill cleared on the
      // repaired range alone left a rotted line 0 declared healthy (fuzz seed 2563). Every read checks its lines against the chain, so reading it all is the store's own evidence.
      for (let n = 0; n < head.lines; n += READ_SLICE_LINES) {
        const got = await ctx.store.read(v.local, 0, n, Math.min(head.lines, n + READ_SLICE_LINES));
        if (got === 'evicted') break; // evicted bodies cannot be re-read here; they are the storage policy's
        await new Promise<void>((res) => setImmediate(res));
      }
      if (head.lines >= r.end) { run.refill = null; ctx.bump('refill-cleared'); ctx.advertise(); }
      else await ctx.reconsider(wire); // reads work but the source's head is not reached yet
    } catch (e) {
      // a corrupt read is the damage signal (store.read note): stay in refill and ask again
      ctx.bump('refill-read-failed');
      if (!(e instanceof StoreError && (e.code === 'corrupt' || e.code === 'evicted'))) reportFailure({ what: 'check a refilled chat copy', cause: e, where: 'mesh.replicator' });
      await ctx.reconsider(wire);
    }
  }
}

/** A `read` threw `corrupt`: the store's damage signal (head().damagedFromLine can stay null until a scrub). Scrub to make the store say where, then repair from what it says; if the scrub
 *  finds nothing the read failure is unexplained and the version says so (stuck), never "fine". Runs inside the version's queue. */
export async function onCorruptRead(ctx: RepCtx, wire: Buffer, local: Buffer): Promise<void> {
  const run = ctx.runOf(wire);
  ctx.bump('corrupt-read');
  const dmg = await scrubAll(ctx, local);
  if (dmg === null) {
    // the scrub names nothing: either the damage was healed between the failing read and now (a resend repaired it), or it is real and unexplained. A full check tells them apart.
    if ((await ctx.store.verify(local)).ok) { ctx.bump('corrupt-read-already-healed'); return; }
    run.stuck = 'corrupt-read-unexplained'; reportFailure({ what: 'explain a damaged read of a chat copy (the scrub found nothing)', where: 'mesh.replicator' }); return;
  }
  await checkRepair(ctx, wire);
}
