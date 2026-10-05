import type { TranscriptEvent } from '../../shared/types';
import type { ChatAction } from './chat-types';
import { eventToAction } from './transcript-event-actions';

/**
 * One TranscriptEvent from a history PAGE -> the reducer action that renders it,
 * or null when a page has nothing to draw for it.
 *
 * WHY a wrapper: the mapping itself lives in `eventToAction` (the one translator
 * App, the buddy feed and this share). `live: false` is what makes it
 * history-shaped: heartbeats, `session-error`, `replay-complete`, the compaction
 * marker and the /clear gauge re-base are live conditions and yield nothing (a saved
 * retry marker, `dropPart`, is NOT: it replays as NATIVE_PARTS_DROPPED), and
 * every remaining event yields at most one action, so `[0]` loses nothing.
 * Used by chat-reducer's HISTORY_PAGE_LOADED, in the main window and the buddy.
 */
export function pageEventToAction(event: TranscriptEvent): ChatAction | null {
  return eventToAction(event, { live: false })[0] ?? null;
}
