// Horizontal-scroll rail. Transparent container so only cards composite
// against the wallpaper (keeps backdrop-filter stacking at ≤2).

import React, { useRef } from "react";

interface Props {
  title: string;
  description?: string;
  onSeeAll?(): void;
  children: React.ReactNode;
}

export default function MarketplaceRail({ title, description, onSeeAll, children }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.8), behavior: "smooth" });
  };

  return (
    <section className="flex flex-col gap-2" role="region" aria-label={title}>
      <header className="flex items-baseline justify-between gap-3 px-1">
        <div className="min-w-0">
          <h3 className="text-lg font-medium text-fg">{title}</h3>
          {description && <p className="text-xs text-fg-dim truncate">{description}</p>}
        </div>
        {onSeeAll && (
          <button
            type="button"
            onClick={onSeeAll}
            className="text-sm text-fg-2 hover:text-fg shrink-0"
          >
            See all →
          </button>
        )}
      </header>
      <div className="relative group">
        <div
          ref={scrollRef}
          role="list"
          // overflow-x-auto coerces overflow-y to scroll/auto per CSS spec —
          // the rail's clip box becomes the cards' bounding box, so any
          // vertical shadow extending past the card top/bottom gets sliced,
          // producing hard horizontal cutoff lines. Fix: pt-3/pb-6 gives
          // the .layer-surface shadow (`0 8px 32px`) most of its visible
          // extent without leaving the previous pt-6/pb-10's excessive
          // dead space between rails. The shadow tail past pb-6 is at
          // <25% of peak intensity so the cut reads as a soft fade, not
          // the hard horizontal line that motivated the original fix.
          //
          // Edge-to-edge horizontal scroll: parent has px-3 sm:px-4 padding
          // for content alignment, but we want cards to scroll OUT at the
          // actual screen edge (not the gutter). -mx-3 sm:-mx-4 pulls the
          // scroll container's bounds out to the screen edges, then
          // matching px-3 sm:px-4 inside re-pads the first card.
          //
          // BUT: snap-mandatory + snap-start aligns the first card's start
          // with the snapport's start, and without scroll-padding the
          // snapport equals the scroll container's padding box edge
          // (= screen edge, after -mx-3). That overrides the visual px-3
          // and snaps the first card flush to the screen. Adding
          // scroll-px-3 sm:scroll-px-4 redefines the snapport start to
          // match the visual padding, so snap-start lands the first card
          // at the same 12/16px offset as the rest of the marketplace
          // content.
          //
          // Hide horizontal scrollbar — touch users swipe; desktop users
          // use hover arrows. Visible scrollbar also eats bottom edge room.
          className="flex gap-3 overflow-x-auto scroll-smooth pt-3 pb-6 snap-x snap-mandatory
                     -mx-3 sm:-mx-4 px-3 sm:px-4 scroll-px-3 sm:scroll-px-4
                     [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
                     [&>*]:snap-start [&>*]:shrink-0 [&>*]:w-[min(220px,70vw)] sm:[&>*]:w-[min(280px,85vw)]"
        >
          {children}
        </div>
        {/* Hover arrows — desktop only; touch users swipe. */}
        <button
          type="button"
          aria-label="Scroll left"
          onClick={() => scrollBy(-1)}
          className="hidden md:flex absolute left-0 top-1/2 -translate-y-1/2 w-9 h-9 items-center justify-center rounded-full layer-surface opacity-0 group-hover:opacity-100 transition-opacity"
        >
          ←
        </button>
        <button
          type="button"
          aria-label="Scroll right"
          onClick={() => scrollBy(1)}
          className="hidden md:flex absolute right-0 top-1/2 -translate-y-1/2 w-9 h-9 items-center justify-center rounded-full layer-surface opacity-0 group-hover:opacity-100 transition-opacity"
        >
          →
        </button>
      </div>
    </section>
  );
}
