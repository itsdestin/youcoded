// @vitest-environment jsdom
// Pins the artifact-viewer branch of the right-click menu: "Ask about this"
// must cite SOURCE LINE NUMBERS for raw text/code views and fall back to a
// quote for rendered markdown (whose DOM doesn't map back to source lines).
// Round 2 (Destin): the menu no longer builds a scaffold STRING, nor a
// {quote, sourceLabel} chip (round 1) — it attaches a ComposeRef PILL via
// youcoded:compose-insert, ported from session/comments-mock-c (compose-ref.ts).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildContextMenu } from './build-menu';
import type { ComposeRef } from './compose-ref';

// Builds the DOM shape MarkdownView emits for raw text (txt) and rendered md.
// CODE files no longer use this shape — CodeMirror replaced CodeView, and its
// contract is pinned by build-menu-cm6.test.tsx, which mounts the REAL
// component (a synthetic shape here would stay green while production broke).
function mountViewer(opts: { path: string; source: 'raw' | 'rendered'; body: string }) {
  const container = document.createElement('div');
  container.setAttribute('data-artifact-viewer', 'true');
  container.setAttribute('data-doc-path', opts.path);
  container.setAttribute('data-artifact-source', opts.source);
  const pre = document.createElement('pre');
  pre.textContent = opts.body;
  container.appendChild(pre);
  document.body.appendChild(container);
  return { container, pre };
}

// The menu reads window.getSelection(), so drive the real selection API.
function selectWithin(node: Node, start: number, end: number) {
  const range = document.createRange();
  const textNode = node.firstChild!;
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

// Runs the menu's "Ask about this" action and returns the ComposeRef pill it
// would attach to the composer (delivered via youcoded:compose-insert).
function referenceFor(container: HTMLElement): ComposeRef | null {
  const entries = buildContextMenu(container);
  const ask = entries?.find((e) => e.type === 'item' && e.id === 'ask');
  if (!ask || ask.type !== 'item') return null;
  const spy = vi.fn();
  window.addEventListener('youcoded:compose-insert', spy);
  ask.run();
  window.removeEventListener('youcoded:compose-insert', spy);
  return (spy.mock.calls[0]?.[0] as CustomEvent)?.detail?.ref ?? null;
}

const FILE = 'alpha\nbravo\ncharlie\ndelta';

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  Object.defineProperty(document, 'execCommand', { value: undefined, configurable: true });
});

describe('context-menu image paste', () => {
  const pasteItemFor = (el: HTMLTextAreaElement) => {
    const item = buildContextMenu(el)?.find((entry) => entry.type === 'item' && entry.id === 'paste');
    expect(item?.type).toBe('item');
    return item?.type === 'item' ? item : null;
  };

  const setClipboardText = (text: string) => {
    const readText = vi.fn().mockResolvedValue(text);
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
    return readText;
  };

  it('requests attachment staging for an image-only composer clipboard and restores its captured selection', async () => {
    setClipboardText('');
    const textarea = document.createElement('textarea');
    textarea.className = 'input-bar-textarea';
    textarea.value = 'draft';
    document.body.appendChild(textarea);
    textarea.setSelectionRange(1, 4);
    const paste = pasteItemFor(textarea);
    textarea.setSelectionRange(0, 0);
    const listener = vi.fn();
    window.addEventListener('youcoded:composer-paste-image', listener);

    await paste?.run();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 4]);
    window.removeEventListener('youcoded:composer-paste-image', listener);
  });

  it('keeps a non-composer textarea text-only when clipboard text is empty', async () => {
    setClipboardText('');
    const textarea = document.createElement('textarea');
    textarea.className = 'artifact-edit-textarea';
    document.body.appendChild(textarea);
    const listener = vi.fn();
    window.addEventListener('youcoded:composer-paste-image', listener);

    await pasteItemFor(textarea)?.run();

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('youcoded:composer-paste-image', listener);
  });

  it.each(['input-bar-textarea', 'artifact-edit-textarea'])(
    'inserts delayed clipboard text at the captured range for %s',
    async (className) => {
      let resolveText!: (text: string) => void;
      const readText = vi.fn(() => new Promise<string>((resolve) => { resolveText = resolve; }));
      Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });
      const textarea = document.createElement('textarea');
      textarea.className = className;
      textarea.value = 'abcdef';
      document.body.appendChild(textarea);
      textarea.setSelectionRange(1, 4);
      const paste = pasteItemFor(textarea);
      const execCommand = vi.fn((_command: string, _showUi: boolean, text: string) => {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
      });
      Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
      const listener = vi.fn();
      window.addEventListener('youcoded:composer-paste-image', listener);

      const pasteResult = paste?.run();
      textarea.setSelectionRange(6, 6);
      resolveText('pasted');
      await pasteResult;

      expect(textarea.value).toBe('apastedef');
      expect(execCommand).toHaveBeenCalledWith('insertText', false, 'pasted');
      expect(listener).not.toHaveBeenCalled();
      window.removeEventListener('youcoded:composer-paste-image', listener);
    },
  );
});

describe('artifact viewer context menu', () => {
  it('cites a single source line for a one-line selection', () => {
    const { container, pre } = mountViewer({ path: 'docs/notes.txt', source: 'raw', body: FILE });
    selectWithin(pre, 6, 11); // "bravo" — second line
    expect(referenceFor(container)).toMatchObject({ kind: 'doc', path: 'docs/notes.txt', fileName: 'notes.txt', label: 'line 2 · notes.txt', lineRange: [2, 2] });
  });

  it('cites a line RANGE for a multi-line selection', () => {
    const { container, pre } = mountViewer({ path: 'src/app.ts', source: 'raw', body: FILE });
    selectWithin(pre, 6, 19); // "bravo\ncharlie" — lines 2-3
    expect(referenceFor(container)).toMatchObject({ kind: 'doc', path: 'src/app.ts', label: 'lines 2-3 · app.ts', lineRange: [2, 3] });
  });

  it('falls back to a paragraph mark + quote for rendered markdown (no reliable source mapping)', () => {
    const { container, pre } = mountViewer({ path: 'README.md', source: 'rendered', body: FILE });
    selectWithin(pre, 6, 11);
    expect(referenceFor(container)).toMatchObject({ kind: 'doc', path: 'README.md', label: '“bravo”', lineRange: undefined });
  });

  it('"Add comment" writes straight into the shared doc-comments store, anchored to the same selection', async () => {
    const { container, pre } = mountViewer({ path: 'docs/notes.txt', source: 'raw', body: FILE });
    selectWithin(pre, 6, 11);
    const entries = buildContextMenu(container);
    const comment = entries?.find((e) => e.type === 'item' && e.id === 'comment');
    expect(comment, 'Add comment must exist for a selection').toBeTruthy();
    const { commentsForPath } = await import('../../state/doc-comments-store');
    const before = commentsForPath('docs/notes.txt').length;
    if (comment?.type === 'item') comment.run();
    const after = commentsForPath('docs/notes.txt');
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toMatchObject({ quote: 'bravo', sourceLabel: 'line 2 · notes.txt', resolved: false });
  });

  it('offers no "Ask about this" without a selection — the whole file is never implied', () => {
    const { container } = mountViewer({ path: 'docs/notes.txt', source: 'raw', body: FILE });
    const entries = buildContextMenu(container);
    expect(entries?.some((e) => e.type === 'item' && e.id === 'ask')).toBe(false);
  });

  it('leaves non-artifact, non-chat surfaces alone (no menu hijack)', () => {
    const stray = document.createElement('div');
    document.body.appendChild(stray);
    expect(buildContextMenu(stray)).toBeNull();
  });

  it('gives the artifact edit textarea a cut/copy/paste menu', () => {
    const ta = document.createElement('textarea');
    ta.className = 'artifact-edit-textarea';
    ta.value = 'draft text';
    document.body.appendChild(ta);
    const ids = buildContextMenu(ta)?.filter((e) => e.type === 'item').map((e: any) => e.id);
    expect(ids).toEqual(['cut', 'copy', 'paste', 'select-all']);
  });
});

// A3 (2026-08-26 preview-header spec): a previewed past conversation
// (SessionPreviewPane) marks its scroll container
// with data-conversation-id/-title instead of .chat-scroll — see the WHY
// comment on the guard in build-menu.ts. This mirrors that DOM shape by hand
// (the way mountViewer() above mirrors the artifact viewer's), rather than
// mounting the real component tree, to keep the guard's contract pinned
// independent of SessionPreviewPane's own markup.
function mountBubble(opts: {
  // 'chat-scroll' = live chat's real marker. 'preview' = the transcript's
  // data-attribute marker. 'none' = neither — the positive control.
  scroll: 'chat-scroll' | 'preview' | 'none';
  role: 'assistant' | 'user';
  text: string;
  conversationId?: string;
  conversationTitle?: string;
}) {
  const scroller = document.createElement('div');
  if (opts.scroll === 'chat-scroll') scroller.className = 'chat-scroll';
  if (opts.scroll === 'preview') {
    scroller.setAttribute('data-conversation-id', opts.conversationId ?? 'conv-1');
    scroller.setAttribute('data-conversation-title', opts.conversationTitle ?? '');
  }
  const bubble = document.createElement('div');
  bubble.className = opts.role === 'assistant' ? 'assistant-bubble' : 'user-bubble';
  bubble.textContent = opts.text;
  scroller.appendChild(bubble);
  document.body.appendChild(scroller);
  return bubble;
}

describe('previewed-conversation right-click (spec §A3)', () => {
  it('right-clicking a bubble inside the preview yields the chat menu ("Ask about this" present)', () => {
    const bubble = mountBubble({ scroll: 'preview', role: 'assistant', text: 'hello world', conversationId: 'conv-1', conversationTitle: 'Debugging sync' });
    const entries = buildContextMenu(bubble);
    expect(entries?.some((e) => e.type === 'item' && e.id === 'ask')).toBe(true);
  });

  it('positive control: the SAME bubble markup with no preview marker (and no .chat-scroll) yields no menu at all', () => {
    const bubble = mountBubble({ scroll: 'none', role: 'assistant', text: 'hello world' });
    expect(buildContextMenu(bubble)).toBeNull();
  });

  it('the live chat (.chat-scroll, no conversation marker) still gets the menu, same as before', () => {
    const bubble = mountBubble({ scroll: 'chat-scroll', role: 'assistant', text: 'hello world' });
    const entries = buildContextMenu(bubble);
    expect(entries?.some((e) => e.type === 'item' && e.id === 'ask')).toBe(true);
  });

  it('the preview reference names the pill after the conversation title, not a generic "message" label', () => {
    const bubble = mountBubble({ scroll: 'preview', role: 'assistant', text: 'hello world', conversationId: 'conv-1', conversationTitle: 'Debugging sync' });
    expect(referenceFor(bubble)).toMatchObject({ kind: 'chat', label: '“Debugging sync” · “hello world”' });
  });

  it('the live chat reference is generic (no preview marker to name)', () => {
    const bubble = mountBubble({ scroll: 'chat-scroll', role: 'assistant', text: 'hello world' });
    expect(referenceFor(bubble)).toMatchObject({ kind: 'chat', label: '“hello world”' });
  });

  it('a user bubble with no preview reads the same generic way', () => {
    const bubble = mountBubble({ scroll: 'chat-scroll', role: 'user', text: 'my question' });
    expect(referenceFor(bubble)).toMatchObject({ kind: 'chat', label: '“my question”' });
  });

  it('a previewed user bubble still prefers the conversation title', () => {
    const bubble = mountBubble({ scroll: 'preview', role: 'user', text: 'my question', conversationId: 'conv-2', conversationTitle: 'Untitled thread' });
    expect(referenceFor(bubble)).toMatchObject({ kind: 'chat', label: '“Untitled thread” · “my question”' });
  });
});

// Destin, 2026-09-10: tool card titles, chips and other app chrome must not be
// highlightable OR copyable from the right-click menu. CSS makes them
// unselectable (globals.css — every <button>; `select-none` on chrome areas);
// these pin the menu half, which CSS cannot reach: `bubble.textContent` reads
// unselectable text just the same.
describe('app chrome is not copy material', () => {
  // An assistant message holding prose, a tool-group title (a <button>), an
  // unselectable label, and a clickable file name (a <button> opted back in
  // with `select-text`, because a file name IS part of the message's words).
  function mountMessageWithChrome() {
    const scroller = document.createElement('div');
    scroller.className = 'chat-scroll';
    const bubble = document.createElement('div');
    bubble.className = 'assistant-bubble';
    bubble.innerHTML =
      '<p id="prose">Edited </p>' +
      '<button id="file" class="select-text" data-file-path="/proj/src/app.ts">app.ts</button>' +
      '<span id="sep" class="select-none">|</span>' +
      '<div class="border-edge"><button id="tool">Ran 6 commands</button></div>';
    scroller.appendChild(bubble);
    document.body.appendChild(scroller);
    const $ = (id: string) => bubble.querySelector<HTMLElement>(`#${id}`)!;
    return { bubble, prose: $('prose'), file: $('file'), sep: $('sep'), tool: $('tool') };
  }

  it('right-clicking a tool card title shows no menu at all', () => {
    const { tool } = mountMessageWithChrome();
    expect(buildContextMenu(tool)).toBeNull();
  });

  it('right-clicking an unselectable label shows no menu at all', () => {
    const { sep } = mountMessageWithChrome();
    expect(buildContextMenu(sep)).toBeNull();
  });

  it('a clickable file name keeps its own menu (it is a button, but not chrome)', () => {
    const { file } = mountMessageWithChrome();
    const ids = buildContextMenu(file)?.filter((e) => e.type === 'item').map((e: any) => e.id);
    expect(ids).toContain('copy-path');
  });

  it('"Ask about this" on the prose quotes the message without the tool title, keeping the file name', () => {
    const { prose } = mountMessageWithChrome();
    expect(referenceFor(prose)).toMatchObject({ kind: 'chat', label: '“Edited app.ts”' });
  });

  it('whole-message Copy leaves chrome text out', async () => {
    const { prose } = mountMessageWithChrome();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copy = buildContextMenu(prose)?.find((e) => e.type === 'item' && e.id === 'copy');
    expect(copy && copy.type === 'item' && !copy.disabled).toBe(true);
    if (copy?.type === 'item') copy.run();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith('Edited app.ts');
  });
});
