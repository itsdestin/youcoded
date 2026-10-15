// A file chip in a message shows only the file NAME, but copying it should give
// the FULL PATH (Destin, 2026-10-14): a copied sentence or message is usually
// pasted somewhere that needs to find the file, and a bare name can't.
//
// The pill variant of FilepathToken stamps its full path in CHIP_PATH_ATTR. Every
// copy route asks this module, so they can't disagree:
//   - Ctrl/Cmd+C and the OS Copy command → installChipCopy's 'copy' listener
//   - right-click → Copy with a selection → selectionTextWithChipPaths
//   - right-click → Copy on a whole message → chipPathOf (inside readableText)

export const CHIP_PATH_ATTR = 'data-copy-path';
const CHIP_SELECTOR = `[${CHIP_PATH_ATTR}]`;

/** The chip `node` sits inside, if any. */
function chipOf(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return el?.closest<HTMLElement>(CHIP_SELECTOR) ?? null;
}

/** The full path to copy for a node inside a file chip, else null. */
export function chipPathOf(node: Node | null): { chip: HTMLElement; path: string } | null {
  const chip = chipOf(node);
  const path = chip?.getAttribute(CHIP_PATH_ATTR);
  return chip && path ? { chip, path } : null;
}

/** Chips the range touches, in document order. */
function chipsIn(range: Range): HTMLElement[] {
  const inside = chipOf(range.commonAncestorContainer);
  if (inside) return [inside];
  const root = range.commonAncestorContainer;
  if (!(root instanceof Element || root instanceof DocumentFragment || root instanceof Document)) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(CHIP_SELECTOR)).filter((c) => range.intersectsNode(c));
}

/**
 * The selection's text with each file chip it touches written as its full path
 * — even when only part of the chip's name was highlighted, since a half name
 * is useless. Returns null when the selection touches no chip, so callers keep
 * the browser's own copy untouched.
 *
 * WHY it re-selects each stretch between chips and reads Selection.toString():
 * that is the browser's own rendered text (line breaks between paragraphs, list
 * items, code lines), which Range.toString() and textContent both lose. The
 * original selection is put back before returning, in the same task, so nothing
 * is ever drawn in between.
 */
export function selectionTextWithChipPaths(sel: Selection | null): string | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  // WHY the try: this runs while building the right-click menu and inside every
  // copy; an unexpected selection must fall back to the ordinary copy, never
  // break the menu or the copy.
  let range: Range;
  let chips: HTMLElement[];
  try {
    range = sel.getRangeAt(0);
    chips = chipsIn(range);
  } catch {
    return null;
  }
  if (chips.length === 0) return null;

  const original = range.cloneRange();
  const textOf = (r: Range): string => {
    if (r.collapsed) return '';
    sel.removeAllRanges();
    sel.addRange(r);
    return sel.toString();
  };

  let out = '';
  try {
    let segStart = original.cloneRange();
    segStart.collapse(true);
    for (const chip of chips) {
      // The stretch from where we are up to this chip (empty when the selection
      // began inside the chip).
      const seg = document.createRange();
      seg.setStart(segStart.startContainer, segStart.startOffset);
      if (!chip.contains(original.startContainer)) {
        seg.setEndBefore(chip);
        out += textOf(seg);
      }
      out += chip.getAttribute(CHIP_PATH_ATTR) ?? '';
      segStart = document.createRange();
      segStart.setStartAfter(chip);
    }
    // Whatever follows the last chip (nothing when the selection ended inside it).
    const last = chips[chips.length - 1];
    if (!last.contains(original.endContainer)) {
      const tail = document.createRange();
      tail.setStart(segStart.startContainer, segStart.startOffset);
      tail.setEnd(original.endContainer, original.endOffset);
      out += textOf(tail);
    }
  } finally {
    sel.removeAllRanges();
    sel.addRange(original);
  }
  return out;
}

/** The selection as HTML, chips swapped for their paths — so pasting into a
 *  rich editor (a doc, an email) keeps bold, lists and links as before. */
function selectionHtmlWithChipPaths(sel: Selection): string {
  const frag = sel.getRangeAt(0).cloneContents();
  frag.querySelectorAll<HTMLElement>(CHIP_SELECTOR).forEach((c) => {
    c.replaceWith(document.createTextNode(c.getAttribute(CHIP_PATH_ATTR) ?? ''));
  });
  const box = document.createElement('div');
  box.appendChild(frag);
  return box.innerHTML;
}

/** Ctrl/Cmd+C (and the OS Edit → Copy) over a selection with file chips copies
 *  their full paths. Selections without a chip are left to the browser. */
export function installChipCopy(doc: Document = document): () => void {
  const onCopy = (e: ClipboardEvent) => {
    // A component that already wrote the clipboard (the spreadsheet grid) wins;
    // a text box's selection is its own text, never a chip.
    if (e.defaultPrevented || !e.clipboardData) return;
    const active = doc.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    const sel = doc.getSelection();
    const text = selectionTextWithChipPaths(sel);
    if (text === null || !sel) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', selectionHtmlWithChipPaths(sel));
  };
  doc.addEventListener('copy', onCopy);
  return () => doc.removeEventListener('copy', onCopy);
}
