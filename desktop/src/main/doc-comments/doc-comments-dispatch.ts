// The docComments:* IPC dispatch point — T3 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §1.1, §3.2,
// §4.1). Word (.docx) and Excel (.xlsx) files do NOT get a `PersistedComment`
// sidecar row — their comments live inside the file itself and are read in
// their own format (T10's docx-comments.ts, T12's xlsx-comments.ts). Every
// OTHER file type keeps using the sidecar store (T1, doc-comments-store.ts).
//
// WHY this is its own module rather than inlined in doc-comments/ipc-
// handlers.ts: BOTH desktop IPC (ipc-handlers.ts, via registerDocComments
// Handlers) and the remote WS surface (remote-server.ts) need to make this
// SAME by-extension decision identically — a fork here would let one surface
// silently disagree with the other about which files are sidecar-backed.
//
// Writes into .docx/.xlsx (T11/T13) have not landed yet: every mutation
// (add/reply/resolve/reopen/move) against one of these two extensions
// refuses honestly with `not-yet-supported` rather than either silently
// writing a sidecar nobody reads back for that file, or a no-op that looks
// like success.
import { promises as fs } from 'fs';
import path from 'path';
import { readDocxComments, type DocxReadResult } from './docx-comments';
import { readXlsxComments, type XlsxReadResult } from './xlsx-comments';
import { resolveSourceFilePath, type Refusal } from './doc-comments-store';
import { authorizeBytesRead } from '../artifacts/read-service';

export type NativeFormat = 'docx' | 'xlsx';

/** F1 fix (post-T3 build review, blocker): the no-`projectRoot` fallback in
 *  `resolveSourceFilePath` resolves and returns ANY absolute path the caller
 *  names, with no containment of its own — that fallback is deliberately open
 *  for the JSON *sidecar* location (§1.4: "no containment check applies here:
 *  there is no root to escape, only a hash of wherever the caller says the
 *  file is"), which never exposes the target file's own content. Reading
 *  actual file BYTES to parse as docx/xlsx is a materially different
 *  operation, so it refuses here instead. */
export type UntrackedSourceRefusal = { ok: false; error: 'path-not-tracked' };

/** Extension-based dispatch decision — the ONE place that decides "does this
 *  path have its comments inside the file itself." */
export function nativeFormatFor(filePath: string): NativeFormat | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  return null;
}

/** A mutation channel's shared first step: refuse immediately for a `.docx`/
 *  `.xlsx` target, before touching the sidecar store at all — returns `null`
 *  (proceed to the ordinary sidecar path) for every other extension. */
export function refuseNativeMutation(filePath: string): ({ ok: false; error: 'not-yet-supported' }) | null {
  return nativeFormatFor(filePath) ? { ok: false, error: 'not-yet-supported' } : null;
}

/** `docComments:list` for a `.docx`/`.xlsx` target: resolve the SOURCE file's
 *  own containment-verified absolute path (never a sidecar — there isn't
 *  one), read its bytes, and hand them to the matching T10/T12 reader. The
 *  reader's own `path` argument is the caller's ORIGINAL (project-relative or
 *  fallback-absolute) `path` — the same value every `PersistedComment.path`
 *  elsewhere in this feature carries (§1.1), not the resolved absolute one. */
export async function listNativeComments(
  format: NativeFormat,
  args: { path: string; projectRoot?: string }
): Promise<DocxReadResult | XlsxReadResult | Refusal | UntrackedSourceRefusal | { ok: false; error: 'read-failed' }> {
  const resolved = await resolveSourceFilePath(args);
  if (!resolved.ok) return resolved;
  // Gate 2 (F1 fix): only reachable when `args.projectRoot` was NOT supplied —
  // when it WAS, `resolveSourceFilePath` already ran `resolveSourceFilePath`'s
  // `projectRoot`-bearing branch, and by the time any caller reaches this
  // function that root has ALREADY been checked against the app's known
  // roots (doc-comments-gate.ts's `refuseUnknownProjectRoot`, run by both
  // ipc-handlers.ts and remote-server.ts before this dispatch is ever
  // reached), so its containment is real. With no `projectRoot` there is no
  // project to have vetted at all, so the resolved absolute path is only
  // trusted for a raw byte read when it's one of the same paths the artifacts
  // binary viewers already trust for exactly this: a project root, or a
  // tracked external artifact / explicit user-opened file
  // (`authorizeBytesRead`, `read-binary-access.ts`'s own authority) — never
  // an arbitrary caller-named absolute path.
  if (!args.projectRoot) {
    const auth = await authorizeBytesRead(resolved.absolutePath);
    if (!auth.ok) return { ok: false, error: 'path-not-tracked' };
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(resolved.absolutePath);
  } catch {
    // A resolved-but-unreadable path (permissions, or removed between
    // containment check and read) — an honest, typed refusal, never a thrown
    // exception into the IPC layer.
    return { ok: false, error: 'read-failed' };
  }
  return format === 'docx' ? readDocxComments(bytes, args.path) : readXlsxComments(bytes, args.path);
}
