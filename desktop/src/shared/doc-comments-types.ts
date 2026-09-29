// Document comments — shared types. T1 of the doc-comments build
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §1.1, "Web
// Annotation-flavored" record shape). Copied verbatim from the design's own
// pre-written schema, not re-derived — the design's own §8 task table calls
// getting this shape wrong "expensive": T4/T8/T9a/T10/T12 all build on it.
//
// WHY this lives in its own file rather than beside the store: three
// SEPARATE runtimes need to agree on this shape byte-for-byte — the Electron
// main process, the React renderer (§2's anchoring pass, §7's optimistic UI),
// and the dependency-free Claude Code MCP script (§9), which has no access to
// this repo's module graph and hand-copies these shapes as plain constants.
// One file is what makes a future schema change (e.g. adding an account id)
// a single reviewed diff instead of three drifting copies.
export type CommentAuthor = 'user' | 'assistant' | `person:${string}`;

export interface TextQuoteSelector {
  type: 'TextQuoteSelector'; // W3C Web Annotation Data Model §4.2.3
  exact: string; // the quoted text itself
  prefix: string; // ~32 chars before, whitespace-collapsed
  suffix: string; // ~32 chars after, whitespace-collapsed
  /** 0-indexed: which match of `exact` in the document this was, at creation
   *  time — disambiguates a repeated phrase without needing character
   *  offsets that a later edit would invalidate anyway. */
  occurrence: number;
}

export interface CellSelector {
  type: 'CellSelector';
  cell: string; // "C4"
  sheet?: string; // sheet tab name; absent = the workbook's only sheet
}

export type CommentSelector =
  | { kind: 'text'; selector: TextQuoteSelector; lineHint?: [number, number] }
  | { kind: 'cell'; selector: CellSelector };

export interface CommentReply {
  id: string; // `${commentId}-r${n}`, account-ready (§1.2)
  author: CommentAuthor;
  text: string;
  createdAt: number;
}

export interface ResolveEvent {
  by: CommentAuthor;
  at: number;
  action: 'resolved' | 'reopened';
}

export interface PersistedComment {
  id: string;
  /** Project-relative (or absolute, for the fallback store — §1.4). */
  path: string;
  selector: CommentSelector;
  text: string;
  author: CommentAuthor;
  createdAt: number;
  replies: CommentReply[];
  resolved: boolean;
  /** Full resolve/reopen AUDIT TRAIL (review 1, F13) — R6 needs the
   *  assistant's decisions to be legible after the fact, not just the
   *  latest resolved/resolvedAt-shaped state the renderer mock had. */
  history: ResolveEvent[];
  /** Set by the anchoring pass (§2, T2) at READ time, never persisted:
   *  whether `selector` currently resolves against the file on disk. Kept
   *  out of the stored record so two writers racing on `resolved`/`text`
   *  never also race on a derived field. T1 never sets or reads this. */
  status?: 'anchored' | 'detached';
}

/** §1.3: one JSON sidecar per commented source file's on-disk shape,
 *  `.youcoded/comments/<relative/path/to/file>.json`. `version` exists from
 *  day one so a future schema change can migrate on read instead of needing
 *  a flag day. */
export interface CommentsSidecarFile {
  version: 1;
  comments: PersistedComment[];
}

// ---------------------------------------------------------------------------
// §9.2 / T9a+T9b: the docx/xlsx pending-mutation queue. The Claude Code MCP
// script (T9a) has neither JSZip nor an XML library on either platform (§9.1
// point 2) and "never touches a .docx/.xlsx file directly" (§1.6) — for ANY
// operation against one of those two formats, including a plain read, it
// writes one of these request files under
// `.youcoded/comments/.pending/<id>.json` and polls for the matching
// `<id>.result.json` the main-process queue (T9b, pending-mutation-queue.ts)
// writes once it has applied the request through the real
// docx-comments.ts/xlsx-comments.ts code. Both the MCP script (hand-copies
// this shape as plain JS — it cannot import this file, same constraint as
// every other dependency-free-script type here) and pending-mutation-queue.ts
// (imports this file directly) must agree on it byte-for-byte.
// Not exported: only PendingMutationRequest.kind (below) uses this — every
// caller compares against the literal strings directly rather than needing
// the type name itself.
type PendingMutationKind = 'list' | 'add' | 'reply' | 'resolve' | 'reopen' | 'move';

export interface PendingMutationRequest {
  /** Also the file's own basename (`<id>.json`) and the result's
   *  (`<id>.result.json`) — minted fresh per request (`randomUUID()`), never
   *  reused, so two requests never collide on the same file the way two
   *  writers CAN collide on the same JSON sidecar (§9.1) — this is why the
   *  request write itself needs no lock, only an atomic tmp-then-rename
   *  (chatsearch.js's own outbox precedent, review 2 F12). */
  id: string;
  kind: PendingMutationKind;
  format: 'docx' | 'xlsx';
  /** Project-relative (or fallback-absolute) path, exactly as
   *  `PersistedComment.path` carries it elsewhere (§1.1) — never the
   *  resolved absolute path, so the main-process applier's own containment
   *  check (doc-comments-dispatch.ts's `resolveDocxTarget`/`resolveXlsxTarget`)
   *  runs on the SAME kind of input every other caller gives it. */
  path: string;
  /** The MCP script's own trusted, spawn-time project root
   *  (`YOUCODED_PROJECT_ROOT` — never model-controlled input; see
   *  shared/doc-comments-mcp.ts's own header). **Advisory only, as of
   *  adversarial review 2026-09-27 finding #1 — the applier (pending-
   *  mutation-queue.ts) NEVER uses this field for authorization.** A
   *  self-reported field inside an otherwise-unauthenticated file drop-box is
   *  exactly as trustworthy as whatever wrote the file — which, absent the
   *  `token` field below, could be anything with ordinary filesystem write
   *  access to the project, not only this session's own MCP script. The
   *  applier resolves every request against the WATCHER's own verified root
   *  instead (the `realRoot` its `Entry` was created with); this field is
   *  kept only because the request shape still needs to carry SOME value
   *  here for shape-compat with earlier drafts of this design, and a future
   *  reader diffing a captured request against the applied result can use it
   *  to spot a mismatch. */
  projectRoot: string;
  /** This session's own per-deployment secret (`YOUCODED_MCP_TOKEN` env var —
   *  shared/doc-comments-mcp.ts's own header), included on EVERY request.
   *  The applier refuses (typed `invalid-request-token`) any request whose
   *  token doesn't match, in constant time, the token of one of the Claude
   *  Code sessions currently sharing this project's queue — the actual
   *  authorization boundary this field-drop-box design needs, since nothing
   *  else here proves a request came from this app's own deployed script. */
  token: string;
  /** `reply`/`resolve`/`reopen`/`move` only. */
  commentId?: string;
  /** `add`/`reply` only. */
  text?: string;
  /** `add`/`reply` only. */
  author?: CommentAuthor;
  /** `add` only. */
  selector?: CommentSelector;
  /** `move` only (review 3, F2). */
  newSelector?: CommentSelector;
  createdAt: number;
}

/** The applier's own outcome, one field wider than `PersistedComment[]`
 *  alone: `kind: 'list'` returns `comments`, `kind: 'add'` returns the new
 *  `id`, `kind: 'move'` ALSO returns `id` but only for an xlsx target whose
 *  fresh cell-embedded id changed (code review 2026-09-27, F1 — a docx move's
 *  id never changes, so that branch omits it), and the remaining three kinds
 *  return a bare `{ok:true}` — the exact same per-operation shape
 *  doc-comments-dispatch.ts's own functions already return, just carried
 *  through a file instead of a return value. */
export type PendingMutationResult =
  // `reply` (design commit 6c612cb9, §1.5/§1.6/§7): a docx/xlsx `reply`'s
  // persisted CommentReply, once docx-comments.ts's/xlsx-comments.ts's own
  // reply function is enriched to return it (T3's own row owns that change —
  // T9b only needs to be ready to forward whatever it gets, never invent the
  // shape itself). Optional and additive: today those functions still return
  // a bare `{ok:true}`, so this field is simply absent until that lands.
  | { ok: true; comments?: PersistedComment[]; id?: string; reply?: CommentReply }
  | { ok: false; error: string; features?: string[] };
