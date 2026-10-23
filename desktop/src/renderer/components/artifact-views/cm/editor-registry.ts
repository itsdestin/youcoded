// Bridge between the CodeMirror editor and code that only has a DOM node —
// most importantly build-menu.ts, which needs the LIVE EditorView to compute
// line numbers via state.doc.lineAt(): CM6 virtualizes (only viewport lines
// exist in the DOM), so any textContent-based counting yields plausible WRONG
// citations (spec §5.3 — the worst failure mode, a fabricated line number in a
// prompt scaffold). Keyed by container element; entries live exactly as long
// as the mounted editor.
import type { EditorView } from '@codemirror/view';

const views = new Map<HTMLElement, EditorView>();

export function registerEditorView(container: HTMLElement, view: EditorView): void {
  views.set(container, view);
}

export function unregisterEditorView(container: HTMLElement): void {
  views.delete(container);
}

/** The EditorView whose container contains `el`, or null. */
export function editorViewFor(el: Element | null): EditorView | null {
  if (!el) return null;
  for (const [container, view] of views) {
    if (container.contains(el)) return view;
  }
  return null;
}

/** The visible code editor showing `path`, if any. Used by ref-line-highlight's
 *  chip hover/click AND by `use-code-comment-anchors.ts` — the same lookup, so
 *  a comment's resolved lines and a chip's never disagree about which mounted
 *  EditorView is "the" one for a path.
 *  WHY here, not in ref-line-highlight.ts (2026-10-22 phone speed): that file
 *  loads CodeMirror itself, and the comments rail imported this from it, which
 *  put ~380 KB of editor into the startup download of every page. */
export function visibleEditorFor(path: string): EditorView | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-artifact-source="cm6"]')) {
    if (el.dataset.docPath === path && el.getClientRects().length > 0) return editorViewFor(el);
  }
  return null;
}

/** The EditorView mounted anywhere INSIDE `root` (ancestor lookup), or null. */
export function editorViewWithin(root: Element | null): EditorView | null {
  if (!root) return null;
  for (const [container, view] of views) {
    if (root.contains(container)) return view;
  }
  return null;
}

/**
 * Scroll the editor under `root` to a 1-indexed line, select it, and focus.
 * The jump-to-hit primitive for cross-file search (and anything later that
 * needs "open at line N" — imperative on purpose: a line stored in state
 * would re-fire on stale re-selections, see the archived plan §12.10).
 * Returns false when no editor is mounted under root (markdown viewer,
 * binary fallback) — callers just open the file without the jump.
 */
export function revealLineIn(root: Element | null, line: number): boolean {
  const view = editorViewWithin(root);
  if (!view) return false;
  const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
  const pos = view.state.doc.line(clamped).from;
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
  return true;
}

/**
 * Route Ctrl+F to CodeMirror's own search panel when a CM6 editor is mounted
 * under `root`. Returns true when handled. WHY not ContentFindBar: it walks
 * rendered DOM text nodes, and CM6 virtualizes — it would silently find only
 * viewport-resident matches (same failure class as the §5.3 line numbers).
 * Dynamic import so @codemirror/search stays in the lazy editor chunk.
 */
export function openEditorSearch(root: Element | null): boolean {
  const view = editorViewWithin(root);
  if (!view) return false;
  void import('@codemirror/search').then((m) => {
    m.openSearchPanel(view);
  }).catch(() => { /* chunk unavailable (offline) — no search, no crash */ });
  return true;
}
