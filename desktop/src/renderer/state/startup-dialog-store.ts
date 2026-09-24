// startup-dialog-store.ts — per session: is Claude Code, while the session is
// still starting, showing a dialog that YouCoded cannot turn into buttons?
//
// WHY a store: usePromptDetector (which reads the terminal) sets it; the
// "Initializing session…" screen in App reads it, so that screen can say
// "Claude Code is asking something — answer it in terminal view" the moment
// the dialog appears, instead of a silent hang and a vague hint six seconds
// later. A tiny useSyncExternalStore store, per performance.md rule 3: only the
// one screen that shows it subscribes, and only to its own session.

import { useCallback, useSyncExternalStore } from 'react';

export interface UnreadableStartupDialog {
  /** The dialog's own first line, as Claude Code printed it ('' when none). */
  heading: string;
}

const current = new Map<string, UnreadableStartupDialog>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  for (const l of listeners.get(sessionId) ?? []) l();
}

export function setUnreadableStartupDialog(sessionId: string, dialog: UnreadableStartupDialog | null): void {
  const prev = current.get(sessionId);
  if (!dialog) {
    if (!prev) return;
    current.delete(sessionId);
  } else {
    if (prev && prev.heading === dialog.heading) return;
    current.set(sessionId, dialog);
  }
  notify(sessionId);
}

export function getUnreadableStartupDialog(sessionId: string): UnreadableStartupDialog | null {
  return current.get(sessionId) ?? null;
}

export function useUnreadableStartupDialog(sessionId: string | null): UnreadableStartupDialog | null {
  const subscribe = useCallback((cb: () => void) => {
    if (!sessionId) return () => {};
    let set = listeners.get(sessionId);
    if (!set) { set = new Set(); listeners.set(sessionId, set); }
    set.add(cb);
    return () => { set!.delete(cb); if (!set!.size) listeners.delete(sessionId); };
  }, [sessionId]);
  const get = useCallback(() => (sessionId ? current.get(sessionId) ?? null : null), [sessionId]);
  return useSyncExternalStore(subscribe, get);
}
