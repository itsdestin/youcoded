// Characterisation of the three translators this one function replaced.
//
// tests/fixtures/transcript-event-actions.golden.json was recorded from the OLD
// code at cfbf69ca5 BEFORE any caller was switched over: App.tsx's live switch
// (`app`, with the way each action was dispatched), BubbleFeed.tsx's live switch
// (`buddy`) and the former singular pageEventToAction (`page`), for every event type x payload variant
// in tests/helpers/transcript-event-matrix.ts. So these tests prove the merge kept
// each screen's behaviour, rather than asserting what the new code happens to do.
// ONE deliberate departure (R5-pre, 2026-10-01): the two dropPart entries' `page` was
// `null` (a bug: reopened history showed discarded retry text), and now holds the
// NATIVE_PARTS_DROPPED action the live path already produced.
// ONE MORE (sync-fix6, Destin 2026-10-04): a LIVE `context-clear` no longer carries the divider's markerId (the record's `session:live` clear draws
// the line, once, for both runtimes; the event only resets the turn), and the buddy now translates user-interrupt, skill-invoked and context-clear
// exactly like the main window, so its golden `[]` for those three is replaced by the main window's own actions. Both are asserted below.
import { describe, it, expect } from 'vitest';
import golden from './fixtures/transcript-event-actions.golden.json';
import { MATRIX } from './helpers/transcript-event-matrix';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { pageEventToActions } from '../src/renderer/state/transcript-page-actions';
import type { TranscriptEvent } from '../src/shared/types';
import { clearDividerId } from '../src/shared/divider-ids';
import { malformedEv } from './helpers/transcript-events';

// JSON round trip: the golden file cannot hold `undefined`, and a reducer treats
// a missing field and an undefined one the same.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));


// The one departure from the recorded main-window output (see the header): a live clear carries no divider id.
const withoutLiveClearMarker = (type: string, action: any) => {
  if (type !== 'context-clear' || action?.type !== 'CLEAR_TIMELINE') return action;
  const { markerId: _m, ...rest } = action;
  return rest;
};

// Deliberate summary departure: restore native boundaries on every screen,
// retain CC resume-summary suppression, and preserve the recorded event time.
function expectedSummary(event: TranscriptEvent, fallback: number | null = null) {
  if (event.type !== 'compact-summary') throw new Error('Expected summary fixture');
  const { sessionId, uuid, timestamp, data: d } = event;
  const recorded = d.contextUsedAfter !== undefined || d.contextUsedBefore !== undefined
    || d.usage !== undefined || d.autoCompaction !== undefined
    || d.retainedFromUuid !== undefined || d.compactionRecord !== undefined;
  return [
    ...(d.contextUsedAfter !== undefined || d.usage ? [{ type: 'NATIVE_HISTORY_REWRITTEN', sessionId, uuid,
      contextUsedTokens: d.contextUsedAfter ?? null, usage: d.usage }] : []),
    ...(recorded ? [{ type: 'COMPACTION_COMPLETE', sessionId,
      markerId: `compact-done-${uuid}`, timestamp, ...(recorded ? { recorded: true } : {}),
      afterContextTokens: d.contextUsedAfter ?? fallback, beforeContextTokens: d.contextUsedBefore,
      ...(d.summary ? { summary: d.summary } : {}), ...(d.autoCompaction ? { auto: true } : {}),
      ...(d.retainedFromUuid !== undefined ? { retainedFromUuid: d.retainedFromUuid } : {}),
    }] : []),
  ];
}

describe('eventToAction reproduces the old main-window switch', () => {
  for (const c of MATRIX) {
    it(c.name, () => {
      const actions = eventToAction(c.event, {
        live: true,
        compactionPending: c.ctx?.compactionPending,
        fallbackContextTokens: c.ctx?.statuslineContextTokens ?? null,
      });
      const old = (golden as any)[c.name].app as { via: string; action: unknown }[];
      expect(plain(actions)).toEqual(c.event.type === 'compact-summary'
        ? plain(expectedSummary(c.event, c.ctx?.statuslineContextTokens ?? null))
        : old.map((o) => withoutLiveClearMarker(c.event.type, o.action)));
      // The golden's `via` (direct vs batched) recorded the old route. R4-3 sends every action
      // through the batcher, so only the actions and their order are compared; the route is
      // pinned in tests/transcript-routing.test.ts.
    });
  }
});

describe('eventToAction with live:false reproduces pageEventToActions', () => {
  for (const c of MATRIX) {
    it(c.name, () => {
      const old = (golden as any)[c.name].page;
      const expected = c.event.type === 'compact-summary' ? expectedSummary(c.event) : old ? [old] : [];
      expect(plain(eventToAction(c.event, { live: false }))).toEqual(plain(expected));
      expect(plain(pageEventToActions(c.event))).toEqual(plain(expected));
    });
  }

  it('a page keeps both the summary accounting and boundary actions', () => {
    const c = MATRIX.find(c => c.name === 'compact-summary pending, harness figures')!;
    expect(pageEventToActions(c.event).map(a => a.type)).toEqual(['NATIVE_HISTORY_REWRITTEN', 'COMPACTION_COMPLETE']);
  });
});

// The buddy's old live output, minus the differences Destin approved on 2026-10-01
// (or that are invisible in the buddy window). Everything else must be identical.
describe('eventToAction with buddy options reproduces the old buddy switch', () => {
  // The three types the old buddy never translated live: now closed (sync-fix6), pinned in the next block.
  const BUDDY_WAS_SKIPPING = new Set(['user-interrupt', 'skill-invoked', 'context-clear']);
  for (const c of MATRIX) {
    if (BUDDY_WAS_SKIPPING.has(c.event.type)) continue;
    it(c.name, () => {
      const actions = eventToAction(c.event, {
        live: true,
        compactionPending: c.ctx?.compactionPending,
        fallbackContextTokens: null,
      });
      const old = (golden as any)[c.name].buddy as { action: any }[];
      if (c.event.type === 'compact-summary') {
        expect(plain(actions)).toEqual(plain(expectedSummary(c.event)));
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

describe('the buddy now translates the three events it used to skip, as the main window does', () => {
  for (const c of MATRIX.filter((m) => ['user-interrupt', 'skill-invoked', 'context-clear'].includes(m.event.type))) {
    it(c.name, () => {
      const actions = eventToAction(c.event, { live: true, compactionPending: false, fallbackContextTokens: null });
      const main = (golden as any)[c.name].app as { action: unknown }[];
      expect(actions.length).toBeGreaterThan(0);
      expect(plain(actions)).toEqual(main.map((o) => withoutLiveClearMarker(c.event.type, o.action)));
    });
  }
});

describe('a clear\'s divider: a page draws it, a live event does not (the record draws it live)', () => {
  const clear = MATRIX.find((m) => m.event.type === 'context-clear')!.event;
  it('live: resets the turn with no divider id', () => {
    const [a] = eventToAction(clear, { live: true });
    expect(a).toMatchObject({ type: 'CLEAR_TIMELINE' });
    expect((a as { markerId?: string }).markerId).toBeUndefined();
  });
  it('page: draws it, with the id the computer\'s record uses for the same clear', () => {
    expect(eventToAction(clear, { live: false })[0]).toMatchObject({ type: 'CLEAR_TIMELINE', markerId: clearDividerId(clear.uuid) });
  });
});

describe('compaction certification and explicit legacy fallback', () => {
  const summary = malformedEv('compact-summary', { summary: 'Unproven old summary' }, { sessionId: 's', uuid: 'old', timestamp: 1 });
  it('does not turn an uncertified CC summary into success just because another operation is pending', () => {
    expect(eventToAction(summary, { live: true, compactionPending: true })).toEqual([]);
    expect(eventToAction(summary, { live: true, compactionPending: true, allowLegacyCompaction: false })).toEqual([]);
  });
  it('keeps the pending-only compatibility path exclusive to explicitly legacy hosts', () => {
    expect(eventToAction(summary, { live: true, compactionPending: true, allowLegacyCompaction: true }))
      .toEqual([expect.objectContaining({ type: 'COMPACTION_COMPLETE', markerId: 'compact-done-old' })]);
    expect(eventToAction(summary, { live: false, compactionPending: true, allowLegacyCompaction: true })).toEqual([]);
  });
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
