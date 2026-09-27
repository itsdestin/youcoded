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
import { useLayoutEffect, useState } from 'react';
// Type-only: this hook never constructs or imports the runtime module itself
// (CodeEditorView owns that) — matches editor-registry.ts's own type-only import.
import type { EditorView } from '@codemirror/view';
import { resolveSelector } from '../../../shared/doc-comments-anchor';
import type { TextQuoteSelector } from '../../../shared/doc-comments-types';
import { setCommentStatus, type DocComment } from '../../state/doc-comments-store';
import { visibleEditorFor } from '../artifact-views/cm/ref-line-highlight';

export interface ResolvedLines {
  startLine: number;
  endLine: number;
}

// Recomputed whenever the comment set changes, plus on a debounced watch of
// the editor's own DOM for an external edit (the assistant, a git pull)
// landing WHILE the panel is open. Interactive typing never reaches this at
// all: ActiveArtifactView hides the comments panel outright while editing
// (`showComments = !editing && …`), the same guard MarkdownView's own
// CommentableDocument skip relies on — so there is no keystroke-frequency
// path here to debounce against (performance.md rule 5), only this one. The
// debounce below exists purely for the "someone else changed the file while
// I'm reading it" case. 300ms matches this feature's other debounces
// (doc-comments-store.ts's own watcher, git-watcher.ts's DEBOUNCE_MS).
const DOC_CHANGE_DEBOUNCE_MS = 300;

function resolveOne(view: EditorView, c: DocComment): ResolvedLines | 'detached' | null {
  if (!c.quote) return null;
  const sel: TextQuoteSelector = {
    type: 'TextQuoteSelector',
    exact: c.quote,
    prefix: c.selectorPrefix ?? '',
    suffix: c.selectorSuffix ?? '',
    occurrence: c.selectorOccurrence ?? 0,
  };
  const range = resolveSelector(view.state.doc.toString(), sel);
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
        const next = new Map<string, ResolvedLines>();
        for (const c of comments) {
          const result = resolveOne(view, c);
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
  }, [path, comments]);

  return resolved;
}
