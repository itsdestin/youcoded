// Dense, responsive grid for search-mode + bottom catalog.
//
// At ≥ 640px: 2-/3-/4-column grid of vertical MarketplaceCard tiles.
// At < 640px: stacked flex-col list of MarketplaceCard rows in compact mode.
//
// Switching between the two modes structurally (rather than via pure CSS) lets
// the card itself swap layouts cleanly — pure CSS would require rendering both
// trees and hiding one. See docs/superpowers/specs/2026-04-26-marketplace-mobile-responsive-design.md.

import React, { isValidElement, cloneElement, Children } from "react";
import { useNarrowViewport } from "../../hooks/use-narrow-viewport";

interface Props {
  children: React.ReactNode;
  dense?: boolean;
}

export default function MarketplaceGrid({ children, dense }: Props) {
  const compact = useNarrowViewport();

  // Inject compact={true} into each MarketplaceCard child when compact is on.
  // Done here (rather than at the call site) so MarketplaceScreen doesn't need
  // to know about the breakpoint — its bottom-catalog and search-grid render
  // paths stay unchanged.
  const childrenWithCompact = compact
    ? Children.map(children, (child) => {
        if (!isValidElement(child)) return child;
        // Only the MarketplaceCard children opt into compact. If a different
        // component happens to be passed in, it just won't get the prop.
        return cloneElement(child as React.ReactElement<{ compact?: boolean }>, { compact: true });
      })
    : children;

  // The `dense` panel-glass tray treatment was dropped — its 12px padding
  // pushed cards to 24px from the screen edge (parent's 12px gutter + tray
  // 12px), which made Explore Everything's cards sit deeper inset than the
  // rail cards above. Now both share the same 12/16px gutter for visual
  // continuity. The `dense` prop is preserved as a no-op for caller
  // back-compat; the only difference between dense and non-dense was the
  // tray, which we no longer apply either way.
  void dense;
  if (compact) {
    return (
      <div className="flex flex-col gap-2">
        {childrenWithCompact}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
      {childrenWithCompact}
    </div>
  );
}
