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

export type NativeFormat = 'docx' | 'xlsx';

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
): Promise<DocxReadResult | XlsxReadResult | Refusal | { ok: false; error: 'read-failed' }> {
  const resolved = await resolveSourceFilePath(args);
  if (!resolved.ok) return resolved;
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
