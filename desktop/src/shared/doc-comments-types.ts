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
