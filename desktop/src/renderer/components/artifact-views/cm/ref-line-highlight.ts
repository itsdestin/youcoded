// Code-file half of "a chip points back at its source" (Destin, 2026-09-24:
// "click the chip and have it focus/highlight the originating text… hover
// sensitive as well"). A chip from a code file carries a line range, and
// CodeMirror virtualises its DOM (only the lines near the viewport exist), so
// the CSS-Highlight approach the other viewers use can't reach an off-screen
// line. This paints LINE DECORATIONS through CodeMirror's own state instead —
// they exist whether or not the line is currently drawn — and scrolls with
// CodeMirror's own scrollIntoView.
//
//   hover a chip  → its lines get a soft accent wash
//   click a chip  → scrolled to (centred) and a stronger wash for FLASH_MS
//   click while the file is closed → compose-ref.ts opens it; CodeEditorView
//                   then calls flashPendingJump once the text has loaded
import { StateEffect, StateField, RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { editorViewFor } from './editor-registry';
import { takePendingJump, type ComposeRef } from '../../context-menu/compose-ref';

type Lines = [number, number] | null;
interface Lit { hover: Lines; flash: Lines }

const setLit = StateEffect.define<Partial<Lit>>();

const litField = StateField.define<Lit>({
  create: () => ({ hover: null, flash: null }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLit)) value = { ...value, ...e.value };
    return value;
  },
});

const HOVER_LINE = Decoration.line({ class: 'cm-ref-source-hover' });
const FLASH_LINE = Decoration.line({ class: 'cm-ref-source-flash' });

function decorate(state: EditorState): DecorationSet {
  const { hover, flash } = state.field(litField);
  const n = state.doc.lines;
  // Line number → decoration; flash wins where the two overlap. Ranges are a
  // chip's few lines, so this never walks the whole file.
  const lit = new Map<number, Decoration>();
  if (hover) for (let l = Math.max(1, hover[0]); l <= Math.min(n, hover[1]); l++) lit.set(l, HOVER_LINE);
  if (flash) for (let l = Math.max(1, flash[0]); l <= Math.min(n, flash[1]); l++) lit.set(l, FLASH_LINE);
  const builder = new RangeSetBuilder<Decoration>();
  for (const l of [...lit.keys()].sort((x, y) => x - y)) {
    const from = state.doc.line(l).from;
    builder.add(from, from, lit.get(l)!);
  }
  return builder.finish();
}

/** Add to the editor's extensions (CodeEditorView.buildState). */
export const refLineHighlight: Extension = [
  litField,
  EditorView.decorations.compute([litField], decorate),
  // Same washes as the other viewers' ::highlight(ref-source-*) rules.
  EditorView.baseTheme({
    '.cm-ref-source-hover': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
    '.cm-ref-source-flash': { backgroundColor: 'color-mix(in srgb, var(--accent) 38%, transparent)' },
  }),
];

const FLASH_MS = 1800;
let flashTimer: number | null = null;
let hoveredView: EditorView | null = null;

function clampLines(view: EditorView, r: [number, number]): [number, number] {
  const n = view.state.doc.lines;
  return [Math.max(1, Math.min(r[0], n)), Math.max(1, Math.min(r[1], n))];
}

function flash(view: EditorView, range: [number, number]): void {
  const lines = clampLines(view, range);
  view.dispatch({
    effects: [
      setLit.of({ flash: lines }),
      EditorView.scrollIntoView(view.state.doc.line(lines[0]).from, { y: 'center' }),
    ],
  });
  if (flashTimer) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => { flashTimer = null; view.dispatch({ effects: setLit.of({ flash: null }) }); }, FLASH_MS);
}

/** The visible code editor showing `path`, if any. */
function visibleEditorFor(path: string): EditorView | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-artifact-source="cm6"]')) {
    if (el.dataset.docPath === path && el.getClientRects().length > 0) return editorViewFor(el);
  }
  return null;
}

let installed = false;
/** Idempotent — CodeEditorView calls it on mount. One listener pair for the
 *  whole app, so hidden editors hold none (performance.md rule 2). */
export function installCodeRefHighlight(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('youcoded:ref-hover', (e) => {
    const ref = (e as CustomEvent<{ ref: ComposeRef | null }>).detail?.ref;
    if (hoveredView) { hoveredView.dispatch({ effects: setLit.of({ hover: null }) }); hoveredView = null; }
    if (!ref || ref.kind !== 'doc' || !ref.lineRange || !ref.path) return;
    const view = visibleEditorFor(ref.path);
    if (!view) return;
    view.dispatch({ effects: setLit.of({ hover: clampLines(view, ref.lineRange) }) });
    hoveredView = view;
  });
  window.addEventListener('youcoded:jump-to-ref', (e) => {
    const detail = (e as CustomEvent<{ ref?: ComposeRef; handled?: boolean }>).detail;
    const ref = detail?.ref;
    if (!ref || ref.kind !== 'doc' || !ref.lineRange || !ref.path) return;
    const view = visibleEditorFor(ref.path);
    if (!view) return;
    detail.handled = true;
    flash(view, ref.lineRange);
  });
}

/** A chip clicked while this file was closed: flash its lines once the file's
 *  text has loaded (the editor starts empty and is filled asynchronously). */
export function flashPendingJump(view: EditorView, path: string): () => void {
  const ref = takePendingJump(path);
  if (!ref?.lineRange) return () => {};
  const range = ref.lineRange;
  let tries = 0;
  let timer: number | null = null;
  const attempt = () => {
    timer = null;
    if (view.state.doc.lines >= range[0] && view.state.doc.length > 0) { flash(view, range); return; }
    if (++tries < 30) timer = window.setTimeout(attempt, 150);
  };
  attempt();
  return () => { if (timer) window.clearTimeout(timer); };
}
