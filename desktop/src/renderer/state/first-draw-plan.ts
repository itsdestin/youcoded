// Which timeline entries a conversation draws on its FIRST mount, and a guess at the height of
// the rest (freeze hunt 2026-10-22, item 3).
//
// WHY: a conversation opened with a full page (30 turns) used to draw every entry in the first
// commit, for every open session including ones nobody has looked at (hundreds of ms to seconds each,
// back to back at startup). Only the entries near the bottom can be seen. The rest start FOLDED
// (use-entry-folding.ts): a blank spacer of an estimated height, drawn when the reader scrolls near.
//
// WHY THIS CANNOT JUMP, in one place so a reviewer can check it:
//  - the bottom is pinned: ChatView re-pins to the bottom whenever the content height changes while
//    stuck (its ResizeObserver), before the next paint, so the newest message never moves;
//  - while the reader is scrolled up, the browser's own scroll anchoring keeps the entry they are
//    looking at in place when a spacer above is replaced by its real body;
//  - entries are drawn ~1,500 px BEFORE they can be seen (FOLD_ROOT_MARGIN), so a wrong estimate is
//    corrected off screen. Pinned by tests/first-draw-scroll-stability (real layout, workbench).
import type { AssistantTurn, TimelineEntry } from './chat-types';
import { HISTORY_EXPAND_PROMPT_ID, shouldRenderAssistantTurn } from './chat-types';

/** Below this many entries a conversation is drawn whole, as before: it is cheap, and not worth guessing. */
export const FIRST_DRAW_MIN_ENTRIES = 16;
/** Draw at least this many pixels of newest entries (a tall window plus the 1,500 px fold margin)... */
export const FIRST_DRAW_PX = 3000;
/** ...and at least this many entries, whatever their guessed height. */
export const FIRST_DRAW_MIN_KEEP = 10;

/** The `data-entry-key` of a timeline entry, or null for one that is never drawn (a retired marker). */
export function timelineEntryKey(entry: TimelineEntry): string | null {
  switch (entry.kind) {
    case 'user': return entry.message.id;
    case 'assistant-turn': return entry.turnId;
    case 'prompt': return entry.prompt.promptId === HISTORY_EXPAND_PROMPT_ID ? null : entry.prompt.promptId;
    case 'usage-card': return entry.snapshot.entryId;
    case 'system-marker': return entry.marker.id;
    case 'skill-invocation':
    case 'compacting':
    case 'copy-picker':
      return entry.id;
  }
}

const lines = (text: string, perLine = 85) => text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);

/** A rough height in px. Wrong by tens of percent is fine (see the header); never below a plain row. */
export function estimateEntryHeight(entry: TimelineEntry, turn: AssistantTurn | undefined): number {
  switch (entry.kind) {
    case 'user': return 40 + 22 * lines(entry.message.content ?? '', 70) + (entry.message.attachments?.length ? 110 : 0);
    case 'assistant-turn': {
      if (!turn) return 80;
      let h = 40;
      for (const s of turn.segments) {
        if (s.type === 'text') h += 12 + 24 * lines(s.content);
        else if (s.type === 'reasoning') h += 36;
        else h += 44;
      }
      return h;
    }
    case 'system-marker': return 48;
    default: return 90;
  }
}

/** Only entries that are finished history may start folded; anything live or waiting on the reader stays drawn. */
function mayStartFolded(entry: TimelineEntry): boolean {
  if (entry.kind === 'user') return !entry.pending && !entry.sendNote && !entry.sendRefused;
  return entry.kind === 'assistant-turn' || entry.kind === 'system-marker' || entry.kind === 'usage-card' || entry.kind === 'skill-invocation';
}

/**
 * The entries to start folded, as [key, estimated height] pairs, or undefined to draw everything.
 * Walks from the newest entry back until enough have been kept to fill a window plus the fold margin.
 * `liveTurnId` (the turn being written now) is always kept, as is anything that is not finished history.
 */
export function planFirstDraw(
  timeline: readonly TimelineEntry[],
  turns: ReadonlyMap<string, AssistantTurn>,
  liveTurnId: string | null,
): Array<[string, number]> | undefined {
  if (timeline.length < FIRST_DRAW_MIN_ENTRIES) return undefined;
  let kept = 0;
  let px = 0;
  let boundary = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    const key = timelineEntryKey(entry);
    const turn = entry.kind === 'assistant-turn' ? turns.get(entry.turnId) : undefined;
    if (key === null || (entry.kind === 'assistant-turn' && !shouldRenderAssistantTurn(turn))) continue;
    kept++;
    px += estimateEntryHeight(entry, turn);
    if (kept >= FIRST_DRAW_MIN_KEEP && px >= FIRST_DRAW_PX) { boundary = i; break; }
  }
  if (boundary <= 0) return undefined;
  const plan: Array<[string, number]> = [];
  for (let i = 0; i < boundary; i++) {
    const entry = timeline[i];
    const key = timelineEntryKey(entry);
    if (key === null || !mayStartFolded(entry)) continue;
    const turn = entry.kind === 'assistant-turn' ? turns.get(entry.turnId) : undefined;
    if (entry.kind === 'assistant-turn' && (!shouldRenderAssistantTurn(turn) || entry.turnId === liveTurnId)) continue;
    plan.push([key, Math.round(estimateEntryHeight(entry, turn))]);
  }
  return plan.length ? plan : undefined;
}
