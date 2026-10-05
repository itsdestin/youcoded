import { useCallback, useEffect, useRef } from 'react';

/**
 * After the USER switches session in chat view, the message box takes focus, so typing right
 * after a switch lands in it. WHY (2026-10-05, owner: "the message box should take focus"):
 * after a click on a session pill, focus stays on the pill button, and the app's
 * type-anywhere-to-focus handler deliberately ignores keys aimed at a focused button, so the
 * first words typed after a switch went nowhere.
 *
 * Only the strip's own selection (pill, All Sessions row, Shift-hold switcher, drop) calls
 * `noteUserSwitch`; every programmatic change (session created/closed elsewhere, a phone, the
 * buddy) sets the session id directly and never reaches it. The hook only decides WHEN (the
 * switch has committed, the destination is shown in chat view); whether the box may take focus
 * (touch, narrow screen, dialogs, someone typing elsewhere, a disabled box) is the composer's
 * own `focusAfterSwitch` answer.
 */
export function useFocusComposerAfterSwitch(
  sessionId: string | null,
  viewMode: 'chat' | 'terminal',
  focusComposer: () => void,
): (id: string) => void {
  // The id the user just picked and when; stale after a moment, so a later automatic switch to
  // the same session (picking the already-active one changes nothing) cannot inherit it.
  const pending = useRef<{ id: string; at: number } | null>(null);
  const noteUserSwitch = useCallback((id: string) => { pending.current = { id, at: Date.now() }; }, []);
  const focusRef = useRef(focusComposer);
  focusRef.current = focusComposer;
  useEffect(() => {
    const p = pending.current;
    if (!p || p.id !== sessionId) return;
    pending.current = null;
    if (Date.now() - p.at > 1500 || viewMode !== 'chat') return; // terminal view focuses its own terminal
    // One frame later: the pill takes focus as the press finishes, after this commit.
    const raf = requestAnimationFrame(() => focusRef.current());
    return () => cancelAnimationFrame(raf);
  }, [sessionId, viewMode]);
  return noteUserSwitch;
}
