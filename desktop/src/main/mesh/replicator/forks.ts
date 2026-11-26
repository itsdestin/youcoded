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
import { chatGroup, type RepCtx } from './ctx';
import type { VersionDescriptor } from './directory';

/** The store's id of the CURRENT incarnation of `wire`, registered. null when it cannot be set up yet (a child waiting for its parent). */
export async function setupVersion(ctx: RepCtx, wire: Buffer, desc: VersionDescriptor): Promise<{ local: Buffer; incarnation: number } | null> {
  const run = ctx.runOf(wire);
  const cur = await ctx.ids.current(wire);
  if (cur.registered) return { local: cur.local, incarnation: cur.incarnation };
  const register = async (): Promise<{ local: Buffer; incarnation: number }> => {
    await ctx.store.registerVersion(cur.local, { chatId: desc.chatId, runtime: desc.runtime, parent: desc.parent });
    ctx.link.follow(chatGroup(ctx.setId, desc.chatId));
    return { local: cur.local, incarnation: cur.incarnation };
  };
  if (desc.parent === null || cur.incarnation > 0) return register(); // a recopy of a child is a whole copy (its fork point is inside the lines)
  const forkLine = desc.forkLine as number;
  const parentDesc = ctx.directory.describe(desc.parent);
  if (!parentDesc) { for (const p of ctx.peers.values()) askIntro(ctx, p, desc.parent); ctx.bump('fork-waits-for-parent-intro'); return null; }
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
    // pull the parent to the fork line first; the child is set up when it arrives (replicator.reconsider revisits waiting children)
    for (const p of ctx.peers.values()) if (p.heads.has(desc.parent.toString('hex'))) { await ctx.want(desc.parent, p, { through: forkLine }); break; }
    return null;
  } catch (e) {
    if (e instanceof StoreError && (e.code === 'corrupt' || e.code === 'damaged')) { ctx.bump('fork-waits-for-parent-repair'); return null; }
    run.stuck = e instanceof StoreError ? e.code : 'fork-error';
    reportFailure({ what: 'set up a forked chat version', cause: e, where: 'mesh.replicator' });
    return null;
  }
}
