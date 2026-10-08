// The dev window's name on the welcome screen (dev windows only: run-dev.sh --label → preload's devLabel, which is
// null in the built app). The status bar already names a dev window, but it only appears once a session is open —
// with several dev windows up and no session (page or settings work), they could not be told apart (Destin, 2026-10-08).
import React from 'react';

export function DevWindowLabel() {
  const label = window.claude?.devLabel;
  if (!label) return null;
  return (
    <span className="text-xs text-fg-2 px-2.5 py-0.5 rounded-sm border border-edge-dim bg-inset select-none" data-dev-window-label>
      Dev window · <span className="text-fg font-medium">{label}</span>
    </span>
  );
}
