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
// kept PER (project, path) KEY (`commentsByKey`, F3 review fix — bare-path
// keying let two projects sharing a relative path merge comments), not one
// flat array, and `useDocComments` hands `useSyncExternalStore` a per-key
// snapshot getter that returns the SAME object reference when nothing
// relevant to that key changed (performance.md rule 3: "subscribe to a
// slice, never the whole" — a flat array meant every mounted viewer's
// `useSyncExternalStore` re-rendered on EVERY comment change anywhere, in any
// open file, which is exactly the storm rule 3 exists to prevent once more
// than one file's comments pane can be open at once).
import { useEffect, useSyncExternalStore } from 'react';
import { useOnScreen } from './on-screen-context';
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
   *  the file on disk. `main` never sets this (`PersistedComment.status` is
   *  always `undefined` over the wire) — it is set client-side, at list/read
   *  time, by whatever component actually has the live DOM/document text to
   *  re-anchor against: `use-quote-marks.ts` (markdown/docx/plain-text
   *  highlights, §2.2's `resolveSelector`), `use-code-comment-anchors.ts`
   *  (code files, the same `resolveSelector` run against the live CodeMirror
   *  document), or the cell-presence check inside `use-quote-marks.ts` for a
   *  spreadsheet (`resolveCellSelector`). Deliberately NOT set by
   *  `fromPersisted` above — see `setCommentStatus`'s own WHY.
   *  `'unchecked'` (F3, T14 review): past `MAX_ANCHOR_TEXT_CHARS`
   *  (use-quote-marks.ts/use-code-comment-anchors.ts), the file is simply too
   *  large to run the anchoring pass on at all — a distinct, honest state
   *  from `'detached'` (which claims the text is specifically gone; a file
   *  this large was never actually checked, so that claim would be a guess
   *  error-message-standards.md forbids). */
  status?: 'anchored' | 'detached' | 'unchecked';
  /** F1 fix (T5 review); T14 (§2.2/§2.3): the selector's disambiguation
   *  context. For a still-pending draft it's computed by build-menu.ts at
   *  selection time (see `persistNewComment` below); for an already-persisted
   *  comment `fromPersisted` above threads it back OUT of the wire selector,
   *  so `use-quote-marks.ts`/`use-code-comment-anchors.ts` can rebuild the
   *  full `TextQuoteSelector` `resolveSelector` needs. Not part of the "same
   *  public shape" (§7) contract other fields are (nothing DISPLAYS it), but
   *  no longer dead weight either — the anchoring pass reads it on every
   *  comment. */
  selectorPrefix?: string;
  selectorSuffix?: string;
  selectorOccurrence?: number;
  /** F7 fix (T5 review): the most recent mutation failure FOR THIS COMMENT —
   *  a failed reply/resolve/reopen, or a failed add still sitting on its
   *  never-persisted draft. Per-comment, not per-path (the old `errorByPath`
   *  let a second failing comment in the same file silently clobber the
   *  first's error) — CommentCard/NewCommentPopover render it inline with
   *  `<ErrorState>` (error-message-standards.md: specific detail + Retry),
   *  never a global toast. Additive: existing consumers that destructure only
   *  the fields they already knew about see no change. */
  error?: { message: string; onRetry: () => void };
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
  const textSel = p.selector.kind === 'text' ? p.selector.selector : undefined;
  const [startLine, endLine] = p.selector.kind === 'text' ? p.selector.lineHint ?? [] : [];
  return {
    id: p.id,
    path: p.path,
    quote: textSel?.exact ?? '',
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
    // T14 fix (docs/active/specs/2026-09-26-doc-comments-build-design.md
    // §2.2/§2.3): this used to be threaded through ONLY for a still-pending
    // local draft (see the field's own comment below) — a comment that had
    // already round-tripped through the server lost its prefix/suffix/
    // occurrence entirely, so use-quote-marks.ts's real anchoring pass
    // (resolveSelector) had nothing to disambiguate a repeated phrase with
    // once the page reloaded or a `docComments:changed` refresh landed.
    selectorPrefix: textSel?.prefix,
    selectorSuffix: textSel?.suffix,
    selectorOccurrence: textSel?.occurrence,
  };
}

/** Builds the selector `docComments:add` needs from the renderer's simple
 *  call shape (`quote`/`opts`). F1 fix (T5 review): `prefix`/`suffix`/
 *  `occurrence` used to be hardcoded `''`/`''`/`0` for EVERY comment — a
 *  choice `resolveSelector` (§2.2) can never retroactively fix once written,
 *  so a repeated phrase's 2nd/3rd/… copy was indistinguishable from its 1st
 *  forever. `build-menu.ts`'s "Add comment" entries now compute these at
 *  selection time (raw/CM6: real character offsets against the full source;
 *  rendered markdown/docx: the DOM Range against the viewer container's own
 *  text, via `doc-comments-anchor.ts`'s `quoteContextAt`) and pass them
 *  through `opts` — this only threads them into the selector shape, same as
 *  before. `opts` staying optional keeps every existing call site (cell
 *  comments, and any caller that genuinely has no DOM to derive context from)
 *  working with the same honest `''`/`''`/`0` fallback as before. */
function selectorFor(
  quote: string,
  opts?: { startLine?: number; endLine?: number; cell?: string; sheet?: string; prefix?: string; suffix?: string; occurrence?: number },
): CommentSelector {
  if (opts?.cell) {
    const cellSel: CellSelector = { type: 'CellSelector', cell: opts.cell, sheet: opts.sheet };
    return { kind: 'cell', selector: cellSel };
  }
  const textSel: TextQuoteSelector = {
    type: 'TextQuoteSelector',
    exact: quote,
    prefix: opts?.prefix ?? '',
    suffix: opts?.suffix ?? '',
    occurrence: opts?.occurrence ?? 0,
  };
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
  // F4 fix (T5 review, design §7 review 2 F9): `id` is the renderer-minted
  // comment id (see `addComment` below) — main uses it instead of minting its
  // own, so the optimistic local id and the persisted id are the SAME string
  // from the start. Trailing/optional so a caller that never passes one (a
  // bare unit test) still round-trips through the pre-fix server-mint path.
  add: (path: string, selector: unknown, text: string, author: string, projectRoot?: string, id?: string) => Promise<unknown>;
  reply: (path: string, id: string, text: string, author: string, projectRoot?: string) => Promise<unknown>;
  resolve: (path: string, id: string, by: string, projectRoot?: string) => Promise<unknown>;
  reopen: (path: string, id: string, by: string, projectRoot?: string) => Promise<unknown>;
  move: (path: string, id: string, newSelector: unknown, projectRoot?: string) => Promise<unknown>;
  // Edit/delete (2026-09-28, doc-comments edit/delete build): E-2 (Destin's
  // decisions doc) — anyone's comment/reply, not just the author's, so no
  // `by`/author argument is needed here the way resolve/reopen carry one.
  // Channel payload shapes agreed with the concurrent main-process/Kotlin
  // build: `docComments:edit` {path,id,text,projectRoot}, `docComments:edit-
  // reply` {path,id,replyId,text,projectRoot}, `docComments:delete`
  // {path,id,projectRoot}, `docComments:delete-reply`
  // {path,id,replyId,projectRoot}. MOCK_ONLY in the workbench shim until that
  // build lands on preload/remote-shim/ipc-handlers (see mock-only.ts).
  edit: (path: string, id: string, text: string, projectRoot?: string) => Promise<unknown>;
  editReply: (path: string, id: string, replyId: string, text: string, projectRoot?: string) => Promise<unknown>;
  delete: (path: string, id: string, projectRoot?: string) => Promise<unknown>;
  deleteReply: (path: string, id: string, replyId: string, projectRoot?: string) => Promise<unknown>;
  watch: (path: string, projectRoot?: string) => Promise<unknown>;
  unwatch: (path: string, projectRoot?: string) => Promise<unknown>;
  // F3 fix (T5 review): `projectRoot` identifies WHICH project's copy of a
  // possibly-shared relative path changed — two projects can both have a
  // `README.md`, and without this a change in one could re-list the wrong
  // project's viewer (see `keyFor` below). `undefined` for the per-machine
  // loose-file store, matching every other channel's own `projectRoot` shape.
  onChanged: (cb: (evt: { path: string; projectRoot?: string }) => void) => () => void;
}

function getIpc(): DocCommentsIpc | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as any).claude?.docComments;
  return bridge && typeof bridge.list === 'function' ? (bridge as DocCommentsIpc) : null;
}

// F2 fix (T5, design review round 3 — High): `reply` carries the persisted
// `CommentReply` once `docComments:reply`'s response is enriched (§1.6) — see
// `addReply`'s own reconciliation below, which mirrors `persistNewComment`'s
// already-built `id` handling for `add`. `text` (2026-09-27): a docx/xlsx
// `add` may have STRIPPED XML-illegal control characters from the draft
// before persisting it (xml-text-safety.ts) — carries the actual persisted
// text back so `persistNewComment` can show what's really on disk instead of
// the pre-strip draft.
type MutationResult = { ok: true; id?: string; text?: string; reply?: CommentReply } | { ok: false; error?: string; field?: string; features?: string[] };

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
    // Code review 2026-09-27, Android F3: Android-only wire string — its
    // DocCommentsStore.mutateSidecar now distinguishes a write-time failure
    // (disk full, a failed atomic rename) from an unreadable existing
    // sidecar ('sidecar-corrupt' above), since reporting the former as
    // corruption would send someone chasing a problem that isn't there.
    // Desktop's own equivalent failure currently has no typed code at all
    // (it throws uncaught, caught only by this file's generic top-level
    // catch as a raw OS error string) — this case exists so Android's honest
    // distinction isn't lost to the generic default below.
    case 'sidecar-write-failed': return "This file's saved comments couldn't be saved right now.";
    case 'path-not-tracked': return "This file isn't part of an open project or tracked file.";
    case 'invalid-id': return "Couldn't save this comment — its id wasn't valid.";
    case 'duplicate-id': return 'A comment with this id already exists.';
    case 'read-failed': return "Couldn't read this file.";
    case 'invalid-docx': return "This Word file doesn't look valid.";
    case 'invalid-xlsx': return "This Excel file doesn't look valid.";
    case 'missing-document-part': return 'This Word document is missing a part comments need.';
    // Code review 2026-09-27, desktop F2: this code now ONLY ever means a
    // genuine size overflow (zip-size-guard.ts's `decompressBounded` maps
    // every other stream failure to 'invalid-docx'/'invalid-xlsx' above,
    // never here) — safe to state specifically rather than falling through
    // to the generic default below.
    case 'archive-too-large': return 'This file is too large to open safely.';
    // xlsx T12/T13 review F7 (Low): 'invalid-selector'/'selector-not-found'
    // also fire for an Excel CellSelector (a malformed cell address, a
    // missing `sheet` on a multi-tab workbook, a chartsheet named as if it
    // were a real sheet) — none of which involve "text". Reworded to a
    // format-neutral phrase (the review's own suggested fix) rather than
    // branching per format for one word.
    case 'invalid-selector':
    case 'selector-not-found':
      return 'That location is no longer valid in this file.';
    case 'sheet-not-found': return 'That sheet no longer exists in this workbook.';
    // §4.2's own one-thread-per-cell write policy — worded with a concrete
    // next step (docs/error-message-standards.md: state only what's known;
    // "reply instead" and "pick a different cell" are both always true here,
    // never a guess about WHY the cell already has one).
    case 'cell-already-has-comment':
      return 'This cell already has a comment. Reply to it, or add your new comment to a different cell.';
    case 'destination-cell-occupied':
      return 'The destination cell already has a comment. Choose a different cell to move this one to.';
    // Excel rebuild (2026-09-27, threaded-comments-only, design §4.1): a
    // threaded comment can't be added on top of a genuine legacy Note — exact
    // wording from the design's own §4.1 ("this app refuses the combination
    // as its own policy... needs no unverified claim about Excel's own
    // internals to be true").
    case 'cell-has-note':
      return 'This cell already has a note. Add your comment to a different cell, or remove the note in Excel first.';
    // §4.2/§4.3 (design review round 2, F3): two threads happen to share the
    // same GUID — a real, if rare, possibility this app refuses rather than
    // guessing which one a caller meant from scan order.
    case 'ambiguous-comment-id':
      return "More than one comment thread in this file matches that id, so YouCoded won't guess which one to change.";
    // §4 (design review 1, F3): the record-count ceiling — a workbook with an
    // implausible number of comment records is refused before this app opens
    // it for editing, the same "specific about what's known" bar as the
    // decompression-bomb guard below.
    case 'too-many-comments':
      return 'This workbook has more comments than YouCoded can safely open for editing.';
    // F9/this rewrite: the xlsx write path now edits an existing workbook's
    // comment data in place instead of rebuilding the whole file, so it can
    // refuse a workbook whose comment wiring doesn't look like an ordinary
    // legacy note (see xlsx-comments.ts's own 'ambiguous-comment-wiring' doc
    // comment) rather than risk guessing at it.
    case 'ambiguous-comment-wiring':
      return "This workbook's existing comments are set up in an unusual way YouCoded doesn't recognize, so it won't risk editing them.";
    // xlsx T12/T13 review F3 (Medium): the full-workbook fallback id-
    // resolution scan's own aggregate byte budget was exhausted before this
    // comment was found — distinct from the decompression/record-count
    // guards above (this is about how much this ONE search had to look
    // through, not the file's own size).
    case 'comment-scan-too-large':
      return "This workbook is too large for YouCoded to search for this comment right now.";
    case 'backup-failed': return "Couldn't make a safety copy before saving, so nothing was changed.";
    case 'write-failed': return "Couldn't save this change to the file.";
    case 'verify-failed': return "Saved, but the file didn't check out afterward, so the change was undone.";
    // T11 follow-up (design §3.3's new step 0, review round 3 F4): a real
    // Word/Excel/LibreOffice lock file sits beside the target — exact wording
    // from the design's own §3.3 step 0.
    case 'file-open-elsewhere':
      return 'This file looks open in another app. Close it there, then try again.';
    case 'not-yet-supported': return "This kind of comment isn't supported yet.";
    case 'not-implemented-on-mobile': return "This isn't available on the phone yet.";
    default: return "Error: this comment couldn't be saved.";
  }
}

// ── Per-(project, path) keying (F3 fix, T5 review) ──────────────────────────
// Every store map below used to be keyed by the bare relative `path`. Two
// DIFFERENT projects can share a relative path (both have a `README.md`) —
// keyed by bare path, their comments MERGED into one array, a write from one
// project's viewer could land in the other's array, and they shared a single
// watch refcount (the first project's viewer to close would unwatch the
// SECOND project's still-open file). Every map is now keyed by this composite
// string instead, built the same way `doc-comments-anchor.ts`'s
// `cellSelectorKey` already separates two identifiers with `\u0000` (a byte
// that can never appear in a real path or project root).
function keyFor(path: string, projectRoot: string | undefined): string {
  // WHY the backslash fold: main pushes `docComments:changed` with `/`
  // separators, but a Windows caller may have subscribed with `docs\live.md`;
  // both spellings name the same file and must land on the same key.
  return `${projectRoot ?? ''}\u0000${path.replace(/\\/g, '/')}`;
}
function projectRootOfKey(key: string): string | undefined {
  const root = key.slice(0, key.indexOf('\u0000'));
  return root || undefined;
}

// ── Seed data is GONE from this module (§7) ─────────────────────────────────
// It now lives in dev/workbench/mock-shim.ts's own docComments fixture, fed
// through the SAME docComments:list/watch IPC surface this store calls in the
// real app — the workbench needs no separate code path here.

const EMPTY_COMMENTS: readonly DocComment[] = [];

interface Snap {
  commentsByKey: Record<string, DocComment[]>;
  focusId: string | null;
  showResolvedByKey: Record<string, boolean>;
}

function emptySnap(): Snap {
  return { commentsByKey: {}, focusId: null, showResolvedByKey: {} };
}

let snap: Snap = emptySnap();
const subs = new Set<() => void>();
/** `id -> (project,path) key`, kept in lockstep with `commentsByKey` — every
 *  mutation below (`addReply`/`resolveComment`/`reopenComment`/…) is reached
 *  with just an id (the free-function API predates the per-file sidecar
 *  split, §1.6's own F1 finding), so this is what lets a lookup by id alone
 *  find the right key's array in O(1) instead of scanning every open file's
 *  comments. */
const commentKeyIndex = new Map<string, string>();

function publish(patch: Partial<Snap>) {
  snap = { ...snap, ...patch };
  for (const s of subs) s();
}

/** Replaces one key's array (and only that key's) — every touched-comment
 *  mutation goes through this so an unrelated key's `commentsByKey[key]`
 *  array reference never changes, which is what lets `getKeySnapshot` below
 *  skip a re-render for every OTHER open file (performance.md rule 3). */
function publishKey(key: string, comments: DocComment[]): void {
  publish({ commentsByKey: { ...snap.commentsByKey, [key]: comments } });
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** What `useDocComments(path, projectRoot)` actually hands
 *  `useSyncExternalStore` — a small per-key view, cached and reused across
 *  renders whenever nothing relevant to THIS key changed (comments, its own
 *  showResolved flag, or a focus id that belongs to one of ITS comments). A
 *  change to a different file's (or a different project's SAME-named file's)
 *  comments never invalidates this key's cached view, so
 *  `useSyncExternalStore`'s own `Object.is` check sees "unchanged" and skips
 *  re-rendering every OTHER mounted comments pane. */
interface KeySnap {
  comments: DocComment[];
  focusId: string | null;
  showResolved: boolean;
}
const keySnapCache = new Map<string, KeySnap>();

function getKeySnapshot(key: string): KeySnap {
  const comments = snap.commentsByKey[key] ?? (EMPTY_COMMENTS as DocComment[]);
  const focusId = snap.focusId != null && commentKeyIndex.get(snap.focusId) === key ? snap.focusId : null;
  const showResolved = snap.showResolvedByKey[key] ?? false;
  const cached = keySnapCache.get(key);
  if (cached && cached.comments === comments && cached.focusId === focusId && cached.showResolved === showResolved) {
    return cached;
  }
  const next: KeySnap = { comments, focusId, showResolved };
  keySnapCache.set(key, next);
  return next;
}

// ── F8 fix (T5 review): prune an unused (project, path) entry ──────────────
// A key with zero live subscribers AND zero comments left (every comment
// resolved-and-forgotten is still a comment; this is the "opened once, never
// commented" case, which is the overwhelming majority of files a long
// session touches) carries nothing worth keeping around forever — every map
// below grows by one entry per DISTINCT (project, path) ever opened, with no
// eviction, for the lifetime of the renderer process.
function pruneKeyIfUnused(key: string): void {
  if ((refsByKey.get(key) ?? 0) > 0) return;
  if ((snap.commentsByKey[key]?.length ?? 0) > 0) return;
  keySnapCache.delete(key);
  keyGeneration.delete(key);
  if (!(key in snap.commentsByKey) && !(key in snap.showResolvedByKey)) return;
  const nextComments = { ...snap.commentsByKey };
  delete nextComments[key];
  const nextShow = { ...snap.showResolvedByKey };
  delete nextShow[key];
  publish({ commentsByKey: nextComments, showResolvedByKey: nextShow });
}

// ── Hydration + watch (per key, refcounted) ─────────────────────────────────
// One list() per key per "goes from 0 to 1 live viewers" (design §7: "list on
// file open"); one docComments:watch subscription per key for as long as at
// least one viewer is mounted, released the instant the last one unmounts.
const refsByKey = new Map<string, number>();
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

/** Bumped every time server truth actually lands for a key — F9's own
 *  "has a refresh landed since this mutation started" check reads this to
 *  decide whether a failed reply/resolve/reopen's `rollback` would be
 *  reapplying a STALE pre-mutation snapshot over newer server truth that
 *  arrived while the mutation was in flight. */
const keyGeneration = new Map<string, number>();
function bumpGeneration(key: string): void {
  keyGeneration.set(key, (keyGeneration.get(key) ?? 0) + 1);
}
function currentGeneration(key: string): number {
  return keyGeneration.get(key) ?? 0;
}

// ── §7's reconcile rule (design review round 2, F1) ─────────────────────────
// An optimistic REPLY (unlike a brand-new comment, which `pendingLocalIds`
// already tracks above) has no per-store "not yet persisted" flag of its own
// — it lives inside its parent comment's `replies` array, which a
// `docComments:changed` push's own `mergeServerComments` call REPLACES
// wholesale (rule 1: "a push always replaces the whole array, never a
// field-by-field patch"). Without tracking it separately, a push landing
// before `addReply`'s own `docComments:reply` response resolves would
// silently drop the optimistic reply the instant the fresh read replaced the
// parent comment — exactly the race F1 exists to close. Keyed by the PARENT
// comment's id (a `clientId`-shaped local reply id is already unique per
// entry, §1.2's own account-ready-id convention extended to `r-...`).
interface InFlightReply {
  /** The optimistic reply's own local id (`r-${nextLocalSuffix()}`) —
   *  distinct from the eventual persisted id (rule/F2's own reconciliation). */
  localId: string;
  author: CommentAuthor;
  text: string;
  /** This client's own issue time — the "order" half of rule 2's F3 tie-break
   *  (design review round 3): two genuinely distinct, back-to-back identical
   *  replies pair with the fresh read's own matches by ORDER, never by bare
   *  content existence, since a real `<threadedComment>`/sidecar reply has no
   *  field for a client-generated correlation token to round-trip. */
  issuedAt: number;
}
const inFlightRepliesByParent = new Map<string, InFlightReply[]>();

function trackInFlightReply(parentId: string, localId: string, author: CommentAuthor, text: string, issuedAt: number): void {
  const list = inFlightRepliesByParent.get(parentId) ?? [];
  list.push({ localId, author, text, issuedAt });
  inFlightRepliesByParent.set(parentId, list);
}

/** Rule 3 (§7): the mutation's OWN response is the PRIMARY, fastest
 *  reconciliation path — called unconditionally (success or failure) the
 *  moment `docComments:reply`'s own response resolves, so a push that lands
 *  afterward for the SAME change is just a no-op replace (nothing left
 *  in-flight to re-append). */
function dropInFlightReply(parentId: string, localId: string): void {
  const list = inFlightRepliesByParent.get(parentId);
  if (!list) return;
  const next = list.filter((r) => r.localId !== localId);
  if (next.length) inFlightRepliesByParent.set(parentId, next);
  else inFlightRepliesByParent.delete(parentId);
}

/** Edit/delete build: a reply the user is editing/deleting may still be an
 *  optimistic placeholder from `addReply` (its `localId`, not yet reconciled
 *  with a persisted id) — there is nothing on the server yet for
 *  `docComments:edit-reply`/`docComments:delete-reply` to act on. */
function isReplyLocalOnly(parentId: string, replyId: string): boolean {
  return (inFlightRepliesByParent.get(parentId) ?? []).some((r) => r.localId === replyId);
}

/** Keeps an in-flight reply's tracked text in step with a local edit, so
 *  `reconcileInFlightRepliesForComment`'s later content match (author+text)
 *  compares against what the user actually has on screen now, not what was
 *  first typed. */
function updateInFlightReplyText(parentId: string, localId: string, text: string): void {
  const entry = (inFlightRepliesByParent.get(parentId) ?? []).find((r) => r.localId === localId);
  if (entry) entry.text = text;
}

/** F2 fix (T5, design review round 3 — High): swaps a reply's real, persisted
 *  id/author/text/createdAt into the parent's `replies` array IN PLACE,
 *  mirroring `persistNewComment`'s own already-built id-reconciliation shape
 *  for `add` (same file) — including the identical "already landed via a
 *  concurrent `list()`" guard: a `docComments:changed` push can resolve its
 *  own re-`list()` WHILE this exact `reply()` call is still in flight, so the
 *  server's own copy of this reply may already be present under the real id
 *  by the time this runs. Renaming the local placeholder in that case would
 *  create a duplicate-id crash the same way `persistNewComment`'s own WHY
 *  describes; drop the placeholder instead. */
function reconcileReplyId(parentId: string, localId: string, realReply: CommentReply): void {
  const key = commentKeyIndex.get(parentId);
  if (!key) return;
  const arr = snap.commentsByKey[key];
  if (!arr) return;
  const parent = arr.find((c) => c.id === parentId);
  if (!parent) return;
  const alreadyLanded = parent.replies.some((r) => r.id === realReply.id);
  const nextReplies = alreadyLanded
    ? parent.replies.filter((r) => r.id !== localId)
    : parent.replies.map((r) => (r.id === localId ? { ...realReply } : r));
  publishKey(key, arr.map((c) => (c.id === parentId ? { ...c, replies: nextReplies } : c)));
}

/** Rule 2 (§7, design review round 2, F1), applied to ONE fresh comment at
 *  `mergeServerComments` time: every reply still in `inFlightRepliesByParent`
 *  for this comment is re-appended after the server's own fresh replies list
 *  — UNLESS the fresh read's own content already reflects that specific
 *  reply (the push-arrived-before-the-response race, a genuine race rather
 *  than a bug). **F3 tie-break (design review round 3, Low):** a real reply
 *  has no field for a client-generated correlation token, so "already
 *  reflects it" can only ever match by content (author+text) — when MORE
 *  THAN ONE in-flight entry under this parent shares identical content
 *  (two back-to-back "thanks"), match by ORDER instead of bare existence:
 *  sort the in-flight entries by their own issue time, sort the fresh read's
 *  own matching replies by `createdAt` (the wire `dT`), and pair
 *  position-for-position, consuming one fresh match per in-flight entry — an
 *  unpaired remainder simply stays in-flight (that write hasn't settled or
 *  failed yet). */
function reconcileInFlightRepliesForComment(fresh: DocComment): DocComment {
  const inFlight = inFlightRepliesByParent.get(fresh.id);
  if (!inFlight || inFlight.length === 0) return fresh;
  const groups = new Map<string, InFlightReply[]>();
  for (const r of inFlight) {
    const gkey = `${r.author}\u0000${r.text}`;
    const arr = groups.get(gkey);
    if (arr) arr.push(r);
    else groups.set(gkey, [r]);
  }
  const consumedFreshIds = new Set<string>();
  const stillPending: InFlightReply[] = [];
  for (const [gkey, group] of groups) {
    const sep = gkey.indexOf('\u0000');
    const author = gkey.slice(0, sep) as CommentAuthor;
    const text = gkey.slice(sep + 1);
    const matches = fresh.replies
      .filter((r) => !consumedFreshIds.has(r.id) && r.author === author && r.text === text)
      .sort((a, b) => a.createdAt - b.createdAt);
    const ordered = [...group].sort((a, b) => a.issuedAt - b.issuedAt);
    for (let i = 0; i < ordered.length; i++) {
      if (i < matches.length) consumedFreshIds.add(matches[i].id);
      else stillPending.push(ordered[i]);
    }
  }
  if (stillPending.length === 0) return fresh;
  const appended: CommentReply[] = stillPending.map((r) => ({ id: r.localId, author: r.author, text: r.text, createdAt: r.issuedAt }));
  return { ...fresh, replies: [...fresh.replies, ...appended] };
}

/** Replaces every comment this store already knew about for `key` with the
 *  server's own list, but PRESERVES any comment that only exists locally so
 *  far (a draft still being composed, not yet persisted — see `addComment`) —
 *  the server has never heard of it, so a naive replace would silently
 *  discard someone's half-written note the moment an unrelated change on the
 *  same file pushed a refresh. Also preserves a live per-comment `error`
 *  (F7): that is CLIENT-side state the server has never heard of, and a
 *  refresh landing mid-failure must not silently clear the very error it
 *  exists to keep visible until the user retries or the retry succeeds.
 *  Rule 1/2 (§7): the fresh read wholesale-replaces `replies` too (never a
 *  field-by-field patch) — `reconcileInFlightRepliesForComment` is what
 *  re-appends a reply still in flight so this replace never visibly drops it. */
function mergeServerComments(key: string, serverComments: PersistedComment[]): void {
  const fresh = serverComments.map(fromPersisted).map(reconcileInFlightRepliesForComment);
  for (const c of fresh) commentKeyIndex.set(c.id, key);
  const existing = snap.commentsByKey[key] ?? [];
  const keptLocal = existing.filter((c) => pendingLocalIds.has(c.id));
  const errorsById = new Map(existing.filter((c) => c.error).map((c) => [c.id, c.error]));
  const freshWithErrors = errorsById.size
    ? fresh.map((c) => (errorsById.has(c.id) ? { ...c, error: errorsById.get(c.id) } : c))
    : fresh;
  bumpGeneration(key);
  publishKey(key, dedupeById([...keptLocal, ...freshWithErrors]));
}

async function hydrate(path: string, projectRoot: string | undefined): Promise<void> {
  const ipc = getIpc();
  if (!ipc) return;
  const res: any = await ipc.list(path, projectRoot).catch(() => null);
  if (res && res.ok && Array.isArray(res.comments)) {
    mergeServerComments(keyFor(path, projectRoot), res.comments as PersistedComment[]);
  }
}

function ensureChangedListener(): void {
  if (changedUnsub) return;
  const ipc = getIpc();
  if (!ipc) return;
  changedUnsub = ipc.onChanged((evt) => {
    const key = keyFor(evt.path, evt.projectRoot);
    if (!refsByKey.has(key)) return; // nobody is looking at this exact (project, file) right now
    void hydrate(evt.path, evt.projectRoot);
  });
}

/** Design §7/§1.5 "Watching", plus F6 (T5 review): a hidden-but-mounted
 *  viewer (a background session's ChatView, kept alive per performance.md
 *  rule 2) must not keep a live `docComments:watch` running — `useDocComments`
 *  below only calls this while `useOnScreen()` is true, so going off-screen
 *  releases the subscription exactly like unmounting would, and coming back
 *  on-screen re-subscribes, which re-`list()`s. */
function subscribeKey(path: string, projectRoot: string | undefined): () => void {
  const key = keyFor(path, projectRoot);
  const n = (refsByKey.get(key) ?? 0) + 1;
  refsByKey.set(key, n);
  ensureChangedListener();
  const ipc = getIpc();
  if (n === 1) {
    void hydrate(path, projectRoot);
    void ipc?.watch(path, projectRoot).catch(() => {});
  }
  return () => {
    const remaining = (refsByKey.get(key) ?? 1) - 1;
    if (remaining <= 0) {
      refsByKey.delete(key);
      void ipc?.unwatch(path, projectRoot).catch(() => {});
      // F5 fix (T5 review), corrected (data-loss bug, 2026-09-28): the LAST
      // viewer of this file just went away (or went off-screen) while a
      // draft was still uncommitted (never sent — see `commitDraft`'s own
      // WHY, since keystrokes no longer auto-persist). The ORIGINAL fix here
      // discarded any such draft outright — fine for one nobody ever typed
      // into, but for one with real typed text that silently threw away
      // whatever the user had written (exactly the "vanishes on close" shape
      // of the debounce bug this same file's T5 fix header now warns about).
      // A non-empty draft is committed instead — same outcome Enter/"Comment"/
      // click-away already produce, just triggered by the viewer closing
      // instead of an explicit action; a still-empty one (nothing typed) has
      // nothing to lose, so it's discarded exactly as before.
      for (const c of snap.commentsByKey[key] ?? []) {
        if (!pendingLocalIds.has(c.id)) continue;
        if (c.text.trim()) commitDraft(c.id);
        else removeComment(c.id);
      }
      pruneKeyIfUnused(key);
    } else {
      refsByKey.set(key, remaining);
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
 *  every mutation below that needs a REAL id to address a real comment. Also
 *  what `mergeServerComments`'s `keptLocal` keys off of (its own WHY): as
 *  long as an id stays in here, a server refresh can never see it (the
 *  server has never heard of it) and so can never overwrite its live local
 *  text — see `commitDraft`'s own WHY for why that window now lasts the
 *  WHOLE time a draft is being composed, not just its first keystroke. */
const pendingLocalIds = new Set<string>();

/** Data-loss bug fix (Destin, 2026-09-28 — "comment text gets changed/
 *  truncated/erased after saving"): `setCommentText` used to re-arm a 400ms
 *  debounced `persistNewComment` call on EVERY keystroke (performance.md
 *  rule 5's "don't add on every character" — a reasonable goal, but the
 *  wrong mechanism for a NEW draft with no "edit" IPC to fall back on).
 *  Typing "h", pausing >400ms, then typing more used to persist "h" — the
 *  debounce firing mid-composition — which also deleted the id from
 *  `pendingLocalIds` (`persistNewComment`'s success branch): every
 *  keystroke typed AFTER that point stayed LOCAL-ONLY (nothing left to send
 *  it — comments have no edit-after-add channel), and the next
 *  `docComments:changed` refresh (`mergeServerComments`'s `keptLocal` no
 *  longer kept this id local) replaced the on-screen text with the
 *  truncated saved prefix, even while the user was still typing. On disk
 *  this showed up as truncated prefixes of what was actually typed ('h',
 *  'cur', …).
 *
 *  Fix: a draft is no longer persisted by typing AT ALL — only by an
 *  explicit commit (`commitDraft` below), so `pendingLocalIds` now covers
 *  the ENTIRE composition, and a mid-typing refresh can never see (let
 *  alone overwrite) text the server doesn't have yet. */
function commitDraft(id: string): void {
  if (!pendingLocalIds.has(id)) return; // already persisted (or never existed) — nothing to commit
  const c = findComment(id);
  if (!c || !c.text.trim()) return; // nothing typed — ipc-handlers.ts refuses text: '' anyway
  persistNewComment(id);
}

function findComment(id: string): DocComment | undefined {
  const key = commentKeyIndex.get(id);
  if (!key) return undefined;
  return snap.commentsByKey[key]?.find((c) => c.id === id);
}

/** Every id-addressed mutation below funnels through this: look the id's key
 *  up in the index, apply `updater` to just that one comment inside just that
 *  key's array, and publish only that key (see `publishKey`'s own WHY). */
function updateComment(id: string, updater: (c: DocComment) => DocComment): DocComment | undefined {
  const key = commentKeyIndex.get(id);
  if (!key) return undefined;
  const arr = snap.commentsByKey[key];
  if (!arr) return undefined;
  const before = arr.find((c) => c.id === id);
  if (!before) return undefined;
  publishKey(key, arr.map((c) => (c.id === id ? updater(c) : c)));
  return before;
}

function rollback(id: string, previous: DocComment): void {
  updateComment(id, () => previous);
}

/** Edit/delete build: the same one-key-array-replace shape `updateComment`
 *  gives a top-level comment, applied to ONE reply inside a comment's
 *  `replies` array — so editing/deleting a reply never touches an unrelated
 *  comment's array reference (`publishKey`'s own WHY). Returns the PARENT
 *  comment as it stood before the change (its full pre-edit `replies` array
 *  included), which is exactly what `rollback(commentId, before)` needs to
 *  undo it on a failed mutation. */
function updateReply(commentId: string, replyId: string, updater: (r: CommentReply) => CommentReply): DocComment | undefined {
  const key = commentKeyIndex.get(commentId);
  if (!key) return undefined;
  const arr = snap.commentsByKey[key];
  if (!arr) return undefined;
  const before = arr.find((c) => c.id === commentId);
  if (!before || !before.replies.some((r) => r.id === replyId)) return undefined;
  publishKey(key, arr.map((c) => (c.id === commentId ? { ...c, replies: c.replies.map((r) => (r.id === replyId ? updater(r) : r)) } : c)));
  return before;
}

/** F7: attaches (or clears, passing `null`) a per-comment inline error —
 *  see `DocComment.error`'s own WHY. A no-op when the comment is already
 *  gone (e.g. a concurrent refresh removed it). */
function setCommentError(id: string, message: string, onRetry: () => void): void {
  updateComment(id, (c) => ({ ...c, error: { message, onRetry } }));
}
function clearCommentError(id: string): void {
  updateComment(id, (c) => (c.error ? { ...c, error: undefined } : c));
}

export function addComment(
  path: string,
  quote: string,
  sourceLabel: string,
  opts?: {
    startLine?: number; endLine?: number; cell?: string; sheet?: string; author?: CommentAuthor;
    // F1: the selector's disambiguation context (see `selectorFor`'s WHY).
    prefix?: string; suffix?: string; occurrence?: number;
    projectRoot?: string;
  },
): string {
  // F4 fix (T5 review, design §7 review 2 F9): the RENDERER mints the real id
  // up front — main uses THIS exact id instead of minting its own
  // (`docComments:add`'s `id` argument, threaded through by `persistNewComment`
  // below) — so the optimistic local id and the persisted id are the SAME
  // string from the start; no more swapping one for the other once the round
  // trip lands. `crypto.randomUUID()` (already used elsewhere in this
  // renderer, e.g. pending-handoff.ts) works with no IPC bridge too, so this
  // stays exactly as synchronous/offline-safe as the old counter-based id.
  const id = `c-${crypto.randomUUID()}`;
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
    selectorPrefix: opts?.prefix,
    selectorSuffix: opts?.suffix,
    selectorOccurrence: opts?.occurrence,
  };
  const key = keyFor(path, opts?.projectRoot);
  pendingLocalIds.add(id);
  commentKeyIndex.set(id, key);
  // WHY append, never unshift: comments read top-to-bottom in the margin in
  // the order they were made, same as Docs — a fresh one lands where its
  // anchor sits, not necessarily last, but insertion order is a stable tie-break.
  publish({
    commentsByKey: { ...snap.commentsByKey, [key]: [...(snap.commentsByKey[key] ?? []), comment] },
    focusId: id,
  });
  return id;
}

/** Actually calls `docComments:add` with whatever text the draft holds right
 *  now. Never called with empty text (the scheduler below only arms once
 *  text is non-empty; `ipc-handlers.ts` refuses an empty `text` outright). */
function persistNewComment(id: string): void {
  const comment = findComment(id);
  if (!comment || !comment.text.trim()) return;
  const ipc = getIpc();
  if (!ipc) return; // no bridge (unit test / no preload) — stays local-only
  const path = comment.path;
  const key = commentKeyIndex.get(id)!;
  const projectRoot = projectRootOfKey(key);
  const selector = selectorFor(comment.quote, {
    startLine: comment.startLine, endLine: comment.endLine, cell: comment.cell, sheet: comment.sheet,
    prefix: comment.selectorPrefix, suffix: comment.selectorSuffix, occurrence: comment.selectorOccurrence,
  });
  const sentText = comment.text;
  void callMutation(() => ipc.add(path, selector, comment.text, comment.author, projectRoot, id)).then((res) => {
    if (res.ok) {
      pendingLocalIds.delete(id);
      // 2026-09-27: a docx/xlsx target may have STRIPPED XML-illegal control
      // characters from `sentText` before persisting it (xml-text-safety.ts)
      // — `res.text` is what actually landed on disk. Only apply it if the
      // draft still matches what was sent: a fast follow-up edit (or this
      // callback losing a race with a newer `persistNewComment` call for the
      // same id) means the CURRENT text is already newer than this response.
      const textChanged = res.text !== undefined && res.text !== sentText;
      // F4: for a plain sidecar-backed file, `res.id === id` now (main used
      // OUR id) and this whole branch is a no-op. It stays as a safety net
      // for `.docx`/`.xlsx` targets, whose comment ids are the FILE's own
      // numbering (Word's `w:id`, Excel's cell-keyed note id) and can never
      // be dictated by the caller — those still mint their own id server-side
      // and this reconciles it.
      if (res.id && res.id !== id) {
        commentKeyIndex.delete(id);
        commentKeyIndex.set(res.id, key);
        const arr = snap.commentsByKey[key] ?? [];
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
        const nextArr = alreadyLanded
          ? arr.filter((c) => c.id !== id)
          : arr.map((c) => (c.id === id ? { ...c, id: res.id!, ...(textChanged && c.text === sentText ? { text: res.text! } : {}) } : c));
        publish({
          commentsByKey: { ...snap.commentsByKey, [key]: dedupeById(nextArr) },
          focusId: snap.focusId === id ? res.id! : snap.focusId,
        });
      } else if (textChanged && findComment(id)?.text === sentText) {
        updateComment(id, (c) => ({ ...c, text: res.text! }));
      }
      return;
    }
    // F7 fix (T5 review, supersedes review 2's F9 "remove it" behavior): a
    // failed add now KEEPS the draft in place (still a pending local, so
    // Retry can replay the exact same call) and attaches the failure to the
    // comment itself, for CommentCard/NewCommentPopover's own inline
    // `<ErrorState>` — never a global toast, and never silently discarded
    // (a user who typed a real note deserves the chance to retry it, not to
    // have it vanish).
    setCommentError(id, describeError(res), () => { clearCommentError(id); persistNewComment(id); });
  });
}

// Not exported: every caller reaches these through useDocComments() below
// (knip counts a bare export nobody imports as dead code).
//
// WHY no persist call here at all (data-loss fix, 2026-09-28): this used to
// arm a 400ms debounced `persistNewComment` on every keystroke — see
// `commitDraft`'s own WHY for exactly how that lost typed text. Typing now
// only ever updates LOCAL state; turning it into a real `docComments:add`
// call is `commitDraft`'s job alone, fired by an explicit commit (Enter /
// "Comment" / click-away / blur-with-text / the viewer closing with
// something typed) — never by the act of typing itself.
function setCommentText(id: string, text: string): void {
  updateComment(id, (c) => ({ ...c, text }));
  if (pendingLocalIds.has(id) && text.trim()) {
    clearCommentError(id); // a fresh edit retries fresh; the old failure no longer applies
  }
}

function addReply(id: string, author: CommentAuthor, text: string): void {
  if (!text.trim()) return;
  const trimmed = text.trim();
  const replyId = `r-${nextLocalSuffix()}`;
  const issuedAt = Date.now();
  const reply: CommentReply = { id: replyId, author, text: trimmed, createdAt: issuedAt };
  const before = updateComment(id, (c) => ({ ...c, replies: [...c.replies, reply] }));
  if (!before) return;
  const ipc = getIpc();
  if (!ipc || pendingLocalIds.has(id)) return; // never-persisted draft — nothing to reply to server-side yet
  const key = commentKeyIndex.get(id)!;
  const projectRoot = projectRootOfKey(key);
  const gen = currentGeneration(key);
  // §7's reconcile rule (design review round 2, F1): tracked so a
  // `docComments:changed` push landing before this call's own response
  // resolves re-appends this optimistic reply instead of silently dropping it
  // (`mergeServerComments` → `reconcileInFlightRepliesForComment`).
  trackInFlightReply(id, replyId, author, trimmed, issuedAt);
  void callMutation(() => ipc.reply(before.path, id, trimmed, author, projectRoot)).then((res) => {
    // Rule 3 (§7): the response is the PRIMARY, fastest reconciliation path —
    // drop from the in-flight set the instant it resolves, success or
    // failure, so a push arriving afterward for the SAME change is a no-op.
    dropInFlightReply(id, replyId);
    if (res.ok) {
      // F2 fix (T5, design review round 3 — High): `addReply`'s success
      // branch used to be `if (res.ok) return;` — it never read `res.reply`,
      // never swapped the optimistic placeholder id, and the reconcile rule's
      // in-flight set had nothing to remove it from either. Mirrors
      // `persistNewComment`'s own already-built id-reconciliation shape.
      if (res.reply) reconcileReplyId(id, replyId, res.reply);
      return;
    }
    // F9 fix (T5 review): a `docComments:changed` refresh can land WHILE this
    // mutation is in flight — reapplying `before` (captured before the
    // refresh) would silently undo that newer server truth. Re-list instead
    // whenever the key's generation moved; only rollback to `before` when
    // nothing newer has landed.
    if (currentGeneration(key) !== gen) void hydrate(before.path, projectRoot);
    else rollback(id, before);
    setCommentError(id, describeError(res), () => addReply(id, author, text));
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
  const key = commentKeyIndex.get(id)!;
  const projectRoot = projectRootOfKey(key);
  const gen = currentGeneration(key);
  void callMutation(() => ipc.resolve(before.path, id, by, projectRoot)).then((res) => {
    if (res.ok) return;
    if (currentGeneration(key) !== gen) void hydrate(before.path, projectRoot); // F9
    else rollback(id, before);
    setCommentError(id, describeError(res), () => resolveComment(id, by));
  });
}

/** T14 (§2.2/§2.3): the ONLY writer of `DocComment.status` — called by
 *  `use-quote-marks.ts`/`use-code-comment-anchors.ts` once per anchoring
 *  pass, for every comment they could resolve a verdict for. Deliberately
 *  NOT part of `DocCommentsApi` (§7: "that interface does not change") —
 *  this is an internal wiring detail between the viewer's DOM-aware
 *  anchoring pass and the shared store, not something a comment component
 *  itself decides to call.
 *
 *  Guards on the CURRENT value before calling `updateComment` (never inside
 *  the updater) because `updateComment` unconditionally republishes a new
 *  array for the key — an unguarded call would republish (and rerender every
 *  consumer of that file's comments) on every single anchoring pass, even
 *  when nothing changed, which is exactly the per-event-cost-growth
 *  performance.md rule 4 exists to prevent. With the guard, a pass reaches a
 *  fixed point after its own first publish (see the callers' own WHY on
 *  render-storm safety) instead of looping. Never persisted (PersistedComment
 *  comment's own WHY): purely a derived, client-side field, so this never
 *  touches IPC. */
export function setCommentStatus(id: string, status: 'anchored' | 'detached' | 'unchecked'): void {
  const current = findComment(id);
  if (!current || current.status === status) return;
  updateComment(id, (c) => ({ ...c, status }));
}

/** F4 (T14 review, performance.md rule 5): a stable per-comment "does this
 *  comment's ANCHOR need re-resolving" signature — id plus every field
 *  `resolveSelector`/`resolveCellSelector` actually reads (quote, selector
 *  prefix/suffix/occurrence, cell, sheet) plus `resolved` (which only changes
 *  the mark's OPEN/RESOLVED class, not its position, but still needs a fresh
 *  pass). Typing in a comment's own note or reply republishes `DocComment[]`
 *  with a brand-new array reference on every keystroke (`setCommentText`/
 *  `addReply` above) — `use-quote-marks.ts`'s `useQuoteMarks` and
 *  `use-code-comment-anchors.ts`'s `useCodeCommentAnchors` key their
 *  (expensive, whole-document) anchoring effect on THIS STRING instead of the
 *  array reference, so a keystroke that only changes `text`/`replies`/`error`
 *  never re-runs it. `\u0001`/`\u0002` separators: a real collision could only
 *  ever make the joined string LONGER/DIFFERENT than it would otherwise be
 *  (an unnecessary re-anchor at worst), never make two genuinely different
 *  comment sets compare equal. */
export function anchorSignature(comments: DocComment[]): string {
  return comments
    .map((c) => [
      c.id,
      c.quote,
      c.selectorPrefix ?? '',
      c.selectorSuffix ?? '',
      c.selectorOccurrence ?? '',
      c.cell ?? '',
      c.sheet ?? '',
      c.resolved ? '1' : '0',
    ].join('\u0001'))
    .join('\u0002');
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
  const key = commentKeyIndex.get(id)!;
  const projectRoot = projectRootOfKey(key);
  const gen = currentGeneration(key);
  void callMutation(() => ipc.reopen(before.path, id, 'user', projectRoot)).then((res) => {
    if (res.ok) return;
    if (currentGeneration(key) !== gen) void hydrate(before.path, projectRoot); // F9
    else rollback(id, before);
    setCommentError(id, describeError(res), () => reopenComment(id));
  });
}

/** Local-only discard of a NEVER-PERSISTED draft (NewCommentPopover's Cancel /
 *  CommentCard's Delete on an empty draft, both of which only show while a
 *  draft's text is still empty, i.e. before `commitDraft` could have run —
 *  plus `subscribeKey`'s own unmount/off-screen cleanup, for a draft that
 *  closed with nothing typed into it). Dropping the id from `pendingLocalIds`
 *  here (never persisted, so there is nothing on the server to undo) is what
 *  makes Cancel/Escape/Delete-on-a-draft send no IPC at all. Edit/delete
 *  build (2026-09-28): real, persisted deletion of a real comment is
 *  `deleteComment` below — this function stays draft-only. */
function removeComment(id: string): void {
  pendingLocalIds.delete(id);
  const key = commentKeyIndex.get(id);
  if (!key) return;
  commentKeyIndex.delete(id);
  const arr = snap.commentsByKey[key];
  if (!arr) return;
  publishKey(key, arr.filter((c) => c.id !== id));
  pruneKeyIfUnused(key); // F8: this may have been the key's last comment
}

/** Edit a comment's own note text. E-2 (Destin's decisions,
 *  docs/active/design/2026-09-24-doc-comments/doc-comments.edit-delete.
 *  questions.answers.json): anyone's comment can be edited, not only its
 *  author's — no `by` argument, unlike resolve/reopen. Same optimistic-
 *  update / rollback / inline-error shape as every other mutation here. */
function editComment(id: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return; // nothing to save — the Save button is disabled on empty text anyway
  const before = updateComment(id, (c) => ({ ...c, text: trimmed }));
  if (!before) return;
  const ipc = getIpc();
  if (!ipc || pendingLocalIds.has(id)) return; // never-persisted draft — nothing server-side to edit
  const key = commentKeyIndex.get(id)!;
  const projectRoot = projectRootOfKey(key);
  const gen = currentGeneration(key);
  void callMutation(() => ipc.edit(before.path, id, trimmed, projectRoot)).then((res) => {
    if (res.ok) return;
    if (currentGeneration(key) !== gen) void hydrate(before.path, projectRoot); // F9
    else rollback(id, before);
    setCommentError(id, describeError(res), () => editComment(id, text));
  });
}

/** Edit one reply's text — same shape as `editComment`, but through
 *  `updateReply`/rolled back onto the PARENT comment (a reply has no
 *  standalone entry of its own to roll back). A reply still in flight from
 *  `addReply` (no persisted id yet) is edited locally only; there is nothing
 *  on the server yet for `docComments:edit-reply` to act on, and
 *  `updateInFlightReplyText` keeps the later reconciliation pass comparing
 *  against the text actually on screen. */
function editReply(commentId: string, replyId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const before = updateReply(commentId, replyId, (r) => ({ ...r, text: trimmed }));
  if (!before) return;
  if (isReplyLocalOnly(commentId, replyId)) {
    updateInFlightReplyText(commentId, replyId, trimmed);
    return;
  }
  const ipc = getIpc();
  if (!ipc || pendingLocalIds.has(commentId)) return;
  const key = commentKeyIndex.get(commentId)!;
  const projectRoot = projectRootOfKey(key);
  const gen = currentGeneration(key);
  void callMutation(() => ipc.editReply(before.path, commentId, replyId, trimmed, projectRoot)).then((res) => {
    if (res.ok) return;
    if (currentGeneration(key) !== gen) void hydrate(before.path, projectRoot); // F9
    else rollback(commentId, before);
    setCommentError(commentId, describeError(res), () => editReply(commentId, replyId, text));
  });
}

/** Delete a whole comment thread. E-3 (Destin's decisions): deleting a
 *  thread's first comment deletes the whole thread — true for free here,
 *  since a thread IS one `DocComment` plus its nested `replies`, so removing
 *  the comment object removes every reply with it; no separate cascade is
 *  needed. E-2: anyone's comment. Rolls back to the FULL pre-delete array
 *  (not a re-insert-by-index) so a failed delete restores the comment
 *  exactly where it was, replies and all. */
function deleteComment(id: string): void {
  const key = commentKeyIndex.get(id);
  if (!key) return;
  const before = snap.commentsByKey[key];
  if (!before) return;
  const comment = before.find((c) => c.id === id);
  if (!comment) return;
  if (pendingLocalIds.has(id)) { removeComment(id); return; } // never persisted — nothing server-side to delete
  commentKeyIndex.delete(id);
  publishKey(key, before.filter((c) => c.id !== id));
  const ipc = getIpc();
  if (!ipc) return;
  const projectRoot = projectRootOfKey(key);
  const gen = currentGeneration(key);
  void callMutation(() => ipc.delete(comment.path, id, projectRoot)).then((res) => {
    if (res.ok) { pruneKeyIfUnused(key); return; }
    if (currentGeneration(key) !== gen) { void hydrate(comment.path, projectRoot); return; } // F9
    // Restore the index BEFORE republishing — setCommentError below (and any
    // render this publish triggers) looks the id up through commentKeyIndex.
    commentKeyIndex.set(id, key);
    publishKey(key, before);
    setCommentError(id, describeError(res), () => deleteComment(id));
  });
}

/** Delete one reply. Same in-flight-reply special case as `editReply` — a
 *  reply that never made it off this device yet is just dropped locally and
 *  out of the reconciliation tracking, with no server call at all. */
function deleteReply(commentId: string, replyId: string): void {
  const key = commentKeyIndex.get(commentId);
  if (!key) return;
  const arr = snap.commentsByKey[key];
  if (!arr) return;
  const before = arr.find((c) => c.id === commentId);
  if (!before || !before.replies.some((r) => r.id === replyId)) return;
  const removingLocalOnly = isReplyLocalOnly(commentId, replyId);
  publishKey(key, arr.map((c) => (c.id === commentId ? { ...c, replies: c.replies.filter((r) => r.id !== replyId) } : c)));
  if (removingLocalOnly) { dropInFlightReply(commentId, replyId); return; }
  const ipc = getIpc();
  if (!ipc || pendingLocalIds.has(commentId)) return;
  const projectRoot = projectRootOfKey(key);
  const gen = currentGeneration(key);
  void callMutation(() => ipc.deleteReply(before.path, commentId, replyId, projectRoot)).then((res) => {
    if (res.ok) return;
    if (currentGeneration(key) !== gen) { void hydrate(before.path, projectRoot); return; } // F9
    rollback(commentId, before);
    setCommentError(commentId, describeError(res), () => deleteReply(commentId, replyId));
  });
}

function clearCommentFocus(): void {
  const id = snap.focusId;
  if (id !== null) {
    commitDraft(id); // Enter / "Comment" / click-away — see commitDraft's own WHY
    publish({ focusId: null });
  }
}

/** Bare-path lookup for callers with no `projectRoot` of their own
 *  (use-ref-source-highlight.ts's chip highlighting, build-menu.test.tsx) —
 *  resolves against the per-machine loose-file partition (`keyFor(path,
 *  undefined)`). A caller that DOES know its project passes it, the same way
 *  `useDocComments` does, to read that project's own comments instead. */
export function commentsForPath(path: string, projectRoot?: string): DocComment[] {
  return snap.commentsByKey[keyFor(path, projectRoot)] ?? [];
}

function setShowResolved(key: string, value: boolean): void {
  publish({ showResolvedByKey: { ...snap.showResolvedByKey, [key]: value } });
}

export interface DocCommentsApi {
  comments: DocComment[];
  focusId: string | null;
  showResolved: boolean;
  setShowResolved: (value: boolean) => void;
  addComment: (
    quote: string,
    sourceLabel: string,
    opts?: { startLine?: number; endLine?: number; cell?: string; sheet?: string; prefix?: string; suffix?: string; occurrence?: number },
  ) => string;
  setCommentText: typeof setCommentText;
  /** Explicit commit for a still-uncommitted draft — see `commitDraft`'s own
   *  WHY. Wired to the panel's own inline draft (CommentCard's blur-with-
   *  text, via CommentsMargin/CodeCommentsRail); NewCommentPopover's Enter/
   *  "Comment"/click-away reach the same function through `clearFocus`. */
  commitDraft: typeof commitDraft;
  addReply: typeof addReply;
  resolveComment: typeof resolveComment;
  reopenComment: typeof reopenComment;
  removeComment: typeof removeComment;
  /** Edit/delete build (E-1..E-6, docs/active/design/2026-09-24-doc-comments/
   *  doc-comments.edit-delete.questions.answers.json). */
  editComment: typeof editComment;
  editReply: typeof editReply;
  deleteComment: typeof deleteComment;
  deleteReply: typeof deleteReply;
  clearFocus: typeof clearCommentFocus;
}

/** The one hook surfaces read — a slice of the shared store scoped to one
 *  (project, path) key (performance.md rule 3: subscribe to a slice, not the
 *  whole — `getKeySnapshot` is what makes this a REAL slice, not just a
 *  filtered view of one shared snapshot object). `projectRoot`, when the
 *  caller has one (every real viewer does, via ActiveArtifactView's own
 *  prop), is part of that key (F3, T5 review) — two projects sharing a
 *  relative path get two entirely separate entries, never merged. */
export function useDocComments(path: string, projectRoot?: string): DocCommentsApi {
  const key = keyFor(path, projectRoot);
  const s = useSyncExternalStore(subscribe, () => getKeySnapshot(key));
  // F6 fix (T5 review): a hidden-but-mounted viewer (a background session's
  // ChatView, kept alive per performance.md rule 2 — "App keeps a ChatView
  // mounted for EVERY open session") must not keep a live `docComments:watch`
  // running for a file nobody can see. `useOnScreen()` defaults to `true`
  // outside ChatView (e.g. Project View's Files tab, which already unmounts
  // its own file viewer on hide — see FilesTab.tsx's own WHY), so this is a
  // no-op there; inside a background ChatView it releases the watch exactly
  // like unmounting would, and re-subscribes (re-`list()`s) on coming back.
  const onScreen = useOnScreen();

  // Design §7 / §1.5 "Watching": list on mount, subscribe to docComments:watch
  // while at least one viewer is open AND on screen for this key, released
  // the moment the last one unmounts or goes off screen.
  useEffect(() => {
    if (!onScreen) return undefined;
    return subscribeKey(path, projectRoot);
  }, [path, projectRoot, onScreen]);

  return {
    comments: s.comments,
    focusId: s.focusId,
    showResolved: s.showResolved,
    setShowResolved: (value) => setShowResolved(key, value),
    addComment: (quote, sourceLabel, opts) => addComment(path, quote, sourceLabel, { ...opts, projectRoot }),
    setCommentText,
    commitDraft,
    addReply,
    resolveComment,
    reopenComment,
    removeComment,
    editComment,
    editReply,
    deleteComment,
    deleteReply,
    clearFocus: clearCommentFocus,
  };
}

/** Test-only: tears every module-level cache down between cases, the same
 *  convention `doc-comments-watcher.ts`'s `__resetDocCommentsWatcherForTest`
 *  and `useTagRegistry.ts`'s `__resetTagRegistryForTests` already use — this
 *  store is a module-level singleton, and a fake-IPC test suite that mutates
 *  the SAME comment ids/paths across cases needs a clean slate rather than
 *  relying on every case picking a never-before-used path. */
export function __resetDocCommentsStoreForTest(): void {
  pendingLocalIds.clear();
  commentKeyIndex.clear();
  keySnapCache.clear();
  keyGeneration.clear();
  refsByKey.clear();
  inFlightRepliesByParent.clear();
  changedUnsub?.();
  changedUnsub = null;
  snap = emptySnap();
}
