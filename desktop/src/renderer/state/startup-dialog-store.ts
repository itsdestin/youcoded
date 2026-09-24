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

/** The promptId Android's ManagedSession broadcasts (shown then dismissed at
 *  once) when Claude Code runs its first hook — Android's "session started". */
const ANDROID_SESSION_READY_PROMPT_ID = '_session_ready';

/**
 * Does this prompt:show mean the session has STARTED? Only Android's explicit
 * ready signal does. WHY (review F1, 2026-09-24): App used to count ANY
 * prompt:show as "started" — so the trust card itself switched the startup
 * safety net off and enabled the chat box while a multi-select MCP dialog was
 * live, and typed text went into the dialog.
 */
export function promptShowMeansStarted(promptId: string): boolean {
  return promptId === ANDROID_SESSION_READY_PROMPT_ID;
}

/**
 * Is the message box (and, on touch, the terminal key row) switched off?
 *
 * Chat view: until the session has started — a message typed then would land
 * in a startup dialog. Terminal view on a touch device (phone, remote browser):
 * that box IS the terminal's keyboard — its Send types Enter into whatever
 * Claude Code shows — so it must work BEFORE the session starts, or a startup
 * dialog the chat cannot show ("Answer in terminal view") could only be
 * Esc'd away (second review F2). Desktop terminal view types into xterm
 * directly and was never gated.
 */
export function composerDisabled(s: { trustGate: boolean; moved: boolean; started: boolean; terminalTouch: boolean }): boolean {
  return s.trustGate || s.moved || (!s.started && !s.terminalTouch);
}

/** The ids of listed sessions that have STARTED (host says so, or is too old
 *  to say). A window or phone that connects — or reloads — while a session is
 *  still on its startup dialogs must keep that session's chat gated and its
 *  safety net on; "it was already running" is only true once it has started. */
export function startedIds(list: ReadonlyArray<{ id: string; awaitingStart?: boolean }>): string[] {
  return list.filter((s) => !s.awaitingStart).map((s) => s.id);
}
