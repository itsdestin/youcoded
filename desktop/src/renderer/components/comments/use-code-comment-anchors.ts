// use-code-comment-anchors — CodeCommentsRail's own anchoring pass. T14
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §2.2/§2.3):
// CodeMirror virtualizes its DOM (only viewport lines exist — see
// ref-line-highlight.ts's own WHY), so there is no `<mark>` to wrap the way
// use-quote-marks.ts does for markdown/docx; a code comment's "highlight" is
// CodeMirror's own line decoration (cm/ref-line-highlight.ts), driven by the
// line range CodeCommentsRail hands it. That line range must come from the
// SAME `resolveSelector` this build uses everywhere else, run against the
// LIVE EditorView's current document text — not the line number
// `describeArtifactSelection` captured at CREATION time (`c.startLine`/
// `endLine`, `doc-comments-store.ts`'s `fromPersisted`), which never updates
// and drifts the moment an edit above the comment's line shifts everything
// below it.
import { useLayoutEffect, useRef, useState } from 'react';
// Type-only: this hook never constructs or imports the runtime module itself
// (CodeEditorView owns that) — matches editor-registry.ts's own type-only import.
import type { EditorView } from '@codemirror/view';
import { resolveSelector } from '../../../shared/doc-comments-anchor';
import type { TextQuoteSelector } from '../../../shared/doc-comments-types';
import { setCommentStatus, anchorSignature, type DocComment } from '../../state/doc-comments-store';
import { visibleEditorFor } from '../artifact-views/cm/ref-line-highlight';
// F1/F2/F3 (T14 review): the same document-length bound use-quote-marks.ts
// enforces for its own O(document-length) tree walk — CodeMirror's live
// document can be just as large as a rendered file's DOM text, and exporting
// ONE number from there keeps both hooks agreeing on it rather than risking
// two that quietly drift apart.
import { MAX_ANCHOR_TEXT_CHARS } from './use-quote-marks';

export interface ResolvedLines {
  startLine: number;
  endLine: number;
}

// Recomputed whenever a comment's ANCHOR actually changes (see `signature`
// below), plus on a debounced watch of the editor's own DOM for an external
// edit (the assistant, a git pull) landing WHILE the panel is open.
//
// F4 (T14 review) corrects this WHY, which used to claim interactive typing
// never reaches this hook at all: ActiveArtifactView only hides the comments
// panel while EDITING THE FILE (`showComments = !editing && …`), not while
// typing a note/reply INSIDE an already-open comment card — and that IS a
// keystroke-frequency path, because every such keystroke republishes
// `DocComment[]` with a brand-new array reference (doc-comments-store.ts's
// `setCommentText`/`addReply`). A plain `[path, comments]` effect dependency
// used to re-run this hook's WHOLE-FILE `resolveSelector` pass on every one
// of those keystrokes, for every comment in the file — performance.md rule 5
// squarely applies here after all. The fix keys the effect on
// `anchorSignature(comments)` (doc-comments-store.ts) instead: typing
// text/replies leaves every comment's id/quote/selector/cell/sheet/resolved
// unchanged, so the signature string is unchanged and the effect below
// simply doesn't re-run.
//
// The debounce below is for the SEPARATE "someone else changed the file
// while I'm reading it" case (an external edit's MutationObserver firing),
// which still needs its own timer regardless of the fix above. 300ms matches
// this feature's other debounces (doc-comments-store.ts's own watcher,
// git-watcher.ts's DEBOUNCE_MS).
const DOC_CHANGE_DEBOUNCE_MS = 300;

// F1/F2 (T14 review): `docText` is hoisted OUT of this function and computed
// ONCE per pass by the caller (`run` below) — before this fix every comment
// called `view.state.doc.toString()` itself, an O(document-length) COPY,
// each time; a file with N comments paid that cost N times per pass instead
// of once. `view` is still threaded through for `lineAt`, which reads
// CodeMirror's own line-index structure, not the string.
function resolveOne(view: EditorView, docText: string, c: DocComment): ResolvedLines | 'detached' | null {
  if (!c.quote) return null;
  const sel: TextQuoteSelector = {
    type: 'TextQuoteSelector',
    exact: c.quote,
    prefix: c.selectorPrefix ?? '',
    suffix: c.selectorSuffix ?? '',
    occurrence: c.selectorOccurrence ?? 0,
  };
  const range = resolveSelector(docText, sel);
  if (range === 'detached') return 'detached';
  const startLine = view.state.doc.lineAt(range.start).number;
  const endLine = view.state.doc.lineAt(Math.max(range.start, range.end - 1)).number;
  return { startLine, endLine };
}

/** `id -> currently-resolved line range`, for every `comments` entry
 *  `resolveSelector` could anchor right now — a comment it could not anchor
 *  is left OUT of the map (never a stale fallback to `c.startLine`/`endLine`;
 *  §2.3: a detached comment gets no highlight) and its `status` is set to
 *  `'detached'` via `setCommentStatus`, the same store field
 *  `use-quote-marks.ts` writes for every other file type. */
export function useCodeCommentAnchors(path: string, comments: DocComment[]): Map<string, ResolvedLines> {
  const [resolved, setResolved] = useState<Map<string, ResolvedLines>>(new Map());
  // F4: see this hook's own corrected WHY above `DOC_CHANGE_DEBOUNCE_MS` —
  // `commentsRef` (the same "latest ref" idiom renderer-lists.md's own
  // SkillCard/SessionDrawer use for handlers) hands `run` below the CURRENT
  // comments without making the array reference itself an effect dependency.
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const signature = anchorSignature(comments);

  useLayoutEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    let debounceTimer: number | null = null;
    let observer: MutationObserver | null = null;

    // WHY a retry, not a single lookup: CodeEditorView registers its
    // EditorView from a regular (passive) `useEffect`, which — on the SAME
    // commit CodeCommentsRail first mounts beside it — runs AFTER this
    // hook's own `useLayoutEffect`. A single `visibleEditorFor` call here
    // would reliably miss the freshly-opened file's editor. Mirrors
    // `flashPendingJump`'s own retry loop in ref-line-highlight.ts.
    const attempt = (tries: number) => {
      if (cancelled) return;
      const view = visibleEditorFor(path);
      if (!view) {
        if (tries < 30) retryTimer = window.setTimeout(() => attempt(tries + 1), 150);
        else setResolved(new Map());
        return;
      }

      const run = () => {
        // F1/F2: ONE `toString()` per pass, not one per comment (see
        // `resolveOne`'s own WHY). F3: past the bound, every comment is
        // marked 'unchecked' (too large to check at all — never a false
        // 'detached', which would claim the text is specifically gone).
        const docText = view.state.doc.toString();
        const next = new Map<string, ResolvedLines>();
        if (docText.length > MAX_ANCHOR_TEXT_CHARS) {
          for (const c of commentsRef.current) {
            if (c.quote) setCommentStatus(c.id, 'unchecked');
          }
          setResolved(next);
          return;
        }
        for (const c of commentsRef.current) {
          const result = resolveOne(view, docText, c);
          if (result === 'detached') {
            setCommentStatus(c.id, 'detached');
          } else if (result) {
            setCommentStatus(c.id, 'anchored');
            next.set(c.id, result);
          }
        }
        setResolved(next);
      };
      run();

      // WHY a MutationObserver rather than CodeMirror's own updateListener:
      // this hook has no EditorView-construction access (CodeEditorView owns
      // that), only the registry lookup above — the DOM is the one channel
      // every caller of this module already shares (ref-line-highlight.ts's
      // own `visibleEditorFor` is DOM-based for the same reason).
      observer = new MutationObserver(() => {
        if (debounceTimer != null) window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(run, DOC_CHANGE_DEBOUNCE_MS);
      });
      observer.observe(view.dom, { childList: true, subtree: true, characterData: true });
    };
    attempt(0);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (retryTimer != null) window.clearTimeout(retryTimer);
      if (debounceTimer != null) window.clearTimeout(debounceTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commentsRef always holds the latest comments; signature (not the array reference) is the real re-anchor trigger, see the WHY above DOC_CHANGE_DEBOUNCE_MS
  }, [path, signature]);

  return resolved;
}
