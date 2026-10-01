// Characterisation of the three translators this one function replaced.
//
// tests/fixtures/transcript-event-actions.golden.json was recorded from the OLD
// code at cfbf69ca5 BEFORE any caller was switched over: App.tsx's live switch
// (`app`, with the way each action was dispatched), BubbleFeed.tsx's live switch
// (`buddy`) and pageEventToAction (`page`), for every event type x payload variant
// in tests/helpers/transcript-event-matrix.ts. So these tests prove the merge kept
// each screen's behaviour, rather than asserting what the new code happens to do.
import { describe, it, expect } from 'vitest';
import golden from './fixtures/transcript-event-actions.golden.json';
import { MATRIX } from './helpers/transcript-event-matrix';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { pageEventToAction } from '../src/renderer/state/transcript-page-actions';
import type { TranscriptEvent } from '../src/shared/types';

// JSON round trip: the golden file cannot hold `undefined`, and a reducer treats
// a missing field and an undefined one the same.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

// What App.tsx dispatches directly (not through the frame batcher). Kept as it was;
// moving these into the batch is a separate, visible decision (run R4-3).
const APP_DIRECT = new Set(['TRANSCRIPT_SKILL_INVOKED', 'CLEAR_TIMELINE', 'NATIVE_HISTORY_REWRITTEN', 'COMPACTION_COMPLETE']);

describe('eventToAction reproduces the old main-window switch', () => {
  for (const c of MATRIX) {
    it(c.name, () => {
      const actions = eventToAction(c.event, {
        live: true,
        compactionPending: c.ctx?.compactionPending,
        fallbackContextTokens: c.ctx?.statuslineContextTokens ?? null,
      });
      const old = (golden as any)[c.name].app as { via: string; action: unknown }[];
      expect(plain(actions)).toEqual(old.map((o) => o.action));
      // The batch/direct split App applies on top is a pure function of the type.
      expect(actions.map((a) => (APP_DIRECT.has(a.type) ? 'direct' : 'batch'))).toEqual(old.map((o) => o.via));
    });
  }
});

describe('eventToAction with live:false reproduces pageEventToAction', () => {
  for (const c of MATRIX) {
    it(c.name, () => {
      const old = (golden as any)[c.name].page;
      expect(plain(eventToAction(c.event, { live: false })[0])).toEqual(plain(old));
      expect(plain(pageEventToAction(c.event))).toEqual(plain(old));
    });
  }

  it('a page never yields more than one action per event', () => {
    for (const c of MATRIX) expect(eventToAction(c.event, { live: false }).length).toBeLessThanOrEqual(1);
  });
});

// The buddy's old live output, minus the differences Destin approved on 2026-10-01
// (or that are invisible in the buddy window). Everything else must be identical.
describe('eventToAction with buddy options reproduces the old buddy switch', () => {
  const BUDDY_SKIPPED = new Set(['user-interrupt', 'skill-invoked', 'context-clear']);
  for (const c of MATRIX) {
    if (BUDDY_SKIPPED.has(c.event.type)) continue; // the buddy never ran these live; see the ledger test
    it(c.name, () => {
      const actions = eventToAction(c.event, {
        live: true,
        compactionPending: c.ctx?.compactionPending,
        fallbackContextTokens: null,
      });
      const old = (golden as any)[c.name].buddy as { action: any }[];
      if (c.event.type === 'compact-summary') {
        // Visible change (approved): the marker now says "freed N tokens" and is
        // deduplicated by event id. The buddy also now records the bookkeeping half
        // (the summarize call's bill and the window it left), which no buddy
        // component reads. Marker difference asserted exactly:
        const marker = actions.find((a) => a.type === 'COMPACTION_COMPLETE') as any;
        const oldMarker = old.find((o) => o.action.type === 'COMPACTION_COMPLETE')?.action;
        expect(!!marker).toBe(!!oldMarker);
        if (marker) {
          expect(marker.markerId).toBe(`compact-done-${c.event.uuid}`);
          expect(marker.afterContextTokens).toBe((c.event.data as any).contextUsedAfter ?? null);
          expect(marker.beforeContextTokens).toBe((c.event.data as any).contextUsedBefore);
          const { markerId: _a, afterContextTokens: _b, beforeContextTokens: _c, ...rest } = plain(marker);
          const { markerId: _d, afterContextTokens: _e, ...oldRest } = oldMarker;
          expect(rest).toEqual(oldRest);
        }
        return;
      }
      const stripInvisible = (a: any) => {
        const x = { ...a };
        // Nothing in the buddy window reads these (no ThinkingIndicator props, no totals).
        if (x.type === 'TRANSCRIPT_THINKING_HEARTBEAT') delete x.promptProcessing;
        if (x.type === 'NATIVE_SESSION_ERROR') { delete x.uuid; delete x.usage; }
        return x;
      };
      expect(plain(actions.map(stripInvisible))).toEqual(old.map((o) => plain(stripInvisible(o.action))));
    });
  }
});

describe('eventToAction ignores what it does not know', () => {
  it('returns nothing, and does not throw, for an unknown type (Kotlin sends streaming-text)', () => {
    const e = { type: 'streaming-text', sessionId: 's', uuid: 'u', timestamp: 1 } as unknown as TranscriptEvent;
    expect(eventToAction(e, { live: true })).toEqual([]);
    expect(eventToAction(e, { live: false })).toEqual([]);
  });
});
