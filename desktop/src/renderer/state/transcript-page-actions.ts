import type { TranscriptEvent } from '../../shared/types';
import type { ChatAction } from './chat-types';
import { eventToAction } from './transcript-event-actions';

/**
 * One history event can carry both accounting and a visible boundary.
 * WHY return every action: taking only the first silently loses a compaction's
 * marker or its summarize-call bill. Live-only conditions remain filtered by
 * the shared translator, not by this wrapper.
 */
export function pageEventToActions(event: TranscriptEvent, opts: { restoreCompaction?: boolean } = {}): ChatAction[] {
  return eventToAction(event, { ...opts, live: false });
}
