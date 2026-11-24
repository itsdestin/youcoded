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
}

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

/** Shows `notice` in that chat's strip, replacing whatever that chat showed before. */
export function showChatNotice(sessionId: string, notice: ChatNotice): void {
  if (!sessionId) return;
  notices.set(sessionId, notice);
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
  notify(sessionId);
}

/** Your next action in this chat (typing, sending, switching away): next-action notices leave. */
export function chatNoticeUserActed(sessionId: string): void {
  if (notices.get(sessionId)?.leave === 'next-action') clearChatNotice(sessionId);
}
