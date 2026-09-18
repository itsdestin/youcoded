// True for one animation window after `key` changes — and never on mount.
//
// Two callers, one shape:
//   • SessionStrip arms the pill label transitions when the active session id
//     changes (they are otherwise switched off, so repack churn stays still).
//   • ChatView animates the incoming conversation when its pane becomes the
//     active session.
//
// WHY never on mount: at app start the active session's pill and pane render
// immediately. Firing there would make every cold launch look like a session
// switch that never happened.
//
// WHY the window opens DURING RENDER, not in an effect (2026-09-01 rebuild):
// the first version set `open` from useEffect, which runs after the browser
// has already painted the new state once. For a session switch that meant one
// frame of the incoming conversation fully visible, then the fade-in starting
// from invisible — a flash — whenever the switch was not driven by a click
// (React only flushes effects before paint for discrete input events). Setting
// state while rendering is React's documented pattern for state derived from a
// changed prop: React discards this render and re-runs it immediately with the
// new state, so the FIRST committed frame already carries the window.
//
// WHY no direction option: the hook opens on ANY change of `key`, both ways. A
// caller that wants one direction ANDs in the state it cares about —
// `useOneShotWindow(sessionActive) && sessionActive` is true only on the way
// IN, because on the way OUT the window opens while `sessionActive` is false.
import { useEffect, useState } from 'react';

/** The default window if the stylesheet cannot be read (jsdom, a missing token):
 *  today's --dur-switch (380ms) plus the slack below. */
export const MOTION_WINDOW_FALLBACK_MS = 500;
/** WHY slack: the clock starts when React commits, the animation when the
 *  browser first PAINTS — and a session switch's first paint is a heavy one.
 *  Leaving the class on after a one-iteration animation has ended costs nothing;
 *  taking it off early cancels the animation mid-air. */
const MOTION_WINDOW_SLACK_MS = 120;

let defaultWindowMs: number | null = null;

/** The default window, read ONCE off the stylesheet's `--dur-switch`.
 *
 *  WHY not a number: this was `240`, written for a 240ms switch. The vocabulary
 *  picked on 2026-09-02 made the switch 380ms, nothing tied the two together,
 *  and from then on ChatView pulled `.switch-arrival` off at 63% — the curve is
 *  past its destination at that moment, so the conversation snapped ~1px and the
 *  settle Destin chose was never seen. SessionStrip had the same defect and
 *  fixed it the same way (motionWindowMs). Read once because the tokens sit in
 *  a theme-independent `:root` (pinned by animation-frame-budget.test.ts), and
 *  ChatView re-renders per streamed word. */
export function defaultMotionWindowMs(): number {
  if (defaultWindowMs != null) return defaultWindowMs;
  let ms = NaN;
  if (typeof document !== 'undefined') {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--dur-switch').trim();
    const n = parseFloat(v);
    ms = v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : NaN;
  }
  defaultWindowMs = Number.isFinite(ms) && ms > 0 ? Math.round(ms + MOTION_WINDOW_SLACK_MS) : MOTION_WINDOW_FALLBACK_MS;
  return defaultWindowMs;
}

/** Test seam: forget the cached read. */
export function resetDefaultMotionWindowForTests(): void { defaultWindowMs = null; }

interface Window { key: unknown; open: boolean; gen: number }

export function useOneShotWindow(key: unknown, durationMs = defaultMotionWindowMs()): boolean {
  const [win, setWin] = useState<Window>({ key, open: false, gen: 0 });

  // Derived state: the key moved since the last render, so open a fresh window
  // (a new `gen`, which is what restarts the clock below on back-to-back changes).
  if (win.key !== key) setWin({ key, open: true, gen: win.gen + 1 });

  useEffect(() => {
    if (!win.open) return;
    const t = setTimeout(() => setWin(w => (w.gen === win.gen ? { ...w, open: false } : w)), durationMs);
    return () => clearTimeout(t);
  }, [win.open, win.gen, durationMs]);

  return win.open;
}
