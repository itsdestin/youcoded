import React from 'react';

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

// Hover hints (`ui/Tooltip`). WHY above the popover tier rather than at L4: a hint
// describes the control under the pointer, wherever that control lives — and the
// busiest hint hosts ARE popovers. At L4 (z-100) every hint inside a POPOVER_Z panel
// opened BEHIND it: the model list's favourite star and its value / intelligence
// tags showed nothing, or a sliver past the panel's edge (found 2026-09-11 building
// the model-list tags). A hint is pointer-events-none, so sitting above everything
// can never swallow a click.
export const TOOLTIP_Z = POPOVER_Z + 2;

type ScrimProps = {
  layer: OverlayLayer;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

export function Scrim({ layer, onClick, className = '', style, children }: ScrimProps) {
  return (
    <div
      className={`layer-scrim ${className}`.trim()}
      data-layer={layer}
      style={{ zIndex: SCRIM_Z[layer], ...style }}
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
