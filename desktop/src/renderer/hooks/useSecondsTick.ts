import { useSyncExternalStore } from 'react';

// One clock for every on-screen seconds counter (simplification audit W19).
//
// WHY: every running tool card, helper status line, stall banner, compacting
// card and model-loading bar owned its own 1 s setInterval and re-rendered on
// its own phase — five tools and two helpers was seven unsynchronised renders a
// second, and every one of them kept ticking while the window was hidden. This
// is the BrailleSpinner driver's pattern: a module-level interval that exists
// only while at least one subscriber is mounted, feeding a useSyncExternalStore
// snapshot. On top of that it PAUSES while `document.hidden` and resumes with
// an immediate tick on `visibilitychange`, so a minimised app does no work.
//
// The snapshot is the current time in ms, not a tick count: consumers derive
// elapsed time from their own start timestamp, so a pause loses nothing —
// the number is right the moment the window is back.

let now = Date.now();
let timerId: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick(): void {
  now = Date.now();
  listeners.forEach((cb) => cb());
}

function start(): void {
  if (timerId === null && !document.hidden) timerId = setInterval(tick, 1000);
}

function stop(): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

function onVisibilityChange(): void {
  if (document.hidden) {
    stop();
  } else if (listeners.size > 0) {
    tick(); // catch the counters up at once rather than after a further second
    start();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    // The first subscriber after an idle spell must not read a stale clock:
    // refresh it here, and React re-checks the snapshot right after subscribing.
    now = Date.now();
    document.addEventListener('visibilitychange', onVisibilityChange);
    start();
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}

const subscribeNever = () => () => {};
const getNow = () => now;

/**
 * The shared clock's current time in ms, refreshed once a second while
 * `active` — pass the component's own "still counting" condition so a
 * finished card unsubscribes. Inactive callers get the last reading and never
 * re-render for it; they should be reading their own end timestamp instead.
 */
export function useSecondsTick(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : subscribeNever, getNow, getNow);
}
