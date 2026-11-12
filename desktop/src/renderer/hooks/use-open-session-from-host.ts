import { useEffect, useRef, useState } from 'react';
import { hasAndroidHost, OPEN_SESSION_NUDGE, takePendingSession } from '../android-local-bridge';

/**
 * Tapping a "needs you" alert on the phone opens that conversation.
 * WHY (2026-11-01 phone test): the alert carried the session id but nothing read it, so a tap only opened the app
 * on whatever was last showing. The phone keeps the id until the page asks (cold start: the page is not loaded
 * yet when the tap arrives); the page asks once at start and again whenever the phone nudges it. The switch waits
 * until the conversation list has it, and is dropped if that conversation no longer exists.
 */
export function useOpenSessionFromHost(sessions: ReadonlyArray<{ id: string }>, open: (sessionId: string) => void): void {
  const wanted = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    if (!hasAndroidHost()) return;
    const pull = () => {
      takePendingSession().then((sid) => { if (sid) { wanted.current = sid; setAsked((n) => n + 1); } }).catch(() => {});
    };
    pull();
    window.addEventListener(OPEN_SESSION_NUDGE, pull);
    return () => window.removeEventListener(OPEN_SESSION_NUDGE, pull);
  }, []);

  useEffect(() => {
    const sid = wanted.current;
    if (!sid || sessions.length === 0) return; // wait for the list
    wanted.current = null;
    if (sessions.some((s) => s.id === sid)) openRef.current(sid);
  }, [sessions, asked]);
}
