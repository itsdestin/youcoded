import React from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';

// Hint copy keyed to spec bands: > 60 plenty, 20–60 getting tight, < 20 very low.
// Thresholds are intentionally coarser than contextColor() — the copy describes
// user intent (when to act), not the indicator color.
function hintFor(pct: number): string {
  if (pct > 60) return 'Plenty of room — no action needed.';
  if (pct >= 20) return 'Getting tight — consider compacting soon.';
  return 'Very low — compact now or Claude may start forgetting earlier context.';
}

// Match the color function in StatusBar.tsx exactly so the popup number tracks the chip.
function contextColor(pct: number): string {
  if (pct < 20) return 'text-[#DD4444]';
  if (pct < 50) return 'text-[#FF9800]';
  return 'text-[#4CAF50]';
}

export interface ContextPopupProps {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  contextPercent: number | null;
  contextTokens: number | null;
  /** Dispatches a slash command through App.tsx's wrapper around dispatchSlashCommand. */
  onDispatch: (input: string) => void;
}

export default function ContextPopup({
  open,
  onClose,
  sessionId,
  contextPercent,
  contextTokens,
  onDispatch,
}: ContextPopupProps) {
  if (!open) return null;

  const pct = contextPercent ?? 0;

  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[320px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <h3 className="text-sm font-semibold text-fg">Context</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-fg-muted hover:text-fg leading-none w-6 h-6 flex items-center justify-center rounded-sm hover:bg-inset"
          >
            ✕
          </button>
        </div>

        {/* Current state */}
        <div className="px-4 py-4 space-y-3">
          <div className="text-center">
            <div className={`text-3xl font-bold ${contextColor(pct)}`}>
              {contextPercent != null ? `${contextPercent}%` : '--'}
            </div>
            {contextTokens != null && (
              <div className="text-xs text-fg-muted mt-1">
                {contextTokens.toLocaleString()} tokens remaining
              </div>
            )}
            {contextPercent != null && (
              <p className="text-xs text-fg-2 mt-2">{hintFor(contextPercent)}</p>
            )}
          </div>
        </div>
      </OverlayPanel>
    </>,
    document.body,
  );
}
