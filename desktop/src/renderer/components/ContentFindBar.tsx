// ContentFindBar — Ctrl+F find-in-document for the artifact viewer. Scoped to a
// container element (the artifact content pane) using the CSS Custom Highlight
// API, so it highlights matches WITHOUT mutating the rendered DOM (which would
// fight React) and without leaking into the rest of the page.
//
// The bar must live OUTSIDE the searched container (it's rendered as a sibling
// overlay) — otherwise its own text (the match counter) would be walked and
// matched by the search.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from './ui';
import { TextInput } from './ui';

function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (window as any).Highlight === 'function';
}

function clearHighlights(hl: string, hlCurrent: string) {
  // `CSS` itself can be absent (jsdom, and any WebView without the CSSOM
  // global) — reading `.highlights` off undefined threw from the unmount
  // cleanup, which is the one place a throw takes React's whole tree down.
  if (typeof CSS === 'undefined') return;
  const h = (CSS as any).highlights;
  if (h) { h.delete(hl); h.delete(hlCurrent); }
}

// Walk text nodes in `root` and build a Range for every case-insensitive
// occurrence of `query`.
function computeRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = [];
  const q = query.toLowerCase();
  if (!q) return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.trim().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? '').toLowerCase();
    let idx = text.indexOf(q);
    while (idx !== -1) {
      const r = document.createRange();
      r.setStart(node, idx);
      r.setEnd(node, idx + q.length);
      ranges.push(r);
      idx = text.indexOf(q, idx + q.length);
    }
  }
  return ranges;
}

export function ContentFindBar({ containerRef, onClose, resetKey, highlightName = 'artifact-find', placeholder = 'Find in document', positionClassName = 'top-2 right-2', scrollRef, layout = 'floating' }: {
  containerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  resetKey: string; // changes when the active artifact changes → reset the search
  // Distinct highlight registry name per surface, so two find bars (e.g. the
  // artifact viewer and the chat timeline) don't clobber each other's ranges on
  // the global CSS.highlights map. Needs a matching ::highlight() CSS rule.
  highlightName?: string;
  placeholder?: string;
  // Tailwind positioning utilities for the absolute bar (caller anchors it past
  // any overlaid chrome). Default sits top-right of the searched container.
  positionClassName?: string;
  // The actual scrolling viewport, when it differs from the searched container.
  // Used for the "is the current match off-screen?" check. In the artifact
  // viewer the container IS the scroller, so this defaults to containerRef; the
  // chat timeline searches an inner content div nested inside .chat-scroll, so
  // it must pass the scroll element here or the off-screen check never fires
  // (the content div's rect spans the full scroll height).
  scrollRef?: React.RefObject<HTMLElement | null>;
  // 'floating' (default): the original absolutely-positioned card, anchored by
  // positionClassName — the artifact viewer's mode, untouched.
  // 'row': the same controls, right-aligned in a full-width strip that sits in
  // normal flow above the searched content like a browser's find bar (P-14,
  // Destin 2026-08-27). The floating card covered the end of the first
  // (right-aligned) user message in chat; a row shifts the messages down
  // while it is open instead. The caller owns the strip's top offset (chat
  // sits under an overlaid header) via CSS on `.find-row`.
  layout?: 'floating' | 'row';
}) {
  const HL = highlightName;
  const HL_CURRENT = `${highlightName}-current`;
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  // New artifact → clear the search.
  useEffect(() => { setQuery(''); setCurrent(0); }, [resetKey]);
  // New query → jump back to the first match.
  useEffect(() => { setCurrent(0); }, [query]);

  // Recompute + paint highlights whenever the query, current match, or artifact
  // changes. Scrolls the current match into view if it's off-screen.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !highlightsSupported()) { setCount(0); return; }
    const ranges = computeRanges(root, query);
    setCount(ranges.length);
    if (ranges.length === 0) { clearHighlights(HL, HL_CURRENT); return; }
    const cur = ((current % ranges.length) + ranges.length) % ranges.length;
    const HighlightCtor = (window as any).Highlight;
    (CSS as any).highlights.set(HL, new HighlightCtor(...ranges));
    (CSS as any).highlights.set(HL_CURRENT, new HighlightCtor(ranges[cur]));
    try {
      // Measure "off-screen" against the actual scrolling viewport, not the
      // searched container (they differ for the chat timeline). Falls back to
      // the container when no scrollRef is given (artifact viewer).
      const viewport = scrollRef?.current ?? root;
      const rect = ranges[cur].getBoundingClientRect();
      const vpRect = viewport.getBoundingClientRect();
      if (rect.top < vpRect.top || rect.bottom > vpRect.bottom) {
        (ranges[cur].startContainer.parentElement as HTMLElement | null)?.scrollIntoView({ block: 'center' });
      }
    } catch { /* range geometry can throw on detached nodes — ignore */ }
  }, [query, current, resetKey, containerRef, scrollRef, HL, HL_CURRENT]);

  // Always clear highlights when the bar unmounts (closed).
  useEffect(() => () => clearHighlights(HL, HL_CURRENT), [HL, HL_CURRENT]);

  const go = useCallback((dir: number) => {
    setCurrent((c) => (count === 0 ? 0 : (c + dir + count) % count));
  }, [count]);

  const shown = count > 0 ? `${((current % count) + count) % count + 1}/${count}` : (query ? '0/0' : '');

  // One set of controls, two wrappers — the input/counter/prev/next/close and
  // their key handling are identical in both layouts by construction.
  const controls = (
    <>
      {/* Change 20: this was the gray-focus variant (bg-canvas + rounded-md +
          focus:border-fg-muted) — all three retired by the shared FIELD surface.
          Enter / Shift+Enter / Escape handling and the autofocus ref are unchanged.
          The prev/next/close buttons beside it are navigation, not a submit, so
          this stays a plain field rather than an InputGroup. */}
      <TextInput
        ref={inputRef}
        size="sm"
        aria-label={placeholder}
        className="w-[150px]"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        placeholder={placeholder}
      />
      <span className="text-2xs text-fg-muted tabular-nums text-center px-1 min-w-[40px]">{shown}</span>
      {/* Lucide-style SVGs (stroke currentColor) — the app's icon convention;
          these were literal ↑/↓/✕ text characters before. */}
      <button type="button" title="Previous (Shift+Enter)" onClick={() => go(-1)}
        className="w-6 h-6 rounded-md inline-flex items-center justify-center text-fg-dim hover:text-fg hover:bg-well">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>
      <button type="button" title="Next (Enter)" onClick={() => go(1)}
        className="w-6 h-6 rounded-md inline-flex items-center justify-center text-fg-dim hover:text-fg hover:bg-well">
        <ChevronDown className="w-[13px] h-[13px]" />
      </button>
      <button type="button" title="Close (Esc)" onClick={onClose}
        className="w-6 h-6 rounded-md inline-flex items-center justify-center text-fg-dim hover:text-fg hover:bg-well">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </>
  );

  // One pill, both layouts. Destin's review of P-14 (2026-08-27): "i still want it
  // to be its own element/pill with border, i just don't want it to overlap my
  // message" — so the in-flow row is a transparent lane that RESERVES the height,
  // and the same bordered pill the artifact viewer floats sits at its right edge.
  const pill = 'flex items-center gap-1 px-1.5 py-1 rounded-lg bg-panel border border-edge shadow-lg';
  if (layout === 'row') {
    return (
      // px-2 sm:px-3 = the header bar's own horizontal rhythm, so the pill lines
      // up with the chrome above it. shrink-0: it is a flex-column sibling of the
      // scroll container and must never be squeezed by it.
      <div className="find-row shrink-0 flex justify-end px-2 sm:px-3 py-1">
        <div className={pill}>{controls}</div>
      </div>
    );
  }
  return (
    <div data-loupe-block className={`absolute ${positionClassName} z-20 ${pill}`}>
      {controls}
    </div>
  );
}
