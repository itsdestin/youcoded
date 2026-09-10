// src/renderer/components/guide/guide-events.ts
//
// "Close whatever dialog you have open" — the one thing the tour needs from
// the settings drawer's dialogs (Assistant settings, Appearance, Help) that
// their props cannot express: each keeps its own `open` state and nothing
// above it can close it. Threading a reset prop through SettingsPanel and
// DesktopSettings to three rows was the alternative; a window event that each
// dialog listens for is two lines per dialog and no plumbing.
//
// WHY a DOM event and not the tips' external store: nobody reads this state,
// it is a moment, not a value.
import { useEffect } from 'react';

const RESET_EVENT = 'youcoded:guide-reset';

/** The tour is moving to another screen: every listening dialog closes. */
export function requestGuideReset(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RESET_EVENT));
}

/** A dialog with its own `open` state registers its close here. */
export function useGuideReset(close: () => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener(RESET_EVENT, close);
    return () => window.removeEventListener(RESET_EVENT, close);
  }, [close]);
}
