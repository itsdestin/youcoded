// sheet-measure — column widths from what a cell will SHOW, for the windowed spreadsheet viewers.
//
// WHY (review fix 4, 2026-10-04): the grid draws only visible columns, so every column's width must be known
// without drawing it. The first version used the stored value and a flat 7.2 px a character, which cut formatted
// numbers ("1,234.50", "50%"), dates, capitals and CJK text short with "…" where the old auto-sizing table showed
// them whole. Now: the width comes from the DISPLAYED text; per column only the widest-looking text (by a
// glyph-weighted length) is measured, with a canvas, so it costs a few measurements per column, not 200,000.

import { useSyncExternalStore } from 'react';

const PAD_PX = 18;            // 8 + 8 padding and the border
const SAFETY = 1.04;          // a hair wider than measured: bold cells, sub-pixel rounding
const FALLBACK_CHAR_PX = 7.4; // when there is no canvas (tests, odd WebViews)
const MAX_TEXT_COL_W = 400; // text columns stop growing here (the cell then ends in "…" and carries a title)

/**
 * A rough width for a string in "average character" units, used only to pick WHICH few strings of a column are
 * worth measuring for real: capitals, wide glyphs (CJK, emoji) and runs of m/w count more, narrow ones (i, l, 1,
 * punctuation) less. The real width is then measured (below), so this only has to rank sensibly.
 */
export function weightedLength(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x2e80) w += 2;                    // CJK, full-width forms, most emoji (surrogates count 2 each: generous)
    else if (code === 109 || code === 119 || code === 77 || code === 87 || code === 64) w += 1.6; // m w M W @
    else if (code >= 65 && code <= 90) w += 1.25;  // capitals
    else if ('il1jtfI.,:;|!\''.includes(s[i])) w += 0.55; // narrow
    else w += 1;
  }
  return w;
}

// ── Fonts. A cell's width depends on the font it is drawn in, which can change after a sheet was sized (a theme's
// web font finishing loading, the theme changing). `fontEpoch` counts such changes; the viewers re-size when it
// moves, and the measuring context re-reads the font when it does.
let epoch = 0;
const epochListeners = new Set<() => void>();
let watching = false;
function bump() { epoch++; epochListeners.forEach((l) => l()); }
function watchFonts() {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  try { (document as any).fonts?.addEventListener?.('loadingdone', bump); } catch { /* no FontFaceSet */ }
  if (typeof MutationObserver !== 'undefined') {
    let pending = false;
    new MutationObserver(() => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; bump(); }); } })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-font', 'class', 'style'] });
  }
}
/** Re-renders the caller when the page's fonts or theme changed (so column widths are measured again). */
export function useFontEpoch(): number {
  return useSyncExternalStore(
    (l) => { watchFonts(); epochListeners.add(l); return () => { epochListeners.delete(l); }; },
    () => epoch,
    () => 0,
  );
}
/** Test hook: pretend the fonts changed. */
export const bumpFontEpochForTest = bump;

/** Resolves when the page's fonts have loaded, or after `ms`, whichever is first (never blocks a sheet for long). */
export function fontsReady(ms: number): Promise<void> {
  const ready: Promise<unknown> | undefined = typeof document !== 'undefined' ? (document as any).fonts?.ready : undefined;
  if (!ready) return Promise.resolve();
  return Promise.race([ready.then(() => undefined), new Promise<void>((r) => setTimeout(r, ms))]).then(() => undefined);
}

let ctx: CanvasRenderingContext2D | null | undefined;
let ctxEpoch = -1;
function measurer(): ((s: string) => number) | null {
  if (ctx === undefined) {
    try { ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null; } catch { ctx = null; }
  }
  const c = ctx;
  if (!c) return null;
  if (ctxEpoch !== epoch) {
    ctxEpoch = epoch;
    // The grid's own font: its size is set on the table, the family is the page's.
    c.font = `13px ${typeof getComputedStyle === 'function' ? getComputedStyle(document.body).fontFamily || 'sans-serif' : 'sans-serif'}`;
  }
  return (s: string) => c.measureText(s).width;
}

type Pick = { weight: number; text: string };
const TOP_K = 4; // candidates per column that are really measured

/** Keeps the TOP_K heaviest strings seen. */
function keep(list: Pick[], p: Pick) {
  if (list.length < TOP_K) { list.push(p); return; }
  let min = 0;
  for (let i = 1; i < list.length; i++) if (list[i].weight < list[min].weight) min = i;
  if (p.weight > list[min].weight) list[min] = p;
}

/** Accumulates, per column, the texts that may need the most room, then turns that into pixel widths. */
export class ColumnFitter {
  private text: Array<Pick[] | undefined>;
  private num: Array<Pick[] | undefined>;
  constructor(cols: number) { this.text = new Array(cols); this.num = new Array(cols); }
  /** `numeric`: a right-aligned number is never truncated, so it is exempt from the width cap. */
  observe(col: number, text: string, numeric: boolean): void {
    if (!text) return;
    const slot = numeric ? this.num : this.text;
    (slot[col] ??= []);
    keep(slot[col]!, { weight: weightedLength(text), text });
  }
  /** Pixel width for column `col`, never below `floor`: the widest MEASURED of its top candidates. */
  width(col: number, floor: number, cap = MAX_TEXT_COL_W): number {
    const m = measurer();
    const px = (list: Pick[] | undefined) => {
      if (!list) return 0;
      let best = 0;
      for (const p of list) best = Math.max(best, m ? m(p.text) : p.weight * FALLBACK_CHAR_PX);
      return Math.ceil(best * SAFETY + PAD_PX);
    };
    return Math.max(floor, Math.min(cap, px(this.text[col])), px(this.num[col]));
  }
}
