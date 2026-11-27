// Setting a version up in the store, including the local fork of a takeover (plan section 3, "Fork").
//
// A takeover makes a NEW version (child) whose first N lines equal its parent's. If this device already holds the parent through that line, with the chain value the
// announcement names, and the child id is the derived one (the directory already checked that), the child is made locally with `forkVersion`: no bytes travel. Otherwise the
// parent is pulled to the fork line first. The parent keeps running untouched (its own writer may keep appending to it).
//   * `evicted` from forkVersion (the parent's bodies are gone): register the child empty and copy all of it from a peer.
//   * `version-conflict` (the child id exists with another parent or other first lines): `stuck`, loudly, never merged.
import { StoreError } from '../store';
import { reportFailure } from '../../report-failure';
import { hex } from '../store/chain';
import { askIntro } from './receive';
import { WANT_GAP_MS } from './budget';
import { incarnationId, MAX_INCARNATIONS } from './idmap';
import { chatGroup, type RepCtx } from './ctx';
import type { VersionDescriptor } from './directory';

/** The store's id of the CURRENT incarnation of `wire`, registered. null when it cannot be set up yet (a child waiting for its parent). */
/** Folders already checked against their description, so the (whole-store) listing runs once per version per process (F3). */
const verifiedFolders = new WeakMap<object, Set<string>>();

/** A folder found already registered under the derived id must be THIS version's: same chat, same parent (review 1, F3). Anything else is a squatter or a mistake: not used, named. */
async function folderIsThisVersion(ctx: RepCtx, local: Buffer, desc: VersionDescriptor): Promise<boolean> {
  let seen = verifiedFolders.get(ctx.store); if (!seen) { seen = new Set(); verifiedFolders.set(ctx.store, seen); }
  const key = `${local.toString('hex')}/${desc.chatId}/${desc.parent ? desc.parent.toString('hex') : ''}`;
  if (seen.has(key)) return true;
  const all = await ctx.store.listVersions();
  const mine = all.find((x) => x.version.equals(local));
  if (!mine || mine.chatId === null) return true; // not listed or too damaged to say: the store's own damage handling decides
  // a forked child's folder names its parent's STORE id (forkVersion), a child registered whole names the parent's wire id: either, for any incarnation of the parent, is this version's
  const parentOk = ((): boolean => {
    if (!desc.parent) return mine.parent === null;
    if (!mine.parent) return false;
    const got = mine.parent.toString('hex');
    if (got === desc.parent.toString('hex')) return true;
    for (let n = 0; n <= MAX_INCARNATIONS; n++) if (incarnationId(desc.parent, n).toString('hex') === got) return true;
    return false;
  })();
  if (mine.chatId !== desc.chatId || !parentOk) return false;
  seen.add(key);
  return true;
}

export async function setupVersion(ctx: RepCtx, wire: Buffer, desc: VersionDescriptor): Promise<{ local: Buffer; incarnation: number } | null> {
  const run = ctx.runOf(wire);
  const cur = await ctx.ids.current(wire);
  // The store retired the copy under us (the id map moved up an incarnation, review 1, F2): from here on the version is a fresh copy that must be refilled before it counts for anything,
  // and the other devices must hear at once what this device holds now, so no acknowledgement of the old copy outlives it.
  const retiredNow = run.incarnationSeen !== null && cur.incarnation > run.incarnationSeen;
  run.incarnationSeen = Math.max(run.incarnationSeen ?? 0, cur.incarnation);
  if (retiredNow) { run.caughtUp = false; run.retiredRecopy = true; run.lastSigned.clear(); run.refill = null; ctx.bump('retired-by-store'); ctx.heads.forget(wire); }
  if (cur.registered) {
    if (!(await folderIsThisVersion(ctx, cur.local, desc))) { run.stuck = 'folder-belongs-to-another-version'; ctx.bump('folder-belongs-to-another-version'); return null; }
    if (retiredNow) ctx.advertise();
    return { local: cur.local, incarnation: cur.incarnation };
  }
  const register = async (): Promise<{ local: Buffer; incarnation: number }> => {
    await ctx.store.registerVersion(cur.local, { chatId: desc.chatId, runtime: desc.runtime, parent: desc.parent });
    ctx.link.follow(chatGroup(ctx.setId, desc.chatId));
    if (retiredNow) ctx.advertise(); // the new copy exists now, so what is advertised is what it holds
    return { local: cur.local, incarnation: cur.incarnation };
  };
  // A child is (re)made by forking from its parent EVERY time, a recopy too (fuzz, review 1): a forked child's first lines were never sent as signed batches of its own (they were copied locally),
  // so no peer can serve them; a whole copy from line 0 would wait for signed points that do not exist. The lines after the fork point do come from peers.
  if (desc.parent === null) return register();
  const forkLine = desc.forkLine as number;
  const parentDesc = ctx.directory.describe(desc.parent);
  if (!parentDesc) {
    // asked for at most every WANT_GAP_MS (fuzz seed 815612: every answer made the next ask, without end)
    const nowMs = ctx.clock.now();
    if (run.parentAskAt === null || nowMs - run.parentAskAt >= WANT_GAP_MS) { run.parentAskAt = nowMs; for (const p of ctx.peers.values()) askIntro(ctx, p, desc.parent); }
    ctx.bump('fork-waits-for-parent-intro'); return null;
  }
  const parent = await ctx.localOf(desc.parent);
  if (!parent) return null;
  try {
    const ph = await ctx.store.head(parent.local);
    if (ph.lines >= forkLine && (await ctx.store.hashAt(parent.local, 0, forkLine)) === hex(desc.forkHash as Buffer)) {
      try {
        await ctx.store.forkVersion(parent.local, forkLine, cur.local);
        ctx.link.follow(chatGroup(ctx.setId, desc.chatId));
        ctx.bump('fork-local');
        if (run.stuck === 'corrupt' || run.stuck === 'fork-error') run.stuck = null; // an earlier, transient refusal is over
        return { local: cur.local, incarnation: cur.incarnation };
      } catch (e) {
        if (e instanceof StoreError && e.code === 'evicted') { ctx.bump('fork-evicted-copy-all'); return register(); }
        // the PARENT is being repaired (the store refuses to copy from a copy it reports as damaged): wait; the parent's repair revisits its waiting children. Not a stuck state.
        if (e instanceof StoreError && (e.code === 'corrupt' || e.code === 'damaged')) { ctx.bump('fork-waits-for-parent-repair'); return null; }
        if (e instanceof StoreError && e.code === 'version-conflict') { run.stuck = 'fork-conflict'; reportFailure({ what: 'make a local fork (the id is used for something else)', cause: e, where: 'mesh.replicator' }); return null; }
        throw e;
      }
    }
    if (ph.lines >= forkLine) { ctx.bump('fork-parent-mismatch-copy-all'); return register(); } // my parent differs from the one the takeover names: copy the child whole
    // pull the parent to the fork line first; the child is set up when it arrives (replicator.reconsider revisits waiting children).
    // The ask is repeated only when the parent has GROWN since the last one or WANT_GAP_MS have passed: a peer that cannot serve answers at once, and an immediate re-ask made two devices ping-pong at full speed (fuzz seed 815612).
    const nowMs = ctx.clock.now();
    if (run.parentAskLines === ph.lines && run.parentAskAt !== null && nowMs - run.parentAskAt < WANT_GAP_MS) { ctx.bump('fork-parent-ask-held-back'); return null; }
    run.parentAskAt = nowMs; run.parentAskLines = ph.lines;
    for (const p of ctx.peers.values()) if (p.heads.has(desc.parent.toString('hex'))) { await ctx.want(desc.parent, p, { through: forkLine }); break; }
    return null;
  } catch (e) {
    if (e instanceof StoreError && (e.code === 'corrupt' || e.code === 'damaged')) { ctx.bump('fork-waits-for-parent-repair'); return null; }
    run.stuck = e instanceof StoreError ? e.code : 'fork-error';
    reportFailure({ what: 'set up a forked chat version', cause: e, where: 'mesh.replicator' });
    return null;
  }
}
