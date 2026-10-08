import { useCallback, useEffect, useRef } from 'react';

/**
 * After the USER switches session with a pointer (pill press/click, All Sessions row, drop) in chat view, the
 * message box takes focus, so typing right after lands in it (owner, 2026-10-05). Before, focus stayed on the pill
 * button, which the type-anywhere handler ignores. The strip says which switches count (`markPointerSwitch`):
 * not Enter/Space activation, not the Shift-hold switcher, and automatic switches never reach the strip.
 * Known edge: after a mouse switch the box holds focus, so the Shift-hold switcher refuses until it blurs (the
 * composer's idle blur, about 3/4 s after the last key). InputBar.focusAfterSwitch decides whether focus may move.
 */
const INTENT_MS = 1500;
let markedAt = -Infinity;
export function markPointerSwitch(): void { markedAt = Date.now(); }

export function useFocusComposerAfterSwitch(
  sessionId: string | null,
  viewMode: 'chat' | 'terminal',
  focusComposer: () => void,
): (id: string) => void {
  const pending = useRef<string | null>(null);
  const noteUserSwitch = useCallback((id: string) => {
    if (Date.now() - markedAt > INTENT_MS) return;
    markedAt = -Infinity; // single use
    pending.current = id;
  }, []);
  const focusRef = useRef(focusComposer);
  focusRef.current = focusComposer;
  useEffect(() => {
    if (pending.current !== sessionId) return;
    pending.current = null;
    if (viewMode !== 'chat') return; // terminal view focuses its own terminal
    // One frame later: the pill takes focus as the press finishes, after this commit.
    const raf = requestAnimationFrame(() => focusRef.current());
    return () => cancelAnimationFrame(raf);
  }, [sessionId, viewMode]);
  return noteUserSwitch;
}
