// @vitest-environment jsdom
// Pins the artifact-viewer branch of the right-click menu: the "Ask about this"
// scaffold must cite SOURCE LINE NUMBERS for raw text/code views and fall back to
// a quote for rendered markdown (whose DOM doesn't map back to source lines).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildContextMenu } from './build-menu';
import { COPY } from '../../../shared/chatsearch-refs';

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

// Runs the menu's "Ask about this" action and returns the text it would insert
// into the composer (delivered via the youcoded:compose-insert CustomEvent).
function composedTextFor(container: HTMLElement): string | null {
  const entries = buildContextMenu(container);
  const ask = entries?.find((e) => e.type === 'item' && e.id === 'ask');
  if (!ask || ask.type !== 'item') return null;
  const spy = vi.fn();
  window.addEventListener('youcoded:compose-insert', spy);
  ask.run();
  window.removeEventListener('youcoded:compose-insert', spy);
  return (spy.mock.calls[0]?.[0] as CustomEvent)?.detail?.text ?? null;
}

const FILE = 'alpha\nbravo\ncharlie\ndelta';

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('artifact viewer context menu', () => {
  it('cites a single source line for a one-line selection', () => {
    const { container, pre } = mountViewer({ path: 'docs/notes.txt', source: 'raw', body: FILE });
    selectWithin(pre, 6, 11); // "bravo" — second line
    expect(composedTextFor(container)).toBe(
      'The user is referencing line 2 from "docs/notes.txt". Respond to the following prompt accordingly:\n\n',
    );
  });

  it('cites a line RANGE for a multi-line selection', () => {
    const { container, pre } = mountViewer({ path: 'src/app.ts', source: 'raw', body: FILE });
    selectWithin(pre, 6, 19); // "bravo\ncharlie" — lines 2-3
    expect(composedTextFor(container)).toBe(
      'The user is referencing lines 2-3 from "src/app.ts". Respond to the following prompt accordingly:\n\n',
    );
  });

  it('falls back to a quote for rendered markdown (no reliable source mapping)', () => {
    const { container, pre } = mountViewer({ path: 'README.md', source: 'rendered', body: FILE });
    selectWithin(pre, 6, 11);
    expect(composedTextFor(container)).toBe(
      'The user is referencing "bravo" from "README.md". Respond to the following prompt accordingly:\n\n',
    );
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
// (SessionPreviewPane, via ConversationTranscript) marks its scroll container
// with data-conversation-id/-title instead of .chat-scroll — see the WHY
// comment on the guard in build-menu.ts. This mirrors that DOM shape by hand
// (the way mountViewer() above mirrors the artifact viewer's), rather than
// mounting the real component tree, to keep the guard's contract pinned
// independent of ConversationTranscript's own markup.
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

  it('the preview scaffold names the conversation: contains both its id and its title', () => {
    const bubble = mountBubble({ scroll: 'preview', role: 'assistant', text: 'hello world', conversationId: 'conv-1', conversationTitle: 'Debugging sync' });
    const composed = composedTextFor(bubble);
    expect(composed).toContain('conv-1');
    expect(composed).toContain('Debugging sync');
    expect(composed).toBe(`${COPY.askPreviewContext('Debugging sync', 'conv-1')} In an earlier message, you said:\n"hello world"\n\nThe user has a follow-up: `);
  });

  it('PIN: the live chat scaffold is byte-for-byte unchanged — no conversation reference appears', () => {
    const bubble = mountBubble({ scroll: 'chat-scroll', role: 'assistant', text: 'hello world' });
    const composed = composedTextFor(bubble);
    expect(composed).toBe('In an earlier message, you said:\n"hello world"\n\nThe user has a follow-up: ');
    expect(composed).not.toContain('conv-1');
    expect(composed).not.toContain('past conversation');
  });

  it('the user bubble variant is also named in a preview (role-specific lead preserved)', () => {
    const bubble = mountBubble({ scroll: 'preview', role: 'user', text: 'my question', conversationId: 'conv-2', conversationTitle: 'Untitled thread' });
    const composed = composedTextFor(bubble);
    expect(composed).toBe(`${COPY.askPreviewContext('Untitled thread', 'conv-2')} Earlier I wrote:\n"my question"\n\nThe user has a follow-up: `);
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
    const composed = composedTextFor(prose);
    expect(composed).toBe('In an earlier message, you said:\n"Edited app.ts"\n\nThe user has a follow-up: ');
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
