// desktop/src/renderer/state/dev-tools-store.ts
//
// Developer tools: the Settings → Development "Developer tools" switch, and which
// sessions are currently shown in X-ray.
//
// WHY a tiny external store and not App state or a Context (performance.md rule 3):
// the header button, App's chat pane and the settings row each read one boolean,
// and none of them may redraw the shell when another session flips. Each reader
// subscribes to its own slice through useSyncExternalStore.
//
// WHY the switch is per device (localStorage) and X-ray is per session in memory
// (Destin's deck, 2026-10-04, Q-xray-switch "unlock once, button per session"):
// developer tools are a property of the person at this computer, while X-ray is
// a look at one conversation that should not survive a restart and surprise him
// with a raw view the next morning.
import { useSyncExternalStore } from 'react';

const ENABLED_KEY = 'youcoded-developer-tools';

function readEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

let enabled = readEnabled();
let xraySessions: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit() { for (const l of listeners) l(); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function setDeveloperToolsEnabled(next: boolean) {
  if (next === enabled) return;
  enabled = next;
  try { localStorage.setItem(ENABLED_KEY, next ? '1' : '0'); } catch { /* private mode */ }
  // Turning developer tools off returns every session to normal chat, so no
  // conversation is left in a view whose button has just disappeared.
  if (!next && xraySessions.size > 0) xraySessions = new Set();
  emit();
}

export function setXray(sessionId: string, on: boolean) {
  if (xraySessions.has(sessionId) === on) return;
  const nextSet = new Set(xraySessions);
  if (on) nextSet.add(sessionId); else nextSet.delete(sessionId);
  xraySessions = nextSet;
  emit();
}

export function useDeveloperToolsEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => false);
}

/** True when THIS session is in X-ray. A boolean snapshot, so a flip on another
 *  session does not redraw this reader. */
export function useXray(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => enabled && !!sessionId && xraySessions.has(sessionId),
    () => false,
  );
}
