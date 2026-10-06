import { useCallback, useEffect, useRef } from 'react';

/**
 * After the USER switches session in chat view, the message box takes focus, so typing right
 * after a switch lands in it. WHY (2026-10-05, owner: "the message box should take focus"):
 * after a click on a session pill, focus stays on the pill button, and the app's
 * type-anywhere-to-focus handler deliberately ignores keys aimed at a focused button, so the
 * first words typed after a switch went nowhere.
 *
 * Which switches count is decided by the strip (SessionStrip.onSelectSession → `markPointerSwitch`):
 * a pointer press, a click or menu click with a real pointer (event.detail > 0), a drop, and the
 * Shift-hold switcher's release. NOT Enter/Space on a focused pill or menu row (detail 0 / a key
 * event): those users navigate by keyboard and moving focus off the control would break their Tab
 * order. Automatic switches (session created/closed elsewhere, a phone, the buddy) never go through
 * the strip's callback, so they never count either.
 *
 * A pill PRESS selects on pointerdown, before we know whether the hand is starting a drag to
 * reorder. So when the pointer is still down we wait for its release and skip if the strip said a
 * drag started (`noteStripDrag`). The composer's own `focusAfterSwitch` decides whether focus may
 * move at all (touch, narrow screen, dialogs, someone typing elsewhere, a disabled box).
 */
const INTENT_MS = 1500;
let markedAt = -Infinity;
let pressed = false;
let dragged = false;
const releaseWaiters = new Set<() => void>();
let listening = false;

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('pointerdown', () => { pressed = true; dragged = false; }, true);
  const up = () => { pressed = false; const w = [...releaseWaiters]; releaseWaiters.clear(); w.forEach((f) => f()); };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
}

/** The strip: this switch was made with a pointer (or the Shift-hold switcher). */
export function markPointerSwitch(): void { listen(); markedAt = Date.now(); }
/** The strip: the pill under the pointer started a drag — do not focus the composer for this press. */
export function noteStripDrag(): void { dragged = true; }

export function useFocusComposerAfterSwitch(
  sessionId: string | null,
  viewMode: 'chat' | 'terminal',
  focusComposer: () => void,
): (id: string) => void {
  const pending = useRef<{ id: string; at: number } | null>(null);
  const noteUserSwitch = useCallback((id: string) => {
    // Only a switch the strip marked as pointer-made; the mark is single use.
    if (Date.now() - markedAt > INTENT_MS) return;
    markedAt = -Infinity;
    pending.current = { id, at: Date.now() };
  }, []);
  const focusRef = useRef(focusComposer);
  focusRef.current = focusComposer;
  useEffect(() => {
    const p = pending.current;
    if (!p || p.id !== sessionId) return;
    pending.current = null;
    if (Date.now() - p.at > INTENT_MS || viewMode !== 'chat') return; // terminal view focuses its own terminal
    let raf = 0;
    let cancelled = false;
    const go = () => { raf = requestAnimationFrame(() => { if (!cancelled && !dragged) focusRef.current(); }); };
    // One frame later: the pill takes focus as the press finishes, after this commit.
    if (pressed) releaseWaiters.add(go); else go();
    return () => { cancelled = true; releaseWaiters.delete(go); cancelAnimationFrame(raf); };
  }, [sessionId, viewMode]);
  return noteUserSwitch;
}
