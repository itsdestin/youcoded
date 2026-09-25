// Document comments — Google Docs / Word style markup on a file's own text.
// UI-only mockup (Style A, "Margin"): comments live in renderer memory for
// this session, via a module-level useSyncExternalStore store (the pattern
// hooks/useTagRegistry.ts already uses for "many components read one slice")
// rather than a React Context — no Provider needs to be threaded through
// ActiveArtifactView/InputBar's ancestry, and a comment added from one pane
// (the file viewer) is visible from another (a second window on the same
// file) without prop drilling.
//
// Scope note (Destin, mid-task): comments are DURABLE RECORDS, not a
// copy-paste into chat — each has an author + timestamp, a reply thread, and
// can be resolved by EITHER Destin or the assistant (resolved comments hide
// from the doc by default but stay visible via "Show resolved"). There is no
// live assistant actor in this mockup, so the only INTERACTIVE resolve path
// resolves as the user; assistant-authored comments/replies/resolutions are
// demonstrated by the seed data below, never fabricated live.
import { useMemo, useSyncExternalStore } from 'react';

// `person:<name>` — someone other than you or the assistant, e.g. a colleague
// whose comment came from a Word or Excel file (Destin, questions deck Q-4:
// "show comments left in Word/Google Docs"). A string rather than an object
// so every existing `=== 'user'` / `=== 'assistant'` check keeps working and
// a resolvedBy can name that person too.
export type CommentAuthor = 'user' | 'assistant' | `person:${string}`;

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
   *  own model (Destin, chat follow-up: Excel comments same as Word). When
   *  set, the highlight is the cell itself (use-quote-marks.ts) and `quote`
   *  just records the cell's value for the assistant. */
  cell?: string;
  text: string;
  author: CommentAuthor;
  createdAt: number;
  replies: CommentReply[];
  resolved: boolean;
  resolvedBy: CommentAuthor | null;
  resolvedAt: number | null;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function basenameOf(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

// ── Seed data ────────────────────────────────────────────────────────────────
// Every quote below is an EXACT substring of the plan fixture (see
// dev/workbench/fixtures/artifacts.ts, ONBOARDING_PLAN) or the code fixture
// (a-chatview / ChatView.tsx), so the in-document highlight (comment-highlight
// matching by substring) finds them on first paint — reviewers see mixed
// comment states without clicking anything.
const PLAN_PATH = 'docs/active/plans/2026-09-24-onboarding-redesign.md';
const CODE_PATH = 'desktop/src/renderer/components/ChatView.tsx';
// Word + Excel fixtures (fixtures/docs.ts, fixtures/artifacts.ts). Quotes are
// exact substrings of the .docx body / exact cell addresses of the workbook.
const DOCX_PATH = 'docs/launch-brief.docx';
const XLSX_PATH = 'reports/q3-sales-by-rep.xlsx';
const PRIYA: CommentAuthor = 'person:Priya Shah';
const HOUR = 60 * 60 * 1000;
const now = Date.now();

function seedComments(): DocComment[] {
  return [
    // 1. Open — no reply yet.
    {
      id: 'seed-open',
      path: PLAN_PATH,
      quote: "Today's first-run flow shows five screens before the composer is reachable",
      sourceLabel: basenameOf(PLAN_PATH),
      text: 'Can we get a screenshot of these five screens before we commit to cutting them?',
      author: 'user',
      createdAt: now - 5 * HOUR,
      replies: [],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    },
    // 2. Replied by the assistant, still open.
    {
      id: 'seed-replied',
      path: PLAN_PATH,
      quote: 'Redesigning Settings itself',
      sourceLabel: basenameOf(PLAN_PATH),
      text: "Worth double-checking this doesn't quietly require Settings changes anyway.",
      author: 'user',
      createdAt: now - 4 * HOUR,
      replies: [
        {
          id: 'seed-replied-r1',
          author: 'assistant',
          text: 'It doesn’t — the model default and the theme strip both read existing Settings state without adding new rows there.',
          createdAt: now - 3.5 * HOUR,
        },
      ],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    },
    // 3. Resolved by the assistant.
    {
      id: 'seed-resolved-assistant',
      path: PLAN_PATH,
      quote: 'A dismissible strip offers the theme picker once, after the first reply',
      sourceLabel: basenameOf(PLAN_PATH),
      text: 'What happens if they dismiss it — is it gone forever, or does it come back in Settings?',
      author: 'user',
      createdAt: now - 3 * HOUR,
      replies: [
        {
          id: 'seed-resolved-assistant-r1',
          author: 'assistant',
          text: 'Added to Open Questions above — it can reopen from Settings > Appearance.',
          createdAt: now - 2.8 * HOUR,
        },
      ],
      resolved: true,
      resolvedBy: 'assistant',
      resolvedAt: now - 2.7 * HOUR,
    },
    // 4. Resolved by the user.
    {
      id: 'seed-resolved-user',
      path: PLAN_PATH,
      quote: 'no "unlock your workflow" language',
      sourceLabel: basenameOf(PLAN_PATH),
      text: 'Good — please keep echoing this rule in the actual copy review.',
      author: 'user',
      createdAt: now - 2 * HOUR,
      replies: [],
      resolved: true,
      resolvedBy: 'user',
      resolvedAt: now - 1.9 * HOUR,
    },
    // 5. Code file — a line-range comment (surface 2: "at least one comment
    // shown on a line range"), open.
    {
      id: 'seed-code-open',
      path: CODE_PATH,
      quote: 'stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;',
      sourceLabel: `line 15 · ${basenameOf(CODE_PATH)}`,
      startLine: 15,
      endLine: 15,
      text: 'Is 32px right on every pointer, or should this scale with line-height?',
      author: 'user',
      createdAt: now - HOUR,
      replies: [],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    },
    // 6–9. Word document. The two Priya comments are ALSO in the fixture's
    // own comments.xml (fixtures/docs/make.mjs) — they stand for comments
    // someone left in Word before the file reached you, and look like any
    // other thread (repliable, resolvable) on purpose.
    {
      id: 'seed-docx-priya-goal',
      path: DOCX_PATH,
      quote: 'Move 30% of weekly active users to the new app within six weeks of launch.',
      sourceLabel: basenameOf(DOCX_PATH),
      text: 'Is 30% realistic? The last launch reached 18% in the same window.',
      author: PRIYA,
      createdAt: now - 26 * HOUR,
      replies: [
        { id: 'seed-docx-priya-goal-r1', author: 'user', text: 'Fair — the in-app prompt should help, but let’s say 25%.', createdAt: now - 6 * HOUR },
      ],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    },
    {
      id: 'seed-docx-priya-legal',
      path: DOCX_PATH,
      quote: 'Beta opens to 500 customers on March 10',
      sourceLabel: basenameOf(DOCX_PATH),
      text: 'Legal needs the beta terms by March 3 at the latest.',
      author: PRIYA,
      createdAt: now - 25 * HOUR,
      replies: [],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    },
    {
      id: 'seed-docx-emails',
      path: DOCX_PATH,
      quote: 'Marketing emails go out the same morning as the public launch.',
      sourceLabel: basenameOf(DOCX_PATH),
      text: 'Should we stagger these so support isn’t flooded on day one?',
      author: 'user',
      createdAt: now - 3 * HOUR,
      replies: [
        { id: 'seed-docx-emails-r1', author: 'assistant', text: 'Staggering over three days keeps tickets near today’s weekly level. Want me to add that to the timeline?', createdAt: now - 2.5 * HOUR },
      ],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    },
    {
      id: 'seed-docx-android',
      path: DOCX_PATH,
      quote: 'The payment screen has not been tested on older Android phones.',
      sourceLabel: basenameOf(DOCX_PATH),
      text: 'Which Android versions count as “older” here?',
      author: 'user',
      createdAt: now - 5 * HOUR,
      replies: [
        { id: 'seed-docx-android-r1', author: 'assistant', text: 'Changed it to “Android 11 and earlier”, which is what the test plan covers.', createdAt: now - 4.5 * HOUR },
      ],
      resolved: true,
      resolvedBy: 'assistant',
      resolvedAt: now - 4.5 * HOUR,
    },
    // 10–12. Spreadsheet — cell comments (Excel's model), in the workbook's
    // own cells (fixtures/sheets/make.mjs: header row 1, data from row 2).
    {
      id: 'seed-xlsx-north',
      path: XLSX_PATH,
      cell: 'C4',
      quote: '41',
      sourceLabel: `C4 · ${basenameOf(XLSX_PATH)}`,
      text: 'North looks low for July — was the Denver account left out?',
      author: PRIYA,
      createdAt: now - 20 * HOUR,
      replies: [],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    },
    {
      id: 'seed-xlsx-south',
      path: XLSX_PATH,
      cell: 'C15',
      quote: '167',
      sourceLabel: `C15 · ${basenameOf(XLSX_PATH)}`,
      text: 'Can you check this against the invoice total? It seems high.',
      author: 'user',
      createdAt: now - 2 * HOUR,
      replies: [
        { id: 'seed-xlsx-south-r1', author: 'assistant', text: 'It matches: two invoices of 84 and 83 were booked on Sep 29.', createdAt: now - 1.8 * HOUR },
      ],
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    },
    {
      id: 'seed-xlsx-header',
      path: XLSX_PATH,
      cell: 'C1',
      quote: 'Amount',
      sourceLabel: `C1 · ${basenameOf(XLSX_PATH)}`,
      text: 'Say what unit this is in (thousands?).',
      author: 'user',
      createdAt: now - 7 * HOUR,
      replies: [],
      resolved: true,
      resolvedBy: 'user',
      resolvedAt: now - 6 * HOUR,
    },
  ];
}

interface Snap {
  comments: DocComment[];
  focusId: string | null;
  /** "Show resolved" is per-file, not global — a reviewer working through one
   *  file's history shouldn't flip every other open file's margin too. Shared
   *  here (not local state in either component) so the review bar's toggle
   *  and the margin's filter can never disagree. */
  showResolvedByPath: Record<string, boolean>;
}

let snap: Snap = { comments: seedComments(), focusId: null, showResolvedByPath: {} };
const subs = new Set<() => void>();

function publish(patch: Partial<Snap>) {
  snap = { ...snap, ...patch };
  for (const s of subs) s();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

function getSnapshot(): Snap {
  return snap;
}

export function addComment(
  path: string,
  quote: string,
  sourceLabel: string,
  opts?: { startLine?: number; endLine?: number; cell?: string; author?: CommentAuthor },
): string {
  const id = nextId('c');
  const comment: DocComment = {
    id,
    path,
    quote,
    sourceLabel,
    startLine: opts?.startLine,
    endLine: opts?.endLine,
    cell: opts?.cell,
    text: '',
    author: opts?.author ?? 'user',
    createdAt: Date.now(),
    replies: [],
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
  };
  // WHY append, never unshift: comments read top-to-bottom in the margin in
  // the order they were made, same as Docs — a fresh one lands where its
  // anchor sits, not necessarily last, but insertion order is a stable tie-break.
  publish({ comments: [...snap.comments, comment], focusId: id });
  return id;
}

// Not exported: every caller reaches these through useDocComments() below
// (knip counts a bare export nobody imports as dead code).
function setCommentText(id: string, text: string): void {
  publish({ comments: snap.comments.map((c) => (c.id === id ? { ...c, text } : c)) });
}

function addReply(id: string, author: CommentAuthor, text: string): void {
  if (!text.trim()) return;
  publish({
    comments: snap.comments.map((c) =>
      c.id === id
        ? { ...c, replies: [...c.replies, { id: nextId('r'), author, text: text.trim(), createdAt: Date.now() }] }
        : c,
    ),
  });
}

function resolveComment(id: string, by: CommentAuthor): void {
  publish({
    comments: snap.comments.map((c) =>
      c.id === id ? { ...c, resolved: true, resolvedBy: by, resolvedAt: Date.now() } : c,
    ),
  });
}

function reopenComment(id: string): void {
  publish({
    comments: snap.comments.map((c) => (c.id === id ? { ...c, resolved: false, resolvedBy: null, resolvedAt: null } : c)),
  });
}

function removeComment(id: string): void {
  publish({ comments: snap.comments.filter((c) => c.id !== id) });
}

function clearCommentFocus(): void {
  if (snap.focusId !== null) publish({ focusId: null });
}

export function commentsForPath(path: string): DocComment[] {
  return snap.comments.filter((c) => c.path === path);
}

function setShowResolved(path: string, value: boolean): void {
  publish({ showResolvedByPath: { ...snap.showResolvedByPath, [path]: value } });
}

export interface DocCommentsApi {
  comments: DocComment[];
  focusId: string | null;
  showResolved: boolean;
  setShowResolved: (value: boolean) => void;
  addComment: (quote: string, sourceLabel: string, opts?: { startLine?: number; endLine?: number; cell?: string }) => string;
  setCommentText: typeof setCommentText;
  addReply: typeof addReply;
  resolveComment: typeof resolveComment;
  reopenComment: typeof reopenComment;
  removeComment: typeof removeComment;
  clearFocus: typeof clearCommentFocus;
}

/** The one hook surfaces read — a slice of the shared store scoped to one
 *  file path (performance.md rule 3: subscribe to a slice, not the whole). */
export function useDocComments(path: string): DocCommentsApi {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const list = useMemo(() => s.comments.filter((c) => c.path === path), [s.comments, path]);
  return {
    comments: list,
    focusId: s.focusId,
    showResolved: s.showResolvedByPath[path] ?? false,
    setShowResolved: (value) => setShowResolved(path, value),
    addComment: (quote, sourceLabel, opts) => addComment(path, quote, sourceLabel, opts),
    setCommentText,
    addReply,
    resolveComment,
    reopenComment,
    removeComment,
    clearFocus: clearCommentFocus,
  };
}
