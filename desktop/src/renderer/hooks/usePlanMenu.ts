import { useEffect, useRef, useState } from 'react';
import { parsePlanMenu, type PlanMenuRead } from '../parser/plan-menu-parser';
import { getVisibleScreenText, onBufferReady } from './terminal-registry';

/** How often to re-read even without terminal output — the card's
 *  "can't read the options" fallback is time-based, and a static screen
 *  produces no buffer-ready events at all. */
const REREAD_MS = 500;

function keyOf(r: PlanMenuRead): string {
  return r.status === 'ready'
    ? `ready|${r.menu.signature}|${r.menu.selectedNumber}|${r.menu.feedbackDraft}`
    : r.status === 'unreadable' ? `unreadable|${r.reason}` : 'absent';
}

/**
 * The plan-approval menu as it currently appears in this session's terminal.
 *
 * Reads the SAME xterm buffer the prompt detector reads (terminal-registry), so
 * it works wherever the session's terminal is mounted: desktop, Android's
 * WebView and a remote browser all mount one per Claude Code session from the
 * moment it starts (SessionTerminal.tsx). Re-renders only when what the card
 * would draw changes — not on every buffer flush.
 */
export function usePlanMenu(sessionId: string): PlanMenuRead {
  const [read, setRead] = useState<PlanMenuRead>(() => parsePlanMenu(getVisibleScreenText(sessionId)));
  const keyRef = useRef(keyOf(read));

  useEffect(() => {
    const check = () => {
      const next = parsePlanMenu(getVisibleScreenText(sessionId));
      const k = keyOf(next);
      if (k !== keyRef.current) {
        keyRef.current = k;
        setRead(next);
      }
    };
    check();
    const unsub = onBufferReady((sid) => { if (sid === sessionId) check(); });
    const timer = setInterval(check, REREAD_MS);
    return () => { unsub(); clearInterval(timer); };
  }, [sessionId]);

  return read;
}

/** Resolve on this session's next terminal update, or after `ms`. */
export function nextTerminalUpdate(sessionId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    // WHY `armed`: onBufferReady fires a catch-up call for every terminal right
    // after subscribing (terminal-registry.ts). Counting that as "the screen
    // changed" would make every wait return at once and the driver's poll loop
    // spin (microtask-only waits would also starve the terminal's own writes).
    // Subscribe FIRST, then queue the arming: the catch-up microtask is queued
    // by the subscribe call, so it runs before `armed` flips and is ignored.
    let armed = false;
    const finish = () => { if (done) return; done = true; unsub(); clearTimeout(timer); resolve(); };
    const unsub = onBufferReady((sid) => { if (armed && sid === sessionId) finish(); });
    queueMicrotask(() => { armed = true; });
    const timer = setTimeout(finish, ms);
  });
}
