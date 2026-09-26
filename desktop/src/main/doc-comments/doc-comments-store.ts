// Main-process store for document comments — T1 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §1.5). Owns:
// resolving a (path, projectRoot) pair to its one-sidecar-per-file location
// (§1.3/§1.4), refusing anything that resolves outside the project (§1.5,
// review 2 F1's corrected, full-path-realpath containment check), and every
// read/mutation against that sidecar via mutateFileUnderLock — the same
// primitive artifact-store.ts already trusts for cross-process safety
// between a dev instance and the built app sharing ~/.claude/~/YouCoded
// (docs/PITFALLS.md → "Shared state").
//
// WHY this stays Electron-free: this module is pure Node fs + path logic on
// purpose, so it is unit-testable without a renderer/Electron harness AND so
// a future MCP-script implementation (§9, T9a) can be checked for identical
// on-disk behaviour without importing anything from this main process. IPC
// wiring (chokidar, broadcasts, the docComments:* channels) is T3's job, not
// this one.
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import type {
  CommentAuthor,
  CommentSelector,
  CommentsSidecarFile,
  PersistedComment,
} from '../../shared/doc-comments-types';

const SIDECAR_DIR = ['.youcoded', 'comments'];
const FALLBACK_DIR = ['.youcoded', 'loose-file-comments'];

// Not exported: nothing outside this module needs the error union by name
// yet (T3/T8/T9a will build their own IPC/tool-facing error shapes on top of
// `Refusal`, which IS exported below) — knip counts a bare export nobody
// imports as dead code (see doc-comments-store.ts's use of the same
// convention on artifact-store.ts's private helpers).
type DocCommentsError = 'path-outside-project' | 'lock-timeout' | 'comment-not-found';

/** A refusal shared by every entry point below — a typed error the caller
 *  surfaces honestly (§1.5), never a silent clamp or a thrown exception. */
export type Refusal = { ok: false; error: DocCommentsError };

/**
 * Follows symlinks the whole way down `targetAbs`, walking up to the nearest
 * EXISTING ancestor when the leaf (or an intermediate segment) doesn't exist
 * yet and re-joining the not-yet-real suffix onto that ancestor's realpath.
 *
 * WHY walk up instead of falling through to the raw path on ENOENT
 * (git-service.ts's `locate()` does exactly that, for a different subsystem):
 * falling through here would let a `../../etc/passwd`-shaped or not-yet-
 * existing attacker path dodge the containment check simply by not existing
 * — write-authorization.ts's `judgeRelativeRecord()` fails closed on ENOENT
 * instead (review 2, F1), and this mirrors that.
 *
 * Returns null only when even the filesystem root can't be realpathed.
 */
async function realpathWithNonexistentTail(targetAbs: string): Promise<string | null> {
  try {
    return await fs.realpath(targetAbs);
  } catch (e: any) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }
  const segments: string[] = [];
  let dir = targetAbs;
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit the filesystem root; nothing exists
    segments.unshift(path.basename(dir));
    try {
      const realParent = await fs.realpath(parent);
      return path.join(realParent, ...segments);
    } catch (e: any) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      dir = parent;
    }
  }
}

/**
 * §1.5 as corrected by review 2 (F1 — a blocker): realpath the FULL joined
 * path (via the walk-up above), not just the project root, and test THAT
 * against the realpathed root. This is write-authorization.ts's
 * `judgeRelativeRecord()` shape (realpath the full path), not
 * git-service.ts's shallower root-only `locate()` — round 1's fix mirrored
 * the weaker one, which would let a symlink INSIDE the project (a
 * `notes.md` -> `~/.ssh/config`) dodge containment, since readFile/writeFile
 * follow symlinks regardless of what the unresolved path claims to be.
 */
async function checkContainment(realProjectRoot: string, abs: string): Promise<boolean> {
  const realAbs = await realpathWithNonexistentTail(abs);
  if (realAbs === null) return false;
  const withSep = realProjectRoot.endsWith(path.sep) ? realProjectRoot : realProjectRoot + path.sep;
  return realAbs === realProjectRoot || realAbs.startsWith(withSep);
}

interface Located {
  sidecarPath: string;
}

/**
 * §1.3's sidecar location for a file inside a known project, refused when
 * `filePath` (model-controlled input at the IPC/tool/MCP surfaces the real
 * callers use — §1.5) resolves outside `projectRoot`, including via an
 * absolute-path-shaped argument (`path.resolve` with an absolute second
 * argument ignores the first, so it naturally lands outside `realProjectRoot`
 * and gets refused the same way) or a symlink.
 *
 * WHY the returned `sidecarPath` is built from `realProjectRoot` plus the
 * UNRESOLVED relative suffix, rather than from `checkContainment`'s own
 * fully-resolved path: review 2 (F3) found that realpathing the LEAF sidecar
 * path (for lock-path purposes) throws ENOENT on a file's first-ever comment
 * — the single most common case — and both racing writers then fell through
 * to a non-canonical path, silently reopening the alias trap the
 * canonicalization existed to close. Canonicalizing the project root only
 * (it always exists — this is an open project) and joining the relative
 * suffix gives every caller — this process's next call, a second YouCoded
 * instance, the MCP script (§9) — the SAME stable path whether or not the
 * sidecar exists yet, and that same path is what mutateFileUnderLock below
 * derives its lock name from (`sidecarPath + '.lock'`), so two processes
 * agreeing on `sidecarPath` is what actually excludes them from each other.
 */
async function locateInProject(projectRoot: string, filePath: string): Promise<Located | { ok: false; error: 'path-outside-project' }> {
  let realProjectRoot: string;
  try {
    realProjectRoot = await fs.realpath(projectRoot);
  } catch {
    return { ok: false, error: 'path-outside-project' };
  }
  const abs = path.resolve(realProjectRoot, filePath);
  if (!(await checkContainment(realProjectRoot, abs))) {
    return { ok: false, error: 'path-outside-project' };
  }
  const rel = path.relative(realProjectRoot, abs);
  const sidecarPath = path.join(realProjectRoot, ...SIDECAR_DIR, `${rel}.json`);
  return { sidecarPath };
}

/**
 * §1.4's fallback for a file with no known project root (opened standalone,
 * or before workspace-start registers its directory): a global, per-machine
 * store keyed by a hash of the file's own resolved absolute path —
 * explicitly local-only (matches `~/.youcoded/permission-modes.json`'s own
 * "per machine, never synced" precedent) and orphaned if the file's absolute
 * path changes, the same accepted limitation `useMissingArtifacts.ts` already
 * has at the artifact level. No containment check applies here: there is no
 * root to escape, only a hash of wherever the caller says the file is.
 */
async function locateFallback(absoluteFilePath: string): Promise<string> {
  const abs = path.resolve(absoluteFilePath);
  const resolved = (await realpathWithNonexistentTail(abs)) ?? abs;
  const hash = createHash('sha256').update(resolved).digest('hex');
  return path.join(os.homedir(), ...FALLBACK_DIR, `${hash}.json`);
}

async function resolveSidecarPath(args: {
  path: string;
  projectRoot?: string;
}): Promise<{ ok: true; sidecarPath: string } | { ok: false; error: 'path-outside-project' }> {
  if (args.projectRoot) {
    const located = await locateInProject(args.projectRoot, args.path);
    if ('error' in located) return located;
    return { ok: true, sidecarPath: located.sidecarPath };
  }
  return { ok: true, sidecarPath: await locateFallback(args.path) };
}

function emptySidecar(): CommentsSidecarFile {
  return { version: 1, comments: [] };
}

function parseSidecar(onDisk: string | null): CommentsSidecarFile {
  if (onDisk === null) return emptySidecar();
  return JSON.parse(onDisk) as CommentsSidecarFile;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A GET has nothing to lock — plain async read, non-blocking (performance.md
 *  rule 1: no *Sync fs on a path an IPC call reaches). A missing sidecar is
 *  the overwhelmingly common case (a file with zero comments), so it returns
 *  an empty list, never an error. */
export async function listComments(args: {
  path: string;
  projectRoot?: string;
}): Promise<{ ok: true; comments: PersistedComment[] } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  let raw: string;
  try {
    raw = await fs.readFile(resolved.sidecarPath, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return { ok: true, comments: [] };
    throw e;
  }
  return { ok: true, comments: parseSidecar(raw).comments };
}

// ---------------------------------------------------------------------------
// Mutations — every one goes through mutateFileUnderLock (read-modify-write
// entirely inside the mkdir lock), never a bare read-then-write, so two
// writers racing the same sidecar (this process's own concurrent calls, a
// dev instance and the built app, or a future MCP-script invocation) can't
// interleave and drop one side's change.
// ---------------------------------------------------------------------------

/** Shared plumbing for every mutation below: resolve the sidecar path, run
 *  `apply` against the current on-disk contents (or an empty sidecar) inside
 *  the lock, and write back only when `apply` found what it needed. Returning
 *  the string `'not-found'` from `apply` skips the write entirely — a failed
 *  lookup must never write anything, not even an unchanged copy.
 *
 *  `Extra` is always inferred from `apply`'s own return type at each call
 *  site (`{id}` for addComment, `{}` for the rest) — never defaulted to a
 *  `Record<string, never>`-shaped placeholder, which would make `{ok:true} &
 *  Extra` an uninhabitable type (the `ok` property itself would have to
 *  satisfy an index signature of `never`). */
async function mutateSidecar<Extra extends Record<string, unknown>>(
  sidecarPath: string,
  apply: (file: CommentsSidecarFile) => { file: CommentsSidecarFile; extra: Extra } | 'not-found'
): Promise<({ ok: true } & Extra) | Refusal> {
  // A plain object wrapper, not a reassigned `let` — the mutate callback
  // below runs inside `mutateFileUnderLock`, a separate function, so a
  // captured `let` variable's flow-narrowing does not see those inner
  // assignments and would report this as always `null` after the `await`.
  const box: { outcome: (({ ok: true } & Extra) | Refusal) | null } = { outcome: null };
  const acquired = await mutateFileUnderLock(sidecarPath, (onDisk) => {
    const current = parseSidecar(onDisk);
    const applied = apply(current);
    if (applied === 'not-found') {
      box.outcome = { ok: false, error: 'comment-not-found' };
      return null;
    }
    box.outcome = { ok: true, ...applied.extra };
    return JSON.stringify(applied.file);
  });
  if (!acquired) return { ok: false, error: 'lock-timeout' };
  if (box.outcome === null) {
    // Unreachable in practice: mutateFileUnderLock only skips invoking
    // `mutate` when it returns false (the lock-timeout case above), which is
    // already handled. Thrown rather than cast past, so a future change to
    // that contract fails loudly instead of returning a bogus `Refusal`.
    throw new Error('doc-comments-store: mutateFileUnderLock resolved without invoking its mutate callback');
  }
  return box.outcome;
}

function findComment(file: CommentsSidecarFile, id: string): PersistedComment | undefined {
  return file.comments.find((c) => c.id === id);
}

function replaceComment(file: CommentsSidecarFile, id: string, next: PersistedComment): CommentsSidecarFile {
  return { ...file, comments: file.comments.map((c) => (c.id === id ? next : c)) };
}

export async function addComment(args: {
  path: string;
  projectRoot?: string;
  selector: CommentSelector;
  text: string;
  author: CommentAuthor;
}): Promise<{ ok: true; id: string } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  // Account-ready id (§1.2): a UUID, never a counter — a `let idCounter`
  // (the renderer mock's `nextId()`) resets every reload and would collide
  // across sidecars/processes.
  const id = `c-${randomUUID()}`;
  const comment: PersistedComment = {
    id,
    path: args.path,
    selector: args.selector,
    text: args.text,
    author: args.author,
    createdAt: Date.now(),
    replies: [],
    resolved: false,
    history: [],
  };
  return mutateSidecar(resolved.sidecarPath, (file) => ({
    file: { ...file, comments: [...file.comments, comment] },
    extra: { id },
  }));
}

export async function replyToComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  text: string;
  author: CommentAuthor;
}): Promise<{ ok: true } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  return mutateSidecar(resolved.sidecarPath, (file) => {
    const comment = findComment(file, args.id);
    if (!comment) return 'not-found';
    const replyId = `${comment.id}-r${comment.replies.length + 1}`;
    const next: PersistedComment = {
      ...comment,
      replies: [...comment.replies, { id: replyId, author: args.author, text: args.text, createdAt: Date.now() }],
    };
    return { file: replaceComment(file, args.id, next), extra: {} };
  });
}

export async function resolveComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  by: CommentAuthor;
}): Promise<{ ok: true } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  return mutateSidecar(resolved.sidecarPath, (file) => {
    const comment = findComment(file, args.id);
    if (!comment) return 'not-found';
    const next: PersistedComment = {
      ...comment,
      resolved: true,
      // Full audit trail (§1.1, review 1 F13), not just the latest state —
      // R6 needs the assistant's decisions to stay legible after the fact.
      history: [...comment.history, { by: args.by, at: Date.now(), action: 'resolved' }],
    };
    return { file: replaceComment(file, args.id, next), extra: {} };
  });
}

export async function reopenComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  by: CommentAuthor;
}): Promise<{ ok: true } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  return mutateSidecar(resolved.sidecarPath, (file) => {
    const comment = findComment(file, args.id);
    if (!comment) return 'not-found';
    const next: PersistedComment = {
      ...comment,
      resolved: false,
      history: [...comment.history, { by: args.by, at: Date.now(), action: 'reopened' }],
    };
    return { file: replaceComment(file, args.id, next), extra: {} };
  });
}

/** §2/§5's re-anchor tool target: replace a comment's selector wholesale
 *  (e.g. after MoveComment recomputes where it should point). T1 stores
 *  whatever selector it's given — deciding whether/where a selector resolves
 *  is the anchoring pass's job (§2, T2), not this store's. */
export async function moveComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  newSelector: CommentSelector;
}): Promise<{ ok: true } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  return mutateSidecar(resolved.sidecarPath, (file) => {
    const comment = findComment(file, args.id);
    if (!comment) return 'not-found';
    const next: PersistedComment = { ...comment, selector: args.newSelector };
    return { file: replaceComment(file, args.id, next), extra: {} };
  });
}
