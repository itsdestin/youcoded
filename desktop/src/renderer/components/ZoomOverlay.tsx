import { OverlayPanel } from './overlays/Overlay';
import { Tooltip } from './ui';

/**
 * Floating zoom overlay — appears when user zooms in/out via Ctrl+/- or pinch,
 * shows the current zoom percentage with +/- buttons, auto-hides after 1.5s of
 * inactivity.
 *
 * L4 System (change 29), raised from a hardcoded z-50. A zoom readout is an
 * always-visible indicator, so it has to clear the L2 popups (z-61) it can be
 * triggered over — at z-50 it was painting UNDER them.
 */

interface ZoomOverlayProps {
  /** Current zoom percentage (100 = default) */
  zoomPercent: number;
  /** Whether the overlay is visible */
  visible: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

export function ZoomOverlay({ zoomPercent, visible, onZoomIn, onZoomOut, onZoomReset }: ZoomOverlayProps) {
  if (!visible) return null;

  return (
    <OverlayPanel
      layer={4}
      className="fixed top-16 right-4 text-sm text-fg"
      style={{ borderRadius: 'var(--radius-lg)' }}
    >
    {/* Padding + the wheel guard live on this inner div because OverlayPanel's
        typed props don't include onWheel — same reason ContextMenu keeps its
        onKeyDown on an inner div. The inner div must carry the padding too, or
        the guard wouldn't cover the panel's own gutter. */}
    <div
      className="flex items-center gap-2 px-3 py-2"
      // Prevent zoom gestures on the overlay itself from bubbling
      onWheel={(e) => e.stopPropagation()}
    >
      <Tooltip text="Zoom out (Ctrl+−)">
        <button
          onClick={onZoomOut}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-well
                     text-fg-dim hover:text-fg transition-colors"
        >
          −
        </button>
      </Tooltip>

      {/* Clickable percentage label — resets to 100% */}
      <Tooltip text="Reset zoom (Ctrl+0)">
        <button
          onClick={onZoomReset}
          className="min-w-[3.5rem] text-center font-medium tabular-nums
                     hover:text-accent transition-colors cursor-pointer"
        >
          {zoomPercent}%
        </button>
      </Tooltip>

      <Tooltip text="Zoom in (Ctrl++)">
        <button
          onClick={onZoomIn}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-well
                     text-fg-dim hover:text-fg transition-colors"
        >
          +
        </button>
      </Tooltip>
    </div>
    </OverlayPanel>
  );
}
