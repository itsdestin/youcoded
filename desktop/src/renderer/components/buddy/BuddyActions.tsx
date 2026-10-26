import { useCallback, useState } from 'react';
import { Tooltip } from '../ui/Tooltip';

/**
 * The buddy's three actions — screenshot the desktop into the chat, open the main window, hide the buddy until restart —
 * drawn as small icon buttons INSIDE the chat window (buddy rebuild, 2026-10-25; buddy-rebuild-questions#Q-5 asked to
 * see the placements as pictures). Same three calls the round buttons beside the mascot make (BuddyBarApp).
 */
const ICON = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
} as const;

export function CameraIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}
function OpenIcon() {
  return (
    <svg {...ICON}>
      <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}
function HideIcon() {
  return (
    <svg {...ICON}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

/** Screenshot with a short pressed hold, so a click is visibly acknowledged while main hides the windows to capture. */
export function useCaptureDesktop(): [() => void, boolean] {
  const [busy, setBusy] = useState(false);
  const capture = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve(window.claude?.buddy?.captureDesktop?.()).finally(() => setTimeout(() => setBusy(false), 150));
  }, [busy]);
  return [capture, busy];
}

const BTN = 'shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-fg-dim hover:text-fg hover:bg-inset transition-colors disabled:opacity-40';

export function CaptureButton({ className = BTN }: { className?: string }) {
  const [capture, busy] = useCaptureDesktop();
  return (
    <Tooltip text="Screenshot your desktop into the chat">
      <button type="button" aria-label="Screenshot desktop" className={className} disabled={busy} onClick={capture}>
        <CameraIcon />
      </button>
    </Tooltip>
  );
}

export function OpenMainButton() {
  return (
    <Tooltip text="Open YouCoded">
      <button type="button" aria-label="Open YouCoded" className={BTN} onClick={() => { void window.claude?.buddy?.openMain?.(); }}>
        <OpenIcon />
      </button>
    </Tooltip>
  );
}

export function HideBuddyButton() {
  return (
    <Tooltip text="Hide the buddy until restart">
      <button type="button" aria-label="Hide buddy until restart" className={BTN} onClick={() => { void window.claude?.buddy?.dismiss?.(); }}>
        <HideIcon />
      </button>
    </Tooltip>
  );
}
