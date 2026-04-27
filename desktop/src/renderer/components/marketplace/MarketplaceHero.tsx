// Hero section — rotating featured slots from featured.hero[]. Auto-advances
// every ~6s; pauses under prefers-reduced-motion so the page stops animating
// for users who've asked it to.

import React, { useEffect, useState } from "react";
import type { FeaturedHeroSlot, SkillEntry } from "../../../shared/types";

const ROTATION_MS = 6000;

interface Props {
  slots: FeaturedHeroSlot[];
  lookup(id: string): SkillEntry | undefined;
  onOpen(id: string): void;
}

export default function MarketplaceHero({ slots, lookup, onOpen }: Props) {
  const [index, setIndex] = useState(0);
  const reduceMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (slots.length <= 1 || reduceMotion) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % slots.length), ROTATION_MS);
    return () => window.clearInterval(id);
  }, [slots.length, reduceMotion]);

  if (slots.length === 0) return null;
  const slot = slots[Math.min(index, slots.length - 1)];
  const entry = lookup(slot.id);

  return (
    <section
      role="region"
      aria-label="Featured"
      className="layer-surface relative overflow-hidden min-h-[110px] sm:min-h-[180px] p-4 sm:p-6 flex flex-col justify-end gap-2"
      style={slot.accentColor ? { borderColor: slot.accentColor } : undefined}
    >
      <div className="relative z-10">
        <p className="text-xs uppercase tracking-wide text-fg-dim">Featured</p>
        <h2 className="text-base sm:text-2xl font-semibold text-fg">
          {entry?.displayName || slot.id}
        </h2>
        <p className="text-sm text-fg-2 max-w-xl mt-1 line-clamp-1 sm:line-clamp-none">{slot.blurb}</p>
        <button
          type="button"
          onClick={() => onOpen(slot.id)}
          className="mt-3 self-start px-3 py-1.5 rounded-md bg-accent text-on-accent text-sm font-medium hover:opacity-90 transition-opacity"
        >
          View details
        </button>
      </div>
      {slots.length > 1 && (
        <div className="absolute bottom-3 right-4 flex gap-1.5 z-10">
          {slots.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Go to slot ${i + 1}`}
              onClick={() => setIndex(i)}
              className={`w-2 h-2 rounded-full transition-opacity ${i === index ? "bg-fg opacity-90" : "bg-fg-dim opacity-40 hover:opacity-70"}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
