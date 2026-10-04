// sheet-measure — column widths from what a cell will SHOW, for the windowed spreadsheet viewers.
//
// WHY (review fix 4, 2026-10-04): the grid draws only visible columns, so every column's width must be known
// without drawing it. The first version used the stored value and a flat 7.2 px a character, which cut formatted
// numbers ("1,234.50", "50%"), dates, capitals and CJK text short with "…" where the old auto-sizing table showed
// them whole. Now: the width comes from the DISPLAYED text; per column only the widest-looking text (by a
// glyph-weighted length) is measured, with a canvas, so it costs a few measurements per column, not 200,000.

const PAD_PX = 18;            // 8 + 8 padding and the border
const SAFETY = 1.04;          // a hair wider than measured: bold cells, sub-pixel rounding
const FALLBACK_CHAR_PX = 7.4; // when there is no canvas (tests, odd WebViews)
const MAX_TEXT_COL_W = 400; // text columns stop growing here (the cell then ends in "…" and carries a title)

/** A rough width for a string in "average character" units: capitals and wide (CJK, emoji) glyphs count more. */
function weightedLength(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x2e80) w += 2;                 // CJK, full-width forms, most emoji (surrogates count 2 each: generous)
    else if (code >= 65 && code <= 90) w += 1.25; // capitals
    else w += 1;
  }
  return w;
}

let ctx: CanvasRenderingContext2D | null | undefined;
let ctxFont = '';
function measurer(): ((s: string) => number) | null {
  if (ctx === undefined) {
    try {
      ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch { ctx = null; }
    // jsdom returns null / throws "not implemented": fall back to the flat estimate there
    if (ctx) {
      // The grid's own font: its size is set on the table, the family is the page's.
      ctxFont = `13px ${typeof getComputedStyle === 'function' ? getComputedStyle(document.body).fontFamily || 'sans-serif' : 'sans-serif'}`;
      ctx.font = ctxFont;
    }
  }
  const c = ctx;
  return c ? (s: string) => c.measureText(s).width : null;
}

type Pick = { weight: number; text: string };

/** Accumulates, per column, the text that will need the most room, then turns that into pixel widths. */
export class ColumnFitter {
  private text: Array<Pick | undefined>;
  private num: Array<Pick | undefined>;
  constructor(cols: number) { this.text = new Array(cols); this.num = new Array(cols); }
  /** `numeric`: a right-aligned number is never truncated, so it is exempt from the width cap. */
  observe(col: number, text: string, numeric: boolean): void {
    if (!text) return;
    const weight = weightedLength(text);
    const slot = numeric ? this.num : this.text;
    const b = slot[col];
    if (!b || weight > b.weight) slot[col] = { weight, text };
  }
  /** Pixel width for column `col`, never below `floor`. */
  width(col: number, floor: number, cap = MAX_TEXT_COL_W): number {
    const m = measurer();
    const px = (p: Pick) => Math.ceil((m ? m(p.text) : p.weight * FALLBACK_CHAR_PX) * SAFETY + PAD_PX);
    const t = this.text[col], n = this.num[col];
    return Math.max(floor, t ? Math.min(cap, px(t)) : 0, n ? px(n) : 0);
  }
}
