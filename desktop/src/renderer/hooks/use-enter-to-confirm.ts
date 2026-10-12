// hooks/use-enter-to-confirm.ts
//
// Enter confirms a popup — the one shared way (close-session-friction proposal 2, approved
// 2026-10-12). The shared popup (`<Dialog onEnter>`) is its caller; nothing else should listen
// for Enter on the window (tests/enter-to-confirm-authority.test.ts).
//
// WHY each rule — every one is a bug the close prompt shipped with a hand-made listener:
// - A focused control keeps its own Enter: a button, tag pill, switch, link, menu item, tab or
//   select already answers Enter itself. The close prompt also heard it, so Enter on a tag
//   closed the session mid-edit, and Enter on its own Close session button fired twice.
// - Typing is never a confirm: Enter in a text box or the note is a newline or the field's own.
// - Only the popup on top: Enter under a stacked popup (the rename popup over the close prompt)
//   belongs to that popup. `isTop` is the Escape stack's answer (useEscClose).
// - An Enter someone already handled (`defaultPrevented`), held down (`repeat`), mid-IME
//   (`isComposing`) or with a modifier is not a confirm.
import { useEffect, useRef } from 'react';
import { isTypingTarget } from '../utils/is-typing-target';

const OWNS_ENTER = 'button, a[href], select, summary, [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], [role="tab"], [role="link"], [contenteditable="true"]';

/** True when this keydown should confirm the popup. Exported for its test. */
export function isConfirmEnter(e: KeyboardEvent): boolean {
  if (e.key !== 'Enter' || e.defaultPrevented || e.repeat || e.isComposing) return false;
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = e.target instanceof Element ? e.target : null;
  if (el && (isTypingTarget(el) || el.closest(OWNS_ENTER))) return false;
  return true;
}

export function useEnterToConfirm(active: boolean, isTop: () => boolean, onEnter: (() => void) | undefined): void {
  // Latest handler without re-subscribing every render (performance rule 5).
  const ref = useRef(onEnter);
  useEffect(() => { ref.current = onEnter; });
  const enabled = active && !!onEnter;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (!isConfirmEnter(e) || !isTop()) return;
      e.preventDefault();
      ref.current?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, isTop]);
}
