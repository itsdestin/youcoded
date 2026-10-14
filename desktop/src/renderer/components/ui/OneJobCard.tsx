import React from 'react';
import { CARD_LEVEL_1 } from './cardLevels';

/**
 * The body of a popup that does one job: one first-level card holding its words, its field or
 * tick box, and then its buttons — stacked full width, the main (filled or red) one on top.
 *
 * WHY one shared piece (popup-cards-2#A-1/#A-2/#A-3, Destin: "still think these can look more
 * similar. notice the difference in header/text/input box/button positioning across all 3 popups
 * that basically have the same job/size"): after popup-cards-1#PC-1 put every one-job popup's
 * buttons inside its card, each popup still drew that card its own way — Rename's buttons side
 * by side at the right, Pick a handle's Save inside the text box, OpenRouter's stacked; 11px words
 * in one, 12px in the next; 340px wide here, 420px there. One piece draws them all the same, so
 * the next one-job popup cannot invent a fourth shape.
 *
 * Stacked, never side by side: these popups are all narrow (`panel`, 420px), and the guide's
 * button rule stacks two buttons in a narrow popup, filled on top. Callers pass their buttons in
 * order, main one first; each one is stretched to the card's width here (a `Tooltip` around a
 * button passes the width through, it clones its child).
 */
export function OneJobCard({ children, actions }: { children: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div className={`${CARD_LEVEL_1} p-3 space-y-3`}>
      {children}
      {/* `data-parts-agree`: shoot's parts check measures every one-job popup's buttons as one row
          kind (scripts/shoot/parts-agree.mjs), the mark Remove project's buttons carried alone. */}
      <div className="flex flex-col gap-2 [&>*]:w-full" data-parts-agree="one-job buttons">
        {actions}
      </div>
    </div>
  );
}

/** The words of a one-job popup: 12px, the secondary text colour (guide "Text and numbers"). */
export function OneJobText({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`text-xs text-fg-2 leading-relaxed space-y-2 ${className}`}>{children}</div>;
}

/**
 * A text box's name, above it. WHY always named (popup-cards-2#A-1): Rename had a "Session name"
 * line, Pick a handle and OpenRouter only grey words inside the box that vanish once you type.
 */
export function OneJobLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="block text-xs font-medium text-fg mb-1.5">{children}</label>;
}

/** A line under a text box (what happens to it, or "Connected."): 12px, grey. */
export function OneJobHint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-fg-muted mt-1.5">{children}</p>;
}
