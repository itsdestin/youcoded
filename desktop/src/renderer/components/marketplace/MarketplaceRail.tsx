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
          // producing the hard horizontal cutoff lines we kept seeing.
          // Fix: bake enough vertical padding into the scroll container that
          // the .layer-surface shadow (`0 8px 32px` → ~24px above, ~40px
          // below each card) renders entirely INSIDE the clip box. pt-6/pb-10
          // matches the shadow's actual extent without removing it.
          // Hide horizontal scrollbar — touch users swipe; desktop users use
          // hover arrows. Visible scrollbar also eats bottom edge room.
          className="flex gap-3 overflow-x-auto scroll-smooth pt-6 pb-10 snap-x snap-mandatory
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
