import type { TimelineEntry } from './chat-types';

/**
 * Where the model's context begins.
 *
 * `/compact` and `/clear` both draw a line under the conversation: everything
 * above is out of the model's context but still the user's to re-read. ChatView
 * fades those entries and labels them archived.
 *
 * WHY this is a module rather than a closure inside ChatView's render: it is the
 * whole of the /clear fix's visible half, and testing it inside ChatView means
 * mounting a component that pulls highlight.js — which cannot load through this
 * worktree's node_modules symlink. A copy of the logic in a test file would test
 * the copy, not the app (a trap this branch has already fallen into more than
 * once), so the app imports this and the test imports the same thing.
 *
 * Only `compact` and `clear` are boundaries. An `info` marker is a divider, not
 * a context reset.
 *
 * `index` is the fade line: entries ABOVE it (idx < index) are archived. For
 * `/clear`, Claude Code and legacy markers it is the marker itself. A native
 * compaction KEEPS a recent tail the model still sees, and its marker lands
 * after that tail — so its marker carries `retainedFromUuid` (the user message
 * opening the kept turn) and the line moves up to that message. When that
 * message is not in the timeline (paged out, or null = unknown), this marker
 * dims nothing new and the previous boundary's line stands: under-dimming is
 * safe, fading a kept message falsely says the model lost it.
 */
export function findArchiveBoundary(
  timeline: readonly TimelineEntry[],
  // The buddy feed has only ever faded above COMPACT markers; it passes ['compact'].
  variants: ReadonlyArray<'compact' | 'clear'> = ['compact', 'clear'],
): {
  index: number;
  kind: 'compact' | 'clear' | null;
} {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.kind !== 'system-marker' || (e.marker.variant !== 'compact' && e.marker.variant !== 'clear')
        || !variants.includes(e.marker.variant)) continue;
    const retained = e.marker.retainedFromUuid;
    if (retained === undefined) return { index: i, kind: e.marker.variant };
    const start = retained === null ? -1
      // A kept turn can open with a typed message OR a /skill (its card id is
      // `skill-<event uuid>`, chat-reducer.ts); both are the user's turn start.
      : timeline.findIndex((entry, j) => j < i && ((entry.kind === 'user' && entry.uuid === retained)
        || (entry.kind === 'skill-invocation' && entry.id === `skill-${retained}`)));
    if (start >= 0) return { index: start, kind: e.marker.variant };
  }
  return { index: -1, kind: null };
}
