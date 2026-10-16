// Whether this computer has a network connection at all, from the browser's own
// online flag (`navigator.onLine` + the window's online/offline events).
//
// WHY (games-social round 2, deck games-social-1 GS-12 — Destin: "need to have a clear
// difference between the incognito state, pc internet off state, and game server
// broken/unreachable state"): the games panel could only say "Can't reach the game
// server" for both of the last two. The error-message standards forbid naming a cause the
// app has not verified, so "No internet connection" is said ONLY when this flag is false —
// the browser reports no network connection at all, which is a fact the app can read. A
// `true` proves nothing about the internet, so it never produces a message of its own.
//
// Mounted only while the games panel is open, so its two window listeners follow the
// panel (performance rule 2: hidden means idle).
import { useSyncExternalStore } from 'react';
import { workbenchNetworkOffline } from '../workbench-mode';

function subscribe(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

const read = () => !workbenchNetworkOffline() && (typeof navigator === 'undefined' || navigator.onLine !== false);

/** The same answer, read once, with no listener — for a screen that only words a failure it
 *  just met (the ticket, Contribute). WHY not the hook there: those popups stay mounted while
 *  closed, and a hidden surface keeps no window listeners (performance rule 2). */
export const networkOnlineNow = read;

export function useNetworkOnline(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
