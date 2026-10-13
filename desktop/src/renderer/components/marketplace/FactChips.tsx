// The fact-chip row and its number chips, shared by the Marketplace detail pages' top card
// and the item cards in the Marketplace and Your library.
// WHY one module (decisions "Item card chips", ui-element-review-unreviewed#U-1: "all the chips
// should be in the same row right below the name"; "Card chip row", G-9, refined by "Detail
// chips: one size, one row that scrolls", M2-1): the card now draws the same row the detail
// page approved — moved here unchanged from DetailPage.tsx and MarketplaceDetailOverlay.tsx.
import React from 'react';
import { Chip } from '../ui';
import { MIN_VOTES_FOR_PCT, ThumbIcon, thumbsSummary } from './FeedbackSection';
import './DetailPage.css';

/** The chip row: one line that scrolls sideways (round 5, marketplace-detail-4#M4-2).
 *  WHY no wheel translation: like the Marketplace rails, the row takes the browser's own
 *  sideways scrolling — touch swipe, trackpad two-finger, and Shift + mouse wheel. Turning
 *  a plain vertical wheel into sideways scrolling would trap the popup's own scrolling
 *  whenever the pointer crossed the row. The fade tells the eye there is more. */
export function ChipRow({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [fade, setFade] = React.useState<'none' | 'left' | 'right' | 'both'>('none');
  // 1px slack absorbs sub-pixel scroll positions (MarketplaceRail's rule).
  const update = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) { setFade('none'); return; }
    const left = el.scrollLeft > 1, right = el.scrollLeft < max - 1;
    setFade(left && right ? 'both' : left ? 'left' : right ? 'right' : 'none');
  }, []);
  // Window resize only, as the rails do: the row's width follows the window.
  React.useEffect(() => {
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [update, children]);
  return (
    // WHY py-1 with a matching -my-1 (Destin, marketplace-detail-5#M5-3: "the bottom of the
    // claude chip is clipping"): a sideways-scrolling box clips vertically too (CSS turns
    // overflow-y to auto alongside overflow-x), exactly at its content edge — and at a
    // fractional screen scale (1.5×) the chips' 1px bottom border rounded just outside it.
    // The padding gives the borders room inside the clip; the negative margin keeps the
    // card's spacing unchanged. Pinned in tests/marketplace-detail-shell.test.ts.
    // WHY [&>*]:shrink-0: in a row that scrolls, a chip never squeezes (the author chip
    // shrank to "@de…" on the item cards) — what doesn't fit scrolls under the fade.
    <div ref={ref} data-detail-chips data-fade={fade} onScroll={update}
      className="flex-1 min-w-0 flex items-center gap-1.5 flex-nowrap overflow-x-auto py-1 -my-1 [&>*]:shrink-0">
      {children}
    </div>
  );
}

/** A number chip: bold number, grey word — "412 installs" (guide "Text and numbers"). Same
 *  chip recipe as the trust badges beside it (Chip — round 2, MD-1 "install is tiny"). */
export function CountChip({ n, word }: { n: number; word: string }) {
  return (
    <Chip>
      <span className="font-medium text-fg">{n.toLocaleString()}</span>
      {n === 1 ? word : `${word}s`}
    </Chip>
  );
}

/** "👍 93%" — or the raw count under MIN_VOTES_FOR_PCT, where a percentage would lie. Drawn
 *  inside Chip rather than reusing the card's ThumbsSummary, whose own 12px text made
 *  this chip taller than its neighbours in round 1. */
export function ThumbsChip({ up, down }: { up?: number; down?: number }) {
  const s = thumbsSummary(up, down);
  if (!s) return null;
  const low = s.total < MIN_VOTES_FOR_PCT;
  return (
    <Chip title={low ? `${s.up} of ${s.total} found it helpful` : `${s.pct}% of ${s.total.toLocaleString()} people found it helpful`}>
      <span className="inline-flex text-fg-dim"><ThumbIcon /></span>
      {low ? s.up : `${s.pct}%`}
    </Chip>
  );
}

