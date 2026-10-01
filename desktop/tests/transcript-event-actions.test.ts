// Characterisation of the three translators this one function replaced.
//
// tests/fixtures/transcript-event-actions.golden.json was recorded from the OLD
// code at cfbf69ca5 BEFORE any caller was switched over: App.tsx's live switch
// (`app`, with the way each action was dispatched), BubbleFeed.tsx's live switch
// (`buddy`) and pageEventToAction (`page`), for every event type x payload variant
// in tests/helpers/transcript-event-matrix.ts. So these tests prove the merge kept
// each screen's behaviour, rather than asserting what the new code happens to do.
// ONE deliberate departure (R5-pre, 2026-10-01): the two dropPart entries' `page` was
// `null` (a bug: reopened history showed discarded retry text), and now holds the
// NATIVE_PARTS_DROPPED action the live path already produced.
import { describe, it, expect } from 'vitest';
import golden from './fixtures/transcript-event-actions.golden.json';
import { MATRIX } from './helpers/transcript-event-matrix';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { pageEventToAction } from '../src/renderer/state/transcript-page-actions';
import type { TranscriptEvent } from '../src/shared/types';
import { malformedEv } from './helpers/transcript-events';

// JSON round trip: the golden file cannot hold `undefined`, and a reducer treats
// a missing field and an undefined one the same.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));


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
      // The golden's `via` (direct vs batched) recorded the old route. R4-3 sends every action
      // through the batcher, so only the actions and their order are compared; the route is
      // pinned in tests/transcript-routing.test.ts.
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
    // Kotlin's flat, data-less 'streaming-text' is not in the union at all.
    const e = malformedEv('streaming-text', undefined, { sessionId: 's', uuid: 'u', timestamp: 1 });
    expect(eventToAction(e, { live: true })).toEqual([]);
    expect(eventToAction(e, { live: false })).toEqual([]);
  });
});

// A malformed line must never throw inside an IPC listener, on any screen. The old
// live switches threw on a missing text (batched, so it surfaced a frame later);
// the page path never did. All three paths now agree (R4-2 review F2/F3, R4-3).
describe('eventToAction on events with a missing text or data bag', () => {
  const PATHS: Array<[string, (e: TranscriptEvent) => ReturnType<typeof eventToAction>]> = [
    ['main window (live)', (e) => eventToAction(e, { live: true })],
    ['buddy (live)', (e) => eventToAction(e, { live: true, compactionPending: false, fallbackContextTokens: null })],
    ['history page', (e) => eventToAction(e, { live: false })],
  ];
  const bare = (type: string, data?: unknown) =>
    malformedEv(type, data, { sessionId: 's', uuid: 'u', timestamp: 1 });

  for (const [path, run] of PATHS) {
    it(`${path}: an assistant-text with no text becomes an empty text`, () => {
      for (const data of [undefined, {}]) {
        expect(run(bare('assistant-text', data))).toEqual([expect.objectContaining({ type: 'TRANSCRIPT_ASSISTANT_TEXT', text: '' })]);
      }
    });

    it(`${path}: a user-message with no text draws no bubble`, () => {
      for (const data of [undefined, {}, { text: '' }]) expect(run(bare('user-message', data))).toEqual([]);
    });

    it(`${path}: no event type throws when its data bag is missing`, () => {
      for (const c of MATRIX) {
        expect(() => run(malformedEv(c.event.type, undefined, { uuid: c.event.uuid })), `${c.event.type}`).not.toThrow();
        expect(() => run(malformedEv(c.event.type, {}, { uuid: c.event.uuid })), `${c.event.type} {}`).not.toThrow();
      }
    });
  }
});
