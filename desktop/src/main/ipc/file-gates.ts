// file-gates.ts — the folder gates a PHONE's file reads pass before anything is looked up.
//
// WHY (2026-09-30 one-core R3-7): these were private methods of the phone's socket server
// (remote-server.ts), called from a lookup table of its own. The file channels are table entries now, so
// the gates live beside them and each entry declares its own as its `remoteGuard`. Nothing changed in
// what they decide.
//
// Every root a phone names is checked against the roots the computer itself shows (saved folders,
// indexed projects) before any read (design 2026-09-10 §8 "same roots"; 2026-09-10 review of T6,
// finding 2). The computer's renderer only ever asks about roots it was given; a phone's payload is the
// phone's, and without this every read channel answered for any directory on the computer.
//
// A folder a live session runs in counts ONLY for that session's recorded files (`records: true`): the
// drawer's list, the existence check, a record read by its id, and Download's record route. WHY: a phone
// can start a session in any folder (and "No folder" lands in the home folder), so a session folder
// counting as a full root handed out every file in it by path (T7 re-review, finding 1).
import { isKnownRoot, isKnownProjectRef } from '../artifacts/read-service';
import { readSidecarShared } from '../artifacts/artifact-store';
import type { MainChannelCtx } from './channel-def';

type Refusal = { ok: false; error: string };

/** The folders of this phone's door's open sessions; none when called off the phone door. */
const sessionRoots = (ctx: MainChannelCtx): string[] => ctx.remote?.sessionRoots() ?? [];

export async function refuseUnknownRoot(root: unknown, ctx: MainChannelCtx, opts: { records?: boolean } = {}): Promise<Refusal | null> {
  if (typeof root !== 'string' || root.length === 0) return { ok: false, error: 'bad-request' };
  const known = opts.records ? await isKnownRoot(root, sessionRoots(ctx)) : await isKnownRoot(root);
  return known ? null : { ok: false, error: 'not-allowed' };
}

export async function refuseUnknownProject(projectId: unknown, ctx: MainChannelCtx, opts: { records?: boolean } = {}): Promise<Refusal | null> {
  if (typeof projectId !== 'string' || projectId.length === 0) return { ok: false, error: 'bad-request' };
  return (await isKnownProjectRef(projectId, opts.records ? sessionRoots(ctx) : [])) ? null : { ok: false, error: 'not-allowed' };
}

/** A record id the folder's sidecar actually holds. */
export async function refuseUnlessRecorded(root: string, artifactId: string): Promise<Refusal | null> {
  const sidecar = await readSidecarShared(root).catch(() => null);
  const recorded = !!sidecar && !('corrupted' in sidecar) && sidecar.artifacts.some((a) => a.id === artifactId);
  return recorded ? null : { ok: false, error: 'not-allowed' };
}
