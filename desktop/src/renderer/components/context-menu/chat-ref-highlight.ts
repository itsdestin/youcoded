// Chat half of "a chip points back at its source" (Destin, 2026-09-24:
// hover/click worked for document chips but "not for message text").
// use-ref-source-highlight.ts handles chips from FILES; this handles chips
// made by "Ask about this" on a chat message or code block: hovering tints
// the quoted words in that message, clicking scrolls the chat to them and
// flashes them.
//
// WHY one module-level listener pair, not one per ChatView: every session's
// ChatView stays mounted, and hidden tabs must not hold listeners
// (performance.md rule 2). The handlers pick the VISIBLE copy of the entry.
import { findQuote } from '../comments/use-quote-marks';
import { paint, scrollToRange, HOVER_NAME, FLASH_NAME, FLASH_MS } from '../comments/use-ref-source-highlight';
import type { ComposeRef } from './compose-ref';

// A far-off message may be folded into a spacer (useEntryFolding), with no
// text in it until it scrolls near — so a click scrolls to the entry first
// and then retries finding the words.
const RETRY_MS = 150;
const RETRIES = 12;

function visible(el: Element): boolean {
  return el.getClientRects().length > 0;
}

/** The visible element to search: the message's own timeline entry, or —
 *  for a chip with no entry key (made before keys were recorded) — the
 *  whole visible chat. */
function searchRoot(ref: ComposeRef): HTMLElement | null {
  if (ref.entryKey) {
    const all = document.querySelectorAll<HTMLElement>(`[data-entry-key="${CSS.escape(ref.entryKey)}"]`);
    for (const el of all) if (visible(el)) return el;
    return null;
  }
  for (const el of document.querySelectorAll<HTMLElement>('.chat-scroll')) if (visible(el)) return el;
  return null;
}

function rangeIn(root: HTMLElement, ref: ComposeRef): Range | null {
  if (!ref.quote) return null;
  const hit = findQuote(root, ref.quote);
  if (!hit) return null;
  const r = document.createRange();
  r.setStart(hit.start.node, hit.start.offset);
  r.setEnd(hit.end.node, hit.end.offset);
  return r;
}

let installed = false;
let flashTimer: number | null = null;
let retryTimer: number | null = null;

/** Idempotent — InputBar calls it on mount. */
export function installChatRefHighlight(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('youcoded:ref-hover', (e) => {
    const ref = (e as CustomEvent<{ ref: ComposeRef | null }>).detail?.ref;
    if (ref && ref.kind !== 'chat') return; // a file chip — not ours
    const root = ref ? searchRoot(ref) : null;
    paint(HOVER_NAME, ref && root ? rangeIn(root, ref) : null);
  });
  window.addEventListener('youcoded:jump-to-ref', (e) => {
    const detail = (e as CustomEvent<{ ref?: ComposeRef; handled?: boolean }>).detail;
    const ref = detail?.ref;
    if (!ref || ref.kind !== 'chat') return;
    detail.handled = true;
    if (retryTimer) window.clearTimeout(retryTimer);
    let tries = 0;
    const attempt = () => {
      retryTimer = null;
      const root = searchRoot(ref);
      const range = root ? rangeIn(root, ref) : null;
      if (range) {
        scrollToRange(range);
        paint(FLASH_NAME, range);
        if (flashTimer) window.clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => paint(FLASH_NAME, null), FLASH_MS);
        return;
      }
      if (tries === 0) root?.scrollIntoView({ block: 'center' }); // unfold it
      if (++tries < RETRIES) retryTimer = window.setTimeout(attempt, RETRY_MS);
    };
    attempt();
  });
}
