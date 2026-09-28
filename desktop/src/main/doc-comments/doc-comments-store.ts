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
import { authorizeBytesRead } from '../artifacts/read-service';
import { nativeFormatFor, type NativeFormat } from './native-format';
import type {
  CommentAuthor,
  CommentReply,
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
// 'sidecar-corrupt' and 'path-not-absolute' added post-review (F3, F4 — see
// their fix sites below) — both are refusals a caller can surface honestly,
// same as the three that shipped with T1.
// 'invalid-id'/'duplicate-id' added post-review (F4, T5 review — see
// `addComment`'s own WHY below): the renderer now mints and passes the
// comment id up front; both are honest refusals for a caller-supplied id
// this store cannot accept, never a silent overwrite or a thrown exception.
// 'path-not-tracked' added for the live-refresh review (2026-09-27, finding
// 1 — high): `resolveWatchTarget`'s own native-format branch, below, is the
// one entry point in this module that reads bytes-adjacent state (it starts
// a live filesystem watch) for a no-`projectRoot` absolute path — the SAME
// authority `doc-comments-dispatch.ts`'s `resolveDocxTarget`/`resolveXlsxTarget`/
// `listNativeComments` already gate a raw-byte read on (`authorizeBytesRead`,
// `read-service.ts`), reused here rather than re-derived, so a watch can
// never authorize a path a read would refuse.
type DocCommentsError =
  | 'path-outside-project'
  | 'lock-timeout'
  | 'comment-not-found'
  | 'sidecar-corrupt'
  | 'path-not-absolute'
  | 'invalid-id'
  | 'duplicate-id'
  | 'path-not-tracked';

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
 * Returns null when even the filesystem root can't be realpathed, OR when
 * the walk-up exceeds `MAX_WALKUP_DEPTH` (review F5) — a `path`/`projectRoot`
 * argument is model-controlled input (§1.5), and without a cap a
 * pathologically deep non-existent chain (e.g. hundreds of `a/b/c/...`
 * segments that don't exist) would cost one `fs.realpath` call per level with
 * no bound. Every caller already treats null as "can't verify, refuse" —
 * `checkContainment` fails closed, `locateFallback` falls back to the
 * unresolved path (its documented, non-security-critical degraded case) — so
 * capping here fails the same honest way the codebase already fails on a
 * plain ENOENT-to-root, never a silent clamp or an unbounded loop.
 */
const MAX_WALKUP_DEPTH = 200;

async function realpathWithNonexistentTail(targetAbs: string): Promise<string | null> {
  try {
    return await fs.realpath(targetAbs);
  } catch (e: any) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }
  const segments: string[] = [];
  let dir = targetAbs;
  for (let depth = 0; depth < MAX_WALKUP_DEPTH; depth++) {
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
  return null; // exceeded the cap — refuse rather than keep walking
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
 *
 * Returns the resolved, verified-contained path itself (not just a boolean) —
 * `locateInProject` below builds the sidecar's relative suffix from THIS
 * value (post-review F1), never from the caller's unresolved `abs`, so a
 * symlink OUTSIDE the project that happens to point back INSIDE it (e.g. a
 * `../../../linked/file.md`-shaped path through a symlink rooted elsewhere)
 * can no longer leave stray `..` segments in the relative suffix once
 * containment has already proven the real target is inside the root.
 */
async function checkContainment(realProjectRoot: string, abs: string): Promise<string | null> {
  const realAbs = await realpathWithNonexistentTail(abs);
  if (realAbs === null) return null;
  const withSep = realProjectRoot.endsWith(path.sep) ? realProjectRoot : realProjectRoot + path.sep;
  return realAbs === realProjectRoot || realAbs.startsWith(withSep) ? realAbs : null;
}

interface Located {
  sidecarPath: string;
  // Added for T3's watch surface (resolveWatchTarget, below): the whole
  // per-project `.youcoded/comments/` directory is what chokidar watches
  // (§1.5 — many open files in one project share ONE watcher), which needs
  // the realpathed root, not just the one file's sidecar path. Existing
  // callers (resolveSidecarPath) only ever read `.sidecarPath`, so this is
  // additive.
  realProjectRoot: string;
  // Added for T3's docx/xlsx dispatch (resolveSourceFilePath, below): Word/
  // Excel comments live INSIDE the file (§1.1), so a `.docx`/`.xlsx` target
  // has no sidecar to read — this is the already-computed, already-
  // containment-verified absolute path to the SOURCE file itself.
  sourceAbsolutePath: string;
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
 * relative suffix of the RESOLVED, containment-verified target (`checkContainment`'s
 * return value — post-review F1), never from the caller's unresolved `abs`:
 * a path that escapes the project and comes back in through a symlink rooted
 * OUTSIDE it (project `/x/work/myproject`, symlink `/x/linked ->
 * /x/work/myproject/subdir`, argument `../../../linked/file.md`) passes
 * containment because the REAL target is inside the root, but the unresolved
 * `abs` still contains the `..` segments that walked out to `/x/linked` —
 * joining THAT onto `realProjectRoot` put the sidecar outside
 * `.youcoded/comments`, sometimes outside the project entirely. Deriving
 * `rel` from the already-resolved, already-verified-contained path instead
 * means it can never carry a leading `..`: the value is either exactly
 * `realProjectRoot`, or a real descendant of it that `path.relative` can only
 * express as clean forward segments (this is the same fix shape a regression
 * test at the bottom of the test file pins).
 *
 * This is a separate concern from lock-path canonicalization (review 2, F3):
 * `sidecarPath` itself is still never realpathed here (that would ENOENT on a
 * file's first-ever comment, the bug F3 fixed) — only the SOURCE FILE being
 * commented on is resolved, and it — unlike the sidecar we're about to create
 * — is expected to already exist (or `realpathWithNonexistentTail`'s walk-up
 * covers the rest), so this never reopens F3's trap.
 */
async function locateInProject(projectRoot: string, filePath: string): Promise<Located | { ok: false; error: 'path-outside-project' }> {
  let realProjectRoot: string;
  try {
    realProjectRoot = await fs.realpath(projectRoot);
  } catch {
    return { ok: false, error: 'path-outside-project' };
  }
  const abs = path.resolve(realProjectRoot, filePath);
  const realAbs = await checkContainment(realProjectRoot, abs);
  if (realAbs === null) {
    return { ok: false, error: 'path-outside-project' };
  }
  const rel = path.relative(realProjectRoot, realAbs);
  const sidecarPath = path.join(realProjectRoot, ...SIDECAR_DIR, `${rel}.json`);
  return { sidecarPath, realProjectRoot, sourceAbsolutePath: realAbs };
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
 *
 * WHY an absolute path is required (F4): `path.resolve(absoluteFilePath)`
 * with no second argument resolves a RELATIVE input against `process.cwd()`
 * — this main process's cwd, not any caller-meaningful directory — so a
 * relative `path` here would silently hash a location the caller never
 * specified, and that hash would drift with whatever the process's cwd
 * happened to be that launch. There is no root to resolve a relative path
 * against in the fallback case (that's the whole reason it's the fallback),
 * so a non-absolute `path` is refused rather than guessed.
 */
async function locateFallback(absoluteFilePath: string): Promise<{ ok: true; sidecarPath: string } | Refusal> {
  if (!path.isAbsolute(absoluteFilePath)) {
    return { ok: false, error: 'path-not-absolute' };
  }
  const abs = path.resolve(absoluteFilePath);
  const resolved = (await realpathWithNonexistentTail(abs)) ?? abs;
  const hash = createHash('sha256').update(resolved).digest('hex');
  return { ok: true, sidecarPath: path.join(os.homedir(), ...FALLBACK_DIR, `${hash}.json`) };
}

async function resolveSidecarPath(args: {
  path: string;
  projectRoot?: string;
}): Promise<{ ok: true; sidecarPath: string } | Refusal> {
  if (args.projectRoot) {
    const located = await locateInProject(args.projectRoot, args.path);
    if ('error' in located) return located;
    return { ok: true, sidecarPath: located.sidecarPath };
  }
  return locateFallback(args.path);
}

function emptySidecar(): CommentsSidecarFile {
  return { version: 1, comments: [] };
}

/**
 * WHY this returns a typed refusal instead of letting `JSON.parse` throw
 * (F3): every sidecar is read on a path a click or IPC call reaches (a GET in
 * `listComments`, or inside the mutation lock in `mutateSidecar`) — an
 * uncaught throw there would surface as an unhandled main-process rejection,
 * not the honest, typed error the rest of this module already returns for
 * every other failure mode (§1.5). A hand-edited or half-written (pre-`fsync`
 * torn write, or a future version this build predates) sidecar is refused the
 * same way a corrupt one is: neither case is safe to guess at, and both are
 * rare enough that a caller surfacing "this file's comments are unreadable"
 * is the right outcome, not a crash and not silently discarding history by
 * treating it as empty.
 */
function parseSidecar(onDisk: string | null): { ok: true; file: CommentsSidecarFile } | Refusal {
  if (onDisk === null) return { ok: true, file: emptySidecar() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(onDisk);
  } catch {
    return { ok: false, error: 'sidecar-corrupt' };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { comments?: unknown }).comments)
  ) {
    return { ok: false, error: 'sidecar-corrupt' };
  }
  return { ok: true, file: parsed as CommentsSidecarFile };
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
  const parsed = parseSidecar(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, comments: parsed.file.comments };
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
// F2 (minor, inherited from cas-write.ts, left as-is): mutateFileUnderLock
// unconditionally `fs.mkdir(dirname(target), { recursive: true })`s before
// acquiring the lock, so a failed lookup (e.g. replyToComment against a
// comment id that was never added, on a path with no sidecar yet) leaves
// behind an empty `.youcoded/comments/<dirs>/` chain even though `apply`
// returns 'not-found' and no sidecar file is ever written. Not fixed here:
// `mutateFileUnderLock` is a shared primitive other callers (the artifacts
// central index) also depend on, so changing its mkdir timing is out of this
// task's scope; and pre-checking existence in THIS module before calling it
// would just duplicate the lock's own existence check outside the lock,
// reopening a TOCTOU race the lock exists to close. An empty directory is
// harmless (gitignored under `.youcoded/`, no data in it) — noted, not fixed.
async function mutateSidecar<Extra extends Record<string, unknown>>(
  sidecarPath: string,
  apply: (file: CommentsSidecarFile) => { file: CommentsSidecarFile; extra: Extra } | 'not-found' | Refusal
): Promise<({ ok: true } & Extra) | Refusal> {
  // A plain object wrapper, not a reassigned `let` — the mutate callback
  // below runs inside `mutateFileUnderLock`, a separate function, so a
  // captured `let` variable's flow-narrowing does not see those inner
  // assignments and would report this as always `null` after the `await`.
  const box: { outcome: (({ ok: true } & Extra) | Refusal) | null } = { outcome: null };
  const acquired = await mutateFileUnderLock(sidecarPath, (onDisk) => {
    // F3: a corrupt/unsupported-version sidecar refuses here too, inside the
    // lock, same as a real 'not-found' — never falls through to `apply` with
    // a bogus empty file, which would silently discard whatever couldn't be
    // parsed the moment any mutation next touched this path.
    const parsed = parseSidecar(onDisk);
    if (!parsed.ok) {
      box.outcome = parsed;
      return null;
    }
    const applied = apply(parsed.file);
    if (applied === 'not-found') {
      box.outcome = { ok: false, error: 'comment-not-found' };
      return null;
    }
    // F4 (T5 review): `apply` can also refuse OUTRIGHT (e.g. `addComment`'s
    // own duplicate-id check below) — a distinct refusal from 'not-found',
    // checked inside the SAME lock acquisition as the read, so the check sees
    // truly current on-disk state rather than a racing read from outside it.
    // Narrowed on the SUCCESS shape's own `file` key (never present on a
    // `Refusal`) rather than `'ok' in applied` — a generic `Extra` makes the
    // negative check too weak for the compiler to exclude the success arm.
    if (!('file' in applied)) {
      box.outcome = applied;
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

/** F4 (T5 review): a caller-supplied id must look like this store's own
 *  `c-${randomUUID()}` shape — loose enough to accept any UUID variant/case,
 *  strict enough to refuse garbage (a truncated string, a docx/xlsx-shaped
 *  `w-`/`x-` id sent to the wrong channel) rather than silently storing it. */
const COMMENT_ID_RE = /^c-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function addComment(args: {
  path: string;
  projectRoot?: string;
  selector: CommentSelector;
  text: string;
  author: CommentAuthor;
  /** F4 fix (T5 review, design §7 review 2 F9): the RENDERER mints this now
   *  (`c-${randomUUID()}`) and passes it here, so its optimistic local id and
   *  the persisted id are the same string from the start — no more swapping
   *  the local id for a server-minted one once the round trip lands.
   *  Optional-then-required (this pass keeps it optional): a caller that
   *  hasn't been updated yet still gets a server-minted id exactly as
   *  before, so this can land ahead of every call site adopting it. */
  id?: string;
}): Promise<{ ok: true; id: string } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  if (args.id !== undefined && !COMMENT_ID_RE.test(args.id)) {
    return { ok: false, error: 'invalid-id' };
  }
  // Account-ready id (§1.2): a UUID, never a counter — a `let idCounter`
  // (the renderer mock's `nextId()`) resets every reload and would collide
  // across sidecars/processes. Minted here only when the caller didn't
  // already mint one (F4's fallback for an unupdated caller, above).
  const id = args.id ?? `c-${randomUUID()}`;
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
  // Explicit type argument (F4): the callback below also returns a `Refusal`
  // branch, which throws off `Extra` inference (it comes back as a bare
  // `Record<string, unknown>` instead of `{id: string}` without this).
  return mutateSidecar<{ id: string }>(resolved.sidecarPath, (file) => {
    // F4: refuse a caller-supplied id that collides with one already in this
    // sidecar, checked INSIDE the lock against the current on-disk state
    // (never a separate read-then-write outside it) — a real UUID collision
    // is vanishingly unlikely, but a hand-rolled or replayed id is refused
    // honestly rather than silently overwriting the existing comment.
    if (args.id !== undefined && findComment(file, args.id)) {
      return { ok: false, error: 'duplicate-id' };
    }
    return { file: { ...file, comments: [...file.comments, comment] }, extra: { id } };
  });
}

/** T5 review (design §1.6, F2 — round 2's own reply-enrichment fix, never
 *  applied to this plain-sidecar path either): returns the real persisted
 *  `CommentReply` alongside `ok:true`, the same wire shape `docx-comments.ts`'s
 *  `replyToDocxComment` now returns (§1.6's table entry is general, not
 *  gated to native formats) — so the renderer's own optimistic placeholder
 *  (today a purely local `r-${nextLocalSuffix()}` id) can be swapped in place
 *  immediately for EVERY target type, not just Word/Excel. */
export async function replyToComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  text: string;
  author: CommentAuthor;
}): Promise<{ ok: true; reply: CommentReply } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  return mutateSidecar<{ reply: CommentReply }>(resolved.sidecarPath, (file) => {
    const comment = findComment(file, args.id);
    if (!comment) return 'not-found';
    const replyId = `${comment.id}-r${comment.replies.length + 1}`;
    const reply: CommentReply = { id: replyId, author: args.author, text: args.text, createdAt: Date.now() };
    const next: PersistedComment = {
      ...comment,
      replies: [...comment.replies, reply],
    };
    return { file: replaceComment(file, args.id, next), extra: { reply } };
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

/** Edit/delete build (2026-09-28, §"Edit and delete" in the design doc):
 *  anyone's comment/reply can be edited or deleted (no author check — the
 *  decision doc, `doc-comments.edit-delete.questions.answers.json`, is
 *  explicit: "anyone's comment/reply can be edited or deleted"). No "edited"
 *  marker is stored or shown, so this is a plain text overwrite — never a
 *  history-append the way resolve/reopen's audit trail works. */
export async function editComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
  text: string;
}): Promise<{ ok: true } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  return mutateSidecar(resolved.sidecarPath, (file) => {
    const comment = findComment(file, args.id);
    if (!comment) return 'not-found';
    const next: PersistedComment = { ...comment, text: args.text };
    return { file: replaceComment(file, args.id, next), extra: {} };
  });
}

/** Deleting a THREAD's first comment deletes the whole thread (decision doc:
 *  "deleting a thread's first comment deletes the whole thread") — this
 *  channel always removes the whole `PersistedComment` row, replies
 *  included; a single reply is removed by `deleteReply` below instead. */
export async function deleteComment(args: {
  path: string;
  projectRoot?: string;
  id: string;
}): Promise<{ ok: true } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  return mutateSidecar(resolved.sidecarPath, (file) => {
    const comment = findComment(file, args.id);
    if (!comment) return 'not-found';
    return { file: { ...file, comments: file.comments.filter((c) => c.id !== args.id) }, extra: {} };
  });
}

/** Mirrors `replyToComment`'s own enrichment (§1.6, T5 review F2): returns
 *  the edited reply so a renderer's optimistic edit can be confirmed/
 *  corrected in place, the same wire shape every reply-shaped mutation here
 *  already uses. */
export async function editReply(args: {
  path: string;
  projectRoot?: string;
  id: string;
  replyId: string;
  text: string;
}): Promise<{ ok: true; reply: CommentReply } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  return mutateSidecar<{ reply: CommentReply }>(resolved.sidecarPath, (file) => {
    const comment = findComment(file, args.id);
    if (!comment) return 'not-found';
    const idx = comment.replies.findIndex((r) => r.id === args.replyId);
    if (idx === -1) return 'not-found';
    const reply: CommentReply = { ...comment.replies[idx], text: args.text };
    const replies = comment.replies.slice();
    replies[idx] = reply;
    const next: PersistedComment = { ...comment, replies };
    return { file: replaceComment(file, args.id, next), extra: { reply } };
  });
}

export async function deleteReply(args: {
  path: string;
  projectRoot?: string;
  id: string;
  replyId: string;
}): Promise<{ ok: true } | Refusal> {
  const resolved = await resolveSidecarPath(args);
  if (!resolved.ok) return resolved;
  return mutateSidecar(resolved.sidecarPath, (file) => {
    const comment = findComment(file, args.id);
    if (!comment) return 'not-found';
    if (!comment.replies.some((r) => r.id === args.replyId)) return 'not-found';
    const next: PersistedComment = { ...comment, replies: comment.replies.filter((r) => r.id !== args.replyId) };
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

// ---------------------------------------------------------------------------
// T3's watch surface (docComments:watch/:unwatch, design §1.5 "Watching") —
// WHERE to watch, reusing this module's own location logic so the watched
// path can never drift from where list/add/etc. actually read and write.
// ---------------------------------------------------------------------------

/** A project subscribes as a whole directory (`.youcoded/comments/` — many
 *  open files in one project share ONE chokidar watcher, §1.5); the fallback
 *  (no project root) case has exactly one file, the same single sidecar
 *  `locateFallback` already resolves for list/add. `sourcePath` on the
 *  fallback arm is the caller's OWN `path` argument (unchanged) — it is what
 *  a `docComments:changed` push should carry for that scheme, exactly the
 *  same value `PersistedComment.path` already holds for a fallback-stored
 *  comment (§1.4). */
export type CommentsWatchTarget =
  // F3 fix (T5 review): `projectRoot` (the REALPATHED root — same value the
  // renderer's own `keyFor` needs) rides along so `doc-comments-watcher.ts`
  // can put it on the `docComments:changed` push. Without it, two projects
  // sharing a relative path (both have a `README.md`) both matched the same
  // renderer-side key, so a change in ONE project could re-list the wrong
  // project's open viewer.
  | { kind: 'project'; commentsDir: string; projectRoot: string }
  | { kind: 'fallback'; sidecarPath: string; sourcePath: string }
  // T3 follow-up (design section 1.5's new bullet, "A second, narrower
  // watcher for a .docx/.xlsx target's OWN file" — design review round 2 F1,
  // corrected round 3 F1): a native-format target has no sidecar to watch at
  // all (section 1.1) — this watches the SOURCE FILE'S OWN bytes instead, and
  // REPLACES the 'project' variant above for such a target, never runs
  // alongside it (round 3's own correction from an earlier "also register"
  // wording). `sourcePath` is the caller's ORIGINAL `path` argument (mirrors
  // 'fallback' above) — what a `docComments:changed` push should carry back
  // so the renderer's own `keyFor(path, projectRoot)` matches the value it
  // watched with, whether that path came from a known project (relative) or
  // the loose-file fallback (absolute). `projectRoot` mirrors 'project' above
  // for the identical reason (F3, T5 review): two projects can both have a
  // `report.docx`.
  | { kind: 'document'; absolutePath: string; sourcePath: string; projectRoot: string | undefined };

export async function resolveWatchTarget(args: {
  path: string;
  projectRoot?: string;
}): Promise<{ ok: true; target: CommentsWatchTarget } | Refusal> {
  // Checked FIRST, before either sidecar scheme below: a `.docx`/`.xlsx`
  // target's comments live inside the file itself (section 1.1), so it never
  // has a `.youcoded/comments/` sidecar to watch — the SAME `resolveNativeFormat`
  // decision `doc-comments-dispatch.ts`'s LIST/ADD/etc. already make on the
  // SAME string (review finding #5: on the RESOLVED real path, not the raw
  // one, so a `.txt` symlink to a real `.docx` is watched as the document it
  // actually is), so this can never disagree with them about which files are
  // native-format. `resolveSourceFilePath` (below) reuses the identical
  // containment logic (project-contained realpath, or the fallback's
  // absolute-path rule) every other native-format entry point already uses.
  if (await resolveNativeFormat(args.path, args.projectRoot)) {
    const resolved = await resolveSourceFilePath(args);
    if (!resolved.ok) return resolved;
    // Live-refresh review (2026-09-27, finding 1 — high): every OTHER
    // native-format entry point with no `projectRoot` (list/add/reply/
    // resolve/reopen/move, via `doc-comments-dispatch.ts`) runs the resolved
    // absolute path through `authorizeBytesRead` before touching it, refusing
    // `path-not-tracked` for anything that isn't a saved folder, an indexed
    // project, or a tracked external artifact. This branch skipped that gate
    // entirely — a WS-remote client (already past password auth) or a
    // renderer call naming an arbitrary `{path: '/anywhere.docx'}` with no
    // `projectRoot` could start a live filesystem watch (and learn "this file
    // exists" plus a live change signal) on a path `list()` on the SAME path
    // would correctly refuse. A watch never exposes the file's CONTENT the
    // way a read does, but starting one is still an action on an
    // unauthorized path, so it gets the identical gate a read already has —
    // never a lighter check because "it's just a watch."
    if (!args.projectRoot) {
      const auth = await authorizeBytesRead(resolved.absolutePath);
      if (!auth.ok) return { ok: false, error: 'path-not-tracked' };
    }
    return {
      ok: true,
      target: { kind: 'document', absolutePath: resolved.absolutePath, sourcePath: args.path, projectRoot: args.projectRoot },
    };
  }
  if (args.projectRoot) {
    const located = await locateInProject(args.projectRoot, args.path);
    if ('error' in located) return located;
    return {
      ok: true,
      target: { kind: 'project', commentsDir: path.join(located.realProjectRoot, ...SIDECAR_DIR), projectRoot: located.realProjectRoot },
    };
  }
  const fb = await locateFallback(args.path);
  if (!fb.ok) return fb;
  return { ok: true, target: { kind: 'fallback', sidecarPath: fb.sidecarPath, sourcePath: args.path } };
}

// ---------------------------------------------------------------------------
// T3's docx/xlsx dispatch (design §1.1: Word/Excel comments live INSIDE the
// file, so these two extensions have no sidecar at all) — resolving the
// SOURCE file's own verified-contained absolute path, reusing the exact same
// containment algorithm every other entry point uses (§1.5), so a `.docx`/
// `.xlsx` read can never escape the project either.
// ---------------------------------------------------------------------------

export async function resolveSourceFilePath(args: {
  path: string;
  projectRoot?: string;
}): Promise<{ ok: true; absolutePath: string } | Refusal> {
  if (args.projectRoot) {
    const located = await locateInProject(args.projectRoot, args.path);
    if ('error' in located) return located;
    return { ok: true, absolutePath: located.sourceAbsolutePath };
  }
  // Mirrors locateFallback's own absolute-path requirement (F4) — there is no
  // root to resolve a relative path against outside a known project.
  if (!path.isAbsolute(args.path)) return { ok: false, error: 'path-not-absolute' };
  const abs = path.resolve(args.path);
  const resolved = (await realpathWithNonexistentTail(abs)) ?? abs;
  return { ok: true, absolutePath: resolved };
}

/**
 * Review finding #5 (docs/active/reviews/2026-09-27-doc-comments-t9ab-
 * review.md, "Low/info"): `nativeFormatFor` alone decides "is this a Word/
 * Excel file" purely from the CALLER-SUPPLIED path string — a `.txt` symlink
 * pointing at a real `.docx` extension-matches as plain text, so its comment
 * silently landed in the inert JSON sidecar instead of the real document
 * (never a bypass — both the permission check and the dispatch agreed — but a
 * silent product surprise). Fixed 2026-09-27 by deciding format from the
 * SAME resolved path `resolveSourceFilePath` already computes (realpath,
 * following any symlink, inside a known project or as an absolute fallback),
 * never the caller's unresolved string.
 *
 * Deliberately forgiving on failure: if resolution refuses for any reason
 * (outside the project, doesn't exist, not absolute with no project root),
 * this returns `null` (never "native") rather than surfacing that refusal
 * itself — every caller below still runs its OWN resolve step right
 * afterward (inside `addComment`/`addNativeDocxComment`/etc.) and produces
 * the exact same typed refusal it always did. This function's only job is
 * picking the RIGHT dispatch branch; it authorizes nothing on its own, and
 * path containment is still checked exactly where it already was.
 */
export async function resolveNativeFormat(filePath: string, projectRoot?: string): Promise<NativeFormat | null> {
  const resolved = await resolveSourceFilePath({ path: filePath, projectRoot });
  if (!resolved.ok) return null;
  return nativeFormatFor(resolved.absolutePath);
}
