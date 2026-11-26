// session-cleanup.ts — ONE list of "put this away when the chat closes", per chat.
//
// WHY (R-4, 2026-11-18): every owner of per-chat state (maps, timers, watchers, lock markers)
// used to be wired by hand into one of ten `session-exit` listeners. A new owner that forgot
// to wire itself leaked quietly for the life of the app. Now an owner signs up ONCE, where it
// creates the per-chat entry, and SessionManager runs the whole list when the chat ends.
//
// Rules this class keeps:
//  - closing runs EVERY sign-up, in the order they were made; one that throws is logged and
//    the rest still run (a failed tidy-up must never strand the others);
//  - closing is idempotent: the list is emptied as it runs, so closing twice does nothing the
//    second time, and the exit paths that can both fire for one chat are safe;
//  - sign-ups made AFTER a close belong to the next life of that id (close-then-reopen), and
//    are untouched by the earlier close;
//  - the returned function un-registers early (an owner that tidied itself sooner).
import { log } from './logger';

export type CleanupFn = () => void | Promise<void>;

export class SessionCleanup {
  private readonly perChat = new Map<string, Set<CleanupFn>>();

  /** Sign `fn` up to run when `sessionId` closes. Returns an un-register function. */
  register(sessionId: string, fn: CleanupFn): () => void {
    let set = this.perChat.get(sessionId);
    if (!set) { set = new Set(); this.perChat.set(sessionId, set); }
    set.add(fn);
    return () => {
      const cur = this.perChat.get(sessionId);
      if (!cur) return;
      cur.delete(fn);
      if (cur.size === 0) this.perChat.delete(sessionId);
    };
  }

  /** Run and forget every sign-up for `sessionId`. Never throws. */
  closeSession(sessionId: string): void {
    const set = this.perChat.get(sessionId);
    if (!set) return;
    // Take the list out BEFORE running: a cleanup that registers again (a new life of this id)
    // lands in a fresh list that this close does not run.
    this.perChat.delete(sessionId);
    for (const fn of set) {
      try {
        const r = fn();
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch((error) => log('WARN', 'SessionCleanup', 'cleanup failed', { sessionId, error: String(error) }));
        }
      } catch (error) {
        log('WARN', 'SessionCleanup', 'cleanup failed', { sessionId, error: String(error) });
      }
    }
  }

  /** How many chats still hold sign-ups (the leak test reads this; it must return to 0). */
  get openCount(): number { return this.perChat.size; }
}
