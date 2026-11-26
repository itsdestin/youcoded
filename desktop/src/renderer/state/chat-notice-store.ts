// chat-notice-store.ts — the one notice a chat may show in the strip above its message box.
//
// WHY per chat (Destin, waiting-notice deck round 3, K-1/K-3/K-4): a notice about THIS chat
// ("your message was held back", "that can't be done here", "that command didn't run") used
// to be the app-wide floating toast, which followed him into chats it had nothing to do with
// and sat over the messages. Keyed by session, a notice can only ever show in its own chat,
// and switching away and back finds it still there until its reason is gone.
//
// WHY a tiny subscribe/notify store, not React state in App: only the strip of the one chat
// on screen reads it (performance rule 3, subscribe to a slice), and the code that raises a
// notice (send gates, command handlers) has no prop path to the input bar.

import type { SessionChatState } from './chat-types';
import { isTurnBusy } from '../hooks/useStreamingGate';

interface ChatNoticeAction {
  label: string;
  onClick: () => void;
  /** The one filled button, drawn last (rightmost). */
  primary?: boolean;
}

export interface ChatNotice {
  /** What raised it, so the code that knows the reason is gone can clear exactly its own notice. */
  key: string;
  text: string;
  /** warn: held back / can't do it now (amber dot). error: something failed (red dot). */
  tone: 'warn' | 'error';
  /**
   * When it leaves on its own.
   *  resolved — only when the code that raised it says the reason is gone (or you send / Dismiss).
   *  next-action — also on your next typing, send, or chat switch (Destin, K-3).
   */
  leave: 'resolved' | 'next-action';
  /** Buttons after Dismiss, outlined first, the filled main one last (Destin, K-7 note). */
  actions?: ChatNoticeAction[];
  /**
   * Is the reason for this notice still true? (waiting-notice T1, review B3 — "derived, not stored hopes".)
   * The strip asks whenever the chat or its pop-up changes, and takes the notice away the moment this says
   * false — so "Claude Code is waiting on something" disappears by itself once you answer it, instead of
   * waiting for you to find the Dismiss button. A plain function of current state; never a React hook.
   */
  stillTrue?: () => boolean;
  /**
   * Also ask once a second while it is showing in the chat you are looking at — but ONLY on a host that reads
   * the terminal's text itself (the Android app's own runtime), where nothing announces that a pop-up closed
   * (review 2, S1). Everywhere else the published reading already tells us, so no timer runs.
   */
  recheckEverySecond?: boolean;
}

// The three "reason is gone" tests every notice of a kind shares, so each call site states WHAT it waits on in
// one line and cannot get the test subtly different (T2 wires most of these).

/** Still busy: a reply is being written (same test as the Stop button, so the lost-message state cannot trap it). */
export const stillBusy = (getSession: () => SessionChatState | undefined) => (): boolean => {
  const session = getSession();
  return !!session && isTurnBusy(session);
};
/** Still not live: the chat is not running right now (`isLive` is the caller's own "it is running" test). */
export const stillNotLive = (isLive: () => boolean) => (): boolean => !isLive();
/** Still moving: a finish-the-transfer step has not completed (`inProgress` is the caller's own test). */
export const stillTransferring = (inProgress: () => boolean) => (): boolean => inProgress();

const notices = new Map<string, ChatNotice>();
const listeners = new Map<string, Set<() => void>>();
const notify = (id: string) => { for (const listener of listeners.get(id) ?? []) listener(); };

export function getChatNotice(sessionId: string | null | undefined): ChatNotice | undefined {
  return sessionId ? notices.get(sessionId) : undefined;
}

export function subscribeChatNotice(sessionId: string | null | undefined, listener: () => void): () => void {
  if (!sessionId) return () => {};
  let set = listeners.get(sessionId);
  if (!set) { set = new Set(); listeners.set(sessionId, set); }
  set.add(listener);
  return () => { set!.delete(listener); if (set!.size === 0) listeners.delete(sessionId); };
}

/** Chats that were closed in this window: a late answer for one of them must not raise a notice nobody can ever see (review F6). */
const closedChats = new Set<string>();

/**
 * The chat was closed: its notice goes, its red dot goes, and nothing more is accepted for it until it is open again.
 * WHY (review F6): a failure answer that lands after the chat closed used to create a notice and a red-dot entry for an id nobody lists,
 * and that entry then outlived the chat (a resumed chat reuses its id and would have shown the old notice).
 */
export function markChatClosed(sessionId: string): void {
  closedChats.add(sessionId);
  clearChatNotice(sessionId);
  dropUnseenFailure(sessionId);
}

/** These chats are open (App's list of chats): any that were marked closed accept notices again (resume reuses an id). */
export function markChatsOpen(ids: readonly string[]): void {
  for (const id of ids) closedChats.delete(id);
}

/** Shows `notice` in that chat's strip, replacing whatever that chat showed before. */
export function showChatNotice(sessionId: string, notice: ChatNotice): void {
  if (!sessionId || closedChats.has(sessionId)) return;
  const previous = notices.get(sessionId);
  notices.set(sessionId, notice);
  // WHY (review F7): the red dot points at a RED notice. Replacing an error with a warning leaves nothing red behind it, so the dot goes.
  if (previous?.tone === 'error' && notice.tone !== 'error') dropUnseenFailure(sessionId);
  // WHY here (R-elsewhere, owner chose "a red dot on that chat in the list"): a failure raised for a chat nobody is looking at
  // would sit unseen in a strip nobody can see. Marking it here covers every caller with one rule.
  if (notice.tone === 'error' && !isViewed(sessionId)) addUnseenFailure(sessionId);
  notify(sessionId);
}

/**
 * Takes the chat's notice away. With `key`, only if it is still that notice — so a late
 * "reason is gone" for an old notice never removes a newer, different one.
 */
export function clearChatNotice(sessionId: string, key?: string): void {
  const current = notices.get(sessionId);
  if (!current || (key && current.key !== key)) return;
  notices.delete(sessionId);
  // The notice is gone, so there is nothing left for the dot to point at.
  dropUnseenFailure(sessionId);
  notify(sessionId);
}

/**
 * Asks the chat's notice whether its reason still holds; takes it away when not. Called by the strip on chat and
 * pop-up changes. Returns true when it cleared one.
 */
export function recheckChatNotice(sessionId: string): boolean {
  const notice = notices.get(sessionId);
  if (!notice?.stillTrue || notice.stillTrue()) return false;
  clearChatNotice(sessionId, notice.key);
  return true;
}

/** Your next action in this chat (typing, sending, switching away): next-action notices leave. */
export function chatNoticeUserActed(sessionId: string): void {
  if (notices.get(sessionId)?.leave === 'next-action') clearChatNotice(sessionId);
}

// ---- The red dot for a failure in a chat you are not looking at (waiting-notice T2, R-elsewhere) ----
//
// WHY store-level and not per list row (review S1/N5): one subscription in App reads the whole set and paints the dots, so no
// row subscribes and no chat's streaming reaches the list. The set is only ever replaced when it really changes, so the
// subscriber re-renders once per failure, never per word. It is per window: a failure marks the list in the window it happened in.

let unseenFailures: ReadonlySet<string> = new Set();
const unseenListeners = new Set<() => void>();
const setUnseen = (next: ReadonlySet<string>) => { unseenFailures = next; for (const l of unseenListeners) l(); };
function addUnseenFailure(id: string): void {
  if (unseenFailures.has(id)) return;
  setUnseen(new Set([...unseenFailures, id]));
}
function dropUnseenFailure(id: string): void {
  if (!unseenFailures.has(id)) return;
  const next = new Set(unseenFailures);
  next.delete(id);
  setUnseen(next);
}

/** Which chat each window is looking at right now (null: none, or it is in terminal view). Only used to decide "not visible". */
const viewers = new Map<string, string | null>();
const isViewed = (id: string): boolean => { for (const seen of viewers.values()) if (seen === id) return true; return false; };

/**
 * Which chat's message area is really on screen: only in chat view, and not while a full-screen panel (Settings, the marketplace, the
 * library, a project or page screen) sits over it. WHY (review, panel-covers-chat): the strip is hidden behind such a panel, so a failure
 * raised then must count as "not looked at" and get its red dot, like any other chat that is not on screen.
 */
export function noticeViewerFor(o: { viewMode: string; sessionId: string | null | undefined; covered: boolean }): string | null {
  return o.viewMode === 'chat' && !o.covered ? (o.sessionId ?? null) : null;
}

/** A window says which chat's message area is on screen. Opening a chat also counts it as seen (clears its dot). */
export function setNoticeViewer(windowKey: string, sessionId: string | null): void {
  viewers.set(windowKey, sessionId);
  if (sessionId) dropUnseenFailure(sessionId);
}

/** The chat was opened or looked at (where the list's own "viewed" mark is set, and the buddy's seen callback): its dot goes. */
export function markFailureSeen(sessionId: string): void { dropUnseenFailure(sessionId); }

export function getUnseenFailureIds(): ReadonlySet<string> { return unseenFailures; }
export function subscribeUnseenFailures(listener: () => void): () => void {
  unseenListeners.add(listener);
  return () => { unseenListeners.delete(listener); };
}
