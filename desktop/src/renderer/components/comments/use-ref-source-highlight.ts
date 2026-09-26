// useRefSourceHighlight — lights up the text an "Ask about this" chip came
// from (Destin, 2026-09-24: "i should be able to click the chip and have it
// focus/highlight the originating text in some way. should be hover
// sensitive as well"). Mounted once per open commentable file
// (CommentableDocument), in both Reading and Comments mode.
//
//   hover a chip  → the source text gets a soft accent wash, no scrolling
//   click a chip  → scrolled into view (centred) and a stronger wash that
//                   fades after FLASH_MS
//   click when the file is closed → compose-ref.ts opens it and leaves a
//                   pending jump, taken here once the content has loaded
//
// WHY the CSS Custom Highlight API (like ContentFindBar): it paints a Range
// without touching the DOM, so it can never fight the comment <mark>s
// use-quote-marks.ts wraps into the same text.
import { useEffect, type RefObject } from 'react';
import { findQuote, cellSelector } from './use-quote-marks';
import { takePendingJump, type ComposeRef } from '../context-menu/compose-ref';
import { revealSheet } from './sheet-reveal';

export const HOVER_NAME = 'ref-source-hover';
export const FLASH_NAME = 'ref-source-flash';
export const FLASH_MS = 1800;
// A just-opened file renders its content asynchronously (bytes → parse →
// render), so a pending jump retries until the text exists or it expires.
const PENDING_RETRY_MS = 150;
const PENDING_TRIES = 30;

function rangeFor(root: HTMLElement, ref: ComposeRef): Range | null {
  if (ref.cell) {
    const cellEl = root.querySelector(cellSelector(ref));
    if (!cellEl) return null;
    const r = document.createRange();
    r.selectNodeContents(cellEl);
    return r;
  }
  // Chips sent before refs carried their quote only have the label
  // (“truncated quote…”) — its text is still a prefix of the source, so
  // search for that rather than doing nothing.
  const quote = ref.quote ?? ref.label.replace(/^“|”$/g, '').replace(/…$/, '');
  if (!quote.trim()) return null;
  const hit = findQuote(root, quote);
  if (!hit) return null;
  const r = document.createRange();
  r.setStart(hit.start.node, hit.start.offset);
  r.setEnd(hit.end.node, hit.end.offset);
  return r;
}

// Guarded: an engine without the API simply shows no highlight.
export function paint(name: string, range: Range | null): void {
  const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !HighlightCtor) return;
  if (range) reg.set(name, new HighlightCtor(range));
  else reg.delete(name);
}

export function scrollToRange(range: Range): void {
  const el = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function useRefSourceHighlight(contentRef: RefObject<HTMLElement | null>, path: string): void {
  useEffect(() => {
    let flashTimer: number | null = null;
    let pendingTimer: number | null = null;
    const flash = (range: Range) => {
      scrollToRange(range);
      paint(FLASH_NAME, range);
      if (flashTimer) window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => paint(FLASH_NAME, null), FLASH_MS);
    };
    const onHover = (e: Event) => {
      const ref = (e as CustomEvent<{ ref: ComposeRef | null }>).detail?.ref;
      // A chat chip is chat-ref-highlight.ts's to paint — clearing here would
      // wipe its highlight (both use the same highlight names).
      if (ref && ref.kind !== 'doc') return;
      // Another file's chip — leave the highlight alone (a second open viewer
      // of that file may be the one painting it).
      if (ref && ref.path !== path) return;
      const root = contentRef.current;
      paint(HOVER_NAME, ref && root ? rangeFor(root, ref) : null);
    };
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<{ ref?: ComposeRef; handled?: boolean }>).detail;
      const root = contentRef.current;
      if (!detail?.ref || !root || detail.ref.path !== path) return;
      // Handled even if the text is gone: the file IS open, so compose-ref
      // must not try to open it again.
      detail.handled = true;
      const ref = detail.ref;
      const range = rangeFor(root, ref);
      if (range) { flash(range); return; }
      // A cell on a sheet tab that isn't showing: switch to it, then look again.
      if (ref.cell && ref.sheet) {
        revealSheet(path, ref.sheet);
        pendingTimer = window.setTimeout(() => {
          const again = contentRef.current ? rangeFor(contentRef.current, ref) : null;
          if (again) flash(again);
        }, PENDING_RETRY_MS);
      }
    };
    window.addEventListener('youcoded:ref-hover', onHover);
    window.addEventListener('youcoded:jump-to-ref', onJump);

    const pending = takePendingJump(path);
    if (pending) {
      let tries = 0;
      const attempt = () => {
        const root = contentRef.current;
        const range = root ? rangeFor(root, pending) : null;
        if (range) { flash(range); pendingTimer = null; return; }
        if (++tries < PENDING_TRIES) pendingTimer = window.setTimeout(attempt, PENDING_RETRY_MS);
      };
      attempt();
    }

    return () => {
      window.removeEventListener('youcoded:ref-hover', onHover);
      window.removeEventListener('youcoded:jump-to-ref', onJump);
      if (flashTimer) window.clearTimeout(flashTimer);
      if (pendingTimer) window.clearTimeout(pendingTimer);
      paint(HOVER_NAME, null);
      paint(FLASH_NAME, null);
    };
  }, [contentRef, path]);
}
