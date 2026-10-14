import React, { useLayoutEffect, useState } from 'react';

// Phase 3 overlay primitives. Wrap .layer-scrim and .layer-surface from
// globals.css so components get consistent scrim color, blur, rounding,
// shadow, and z-index straight from the theme tokens.
//
// Layer semantics (see docs/plans/overlay-layer-system):
//   L1 Drawer   — side/bottom panels (Settings, CommandDrawer, ResumeBrowser)
//   L2 Popup    — anchored/centered panels (theme picker, ShareSheet, pickers)
//   L3 Critical — destructive confirmations (delete session, clear history)
//   L4 System   — always-visible indicators (toasts, keyboard shortcut hint)

export type OverlayLayer = 1 | 2 | 3 | 4;

const SCRIM_Z: Record<OverlayLayer, number> = { 1: 40, 2: 60, 3: 70, 4: 100 };

// Exported because a few overlays wrap OverlayPanel in a full-screen centring
// div (the panel then runs at `position: relative; z-index: auto`, so the WRAPPER
// carries the stacking). Those wrappers were hand-writing `z-[61]` / `z-50`,
// which re-literalled these numbers in four files. Import the map instead —
// design rule 11 is that this file is the only place a layer number is decided.
export const CONTENT_Z: Record<OverlayLayer, number> = { 1: 50, 2: 61, 3: 71, 4: 100 };

// Popover escape-hatch tier: a floating menu/panel SPAWNED FROM a host that
// lives in the z-9000 exception band (SessionStrip dropdown, ProjectHero,
// OverflowMenu — see docs/shared-ui-architecture.md → Overlay Layer System).
// Those hosts render above every L1–L4 overlay, so a popover portaled out of
// them at the top of the normal scale (L4 = z-100) still lands BEHIND its own
// host. This is the single source of truth for the 9001 value FolderSwitcher
// already hand-rolled; keep it 1 above the 9000 host tier so a spawned popover
// always clears its host without re-magic-numbering at each call site.
export const POPOVER_Z = 9001;

// Hint tier: Tooltip and AnchorTip bubbles. WHY above everything, including
// the 9000–9999 exception band: a hint is anchored to the control under the
// pointer, so that control is already on top — yet at L4 (z-100) a hint opened
// inside the session menu, model picker or ⋯ menu drew BEHIND its own menu
// (Destin, 2026-09-27: "tooltips get stuck behind other surfaces"). Safe at the
// very top because hover hints are pointer-events-none and close on leave.
export const TOOLTIP_Z = 10000;

// ── Stacking: a popup opened over another popup ──────────────────────────────
// WHY (final-review#CT-8, Destin: "these popups are stacking with no blur, which looks a bit
// cluttered. all other popups blur what's behind them"): two popups on the SAME layer used the
// same two numbers, so the first popup's panel (CONTENT_Z, 61) sat ABOVE the second popup's scrim
// (SCRIM_Z, 60) — the second popup's blur and dim covered the app but not the popup it came from.
// Every scrim now takes a depth: 0 for the first one open, then one more for each scrim opened
// while others are up, and lifts its scrim (and the Dialog its panel) 2 per depth. Capped at 4
// so a depth never reaches the next layer's numbers (L2's 61 + 8 = 69 < L3's scrim at 70).
const MAX_STACK_DEPTH = 4;
const openDepths = new Set<number>();

/** This overlay's depth among the scrims open now (0 = nothing under it). */
export function useOverlayDepth(active: boolean): number {
  const [depth, setDepth] = useState(0);
  // Layout effect, so the lifted numbers land before the first paint (no flash under the
  // popup beneath). Takes the first depth above every one in use; gives it back on close.
  useLayoutEffect(() => {
    if (!active) return;
    let d = 0;
    for (const used of openDepths) d = Math.max(d, used + 1);
    d = Math.min(d, MAX_STACK_DEPTH);
    openDepths.add(d);
    setDepth(d);
    return () => { openDepths.delete(d); };
  }, [active]);
  return depth;
}

/** The z-index lift for an overlay `depth` popups deep. */
export const stackLift = (depth: number) => depth * 2;

type ScrimProps = {
  layer: OverlayLayer;
  /** The depth a caller already took with useOverlayDepth (Dialog does, to lift its panel by
   *  the same amount). Without it the scrim takes its own. */
  depth?: number;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

export function Scrim({ layer, depth, onClick, className = '', style, children }: ScrimProps) {
  // A scrim with no depth from its caller registers its own, so a Dialog opened over it counts it.
  const own = useOverlayDepth(depth === undefined);
  const d = depth ?? own;
  return (
    <div
      className={`layer-scrim ${className}`.trim()}
      data-layer={layer}
      style={{ zIndex: SCRIM_Z[layer] + stackLift(d), ...style }}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

type OverlayPanelProps = {
  layer: OverlayLayer;
  destructive?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
  children?: React.ReactNode;
  role?: string;
  /** Needed by `Tooltip`, whose bubble is the target of the control's
   *  `aria-describedby`. Already reaches the div through `...rest`. */
  id?: string;
  'aria-modal'?: boolean;
  'aria-labelledby'?: string;
  'aria-label'?: string;
  /** The Toast's live region ("polite"). Declared so the type says what reaches the div —
   *  tests/aria-props.test.ts flags an undeclared aria-* prop on a component. */
  'aria-live'?: 'off' | 'polite' | 'assertive';
};

// Single-element .layer-surface. An earlier split added an inner
// .layer-surface-blur absolutely-positioned child to host backdrop-filter
// on an untransformed element (so Chrome could sample the backdrop through
// centering transforms on the outer). That child stacked above non-positioned
// caller children per CSS painting order (positioned z-index:0 paints above
// non-positioned block descendants) and made every OverlayPanel consumer
// appear blank. Backdrop-filter under a centering transform only matters
// when a wallpaper is active; solve that per-component if/when a specific
// popup needs it, instead of breaking the shared primitive.
export const OverlayPanel = React.forwardRef<HTMLDivElement, OverlayPanelProps>(
  ({ layer, destructive, className = '', style, children, ...rest }, ref) => (
    <div
      ref={ref}
      className={`layer-surface ${className}`.trim()}
      data-layer={layer}
      data-destructive={destructive ? '' : undefined}
      style={{ zIndex: CONTENT_Z[layer], ...style }}
      {...rest}
    >
      {children}
    </div>
  ),
);
OverlayPanel.displayName = 'OverlayPanel';
