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
import fs from 'fs';
import path from 'path';
import { isKnownRoot, isKnownProjectRef } from '../artifacts/read-service';
import { isPhoneDeniedFile, KEPT_ON_COMPUTER } from '../phone-read-deny';
import { uploadDir } from '../upload-store';
import { canonicalize } from '../../shared/artifacts/canonicalize';
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

/**
 * WHY (2026-10-01 one-core R3-SEC, review fix): the gate on a PHONE's fs:read-head, which used to answer for any file on
 * the computer. The only thing a phone previews through it is an attachment it just uploaded (AttachmentChip, the one
 * caller anywhere in the renderer), so it may read ONLY the temp folder uploads land in, never a project or home folder.
 * Judged on the resolved path, so a link in the upload folder to a file elsewhere is refused; the phone deny list is
 * checked as well. Null means allowed. A file that does not exist is judged by its typed name, so the answer never
 * tells a phone whether a path elsewhere exists.
 */
export async function refuseHeadOutsideKnownFolders(filePath: unknown): Promise<{ ok: false; error: string } | null> {
  if (typeof filePath !== 'string' || filePath.length === 0 || !path.isAbsolute(filePath)) return { ok: false, error: 'no path' };
  if (await isPhoneDeniedFile(filePath)) return { ok: false, error: KEPT_ON_COMPUTER };
  const real = await fs.promises.realpath(filePath).catch(() => path.resolve(filePath));
  const upDir = canonicalize(await fs.promises.realpath(uploadDir()).catch(() => uploadDir()), null);
  return canonicalize(real, null).startsWith(upDir + '/') ? null : { ok: false, error: 'not-allowed' };
}
