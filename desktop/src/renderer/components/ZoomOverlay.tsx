import React, { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Floating zoom overlay — appears when user zooms in/out via Ctrl+/- or pinch,
 * shows the current zoom percentage with +/- buttons, auto-hides after 1.5s of
 * inactivity. Matches the app's semantic token palette (bg-panel, border-edge, etc.).
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
    <div
      className="fixed top-16 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-lg
                 bg-panel border border-edge text-sm text-fg shadow-lg"
      // Prevent zoom gestures on the overlay itself from bubbling
      onWheel={(e) => e.stopPropagation()}
    >
      <button
        onClick={onZoomOut}
        className="w-7 h-7 flex items-center justify-center rounded hover:bg-well
                   text-fg-dim hover:text-fg transition-colors"
        title="Zoom out (Ctrl+−)"
      >
        −
      </button>

      {/* Clickable percentage label — resets to 100% */}
      <button
        onClick={onZoomReset}
        className="min-w-[3.5rem] text-center font-medium tabular-nums
                   hover:text-accent transition-colors cursor-pointer"
        title="Reset zoom (Ctrl+0)"
      >
        {zoomPercent}%
      </button>

      <button
        onClick={onZoomIn}
        className="w-7 h-7 flex items-center justify-center rounded hover:bg-well
                   text-fg-dim hover:text-fg transition-colors"
        title="Zoom in (Ctrl++)"
      >
        +
      </button>
    </div>
  );
}
