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
          className="flex gap-3 overflow-x-auto scroll-smooth pb-2 snap-x snap-mandatory
                     [&>*]:snap-start [&>*]:shrink-0 [&>*]:w-[280px]"
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
