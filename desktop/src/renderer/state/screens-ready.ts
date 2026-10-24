// screens-ready.ts — whether the app's rarely used screens may load their code now (2026-10-22 phone speed).
//
// WHY: Settings, the conversation browser, Projects, Pages, the Marketplace, the Library and the games were in the code a
// phone downloads and runs before it shows anything. They now load on their own (components/deferred-screen.tsx): when
// opened, and ahead of that once this says so — on a phone, after its conversation is drawn (remote-shim reportFill), so
// they never compete with it; on the computer and the Android app, at once (their code is on disk).
import { useSyncExternalStore } from 'react';

let ready = false;
const listeners = new Set<() => void>();

/** From now on the deferred screens may load. Idempotent. */
export function markScreensReady(): void {
  if (ready) return;
  ready = true;
  for (const listener of [...listeners]) listener();
}

export function useScreensReady(): boolean {
  return useSyncExternalStore(
    (onChange) => { listeners.add(onChange); return () => { listeners.delete(onChange); }; },
    () => ready,
  );
}
