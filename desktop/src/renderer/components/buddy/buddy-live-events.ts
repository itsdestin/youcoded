import type { TranscriptEventType } from '../../../shared/types';

/**
 * Which live transcript events the buddy window draws like the main window does.
 *
 * The buddy is a separate BrowserWindow with its own reducer, fed by the same
 * `eventToAction` translator as the main window. This ledger is the ONE place its
 * differences live. `Record<TranscriptEventType, ...>` makes the compiler demand an
 * answer for every event type, so a new type cannot be silently dropped by the
 * buddy the way `replay-complete` once was (PR #287): the author has to write
 * 'same' or a reason.
 *
 * A skip is NOT a verdict that the gap is right. These three are known gaps from
 * before the translators were merged, kept exactly as they were; closing one is a
 * visible product decision of its own. (The buddy's HISTORY PAGE path is separate
 * and does draw all three, via pageEventToAction.)
 */
export const BUDDY_LIVE: Record<TranscriptEventType, 'same' | { skip: string }> = {
  'user-message': 'same',
  'user-interrupt': { skip: 'Not investigated whether the buddy should end its turn when the main window\'s ESC interrupts (PR #287 review, 2026-08-10). The buddy has no InputBar, so it never sends ESC itself.' },
  'assistant-text': 'same',
  'tool-use': 'same',
  'tool-result': 'same',
  'replay-complete': 'same',
  'turn-complete': 'same',
  'assistant-thinking': 'same',
  'session-error': 'same',
  'skill-invoked': { skip: 'The buddy has no skill card today (PR #287 review, 2026-08-10).' },
  'context-clear': { skip: 'The buddy timeline does not clear its TRANSCRIPT live on /clear (PR #287 review, 2026-08-10); it picks the barrier up the next time it loads history. (Since sync-fix3 the buddy does draw the "Conversation cleared" LINE live, but from the computer\'s separate `session:live` clear divider, which is its own event, not this one. The ledger gap is unchanged.)' },
  'compact-summary': 'same',
  'subagent-usage': 'same',
  'background-task': 'same',
};
