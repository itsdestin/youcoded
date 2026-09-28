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
// .docx WRITES (T11, docs/active/specs/2026-09-26-doc-comments-build-
// design.md §3.3) and .xlsx WRITES (T13, §4.3) are both real as of this
// module's `addNativeDocxComment`/`addNativeXlsxComment` etc. below — neither
// native format refuses any more. The by-extension dispatch pattern is
// unchanged: this is still the ONE place both desktop IPC (ipc-handlers.ts)
// and the remote WS surface (remote-server.ts) decide which files are
// native-format vs. sidecar-backed.
import { promises as fs } from 'fs';
import {
  readDocxComments,
  type DocxReadResult,
  addDocxComment,
  replyToDocxComment,
  resolveDocxComment,
  reopenDocxComment,
  moveDocxComment,
} from './docx-comments';
import {
  readXlsxComments,
  type XlsxReadResult,
  addXlsxComment,
  replyToXlsxComment,
  resolveXlsxComment,
  reopenXlsxComment,
  moveXlsxComment,
} from './xlsx-comments';
import { resolveSourceFilePath, resolveNativeFormat, type Refusal } from './doc-comments-store';
import { authorizeBytesRead } from '../artifacts/read-service';
import type { CommentAuthor, CommentReply, CommentSelector } from '../../shared/doc-comments-types';
// T3 follow-up (design §1.5's new per-document watcher): `nativeFormatFor`
// moved to its own module so `doc-comments-store.ts` can reuse it without a
// circular import (this file already imports FROM doc-comments-store.ts).
// Re-exported here so every existing caller (`ipc-handlers.ts`,
// `remote-server.ts`) keeps importing it from this module, unchanged.
//
// `resolveNativeFormat` (review finding #5, 2026-09-27): the SAME decision,
// but on the caller's path AFTER it's been resolved to its real target
// (following any symlink) — re-exported so every dispatch-decision call site
// can switch to it without a second import. `nativeFormatFor` itself stays
// exported too: `doc-comments-store.ts`'s own containment/locate logic still
// needs the plain, synchronous, no-I/O version internally.
import type { NativeFormat } from './native-format';
export { nativeFormatFor, type NativeFormat } from './native-format';
export { resolveNativeFormat };

/** F1 fix (post-T3 build review, blocker): the no-`projectRoot` fallback in
 *  `resolveSourceFilePath` resolves and returns ANY absolute path the caller
 *  names, with no containment of its own — that fallback is deliberately open
 *  for the JSON *sidecar* location (§1.4: "no containment check applies here:
 *  there is no root to escape, only a hash of wherever the caller says the
 *  file is"), which never exposes the target file's own content. Reading
 *  actual file BYTES to parse as docx/xlsx is a materially different
 *  operation, so it refuses here instead. */
export type UntrackedSourceRefusal = { ok: false; error: 'path-not-tracked' };

/** A mutation channel's shared first step: refuse immediately for a target
 *  this feature CANNOT yet write into. Both native formats now have a real
 *  write path (`.docx` — T11; `.xlsx` — T13), so this always returns `null`
 *  (proceed) today — kept as a single named check, rather than deleted
 *  outright, so `ipc-handlers.ts`/`remote-server.ts` have one place to wire a
 *  refusal into again if a future native format's write path lands after its
 *  read path does, the same staged order `.xlsx` itself went through. */
export function refuseNativeMutation(_filePath: string): ({ ok: false; error: 'not-yet-supported' }) | null {
  return null;
}

/** Resolves a `.docx` mutation's target the SAME way `listNativeComments`
 *  resolves its read target (§1.5's containment check when `projectRoot` is
 *  given; `authorizeBytesRead` — the artifacts binary viewers' own authority
 *  — when it isn't) before handing the verified absolute path to T11's write
 *  module. A write is at least as sensitive as a read, so it gets the exact
 *  same gate, never a looser one. */
async function resolveDocxTarget(
  args: { path: string; projectRoot?: string }
): Promise<{ ok: true; absolutePath: string } | Refusal | UntrackedSourceRefusal> {
  const resolved = await resolveSourceFilePath(args);
  if (!resolved.ok) return resolved;
  if (!args.projectRoot) {
    const auth = await authorizeBytesRead(resolved.absolutePath);
    if (!auth.ok) return { ok: false, error: 'path-not-tracked' };
  }
  return resolved;
}

export async function addNativeDocxComment(args: {
  path: string;
  projectRoot?: string;
  selector: CommentSelector;
  text: string;
  author: CommentAuthor;
}): Promise<{ ok: true; id: string; text: string } | Refusal | UntrackedSourceRefusal | { ok: false; error: string }> {
  const resolved = await resolveDocxTarget(args);
  if (!resolved.ok) return resolved;
  return addDocxComment({ absolutePath: resolved.absolutePath, path: args.path, selector: args.selector, text: args.text, author: args.author });
}

export async function replyToNativeDocxComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  text: string;
  author: CommentAuthor;
}): Promise<{ ok: true; reply: CommentReply } | Refusal | UntrackedSourceRefusal | { ok: false; error: string }> {
  const resolved = await resolveDocxTarget(args);
  if (!resolved.ok) return resolved;
  return replyToDocxComment({ absolutePath: resolved.absolutePath, path: args.path, id: args.id, text: args.text, author: args.author });
}

/** `by` is accepted for call-site symmetry with the generic `{path, id, by}`
 *  payload (§1.6) but not forwarded — see docx-comments.ts's own
 *  `resolveDocxComment`/`reopenDocxComment` doc comment for why a native
 *  Word comment has nowhere to record it. */
export async function resolveNativeDocxComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  by: CommentAuthor;
}): Promise<{ ok: true } | Refusal | UntrackedSourceRefusal | { ok: false; error: string }> {
  const resolved = await resolveDocxTarget(args);
  if (!resolved.ok) return resolved;
  return resolveDocxComment({ absolutePath: resolved.absolutePath, path: args.path, id: args.id });
}

export async function reopenNativeDocxComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  by: CommentAuthor;
}): Promise<{ ok: true } | Refusal | UntrackedSourceRefusal | { ok: false; error: string }> {
  const resolved = await resolveDocxTarget(args);
  if (!resolved.ok) return resolved;
  return reopenDocxComment({ absolutePath: resolved.absolutePath, path: args.path, id: args.id });
}

export async function moveNativeDocxComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  newSelector: CommentSelector;
}): Promise<{ ok: true } | Refusal | UntrackedSourceRefusal | { ok: false; error: string }> {
  const resolved = await resolveDocxTarget(args);
  if (!resolved.ok) return resolved;
  return moveDocxComment({ absolutePath: resolved.absolutePath, path: args.path, id: args.id, newSelector: args.newSelector });
}

/** T13's own `.xlsx` equivalent of `resolveDocxTarget` — same containment/
 *  untracked-source gate, never a looser one, since a write is at least as
 *  sensitive as a read. */
async function resolveXlsxTarget(
  args: { path: string; projectRoot?: string }
): Promise<{ ok: true; absolutePath: string } | Refusal | UntrackedSourceRefusal> {
  const resolved = await resolveSourceFilePath(args);
  if (!resolved.ok) return resolved;
  if (!args.projectRoot) {
    const auth = await authorizeBytesRead(resolved.absolutePath);
    if (!auth.ok) return { ok: false, error: 'path-not-tracked' };
  }
  return resolved;
}

export async function addNativeXlsxComment(args: {
  path: string;
  projectRoot?: string;
  selector: CommentSelector;
  text: string;
  author: CommentAuthor;
}): Promise<{ ok: true; id: string; text: string } | Refusal | UntrackedSourceRefusal | { ok: false; error: string; features?: string[] }> {
  const resolved = await resolveXlsxTarget(args);
  if (!resolved.ok) return resolved;
  return addXlsxComment({ absolutePath: resolved.absolutePath, path: args.path, selector: args.selector, text: args.text, author: args.author });
}

/** Review leftover (a): now enriched with the persisted `CommentReply`,
 *  mirroring `replyToNativeDocxComment` above — `xlsx-comments.ts`'s own
 *  `replyToXlsxComment` mints a real per-reply GUID and computes its
 *  ordinal from the thread's current full transcript, so its id can't be
 *  pre-computed by the renderer the way a brand-new comment's own id can.
 *  The renderer's reconciliation (`doc-comments-store.ts`'s `addReply`)
 *  already reads `res.reply` generically (format-agnostic) — this needed no
 *  renderer-side change to take effect. */
export async function replyToNativeXlsxComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  text: string;
  author: CommentAuthor;
}): Promise<{ ok: true; reply: CommentReply } | Refusal | UntrackedSourceRefusal | { ok: false; error: string; features?: string[] }> {
  const resolved = await resolveXlsxTarget(args);
  if (!resolved.ok) return resolved;
  return replyToXlsxComment({ absolutePath: resolved.absolutePath, path: args.path, id: args.id, text: args.text, author: args.author });
}

/** `by` is accepted for call-site symmetry with the generic `{path, id, by}`
 *  payload (§1.6) but not forwarded — see xlsx-comments.ts's own
 *  `resolveXlsxComment`/`reopenXlsxComment` doc comment for why a native
 *  Excel Note has nowhere to record it. */
export async function resolveNativeXlsxComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  by: CommentAuthor;
}): Promise<{ ok: true } | Refusal | UntrackedSourceRefusal | { ok: false; error: string; features?: string[] }> {
  const resolved = await resolveXlsxTarget(args);
  if (!resolved.ok) return resolved;
  return resolveXlsxComment({ absolutePath: resolved.absolutePath, path: args.path, id: args.id });
}

export async function reopenNativeXlsxComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  by: CommentAuthor;
}): Promise<{ ok: true } | Refusal | UntrackedSourceRefusal | { ok: false; error: string; features?: string[] }> {
  const resolved = await resolveXlsxTarget(args);
  if (!resolved.ok) return resolved;
  return reopenXlsxComment({ absolutePath: resolved.absolutePath, path: args.path, id: args.id });
}

/** Review F3 (Medium) partial fix: now returns the moved thread's FRESH id
 *  (embedding its new cell) — `xlsx-comments.ts`'s own `moveXlsxComment` doc
 *  comment has the full reasoning (a moved thread's OLD id's embedded-cell
 *  hint goes stale the moment it moves, making the very next call pay for a
 *  full-workbook fallback scan unless the caller has a fresh one). */
export async function moveNativeXlsxComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  newSelector: CommentSelector;
}): Promise<{ ok: true; id: string } | Refusal | UntrackedSourceRefusal | { ok: false; error: string; features?: string[] }> {
  const resolved = await resolveXlsxTarget(args);
  if (!resolved.ok) return resolved;
  return moveXlsxComment({ absolutePath: resolved.absolutePath, path: args.path, id: args.id, newSelector: args.newSelector });
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
