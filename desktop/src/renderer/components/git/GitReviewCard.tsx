// One expandable card in the review timeline (mockup ledger 11/12): the
// uncommitted card and every commit card share this shell so the two states
// cannot drift apart visually.
import React from 'react';

export function GitReviewCard({
  accent, expanded, onToggle, headerLeft, headerRight, children,
}: {
  /** accent border marks the pinned Uncommitted card */
  accent?: boolean;
  expanded: boolean;
  onToggle: () => void;
  headerLeft: React.ReactNode;
  headerRight?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    // shrink-0 is load-bearing: the timeline is a `flex flex-col` scroll
    // container, so without it these cards (default flex-shrink:1) COMPRESS to
    // fit the panel instead of overflowing. That squeezed the diff (clipped by
    // this card's overflow-hidden) AND left the timeline with nothing to scroll
    // — scrollHeight collapsed to clientHeight. Holding natural height lets the
    // diff show fully (or hit its own 45vh inner scroll) and lets the timeline
    // overflow and scroll.
    // WHY the whole card lights, not its header (Destin, submit-ticket-5#ST5-Q2, the ST4-2
    // sweep: "the hard divider line at the bottom is bad"): opened, the header's tint ran edge
    // to edge and stopped in a hard line above the changes. Same rule as the shared FoldRow.
    <div className={`shrink-0 rounded-lg border ${accent ? 'border-accent' : 'border-edge'} bg-well overflow-hidden stepped-hover has-[>button:hover]:bg-inset`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`text-fg-muted text-3xs transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
        {headerLeft}
        {headerRight}
      </button>
      {expanded && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}
