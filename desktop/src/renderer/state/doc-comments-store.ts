// Document comments — Google Docs / Word style markup on a file's own text.
// T5 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §7): this module used to be a pure in-memory mock (seed
// data, no persistence). It now hydrates from and mutates through the real
// docComments:* IPC surface T1-T4 built (main-process store, watcher, IPC
// handlers — desktop/src/main/doc-comments/*), while keeping the EXACT same
// public shape (`DocComment`, `DocCommentsApi`, `useDocComments`) every
// comment component already reads, per §7: "That interface does not change."
//
// Store shape: still a module-level store, no Context — but comments are now
// kept PER PATH (`commentsByPath`), not one flat array, and `useDocComments`
// hands `useSyncExternalStore` a per-path snapshot getter that returns the
// SAME object reference when nothing relevant to that path changed
// (performance.md rule 3: "subscribe to a slice, never the whole" — a flat
// array meant every mounted viewer's `useSyncExternalStore` re-rendered on
// EVERY comment change anywhere, in any open file, which is exactly the
// storm rule 3 exists to prevent once more than one file's comments pane can
// be open at once).
import { useEffect, useSyncExternalStore } from 'react';
import type {
  CommentAuthor as SharedCommentAuthor,
  CellSelector,
  CommentSelector,
  PersistedComment,
  TextQuoteSelector,
} from '../../shared/doc-comments-types';

export type CommentAuthor = SharedCommentAuthor;

interface CommentReply {
  id: string;
  author: CommentAuthor;
  text: string;
  createdAt: number;
}

export interface DocComment {
  id: string;
  /** Artifact path this comment is anchored to (matches ArtifactViewProps.path). */
  path: string;
  /** The exact highlighted/selected text — also what the in-document <mark> matches. */
  quote: string;
  /** Compact human label for the anchor, e.g. "lines 12-18 · plan.md" or just
   *  "plan.md" when the view has no reliable line mapping (rendered markdown). */
  sourceLabel: string;
  startLine?: number;
  endLine?: number;
  /** Spreadsheet comments anchor to a CELL ("B4"), not a text span — Excel's
   *  own model. When set, the highlight is the cell itself (use-quote-marks.ts)
   *  and `quote` just records the cell's value for the assistant. */
  cell?: string;
  sheet?: string;
  text: string;
  author: CommentAuthor;
  createdAt: number;
  replies: CommentReply[];
  resolved: boolean;
  resolvedBy: CommentAuthor | null;
  resolvedAt: number | null;
  /** §2.3: whether the anchoring pass could still find this comment's text in
   *  the file on disk. Only ever set by whatever computes real anchoring
   *  (the DOM-aware pass in the file viewer, §2.2's `resolveSelector` — a
   *  separate, not-yet-wired-in task) — this store only threads the field
   *  through from `PersistedComment.status` (main never sets it either) so a
   *  future caller/UI (T6's dedicated "text no longer found" treatment) has
   *  somewhere to read it from. Always `undefined` today. */
  status?: 'anchored' | 'detached';
}

export function basenameOf(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

// ── Mapping: wire shape (PersistedComment) <-> renderer shape (DocComment) ──
// The wire record separates the SELECTOR (how to re-find the anchor) from the
// body (design §1.1); the renderer's own shape predates that split and every
// existing component reads `quote`/`sourceLabel`/`cell`/`sheet`/`startLine`/
// `endLine` directly (use-quote-marks.ts, CommentCard.tsx, NewCommentPopover.tsx,
// CodeCommentsRail.tsx) — keeping THOSE fields, not the wire shape itself, is
// what "the interface doesn't change" (§7) actually requires downstream.

function sourceLabelFor(path: string, selector: CommentSelector): string {
  const base = basenameOf(path);
  if (selector.kind === 'cell') {
    const { cell, sheet } = selector.selector;
    return sheet ? `${sheet} · ${cell} · ${base}` : `${cell} · ${base}`;
  }
  const [start, end] = selector.lineHint ?? [];
  if (start == null) return base;
  return start === end || end == null ? `line ${start} · ${base}` : `lines ${start}-${end} · ${base}`;
}

/** The latest resolve/reopen audit-trail entry whose action is 'resolved' —
 *  `PersistedComment` keeps a full `history` (review 1, F13); the renderer's
 *  own shape only ever needed the LATEST resolvedBy/resolvedAt pair, so this
 *  reduces the trail to that pair rather than exposing the whole history and
 *  changing every card's rendering. */
function lastResolution(history: PersistedComment['history']): { by: CommentAuthor; at: number } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].action === 'resolved') return { by: history[i].by, at: history[i].at };
  }
  return null;
}

function fromPersisted(p: PersistedComment): DocComment {
  const resolution = p.resolved ? lastResolution(p.history) : null;
  const cell = p.selector.kind === 'cell' ? p.selector.selector : undefined;
  const [startLine, endLine] = p.selector.kind === 'text' ? p.selector.lineHint ?? [] : [];
  return {
    id: p.id,
    path: p.path,
    quote: p.selector.kind === 'text' ? p.selector.selector.exact : '',
    sourceLabel: sourceLabelFor(p.path, p.selector),
    startLine,
    endLine,
    cell: cell?.cell,
    sheet: cell?.sheet,
    text: p.text,
    author: p.author,
    createdAt: p.createdAt,
    replies: p.replies,
    resolved: p.resolved,
    resolvedBy: resolution?.by ?? null,
    resolvedAt: resolution?.at ?? null,
    status: p.status,
  };
}

/** Builds the selector `docComments:add` needs from the renderer's simple
 *  call shape (`quote`/`opts`, unchanged since the mockup — build-menu.ts's
 *  "Add comment" entries call this with no other context). `prefix`/`suffix`
 *  are the real anchoring pass's job (§2.2) once it's wired into the viewer
 *  (a separate, not-yet-built task) — left empty here rather than guessed,
 *  which still lets `resolveSelector` find an exact-text match, just without
 *  the extra disambiguation power real surrounding context would add.
 *  `occurrence: 0` for the same reason: this call site has no DOM to count
 *  prior matches in. */
function selectorFor(
  quote: string,
  opts?: { startLine?: number; endLine?: number; cell?: string; sheet?: string },
): CommentSelector {
  if (opts?.cell) {
    const cellSel: CellSelector = { type: 'CellSelector', cell: opts.cell, sheet: opts.sheet };
    return { kind: 'cell', selector: cellSel };
  }
  const textSel: TextQuoteSelector = { type: 'TextQuoteSelector', exact: quote, prefix: '', suffix: '', occurrence: 0 };
  return {
    kind: 'text',
    selector: textSel,
    lineHint: opts?.startLine != null ? [opts.startLine, opts.endLine ?? opts.startLine] : undefined,
  };
}

// ── IPC access — best-effort, never throws into a caller ───────────────────
// Every mutation below stays synchronous-feeling (publishes an optimistic
// local update immediately, the same way the old pure-mock always did) and
// only best-effort persists over IPC in the background. `window.claude` is
// absent in plain unit tests (no preload, no workbench shim) and the store
// must keep working exactly as it always has there — this is what lets
// ReadingHighlights.test.tsx and friends keep calling `addComment`/
// `resolveComment` directly with no IPC to talk to.
interface DocCommentsIpc {
  list: (path: string, projectRoot?: string) => Promise<unknown>;
  add: (path: string, selector: unknown, text: string, author: string, projectRoot?: string) => Promise<unknown>;
  reply: (path: string, id: string, text: string, author: string, projectRoot?: string) => Promise<unknown>;
  resolve: (path: string, id: string, by: string, projectRoot?: string) => Promise<unknown>;
  reopen: (path: string, id: string, by: string, projectRoot?: string) => Promise<unknown>;
  move: (path: string, id: string, newSelector: unknown, projectRoot?: string) => Promise<unknown>;
  watch: (path: string, projectRoot?: string) => Promise<unknown>;
  unwatch: (path: string, projectRoot?: string) => Promise<unknown>;
  onChanged: (cb: (evt: { path: string }) => void) => () => void;
}

function getIpc(): DocCommentsIpc | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as any).claude?.docComments;
  return bridge && typeof bridge.list === 'function' ? (bridge as DocCommentsIpc) : null;
}

type MutationResult = { ok: true; id?: string } | { ok: false; error?: string; field?: string; features?: string[] };

/** A mutation IPC call can REJECT (remote's REJECT_ON_NOT_OK path — the
 *  Electron preload path resolves `{ok:false,...}` instead, see doc-comments/
 *  ipc-handlers.ts / remote-shim.ts) or RESOLVE with `{ok:false}` — this
 *  module treats both identically, since both mean "the mutation did not
 *  happen." */
async function callMutation(fn: () => Promise<unknown>): Promise<MutationResult> {
  try {
    const res = await fn();
    if (res && typeof res === 'object' && ((res as any).ok === false || (res as any).ok === true)) {
      return res as MutationResult;
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

/** error-message-standards.md: specific and accurate where the code names a
 *  real, known cause; general (but never a guessed cause) for anything this
 *  store doesn't recognize. Every one of these codes is a typed refusal from
 *  desktop/src/main/doc-comments/*.ts — never an invented diagnosis. */
function describeError(res: Exclude<MutationResult, { ok: true }>): string {
  switch (res.error) {
    case 'missing-field': return `Something needed to save this comment (${res.field ?? 'a field'}) was missing.`;
    case 'unknown-project-root': return "This folder isn't one YouCoded recognizes yet.";
    case 'path-outside-project': return 'That file is outside this project.';
    case 'path-not-absolute': return "Couldn't place this comment — the file's location wasn't clear.";
    case 'lock-timeout': return 'Another change is being saved to this file right now.';
    case 'comment-not-found': return "This comment couldn't be found anymore.";
    case 'sidecar-corrupt': return "This file's saved comments can't be read right now.";
    case 'path-not-tracked': return "This file isn't part of an open project or tracked file.";
    case 'read-failed': return "Couldn't read this file.";
    case 'invalid-docx': return "This Word file doesn't look valid.";
    case 'invalid-xlsx': return "This Excel file doesn't look valid.";
    case 'missing-document-part': return 'This Word document is missing a part comments need.';
    case 'invalid-selector':
    case 'selector-not-found':
      return 'That text is no longer in this document.';
    case 'sheet-not-found': return 'That sheet no longer exists in this workbook.';
    case 'cell-already-has-comment': return 'This cell already has a comment.';
    case 'cell-has-no-value': return 'Add a value to this cell before commenting on it.';
    case 'destination-cell-occupied': return 'The destination cell already has a comment.';
    case 'unsupported-workbook-features':
      return res.features?.length
        ? `This workbook uses features YouCoded can't edit yet (${res.features.join(', ')}).`
        : "This workbook uses features YouCoded can't edit yet.";
    case 'backup-failed': return "Couldn't make a safety copy before saving, so nothing was changed.";
    case 'write-failed': return "Couldn't save this change to the file.";
    case 'verify-failed': return "Saved, but the file didn't check out afterward, so the change was undone.";
    case 'not-yet-supported': return "This kind of comment isn't supported yet.";
    case 'not-implemented-on-mobile': return "This isn't available on the phone yet.";
    default: return "Error: this comment couldn't be saved.";
  }
}

// ── projectRoot registry ────────────────────────────────────────────────────
// Every real call site that KNOWS a projectRoot (every viewer, via
// ActiveArtifactView's own `projectRoot` prop) passes it into
// `useDocComments(path, projectRoot)`; this registers it here so the free
// functions below (`addComment`/`addReply`/`resolveComment`/…) — reached
// directly from build-menu.ts's context-menu entries and from CommentCard's
// callbacks, neither of which has a projectRoot of their own to pass — can
// still send a real one with their IPC calls. A path with nothing registered
// (a bare unit test, or a file opened before its viewer supplied one) falls
// back to `undefined`, i.e. the per-machine loose-file store (design §1.4) —
// an honest degrade, never a crash.
const projectRootByPath = new Map<string, string>();
function registerProjectRoot(path: string, projectRoot: string | undefined): void {
  if (projectRoot) projectRootByPath.set(path, projectRoot);
}
function projectRootFor(path: string): string | undefined {
  return projectRootByPath.get(path);
}

// ── Seed data is GONE from this module (§7) ─────────────────────────────────
// It now lives in dev/workbench/mock-shim.ts's own docComments fixture, fed
// through the SAME docComments:list/watch IPC surface this store calls in the
// real app — the workbench needs no separate code path here.

const EMPTY_COMMENTS: readonly DocComment[] = [];

interface Snap {
  commentsByPath: Record<string, DocComment[]>;
  focusId: string | null;
  showResolvedByPath: Record<string, boolean>;
  /** Per-path transient mutation failure, for a toast — additive to
   *  `DocCommentsApi` (existing consumers destructure only the fields they
   *  already knew about, so this changes nothing for them). */
  errorByPath: Record<string, { message: string; onRetry: () => void } | undefined>;
}

function emptySnap(): Snap {
  return { commentsByPath: {}, focusId: null, showResolvedByPath: {}, errorByPath: {} };
}

let snap: Snap = emptySnap();
const subs = new Set<() => void>();
/** `id -> path`, kept in lockstep with `commentsByPath` — every mutation
 *  below (`addReply`/`resolveComment`/`reopenComment`/…) is reached with just
 *  an id (the free-function API predates the per-file sidecar split, §1.6's
 *  own F1 finding), so this is what lets a lookup by id alone find the right
 *  path's array in O(1) instead of scanning every open file's comments. */
const commentPathIndex = new Map<string, string>();

function publish(patch: Partial<Snap>) {
  snap = { ...snap, ...patch };
  for (const s of subs) s();
}

/** Replaces one path's array (and only that path's) — every touched-comment
 *  mutation goes through this so an unrelated path's `commentsByPath[path]`
 *  array reference never changes, which is what lets `getPathSnapshot` below
 *  skip a re-render for every OTHER open file (performance.md rule 3). */
function publishPath(path: string, comments: DocComment[]): void {
  publish({ commentsByPath: { ...snap.commentsByPath, [path]: comments } });
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** What `useDocComments(path)` actually hands `useSyncExternalStore` — a
 *  small per-path view, cached and reused across renders whenever nothing
 *  relevant to THIS path changed (comments, its own showResolved flag, its
 *  own error, or a focus id that belongs to one of ITS comments). A change to
 *  a different file's comments never invalidates this path's cached view, so
 *  `useSyncExternalStore`'s own `Object.is` check sees "unchanged" and skips
 *  re-rendering every OTHER mounted comments pane. */
interface PathSnap {
  comments: DocComment[];
  focusId: string | null;
  showResolved: boolean;
  error: { message: string; onRetry: () => void } | null;
}
const pathSnapCache = new Map<string, PathSnap>();

function getPathSnapshot(path: string): PathSnap {
  const comments = snap.commentsByPath[path] ?? (EMPTY_COMMENTS as DocComment[]);
  const focusId = snap.focusId != null && commentPathIndex.get(snap.focusId) === path ? snap.focusId : null;
  const showResolved = snap.showResolvedByPath[path] ?? false;
  const error = snap.errorByPath[path] ?? null;
  const cached = pathSnapCache.get(path);
  if (cached && cached.comments === comments && cached.focusId === focusId && cached.showResolved === showResolved && cached.error === error) {
    return cached;
  }
  const next: PathSnap = { comments, focusId, showResolved, error };
  pathSnapCache.set(path, next);
  return next;
}

function setError(path: string, message: string, onRetry: () => void): void {
  publish({ errorByPath: { ...snap.errorByPath, [path]: { message, onRetry } } });
}

function dismissError(path: string): void {
  if (!snap.errorByPath[path]) return;
  const next = { ...snap.errorByPath };
  delete next[path];
  publish({ errorByPath: next });
}

// ── Hydration + watch (per path, refcounted) ────────────────────────────────
// One list() per path per "goes from 0 to 1 live viewers" (design §7: "list on
// file open"); one docComments:watch subscription per path for as long as at
// least one viewer is mounted, released the instant the last one unmounts.
const pathRefs = new Map<string, number>();
let changedUnsub: (() => void) | null = null;

/** Last-one-wins de-dupe by id — the safety net for the race `mergeServer
 *  Comments`/`persistNewComment` both guard against explicitly (see their own
 *  WHY comments): a `docComments:changed` push can fire — and this store can
 *  re-`list()` — WHILE this window's own just-issued `docComments:add` is
 *  still in flight, so the id-swap below and a server-truth refresh can each
 *  see a half-updated array and both add their own copy of the SAME logical
 *  comment under different ids for one brief window. Kept last: a fresh
 *  server record is more authoritative than a stale local placeholder. */
function dedupeById(comments: DocComment[]): DocComment[] {
  const byId = new Map<string, DocComment>();
  for (const c of comments) byId.set(c.id, c);
  return [...byId.values()];
}

/** Replaces every comment this store already knew about for `path` with the
 *  server's own list, but PRESERVES any comment that only exists locally so
 *  far (a draft still being composed, not yet persisted — see `addComment`) —
 *  the server has never heard of it, so a naive replace would silently
 *  discard someone's half-written note the moment an unrelated change on the
 *  same file pushed a refresh. */
function mergeServerComments(path: string, serverComments: PersistedComment[]): void {
  const fresh = serverComments.map(fromPersisted);
  for (const c of fresh) commentPathIndex.set(c.id, path);
  const existing = snap.commentsByPath[path] ?? [];
  const keptLocal = existing.filter((c) => pendingLocalIds.has(c.id));
  publishPath(path, dedupeById([...keptLocal, ...fresh]));
}

async function hydrate(path: string, projectRoot: string | undefined): Promise<void> {
  const ipc = getIpc();
  if (!ipc) return;
  const res: any = await ipc.list(path, projectRoot).catch(() => null);
  if (res && res.ok && Array.isArray(res.comments)) {
    mergeServerComments(path, res.comments as PersistedComment[]);
  }
}

function ensureChangedListener(): void {
  if (changedUnsub) return;
  const ipc = getIpc();
  if (!ipc) return;
  changedUnsub = ipc.onChanged((evt) => {
    if (!pathRefs.has(evt.path)) return; // nobody is looking at this file right now
    void hydrate(evt.path, projectRootFor(evt.path));
  });
}

function subscribePath(path: string, projectRoot: string | undefined): () => void {
  const n = (pathRefs.get(path) ?? 0) + 1;
  pathRefs.set(path, n);
  ensureChangedListener();
  const ipc = getIpc();
  if (n === 1) {
    void hydrate(path, projectRoot);
    void ipc?.watch(path, projectRoot).catch(() => {});
  }
  return () => {
    const remaining = (pathRefs.get(path) ?? 1) - 1;
    if (remaining <= 0) {
      pathRefs.delete(path);
      void ipc?.unwatch(path, projectRoot).catch(() => {});
    } else {
      pathRefs.set(path, remaining);
    }
  };
}

// ── Mutations ────────────────────────────────────────────────────────────

let idCounter = 0;
function nextLocalSuffix(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter}`;
}

/** ids not yet confirmed by a `docComments:add` round trip — kept out of
 *  `mergeServerComments`'s replace-for-this-path pass (above) and out of
 *  every mutation below that needs a REAL id to address a real comment. */
const pendingLocalIds = new Set<string>();
/** A pending local draft's debounced persist timer, and the args it will
 *  replay with — `setCommentText` reschedules this on every keystroke rather
 *  than calling `docComments:add` per keystroke (performance.md rule 5: an
 *  empty comment can't be added at all — ipc-handlers.ts refuses `text:
 *  ''` — and a live "add on every character" round trip is exactly the
 *  keystroke-frequency IPC chatter that rule exists to prevent). */
const pendingPersist = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>();
const PERSIST_DEBOUNCE_MS = 400;

function schedulePersist(id: string, run: () => void): void {
  const existing = pendingPersist.get(id);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingPersist.delete(id);
    run();
  }, PERSIST_DEBOUNCE_MS);
  pendingPersist.set(id, { timer, run });
}

/** Fires a pending draft's persist immediately (Enter / click "Comment" /
 *  clicking away — NewCommentPopover's `onDone`, which calls `clearFocus`)
 *  instead of waiting out the debounce. */
function flushPersist(id: string): void {
  const existing = pendingPersist.get(id);
  if (!existing) return;
  clearTimeout(existing.timer);
  pendingPersist.delete(id);
  existing.run();
}

function cancelPersist(id: string): void {
  const existing = pendingPersist.get(id);
  if (existing) { clearTimeout(existing.timer); pendingPersist.delete(id); }
  pendingLocalIds.delete(id);
}

function findComment(id: string): DocComment | undefined {
  const path = commentPathIndex.get(id);
  if (!path) return undefined;
  return snap.commentsByPath[path]?.find((c) => c.id === id);
}

/** Every id-addressed mutation below funnels through this: look the id's path
 *  up in the index, apply `updater` to just that one comment inside just that
 *  path's array, and publish only that path (see `publishPath`'s own WHY). */
function updateComment(id: string, updater: (c: DocComment) => DocComment): DocComment | undefined {
  const path = commentPathIndex.get(id);
  if (!path) return undefined;
  const arr = snap.commentsByPath[path];
  if (!arr) return undefined;
  const before = arr.find((c) => c.id === id);
  if (!before) return undefined;
  publishPath(path, arr.map((c) => (c.id === id ? updater(c) : c)));
  return before;
}

function rollback(id: string, previous: DocComment): void {
  updateComment(id, () => previous);
}

export function addComment(
  path: string,
  quote: string,
  sourceLabel: string,
  opts?: { startLine?: number; endLine?: number; cell?: string; sheet?: string; author?: CommentAuthor },
): string {
  // A temporary, locally-minted id — main mints its OWN id on a successful
  // `docComments:add` (doc-comments-store.ts's `addComment`, `c-${randomUUID()}`),
  // so this is swapped for the real one once that round trip lands (below);
  // until then (or forever, offline / in a plain unit test with no IPC) it is
  // the only id anything sees, exactly like the old pure-mock's counter-based
  // id always was.
  const id = `local-${nextLocalSuffix()}`;
  const author = opts?.author ?? 'user';
  const comment: DocComment = {
    id,
    path,
    quote,
    sourceLabel,
    startLine: opts?.startLine,
    endLine: opts?.endLine,
    cell: opts?.cell,
    sheet: opts?.sheet,
    text: '',
    author,
    createdAt: Date.now(),
    replies: [],
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
  };
  pendingLocalIds.add(id);
  commentPathIndex.set(id, path);
  // WHY append, never unshift: comments read top-to-bottom in the margin in
  // the order they were made, same as Docs — a fresh one lands where its
  // anchor sits, not necessarily last, but insertion order is a stable tie-break.
  publish({
    commentsByPath: { ...snap.commentsByPath, [path]: [...(snap.commentsByPath[path] ?? []), comment] },
    focusId: id,
  });
  return id;
}

/** Actually calls `docComments:add` with whatever text the draft holds right
 *  now, and reconciles the local id to the server's real one on success —
 *  see `pendingLocalIds`'s own WHY. Never called with empty text (the
 *  scheduler below only arms once text is non-empty; `ipc-handlers.ts`
 *  refuses an empty `text` outright). */
function persistNewComment(id: string): void {
  const comment = findComment(id);
  if (!comment || !comment.text.trim()) return;
  const ipc = getIpc();
  if (!ipc) return; // no bridge (unit test / no preload) — stays local-only
  const path = comment.path;
  const projectRoot = projectRootFor(path);
  const selector = selectorFor(comment.quote, {
    startLine: comment.startLine, endLine: comment.endLine, cell: comment.cell, sheet: comment.sheet,
  });
  void callMutation(() => ipc.add(path, selector, comment.text, comment.author, projectRoot)).then((res) => {
    if (res.ok) {
      pendingLocalIds.delete(id);
      if (res.id && res.id !== id) {
        commentPathIndex.delete(id);
        commentPathIndex.set(res.id, path);
        const arr = snap.commentsByPath[path] ?? [];
        // A `docComments:changed` push (our OWN write, or someone else's) can
        // resolve its `list()` refresh WHILE this exact `add()` call is still
        // in flight, so the server's own copy of this comment may already be
        // in `arr` under `res.id` by the time this callback runs — renaming
        // the local placeholder in that case would create a second entry
        // with the SAME id (a real duplicate-key crash we hit end-to-end
        // testing this against the workbench). Drop the placeholder instead
        // of renaming it when that's already happened; `dedupeById` is the
        // same belt-and-suspenders the reverse ordering gets in
        // `mergeServerComments`.
        const alreadyLanded = arr.some((c) => c.id === res.id);
        const nextArr = alreadyLanded ? arr.filter((c) => c.id !== id) : arr.map((c) => (c.id === id ? { ...c, id: res.id! } : c));
        publish({
          commentsByPath: { ...snap.commentsByPath, [path]: dedupeById(nextArr) },
          focusId: snap.focusId === id ? res.id! : snap.focusId,
        });
      }
      return;
    }
    // Honest rollback (review 2, F9): a draft that failed to save never
    // existed anywhere but this window, so "pre-mutation state" is
    // non-existence — remove it, and keep the reason visible in the pane
    // via the path-scoped toast, with Retry replaying the exact same call.
    cancelPersist(id);
    commentPathIndex.delete(id);
    const arr = snap.commentsByPath[path] ?? [];
    publishPath(path, arr.filter((c) => c.id !== id));
    setError(path, describeError(res), () => {
      pendingLocalIds.add(id);
      commentPathIndex.set(id, path);
      persistNewComment(id);
    });
  });
}

// Not exported: every caller reaches these through useDocComments() below
// (knip counts a bare export nobody imports as dead code).
function setCommentText(id: string, text: string): void {
  updateComment(id, (c) => ({ ...c, text }));
  if (pendingLocalIds.has(id) && text.trim()) {
    schedulePersist(id, () => persistNewComment(id));
  } else if (!text.trim()) {
    cancelPersist(id);
  }
}

function addReply(id: string, author: CommentAuthor, text: string): void {
  if (!text.trim()) return;
  const trimmed = text.trim();
  const replyId = `r-${nextLocalSuffix()}`;
  const reply: CommentReply = { id: replyId, author, text: trimmed, createdAt: Date.now() };
  const before = updateComment(id, (c) => ({ ...c, replies: [...c.replies, reply] }));
  if (!before) return;
  const ipc = getIpc();
  if (!ipc || pendingLocalIds.has(id)) return; // never-persisted draft — nothing to reply to server-side yet
  const projectRoot = projectRootFor(before.path);
  void callMutation(() => ipc.reply(before.path, id, trimmed, author, projectRoot)).then((res) => {
    if (res.ok) return;
    rollback(id, before);
    setError(before.path, describeError(res), () => addReply(id, author, text));
  });
}

// Exported alongside `addComment`/`commentsForPath` — tests resolve a
// fixture comment directly, the same way `addComment` already lets them
// create one, without going through `useDocComments`'s hook wrapper just to
// reach a plain state mutation.
export function resolveComment(id: string, by: CommentAuthor): void {
  const before = updateComment(id, (c) => ({ ...c, resolved: true, resolvedBy: by, resolvedAt: Date.now() }));
  if (!before) return;
  const ipc = getIpc();
  if (!ipc || pendingLocalIds.has(id)) return;
  const projectRoot = projectRootFor(before.path);
  void callMutation(() => ipc.resolve(before.path, id, by, projectRoot)).then((res) => {
    if (res.ok) return;
    rollback(id, before);
    setError(before.path, describeError(res), () => resolveComment(id, by));
  });
}

function reopenComment(id: string): void {
  // Interactive reopen is always the person at the keyboard — the mock never
  // exposed a `by` here either (the DocCommentsApi's `reopenComment` stays
  // id-only, unchanged); the assistant's own reopen path is a native tool
  // (§5, T8), not this hook.
  const before = updateComment(id, (c) => ({ ...c, resolved: false, resolvedBy: null, resolvedAt: null }));
  if (!before) return;
  const ipc = getIpc();
  if (!ipc || pendingLocalIds.has(id)) return;
  const projectRoot = projectRootFor(before.path);
  void callMutation(() => ipc.reopen(before.path, id, 'user', projectRoot)).then((res) => {
    if (res.ok) return;
    rollback(id, before);
    setError(before.path, describeError(res), () => reopenComment(id));
  });
}

/** Mock/workbench-only (design §7): no contract row asks for permanent
 *  deletion (the closest is resolve, which is reversible), so the real store
 *  exposes no delete IPC channel — this only ever removes a NEVER-PERSISTED
 *  local draft (NewCommentPopover's Cancel / CommentCard's Delete, both of
 *  which only show while a draft's text is still empty, i.e. before
 *  `persistNewComment` could have run). */
function removeComment(id: string): void {
  cancelPersist(id);
  const path = commentPathIndex.get(id);
  if (!path) return;
  commentPathIndex.delete(id);
  const arr = snap.commentsByPath[path];
  if (!arr) return;
  publishPath(path, arr.filter((c) => c.id !== id));
}

function clearCommentFocus(): void {
  const id = snap.focusId;
  if (id !== null) {
    flushPersist(id); // Enter / "Comment" / click-away — commit now, don't wait out the debounce
    publish({ focusId: null });
  }
}

export function commentsForPath(path: string): DocComment[] {
  return snap.commentsByPath[path] ?? [];
}

function setShowResolved(path: string, value: boolean): void {
  publish({ showResolvedByPath: { ...snap.showResolvedByPath, [path]: value } });
}

export interface DocCommentsApi {
  comments: DocComment[];
  focusId: string | null;
  showResolved: boolean;
  setShowResolved: (value: boolean) => void;
  addComment: (quote: string, sourceLabel: string, opts?: { startLine?: number; endLine?: number; cell?: string; sheet?: string }) => string;
  setCommentText: typeof setCommentText;
  addReply: typeof addReply;
  resolveComment: typeof resolveComment;
  reopenComment: typeof reopenComment;
  removeComment: typeof removeComment;
  clearFocus: typeof clearCommentFocus;
  /** Additive (existing components destructure only what they already knew
   *  about): the most recent mutation failure for THIS path, for a toast. */
  lastError: { message: string; onRetry: () => void } | null;
  dismissError: () => void;
}

/** The one hook surfaces read — a slice of the shared store scoped to one
 *  file path (performance.md rule 3: subscribe to a slice, not the whole —
 *  `getPathSnapshot` is what makes this a REAL slice, not just a filtered
 *  view of one shared snapshot object). `projectRoot`, when the caller has
 *  one (every real viewer does, via ActiveArtifactView's own prop — see the
 *  registry's own WHY above), is what lets `docComments:list`/`:add`/etc.
 *  find the right project's sidecar instead of falling back to the
 *  per-machine loose-file store. */
export function useDocComments(path: string, projectRoot?: string): DocCommentsApi {
  registerProjectRoot(path, projectRoot);
  const s = useSyncExternalStore(subscribe, () => getPathSnapshot(path));

  // Design §7 / §1.5 "Watching": list on mount, subscribe to docComments:watch
  // while at least one viewer is open on this path, released the moment the
  // last one unmounts.
  useEffect(() => subscribePath(path, projectRoot), [path, projectRoot]);

  return {
    comments: s.comments,
    focusId: s.focusId,
    showResolved: s.showResolved,
    setShowResolved: (value) => setShowResolved(path, value),
    addComment: (quote, sourceLabel, opts) => addComment(path, quote, sourceLabel, opts),
    setCommentText,
    addReply,
    resolveComment,
    reopenComment,
    removeComment,
    clearFocus: clearCommentFocus,
    lastError: s.error,
    dismissError: () => dismissError(path),
  };
}

/** Test-only: tears every module-level cache down between cases, the same
 *  convention `doc-comments-watcher.ts`'s `__resetDocCommentsWatcherForTest`
 *  and `useTagRegistry.ts`'s `__resetTagRegistryForTests` already use — this
 *  store is a module-level singleton, and a fake-IPC test suite that mutates
 *  the SAME comment ids/paths across cases needs a clean slate rather than
 *  relying on every case picking a never-before-used path. */
export function __resetDocCommentsStoreForTest(): void {
  for (const { timer } of pendingPersist.values()) clearTimeout(timer);
  pendingPersist.clear();
  pendingLocalIds.clear();
  commentPathIndex.clear();
  pathSnapCache.clear();
  projectRootByPath.clear();
  pathRefs.clear();
  changedUnsub?.();
  changedUnsub = null;
  snap = emptySnap();
}
