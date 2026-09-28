import type { SessionChatState } from './chat-types';

/**
 * The menu-gone rule for KEPT cards (2026-07-30 permission-ask-timeout spec §2,
 * ported 2026-09-23).
 *
 * A card kept by a 'hook-closed' expiry settles only after Claude Code's menu
 * has been ABSENT from the visible screen for TWO consecutive buffer flushes.
 * One flush races both ways: an answer typed in the terminal often closes the
 * socket BEFORE the flush that removes the menu (a false keep, which this
 * self-heals), and Claude Code's fallback menu draws a beat AFTER a hook is
 * killed (a one-shot check would settle the card while the session is still
 * blocked on that menu — the originally reported bug).
 */
const MENU_ABSENT_FLUSHES_TO_RESOLVE = 2;

/** Ids of the session's kept cards: awaiting-approval AND expired. Scans the
 *  whole `toolCalls` map, not just the current turn — keeping a card is exactly
 *  what lets it outlive the moment a normal ask would have ended. */
export function expiredToolIds(session: SessionChatState): string[] {
  const ids: string[] = [];
  for (const [id, tool] of session.toolCalls) {
    if (tool.status === 'awaiting-approval' && tool.expired) ids.push(id);
  }
  return ids;
}

/** One step of the per-session absent-flush counter: a menu on screen resets
 *  it; an absent one counts up and settles at MENU_ABSENT_FLUSHES_TO_RESOLVE. */
export function nextAbsentCount(menuPresent: boolean, prevCount: number): { count: number; resolve: boolean } {
  if (menuPresent) return { count: 0, resolve: false };
  const count = prevCount + 1;
  return { count, resolve: count >= MENU_ABSENT_FLUSHES_TO_RESOLVE };
}
