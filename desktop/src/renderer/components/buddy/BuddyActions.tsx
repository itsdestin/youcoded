import { useCallback, useRef, useState } from 'react';
import { Tooltip } from '../ui/Tooltip';
import { ContextMenu } from '../context-menu/ContextMenu';
import type { MenuEntry } from '../context-menu/build-menu';

/**
 * The buddy's actions — screenshot the desktop into the chat, a bigger or smaller chat window, open the main window,
 * hide the buddy until restart — drawn INSIDE the chat window (buddy rebuild, 2026-10-25). Where they sit is
 * buddy-rebuild-review#C-1's open question ("i want to see more options"), so every placement is built from these
 * same pieces: icon buttons, one "⋯" menu, or a row of labelled buttons. Same calls as the round buttons beside the
 * mascot (BuddyBarApp).
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
/** A window with an arrow leaving it: "open the app". Not the diagonal arrows, which mean the size below. */
export function OpenIcon() {
  return (
    <svg {...ICON}>
      <rect x="3" y="4" width="14" height="14" rx="2" /><path d="M3 8h14M14 3h7v7M21 3l-8 8" />
    </svg>
  );
}
export function SizeIcon() {
  return <svg {...ICON}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>;
}
export function HideIcon() {
  return (
    <svg {...ICON}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
function MoreIcon() {
  return <svg {...ICON}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>;
}

/** The four calls, in one place. `large` is the chat's current size, so the size action can say which way it goes. */
export function useBuddyActions(large: boolean, onToggleSize: () => void) {
  const [busy, setBusy] = useState(false);
  const capture = useCallback(() => {
    if (busy) return;
    setBusy(true);
    // Held ~150ms so the press is visibly acknowledged while main hides the windows to take the picture.
    void Promise.resolve(window.claude?.buddy?.captureDesktop?.()).finally(() => setTimeout(() => setBusy(false), 150));
  }, [busy]);
  return {
    busy,
    capture,
    toggleSize: onToggleSize,
    sizeLabel: large ? 'Smaller window' : 'Bigger window',
    openMain: () => { void window.claude?.buddy?.openMain?.(); },
    hide: () => { void window.claude?.buddy?.dismiss?.(); },
  };
}
export type BuddyActionSet = ReturnType<typeof useBuddyActions>;

const ICON_BTN = 'shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-fg-dim hover:text-fg hover:bg-inset transition-colors disabled:opacity-40';

function IconButton({ label, onClick, disabled, children, className = ICON_BTN }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <Tooltip text={label}>
      <button type="button" aria-label={label} className={className} disabled={disabled} onClick={onClick}>{children}</button>
    </Tooltip>
  );
}

export function CaptureButton({ a, className }: { a: BuddyActionSet; className?: string }) {
  return <IconButton label="Screenshot your desktop into the chat" onClick={a.capture} disabled={a.busy} className={className}><CameraIcon /></IconButton>;
}
export function SizeButton({ a }: { a: BuddyActionSet }) {
  return <IconButton label={a.sizeLabel} onClick={a.toggleSize}><SizeIcon /></IconButton>;
}
export function OpenMainButton({ a }: { a: BuddyActionSet }) {
  return <IconButton label="Open YouCoded" onClick={a.openMain}><OpenIcon /></IconButton>;
}
export function HideBuddyButton({ a }: { a: BuddyActionSet }) {
  return <IconButton label="Hide the buddy until restart" onClick={a.hide}><HideIcon /></IconButton>;
}

/** The menu rows, for the "⋯" button and for a right-click on the buddy. `without` leaves out what is already on screen. */
export function buddyMenuEntries(a: BuddyActionSet, without: ReadonlyArray<'capture'> = []): MenuEntry[] {
  const rows: MenuEntry[] = [];
  if (!without.includes('capture')) rows.push({ type: 'item', id: 'capture', label: 'Screenshot desktop', icon: 'camera', disabled: a.busy, run: a.capture });
  rows.push(
    { type: 'item', id: 'size', label: a.sizeLabel, icon: 'resize', run: a.toggleSize },
    { type: 'item', id: 'open', label: 'Open YouCoded', icon: 'open', run: a.openMain },
    { type: 'sep' },
    { type: 'item', id: 'hide', label: 'Hide buddy until restart', icon: 'hide', run: a.hide },
  );
  return rows;
}

/** One "⋯" button holding every action. */
export function MoreMenuButton({ a, without }: { a: BuddyActionSet; without?: ReadonlyArray<'capture'> }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right - 4, y: r.bottom + 4 });
  }, []);
  return (
    // The ref sits on a wrapper: Tooltip owns its child's ref.
    <span ref={ref} className="inline-flex">
      <Tooltip text="More">
        <button type="button" aria-label="More" className={ICON_BTN} onClick={open}><MoreIcon /></button>
      </Tooltip>
      {/* anchor: only a scroll that moves the button closes the menu — not the chat scrolling under it as a reply streams. */}
      {at && <ContextMenu x={at.x} y={at.y} anchor={ref.current ?? undefined} entries={buddyMenuEntries(a, without)} onClose={() => setAt(null)} />}
    </span>
  );
}

/** A thin row of labelled buttons under the message box. */
export function ActionsToolbar({ a }: { a: BuddyActionSet }) {
  const btn = 'inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 rounded-md text-2xs text-fg-dim hover:text-fg hover:bg-inset transition-colors disabled:opacity-40';
  return (
    <div className="buddy-actions-toolbar flex items-center justify-between gap-1 px-1 pt-1">
      <button type="button" className={btn} disabled={a.busy} onClick={a.capture}><CameraIcon />Screenshot</button>
      <button type="button" className={btn} onClick={a.toggleSize}><SizeIcon />{a.sizeLabel.replace(' window', '')}</button>
      <button type="button" className={btn} onClick={a.openMain}><OpenIcon />Open app</button>
      <button type="button" className={btn} onClick={a.hide}><HideIcon />Hide</button>
    </div>
  );
}
