// The main window, the buddy window and a history page all turn a transcript event
// into reducer actions through ONE function, `eventToAction`
// (state/transcript-event-actions.ts). Before that merge each kept its own switch,
// and nothing kept them in step: PR #287 added `replay-complete` to App.tsx only, so
// the buddy kept the spinning orphaned tool card that PR exists to reap; a later fix
// stamped tool-use timestamps in two of the three places.
//
// What guards each of those old failure modes now:
//  - a new event type nobody handled      -> the compiler: `eventToAction`'s switch ends
//                                            in a `never` check, and ALL_TYPES below is a
//                                            Record over the union (this file is type-checked
//                                            by `npm run typecheck`, which verify.sh runs);
//  - the buddy drifting from the main window -> BUDDY_LIVE is a typed ledger of every
//                                            difference, and the behavioural comparison below
//                                            runs every payload variant through both option sets;
//  - a forgotten tool-use timestamp       -> the action's own type makes `timestamp` required.
import { describe, it, expect } from 'vitest';
import type { TranscriptEventType } from '../src/shared/types';
import type { ChatAction } from '../src/renderer/state/chat-types';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { BUDDY_LIVE } from '../src/renderer/components/buddy/buddy-live-events';
import { MATRIX, MATRIX_TYPES } from './helpers/transcript-event-matrix';

// A Record over the union: adding a TranscriptEventType without a row here is a
// COMPILE error, so the matrix below cannot silently miss a new type.
const ALL_TYPES: Record<TranscriptEventType, true> = {
  'user-message': true, 'user-interrupt': true, 'assistant-text': true, 'tool-use': true,
  'tool-result': true, 'replay-complete': true, 'turn-complete': true, 'assistant-thinking': true,
  'session-error': true, 'skill-invoked': true, 'context-clear': true, 'compact-summary': true,
  'subagent-usage': true, 'background-task': true,
};

// The options each window passes (App.tsx, BubbleFeed.tsx). Same compaction flag so
// the comparison isolates what the OPTIONS change; the buddy has no statusline.
const mainWindow = (pending: boolean | undefined) => ({ live: true, compactionPending: pending, fallbackContextTokens: 777 });
const buddyWindow = (pending: boolean | undefined) => ({ live: true, compactionPending: pending, fallbackContextTokens: null });

describe('transcript event surface parity', () => {
  it('the matrix exercises every transcript event type', () => {
    expect([...MATRIX_TYPES].sort()).toEqual(Object.keys(ALL_TYPES).sort());
  });

  it('the buddy ledger lists exactly three skips, each with a reason, and nothing else is skipped', () => {
    const skips = Object.entries(BUDDY_LIVE).filter(([, rule]) => rule !== 'same');
    expect(skips.map(([type]) => type).sort()).toEqual(['context-clear', 'skill-invoked', 'user-interrupt']);
    for (const [type, rule] of skips) {
      expect((rule as { skip: string }).skip.length, `${type} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('the buddy ledger names every event type (no row silently missing)', () => {
    expect(Object.keys(BUDDY_LIVE).sort()).toEqual(Object.keys(ALL_TYPES).sort());
  });

  describe('main window and buddy window translate every handled payload identically', () => {
    for (const c of MATRIX) {
      if (BUDDY_LIVE[c.event.type] !== 'same') continue; // a ledgered skip: the buddy never translates it live
      it(c.name, () => {
        const pending = c.ctx?.compactionPending;
        const main = eventToAction(c.event, mainWindow(pending));
        const buddy = eventToAction(c.event, buddyWindow(pending));
        // The only thing the options may change is the compaction marker's "after"
        // figure when the event carries none: the statusline fallback, which the
        // buddy does not have. Everything else is the same action for the same event.
        const normalise = (actions: ChatAction[]) => actions.map((a) => (
          a.type === 'COMPACTION_COMPLETE' && (c.event.data as { contextUsedAfter?: number }).contextUsedAfter === undefined
            ? { ...a, afterContextTokens: 'FALLBACK' }
            : a
        ));
        expect(normalise(buddy)).toEqual(normalise(main));
      });
    }

    it('the statusline fallback only ever feeds the marker\'s "after" figure', () => {
      const c = MATRIX.find((m) => m.name === 'compact-summary pending, statusline fallback')!;
      const main = eventToAction(c.event, mainWindow(true)).find((a) => a.type === 'COMPACTION_COMPLETE') as Extract<ChatAction, { type: 'COMPACTION_COMPLETE' }>;
      const buddy = eventToAction(c.event, buddyWindow(true)).find((a) => a.type === 'COMPACTION_COMPLETE') as Extract<ChatAction, { type: 'COMPACTION_COMPLETE' }>;
      expect(main.afterContextTokens).toBe(777);
      expect(buddy.afterContextTokens).toBeNull();
      expect(buddy.markerId).toBe(main.markerId); // the same dedupe key either way
    });
  });

  describe('every tool-use action carries the event timestamp', () => {
    it('on a live stream and on a page, with and without a subagent stamp', () => {
      const toolUses = MATRIX.filter((c) => c.event.type === 'tool-use');
      expect(toolUses.length).toBeGreaterThan(0);
      for (const c of toolUses) {
        for (const opts of [mainWindow(false), buddyWindow(false), { live: false }]) {
          const [action] = eventToAction(c.event, opts);
          expect(action.type).toBe('TRANSCRIPT_TOOL_USE');
          expect((action as { timestamp?: number }).timestamp).toBe(c.event.timestamp);
        }
      }
    });

    it('is enforced by the type: an action without it does not compile', () => {
      // `timestamp` is REQUIRED on TRANSCRIPT_TOOL_USE, so a producer that forgets it
      // (the buddy once did, and every specialist note fell to the tail there) fails
      // `npm run typecheck`. This expression is the proof; it never runs.
      const forgotten = (): ChatAction =>
        // @ts-expect-error timestamp is required on TRANSCRIPT_TOOL_USE
        ({ type: 'TRANSCRIPT_TOOL_USE', sessionId: 's', uuid: 'u', toolUseId: 't', toolName: 'Read', toolInput: {} });
      expect(typeof forgotten).toBe('function');
    });
  });
});
