// @vitest-environment jsdom
// Pins the CM6 half of the right-click contract by mounting the REAL
// CodeEditorView (spec §5.3 / §12.3): the old synthetic-<pre> approach stayed
// GREEN while production broke, because it never mounted the actual viewer.
// The failure this exists to catch is the silent one — CM6 virtualizes its
// DOM, so any textContent-based line count reports a plausible WRONG number
// (a selection at line 800 citing "line 41") straight into a prompt scaffold.
// Line numbers must come from view.state.doc.lineAt(), which this test drives
// through the real registry the menu uses.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { buildContextMenu } from './build-menu';
import { CodeEditorView } from '../artifact-views/CodeEditorView';
import { editorViewWithin } from '../artifact-views/cm/editor-registry';

// Minimal geometry shims CM6 needs under jsdom (it measures constantly; jsdom
// implements none of it). Zero-rects are fine — we never assert layout.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON() {} };
  (Range.prototype as any).getBoundingClientRect = () => rect;
  (Range.prototype as any).getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  (Element.prototype as any).scrollIntoView = () => {};
  (document as any).elementFromPoint = () => null;
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// 1000 numbered lines — big enough that a virtualized DOM cannot contain them
// all, which is exactly the condition that broke the old technique.
const LINES = Array.from({ length: 1000 }, (_, i) => `const line${i + 1} = ${i + 1};`);
const DOC = LINES.join('\n');

function mountEditor() {
  const utils = render(
    <CodeEditorView
      path="src/big.ts"
      absolutePath="/proj/src/big.ts"
      content={DOC}
      isEditable
    />
  );
  const container = utils.container.querySelector('[data-artifact-viewer]') as HTMLElement;
  expect(container).toBeTruthy();
  const view = editorViewWithin(container);
  expect(view, 'EditorView must be registered for the menu to find').toBeTruthy();
  return { container, view: view! };
}

// Select a whole line by document offsets and mirror its text into the DOM
// selection API the menu consults for the quote fallback.
function selectLine(view: any, lineNo: number, throughLine?: number) {
  const from = view.state.doc.line(lineNo).from;
  const to = view.state.doc.line(throughLine ?? lineNo).to;
  act(() => {
    view.dispatch({ selection: { anchor: from, head: to } });
  });
  const text = view.state.sliceDoc(from, to);
  vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => text } as any);
}

describe('CM6 artifact context menu (real component)', () => {
  it('cites the TRUE line number for a selection far beyond any rendered viewport', () => {
    const { container, view } = mountEditor();
    selectLine(view, 800);
    const entries = buildContextMenu(container)!;
    const ask = entries.find((e: any) => e.id === 'ask') as any;
    expect(ask, 'Ask about this must exist for a CM6 selection').toBeTruthy();
    const spy = vi.fn();
    window.addEventListener('youcoded:compose-add-reference', spy);
    ask.run();
    window.removeEventListener('youcoded:compose-add-reference', spy);
    const detail = (spy.mock.calls[0]?.[0] as CustomEvent)?.detail ?? {};
    expect(detail.sourceLabel).toContain('line 800');
    expect(detail.sourceLabel).toContain('big.ts');
  });

  it('cites a range across lines', () => {
    const { container, view } = mountEditor();
    selectLine(view, 42, 45);
    const entries = buildContextMenu(container)!;
    const ask = entries.find((e: any) => e.id === 'ask') as any;
    const spy = vi.fn();
    window.addEventListener('youcoded:compose-add-reference', spy);
    ask.run();
    window.removeEventListener('youcoded:compose-add-reference', spy);
    const detail = (spy.mock.calls[0]?.[0] as CustomEvent)?.detail ?? {};
    expect(detail.sourceLabel).toContain('lines 42-45');
  });

  it('read-only CM6 falls through to the artifact menu, not the editable menu', () => {
    const { container, view } = mountEditor();
    selectLine(view, 3);
    // Right-click lands on a node inside .cm-content (contenteditable=false in
    // read mode) — the artifact branch must win.
    const target = (container.querySelector('.cm-content') as HTMLElement) ?? container;
    const entries = buildContextMenu(target)!;
    expect(entries.some((e: any) => e.id === 'ask')).toBe(true);
    expect(entries.some((e: any) => e.id === 'paste')).toBe(false);
  });

  it('mounts the editor even when content arrives AFTER the first render (the fetch-transient blank-panel bug)', () => {
    // Hosts set content=null before every read resolves; the first render must
    // still mount the editor host so the [path]-keyed effect can attach — an
    // early return here left the panel permanently blank (found in review).
    const utils = render(
      <CodeEditorView path="src/late.ts" absolutePath="/proj/src/late.ts" content={null} isEditable={false} />
    );
    utils.rerender(
      <CodeEditorView path="src/late.ts" absolutePath="/proj/src/late.ts" content={'const late = true;'} isEditable />
    );
    const container = utils.container.querySelector('[data-artifact-viewer]') as HTMLElement;
    const view = editorViewWithin(container);
    expect(view).toBeTruthy();
    expect(view!.state.doc.toString()).toBe('const late = true;');
  });

  it('EDITING CM6 gets the cut/copy/paste menu via its contenteditable', () => {
    const utils = render(
      <CodeEditorView
        path="src/edit.ts"
        absolutePath="/proj/src/edit.ts"
        content={'a\nb'}
        isEditable
        editing
        draft={'a\nb'}
        onDraftChange={() => {}}
      />
    );
    const content = utils.container.querySelector('.cm-content[contenteditable="true"]') as HTMLElement;
    expect(content, 'editing CM6 must expose an editable .cm-content').toBeTruthy();
    const entries = buildContextMenu(content)!;
    expect(entries.some((e: any) => e.id === 'paste')).toBe(true);
    expect(entries.some((e: any) => e.id === 'select-all')).toBe(true);
  });
});
