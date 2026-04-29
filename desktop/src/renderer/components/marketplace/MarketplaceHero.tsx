// Hero section — rotating featured slots from featured.hero[]. Auto-advances
// every ~6s; pauses under prefers-reduced-motion so the page stops animating
// for users who've asked it to. Touch-swipe (left/right) cycles slots
// manually on mobile; swiping resets the auto-advance timer so the next
// slot doesn't flip away immediately after you swipe.

import React, { useEffect, useRef, useState } from "react";
import type { FeaturedHeroSlot, SkillEntry } from "../../../shared/types";

const ROTATION_MS = 6000;
// Minimum horizontal travel to count as a swipe, in pixels. Below this, the
// gesture is treated as a tap (so the View-Details button + dot navigators
// still work via their own onClick). Reasonable middle-ground — small enough
// that a deliberate swipe always triggers, large enough that an accidental
// finger drift during a tap doesn't.
const SWIPE_THRESHOLD_PX = 40;

interface Props {
  slots: FeaturedHeroSlot[];
  lookup(id: string): SkillEntry | undefined;
  onOpen(id: string): void;
}

export default function MarketplaceHero({ slots, lookup, onOpen }: Props) {
  const [index, setIndex] = useState(0);
  const reduceMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // setTimeout (not setInterval) keyed on `index` so any manual change —
  // dot tap, swipe, or the auto-advance itself — resets the 6s clock. With
  // setInterval we'd advance partway through the rotation right after a
  // user-driven swipe, which feels jumpy.
  useEffect(() => {
    if (slots.length <= 1 || reduceMotion) return;
    const id = window.setTimeout(() => setIndex((i) => (i + 1) % slots.length), ROTATION_MS);
    return () => window.clearTimeout(id);
  }, [slots.length, reduceMotion, index]);

  // Touch-swipe handlers. Captures the start X on touchstart and the delta
  // on touchend; >= SWIPE_THRESHOLD_PX in either direction cycles the slot.
  // Below threshold the gesture falls through as a tap so dot navigators
  // and the View-Details button keep working without extra wiring.
  const touchStartXRef = useRef<number | null>(null);
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0]?.clientX ?? null;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    const startX = touchStartXRef.current;
    touchStartXRef.current = null;
    if (startX === null || slots.length <= 1) return;
    const endX = e.changedTouches[0]?.clientX ?? startX;
    const dx = endX - startX;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    // Swipe left (dx < 0) advances; swipe right (dx > 0) goes back.
    setIndex((i) =>
      dx < 0 ? (i + 1) % slots.length : (i - 1 + slots.length) % slots.length,
    );
  };

  if (slots.length === 0) return null;
  const slot = slots[Math.min(index, slots.length - 1)];
  const entry = lookup(slot.id);

  return (
    <section
      role="region"
      aria-label="Featured"
      className="layer-surface relative overflow-hidden min-h-[110px] sm:min-h-[180px] p-4 sm:p-6 flex flex-col justify-end gap-2 touch-pan-y select-none"
      style={slot.accentColor ? { borderColor: slot.accentColor } : undefined}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
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
