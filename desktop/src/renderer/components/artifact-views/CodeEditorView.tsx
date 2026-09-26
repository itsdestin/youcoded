// CodeEditorView — CodeMirror 6 viewer/editor for code files (spec §5).
// Replaces the old CodeView, which wrapped the file in a markdown fence and
// re-parsed the whole document through react-markdown per render: no line
// numbers, no gutter, no folding, full re-highlight per keystroke.
//
// Constraints this component honors (spec §5 hard requirements):
// - Loads from the asset origin, reaches data ONLY via props (window.claude
//   flows through ActiveArtifactView) — nothing Node-only, so the identical
//   bundle runs in the Android WebView.
// - Registers its EditorView in editor-registry so build-menu computes line
//   numbers via state.doc.lineAt() — the DOM is virtualized and any
//   textContent counting emits plausible WRONG citations (§5.3).
// - Soft-keyboard: scrollMargins feeds --vvp-offset (Android overlays the
//   keyboard WITHOUT resizing the layout viewport, so CM6's own scrollIntoView
//   math believes a cursor behind the keyboard is visible — §12.7). Do NOT
//   "fix" this by shrinking the root container; that was reverted as jitter.
// - Conflict resolution replaces the document via a FRESH EditorState, so undo
//   can never walk back across the resolution boundary (§12.11).
import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { foldGutter, bracketMatching, indentOnInput, LanguageDescription } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { languages } from '@codemirror/language-data';
import { useTheme } from '../../state/theme-context';
import { buildCmThemeExtensions } from './cm/cm-theme';
import { registerEditorView, unregisterEditorView } from './cm/editor-registry';
import { refLineHighlight, installCodeRefHighlight, flashPendingJump } from './cm/ref-line-highlight';
import type { ArtifactViewProps } from './types';

// Bottom scroll margin = the soft-keyboard overlay height. Read at call time
// (CM6 invokes this on every scroll computation) so it always reflects the
// live viewport without a listener of its own.
function vvpOffsetPx(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--vvp-offset').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function CodeEditorView({ path, content, editing = false, draft = '', onDraftChange }: ArtifactViewProps) {
  const { activeTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Stable compartments so reconfiguration never rebuilds unrelated extensions.
  const comp = useRef({ lang: new Compartment(), theme: new Compartment(), edit: new Compartment() }).current;
  // The loaded language support, cached so document replacement keeps it.
  const langRef = useRef<Extension | null>(null);
  // Refs for values the (stable) updateListener closure must see fresh.
  const editingRef = useRef(editing); editingRef.current = editing;
  const onDraftChangeRef = useRef(onDraftChange); onDraftChangeRef.current = onDraftChange;

  const editExtensions = (isEditing: boolean): Extension => [
    EditorState.readOnly.of(!isEditing),
    EditorView.editable.of(isEditing),
  ];

  const buildState = (doc: string): EditorState => EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      foldGutter(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      bracketMatching(),
      indentOnInput(),
      search({ top: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      comp.edit.of(editExtensions(editingRef.current)),
      comp.lang.of(langRef.current ?? []),
      comp.theme.of(buildCmThemeExtensions()),
      EditorView.scrollMargins.of(() => ({ bottom: vvpOffsetPx() })),
      // Ask-about chips from this file light up their lines (ref-line-highlight.ts).
      refLineHighlight,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && editingRef.current) onDraftChangeRef.current?.(u.state.doc.toString());
      }),
    ],
  });
  const buildStateRef = useRef(buildState); buildStateRef.current = buildState;

  // One EditorView per file. Language loads async from language-data (its own
  // lazy chunk per language — served from the local asset origin, so this is
  // not a network dependency on Android).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({ state: buildStateRef.current(''), parent: host });
    viewRef.current = view;
    registerEditorView(host, view);
    installCodeRefHighlight();
    const cancelPending = flashPendingJump(view, path);
    let dead = false;
    const base = path.split('/').pop() ?? path;
    const desc = LanguageDescription.matchFilename(languages, base);
    if (desc) {
      desc.load().then((support) => {
        if (dead) return;
        langRef.current = support;
        view.dispatch({ effects: comp.lang.reconfigure(support) });
      }).catch(() => { /* no highlighting — the editor still works */ });
    }
    return () => {
      dead = true;
      cancelPending();
      unregisterEditorView(host);
      view.destroy();
      viewRef.current = null;
      langRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Document sync. While editing the doc drives `draft` (via updateListener),
  // so want === doc and this is a no-op; a WHOLESALE replacement (initial load,
  // external refetch, conflict resolution) swaps in a fresh state — which also
  // clears undo history, deliberately (§12.11: undo must not cross a conflict
  // resolution into a document that no longer corresponds to disk).
  const want = editing ? draft : (content ?? '');
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() !== want) {
      view.setState(buildStateRef.current(want));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);

  // Edit-mode toggle without touching the document or history.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: comp.edit.reconfigure(editExtensions(editing)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Re-derive the syntax palette when the theme flips. rAF mirrors
  // TerminalView: the CSS custom properties are only guaranteed applied after
  // the data-theme attribute flip has painted.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      viewRef.current?.dispatch({ effects: comp.theme.reconfigure(buildCmThemeExtensions()) });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTheme]);

  // The editor host must render UNCONDITIONALLY: the mount effect above only
  // runs on [path] — an early return on null content would leave hostRef null
  // during that window and no EditorView would EVER be created for the file
  // (first-review bug: panel flashed, then blank). The old "no longer on disk"
  // overlay is gone: ActiveArtifactView now distinguishes loading / missing /
  // read-error (ArtifactContentState) and renders those states itself, so a
  // null here just shows an empty editor for the transient.
  return (
    <div className="relative h-full">
      <div
        ref={hostRef}
        className="h-full overflow-hidden"
        // Contract with build-menu.ts: data-artifact-viewer routes right-clicks
        // to the artifact menu; source 'cm6' selects the EditorView line-number
        // path (registry lookup), NEVER the <pre> textContent path.
        data-artifact-viewer
        data-doc-path={path}
        data-artifact-source="cm6"
      />
    </div>
  );
}
