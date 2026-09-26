import { isAndroid, isRemoteMode } from '../../platform';
import { copyText, readText } from './clipboard';
import { editorViewFor } from '../artifact-views/cm/editor-registry';
import type { MenuIconName } from './menu-icons';
// "Add comment" writes straight into the shared doc-comments store — no
// event needed (unlike "Ask about this", which must reach InputBar, a
// component this module has no other handle on).
import { addComment as addDocComment } from '../../state/doc-comments-store';
// Round 2: "Ask about this" builds a ComposeRef pill (ported from
// session/comments-mock-c) instead of a {quote, sourceLabel} chip.
import { genRefId, truncateQuote, type ComposeRef } from './compose-ref';

// Builds the chat right-click menu for a given DOM target. Pure inspection of
// the DOM + current selection → a list of entries; the host owns positioning,
// open/close, and rendering. Returns null when the target isn't a surface we
// own (or has nothing actionable), so the host leaves the event alone.

export type MenuEntry =
  | {
      type: 'item';
      id: string;
      label: string;
      icon: MenuIconName;
      kbd?: string;
      primary?: boolean;
      disabled?: boolean;
      run: () => void | Promise<void>;
    }
  | { type: 'sep' };

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
const mod = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);
// Reveal-in-folder / open-in-OS only do anything on the Electron desktop; on
// Android and remote-browser the shell IPC is a no-op, so we hide those items.
const isDesktop = () => !isAndroid() && !isRemoteMode();

// window.claude is the shared IPC surface (preload on desktop, remote-shim on
// Android/remote). Typed loosely here to avoid coupling to the ambient global.
const shell = () => (window as { claude?: { shell?: any } }).claude?.shell;

function selectionText(): string {
  return window.getSelection()?.toString() ?? '';
}

// App chrome (every <button>, and anything marked `select-none`) is not
// highlightable (globals.css + the chrome areas' own classes), so it is not
// copy material from this menu either (Destin, 2026-09-10): right-clicking it
// offers nothing, and a whole-message Copy / "Ask about this" leaves its text
// out. CSS cannot do this half: `textContent` reads unselectable text just the
// same. `select-text` is the opt-back-in (a clickable file name in a message is
// a <button>, but its label is part of the message's words).
const CHROME = 'button, .select-none';

function isChrome(el: Element): boolean {
  const chrome = el.closest(CHROME);
  if (!chrome) return false;
  const optIn = el.closest('.select-text');
  return !(optIn && chrome.contains(optIn));
}

// An element's text as a user could have selected it: text inside chrome is
// skipped. A live selection already leaves chrome out in Chromium (measured
// 2026-09-10), so this only matters for the no-selection fallback.
function readableText(root: Element): string {
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement && !isChrome(node.parentElement)) text += node.textContent ?? '';
  }
  return text;
}

/** The chat timeline entry (ChatView's data-entry-key) a target sits in. */
function entryKeyOf(el: Element): string | undefined {
  return el.closest<HTMLElement>('[data-entry-key]')?.dataset.entryKey;
}

function closestBubble(el: Element): Element | null {
  return el.closest('.assistant-bubble, .user-bubble');
}

// A previewed past conversation (SessionPreviewPane)
// stamps its container with data-conversation-id/-title instead of carrying
// .chat-scroll — see the guard in buildContextMenu for why. Reused here so
// textMenu/codeMenu can name the conversation in their "Ask about this"
// scaffold (spec §A3); absent everywhere else (the live chat IS the
// conversation, so it names nothing — that keeps its scaffold unchanged).
function closestPreviewConversation(el: Element): { id: string; title: string } | null {
  const container = el.closest('[data-conversation-id]');
  if (!(container instanceof HTMLElement)) return null;
  const id = container.getAttribute('data-conversation-id');
  if (!id) return null;
  return { id, title: container.getAttribute('data-conversation-title') || '' };
}

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p;
}

function selectElementContents(el: Element): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

// "Ask about this" attaches a reference PILL inline in the composer's own
// sentence instead of dropping scaffold text into the textarea (redesign,
// doc-comments mockup round 2, Destin: "I'd rather have the comment
// primarily be seen as highlighted text… ask-about → pill inside the
// sentence"). Ported mechanism: compose-ref.ts + InputBar's mirror layer
// (session/comments-mock-c). InputBar appends the marker to the current
// draft and focuses the textarea for the user's own follow-up.
function addReference(ref: ComposeRef): void {
  window.dispatchEvent(new CustomEvent('youcoded:compose-insert', { detail: { ref } }));
}

/** "line N" / "lines N-M" from describeArtifactSelection's own strings, or
 *  null when it fell back to a quote (no reliable source mapping). */
function parseLineRef(ref: string): { startLine: number; endLine: number } | null {
  const single = /^line (\d+)$/.exec(ref);
  if (single) return { startLine: +single[1], endLine: +single[1] };
  const range = /^lines (\d+)-(\d+)$/.exec(ref);
  if (range) return { startLine: +range[1], endLine: +range[2] };
  return null;
}

/** Compact MARGIN-CARD anchor label: "line 12-18 · file.ts" when there's a
 *  real source mapping, else just the file name (a quote fallback already
 *  IS the anchor — repeating it as a label is noise). Comments only — the
 *  compose-ref PILL label below reads differently (a paragraph mark + the
 *  quote itself, since a pill has no separate quote sliver to lean on). */
function sourceLabelFor(ref: string, path: string): string {
  const line = parseLineRef(ref);
  return line ? `${ref} · ${baseName(path)}` : baseName(path);
}

/** Builds the ComposeRef for a DOC selection's "Ask about this" pill: a real
 *  line range reads as "line 12-18 · file.ts"; a rendered-markdown quote
 *  fallback (no line mapping) reads as a paragraph mark + the quote, since
 *  that's the only anchor available. */
function buildDocRef(quote: string, ref: string, path: string): ComposeRef {
  const line = parseLineRef(ref);
  const fileName = baseName(path);
  return {
    id: genRefId(),
    kind: 'doc',
    path,
    fileName,
    quote: quote.slice(0, 2000),
    label: line ? `${ref} · ${fileName}` : `“${truncateQuote(quote)}”`,
    lineRange: line ? [line.startLine, line.endLine] : undefined,
  };
}


// Copy + Select all — shared tail for every read-only chat menu.
function textBasics(bubble: Element | null): MenuEntry[] {
  const sel = selectionText();
  return [
    {
      type: 'item',
      id: 'copy',
      label: 'Copy',
      icon: 'copy',
      kbd: mod('C'),
      disabled: !sel && !bubble,
      // readableText, not textContent: a whole-message copy must leave tool
      // card titles and other chrome out (see isChrome).
      run: () => void copyText(sel || (bubble ? readableText(bubble) : '')),
    },
    {
      type: 'item',
      id: 'select-all',
      label: 'Select all',
      icon: 'select-all',
      kbd: mod('A'),
      disabled: !bubble,
      run: () => {
        if (bubble) selectElementContents(bubble);
      },
    },
  ];
}

function editableMenu(el: HTMLTextAreaElement | HTMLInputElement, canAttachClipboardImage = false): MenuEntry[] {
  // Capture the selection NOW (at right-click), because auto-focusing the menu
  // blurs the textarea; we restore this range before each op so cut/copy/paste
  // act on what the user actually had selected.
  const selStart = el.selectionStart ?? 0;
  const selEnd = el.selectionEnd ?? 0;
  const hasSelection = selStart !== selEnd;
  const empty = (el.value ?? '').length === 0;
  const restore = () => {
    el.focus();
    el.setSelectionRange(selStart, selEnd);
  };
  return [
    // execCommand cut/paste fire the native 'input' event, so React's controlled
    // onChange stays in sync — a manual value set would not.
    { type: 'item', id: 'cut', label: 'Cut', icon: 'cut', kbd: mod('X'), disabled: !hasSelection, run: () => { restore(); document.execCommand('cut'); } },
    { type: 'item', id: 'copy', label: 'Copy', icon: 'copy', kbd: mod('C'), disabled: !hasSelection, run: () => { restore(); document.execCommand('copy'); } },
    { type: 'item', id: 'paste', label: 'Paste', icon: 'paste', kbd: mod('V'), run: async () => {
      restore();
      const t = await readText();
      if (t) {
        // Clipboard reads are async, so focus may move again while they settle.
        restore();
        document.execCommand('insertText', false, t);
      } else if (t === '' && canAttachClipboardImage) {
        // WHY: the menu knows which surface was clicked, but InputBar must remain
        // the owner of attachment state and the existing save/addFiles route.
        window.dispatchEvent(new CustomEvent('youcoded:composer-paste-image'));
      }
    } },
    { type: 'sep' },
    { type: 'item', id: 'select-all', label: 'Select all', icon: 'select-all', kbd: mod('A'), disabled: empty, run: () => { el.focus(); el.select(); } },
  ];
}

// Cut/Copy/Paste for the CodeMirror edit surface. execCommand does not work
// reliably against CM6's contenteditable (it bypasses CM6's transaction
// model), so the ops go through the EditorView API instead — same UX contract
// as editableMenu above.
function cmEditableMenu(contentEl: HTMLElement): MenuEntry[] {
  const view = editorViewFor(contentEl);
  if (!view) return [];
  const range = view.state.selection.main;
  const hasSelection = !range.empty;
  const selText = hasSelection ? view.state.sliceDoc(range.from, range.to) : '';
  const empty = view.state.doc.length === 0;
  return [
    { type: 'item', id: 'cut', label: 'Cut', icon: 'cut', kbd: mod('X'), disabled: !hasSelection, run: () => {
      void copyText(selText);
      view.dispatch({ changes: { from: range.from, to: range.to, insert: '' } });
      view.focus();
    } },
    { type: 'item', id: 'copy', label: 'Copy', icon: 'copy', kbd: mod('C'), disabled: !hasSelection, run: () => void copyText(selText) },
    { type: 'item', id: 'paste', label: 'Paste', icon: 'paste', kbd: mod('V'), run: async () => {
      const t = await readText();
      if (t) {
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: t },
          selection: { anchor: range.from + t.length },
        });
      }
      view.focus();
    } },
    { type: 'sep' },
    { type: 'item', id: 'select-all', label: 'Select all', icon: 'select-all', kbd: mod('A'), disabled: empty, run: () => {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.focus();
    } },
  ];
}

function filePillMenu(el: HTMLElement): MenuEntry[] {
  const abs = el.getAttribute('data-file-path') || '';
  const name = baseName(abs);
  const entries: MenuEntry[] = [];
  if (isDesktop()) {
    entries.push(
      { type: 'item', id: 'open-file', label: 'Open file', icon: 'open', primary: true, run: () => shell()?.openPath(abs) },
      { type: 'item', id: 'reveal', label: 'View in folder', icon: 'folder', run: () => shell()?.showItemInFolder(abs) },
      { type: 'sep' },
    );
  }
  entries.push(
    { type: 'item', id: 'copy-name', label: 'Copy file name', icon: 'copy', run: () => void copyText(name) },
    { type: 'item', id: 'copy-path', label: 'Copy as path', icon: 'path', run: () => void copyText(abs) },
  );
  return entries;
}

function linkMenu(a: HTMLAnchorElement, target: HTMLElement): MenuEntry[] {
  const href = a.href || a.getAttribute('href') || '';
  return [
    { type: 'item', id: 'open-link', label: 'Open link', icon: 'open', primary: true, disabled: !href, run: () => { if (href) shell()?.openExternal(href); } },
    { type: 'item', id: 'copy-link', label: 'Copy link address', icon: 'link', disabled: !href, run: () => void copyText(href) },
    { type: 'sep' },
    ...textBasics(closestBubble(target)),
  ];
}

function codeMenu(pre: HTMLElement, target: HTMLElement): MenuEntry[] {
  const code = pre.innerText.replace(/\n+$/, '');
  const firstLine = code.split('\n', 1)[0] ?? '';
  // quote + entryKey let the chip find and light up this block again
  // (chat-ref-highlight.ts); curly quotes match the file chips' labels.
  const ref: ComposeRef = {
    id: genRefId(), kind: 'chat', label: `code · “${truncateQuote(firstLine, 24)}”`,
    quote: code.slice(0, 2000), entryKey: entryKeyOf(target),
  };
  return [
    { type: 'item', id: 'ask', label: 'Ask about this', icon: 'ask', primary: true, disabled: !code, run: () => addReference(ref) },
    { type: 'item', id: 'copy-code', label: 'Copy code block', icon: 'code', disabled: !code, run: () => void copyText(code) },
    { type: 'sep' },
    ...textBasics(closestBubble(target)),
  ];
}

// Best-effort: match the selection against the artifact's rendered <pre> text to
// report source line numbers. Only attempted for 'raw' viewers (CodeView, and
// MarkdownView on non-.md files) where the <pre> is a verbatim copy of the file —
// rendered markdown prose doesn't map 1:1 back to source lines, so it always
// falls through to a quote. Line matching is first-occurrence indexOf, so a
// selection that also appears earlier in the file can report the wrong line —
// an acceptable miss for a prompt scaffold the user reviews before sending.
//
// textContent, NOT innerText: innerText is layout-dependent (forces a reflow, and
// its line handling follows *rendered* boxes) — on a `whitespace-pre-wrap` <pre>
// that risks counting soft-wrap breaks as source newlines. textContent walks the
// highlight.js spans and yields the file's exact characters. It's also the only
// one jsdom implements, so this stays unit-testable.
function describeArtifactSelection(sel: string, container: HTMLElement): string {
  const source = container.getAttribute('data-artifact-source');
  // CodeMirror viewers NEVER use the textContent path below: CM6 virtualizes,
  // so only viewport lines exist in the DOM and an indexOf count reports a
  // plausible WRONG line (a selection at line 800 cites "line 41") straight
  // into a prompt scaffold (spec §5.3). state.doc.lineAt() is
  // virtualization-immune; the live view comes from the editor registry.
  if (source === 'cm6') {
    const view = editorViewFor(container);
    const range = view?.state.selection.main;
    if (view && range && !range.empty) {
      const startLine = view.state.doc.lineAt(range.from).number;
      const endLine = view.state.doc.lineAt(range.to).number;
      return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
    }
    return `"${sel}"`;
  }
  const pre = source === 'raw' ? container.querySelector('pre') : null;
  const full = pre?.textContent ?? '';
  const idx = pre ? full.indexOf(sel) : -1;
  if (idx !== -1) {
    const startLine = (full.slice(0, idx).match(/\n/g) || []).length + 1;
    const endLine = startLine + (sel.match(/\n/g) || []).length;
    return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  }
  return `"${sel}"`;
}

/** Spreadsheet cell under a right-click with no text selected: "Ask about
 *  this" / "Add comment" name the CELL (Excel's comment model — Destin's Excel
 *  follow-up, 2026-09-24), with its shown value as the quote. */
function cellEntries(td: HTMLElement, path: string): MenuEntry[] {
  const cell = td.getAttribute('data-cell') || '';
  const value = (td.textContent ?? '').trim();
  const label = `${cell} · ${baseName(path)}`;
  return [
    {
      type: 'item', id: 'ask', label: 'Ask about this', icon: 'ask', primary: true,
      run: () => addReference({ id: genRefId(), kind: 'doc', path, fileName: baseName(path), label, cell, quote: value }),
    },
    {
      type: 'item', id: 'comment', label: 'Add comment', icon: 'comment',
      run: () => { addDocComment(path, value, label, { cell }); },
    },
  ];
}

function artifactMenu(container: HTMLElement, target?: HTMLElement): MenuEntry[] {
  // data-doc-path, not data-artifact-path: the latter is reserved by the deferred
  // image sub-menu roadmap item for an ABSOLUTE path on <img> elements. This one
  // is the project-relative artifact path, which is what reads well in a prompt.
  const path = container.getAttribute('data-doc-path') || '';
  const sel = selectionText().trim();
  const entries: MenuEntry[] = [];
  const cell = !sel && path ? target?.closest<HTMLElement>('[data-cell]') : null;
  if (cell && container.contains(cell)) entries.push(...cellEntries(cell, path));
  if (sel && path) {
    const ref = describeArtifactSelection(sel, container);
    const sourceLabel = sourceLabelFor(ref, path);
    const lineOpts = parseLineRef(ref) ?? undefined;
    entries.push({
      type: 'item',
      id: 'ask',
      label: 'Ask about this',
      icon: 'ask',
      primary: true,
      run: () => addReference(buildDocRef(sel, ref, path)),
    });
    // "Add comment" is the doc-comments mockup's second entry point (the
    // first is selection + this same right-click menu, per spec surface 1):
    // it opens an empty margin card anchored to the selection instead of
    // sending anything — many of these get held and batched via the review
    // bar's "Send to assistant", unlike "Ask about this" above.
    entries.push({
      type: 'item',
      id: 'comment',
      label: 'Add comment',
      icon: 'comment',
      run: () => { addDocComment(path, sel, sourceLabel, lineOpts); },
    });
  }
  entries.push(...textBasics(container));
  return entries;
}

function textMenu(target: HTMLElement): MenuEntry[] {
  const bubble = closestBubble(target);
  // readableText: "Ask about this" quotes the message as a user could have
  // selected it, without tool card titles or other chrome.
  const quote = (selectionText().trim() || (bubble ? readableText(bubble).trim() : '')) ?? '';
  const entries: MenuEntry[] = [];
  if (quote) {
    // Preview-only: name which past conversation this quote came from, right
    // in the pill — a no-op in the live chat, where the label is just the quote.
    const previewRef = closestPreviewConversation(target);
    // Curly-quoted like the file chips (Destin, 2026-09-24 chip rework).
    const label = previewRef
      ? `“${previewRef.title || 'Untitled thread'}” · “${truncateQuote(quote, 20)}”`
      : `“${truncateQuote(quote, 28)}”`;
    // quote + entryKey let the chip light up this message again
    // (chat-ref-highlight.ts) — Destin: hover/click worked for documents but
    // "not for message text".
    const ref: ComposeRef = { id: genRefId(), kind: 'chat', label, quote: quote.slice(0, 2000), entryKey: entryKeyOf(target) };
    entries.push({ type: 'item', id: 'ask', label: 'Ask about this', icon: 'ask', primary: true, run: () => addReference(ref) });
  }
  entries.push(...textBasics(bubble));
  return entries;
}

export function buildContextMenu(target: HTMLElement): MenuEntry[] | null {
  // Editable text surfaces (Cut/Copy/Paste/Select all) live outside .chat-scroll:
  // the composer, and the artifact viewer's edit-mode textarea. Electron ships no
  // default context menu, so without this branch right-click in the artifact
  // editor does nothing at all — no cut/copy/paste of any kind.
  // [data-edit-menu]: the comment boxes (CommentCard, NewCommentPopover) are
  // <Textarea> primitives, which may not carry a bare marker class.
  const editable = target.closest('.input-bar-textarea, .artifact-edit-textarea, [data-edit-menu]');
  if (editable instanceof HTMLTextAreaElement || editable instanceof HTMLInputElement) {
    return finalize(editableMenu(editable, editable.classList.contains('input-bar-textarea')));
  }
  // CodeMirror in EDIT mode: the editable surface is a contenteditable div,
  // not a textarea. The [contenteditable=true] filter matters — read-only CM6
  // also renders .cm-content, and that must fall through to the artifact menu
  // below so "Ask about this" keeps working.
  const cmEditable = target.closest('.cm-content[contenteditable="true"]');
  if (cmEditable instanceof HTMLElement) {
    return finalize(cmEditableMenu(cmEditable));
  }

  // Artifact viewer (SessionDrawer / ProjectView file tab) lives outside
  // .chat-scroll, so it's checked before that gate.
  // Chrome (a button, an unselectable label) gets no menu, in the viewer or the
  // chat: nothing on it can be highlighted, so nothing on it is copyable.
  // Checked after the editable surfaces above, which are never chrome.
  const onChrome = isChrome(target);
  const artifactViewer = target.closest('[data-artifact-viewer]');
  if (artifactViewer instanceof HTMLElement) return onChrome ? null : finalize(artifactMenu(artifactViewer, target));

  // Everything else is scoped to chat content — never hijack the terminal, the
  // settings panels, or other chrome. A previewed past conversation
  // (SessionPreviewPane) is chat content too, but its scroll container is
  // NOT .chat-scroll on purpose: that class carries real CSS (globals.css:591,
  // :614, plus bottom-chrome offsets sized for the live composer) that has no
  // meaning inside a drawer, so adopting the class would import layout
  // assumptions along with the behaviour it was really needed for here.
  // data-conversation-id is the transcript's OWN marker (SessionPreviewPane,
  // set only when a caller names a conversation) — accepting either gets the
  // preview the whole menu without borrowing chat-composer CSS.
  if (!target.closest('.chat-scroll') && !target.closest('[data-conversation-id]')) return null;

  const filePill = target.closest('[data-file-path]');
  if (filePill instanceof HTMLElement && filePill.getAttribute('data-file-path')) {
    return finalize(filePillMenu(filePill));
  }
  const link = target.closest('a[href]');
  if (link instanceof HTMLAnchorElement) return finalize(linkMenu(link, target));

  const pre = target.closest('pre');
  if (pre instanceof HTMLElement) return finalize(codeMenu(pre, target));

  // After the file-name, link and code checks: those keep their own menus even
  // when they sit on a button.
  if (onChrome) return null;
  return finalize(textMenu(target));
}

// Drop a menu with no actionable (enabled) item — e.g. a right-click on empty
// chat gutter — so the host doesn't pop an all-greyed shell.
function finalize(entries: MenuEntry[]): MenuEntry[] | null {
  return entries.some((e) => e.type === 'item' && !e.disabled) ? entries : null;
}
