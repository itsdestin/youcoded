// desktop/tests/usage-snapshot.test.ts
//
// WHY this file exists: `/usage` and `/cost` are built entirely out of ONE
// derivation, and until now nothing tested it. It lived inside App.tsx as a
// `useCallback`, no test imports App.tsx at all, and a reviewer deleted the
// native-totals fallback — the whole point of the commit that added it — while
// all 5,820 tests stayed green. The fallback is what stops `/usage` in a
// YouCoded-runtime session falling through the slash-command dispatcher and
// being typed at the model as a chat message. That is not something the
// presentation layer can guard, so the derivation moved out to
// src/renderer/state/usage-snapshot.ts and is pinned here.
import { describe, it, expect } from 'vitest';
import { pruneExpiredUsage } from '../src/renderer/state/usage-snapshot';
import { buildUsageSnapshot, type UsageSnapshotInput } from '../src/renderer/state/usage-snapshot';
import { emptyTotals } from '../src/renderer/state/session-totals';
import { selectNativeStatusChips } from '../src/renderer/components/StatusBar';
import type { TurnUsage } from '../src/renderer/state/chat-types';

const base: UsageSnapshotInput = {
  sessionId: 's1',
  now: 1_700_000_000_000,
  stats: null,
  contextPercent: null,
  usage: null,
  isNative: false,
  session: undefined,
};

/** A native session's timeline holding one completed turn with `usage`. */
function nativeSession(usage: TurnUsage, totals = emptyTotals()) {
  return {
    timeline: [{ kind: 'assistant-turn' as const, turnId: 't1' }],
    assistantTurns: new Map([['t1', { usage }]]),
    totals,
  };
}

const turn = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, ...over,
});

describe('buildUsageSnapshot — the native totals fallback', () => {
  // THE regression this module exists for. A brand-new native session has
  // measured nothing: no Claude Code statusline (it runs none), no context
  // reading, no subscription cache. Every one of those is null, and the ONLY
  // thing left saying "this session exists and I can describe it" is its
  // totals object. Return null here and the dispatcher treats /usage as
  // unhandled and types the literal text "/usage" at the model.
  it('returns a snapshot for a native session that has measured nothing yet', () => {
    const snap = buildUsageSnapshot({ ...base, isNative: true, session: nativeSession(turn()) });
    expect(snap).not.toBeNull();
    expect(snap!.countsFromSessionTotals).toBe(true);
  });

  it('returns null for a Claude Code session that has measured nothing yet', () => {
    // No statusline AND no counted turn: genuinely nothing to snapshot, and the
    // card must not be opened on an empty page. (Token totals ARE now read for
    // Claude Code sessions — see the 2026-09-03 note in usage-snapshot.ts — but
    // an all-zero totals object is "no turn has run", so this still holds.)
    expect(buildUsageSnapshot({ ...base, isNative: false, session: nativeSession(turn()) })).toBeNull();
  });

  it('reads a totals zero as nothing measured, not as a measured zero', () => {
    // emptyTotals() starts every native session at all-zero BEFORE a turn has
    // run, so a zero here is ambiguous and must read as absent — the card then
    // omits the row instead of printing a 0 it never measured.
    const snap = buildUsageSnapshot({ ...base, isNative: true, session: nativeSession(turn()) });
    expect(snap!.inputTokens).toBeNull();
    expect(snap!.outputTokens).toBeNull();
    expect(snap!.cacheReadTokens).toBeNull();
    expect(snap!.cacheCreationTokens).toBeNull();
    expect(snap!.linesAdded).toBeNull();
    expect(snap!.linesRemoved).toBeNull();
  });

  it('lets a measured zero through as the real measurement it is', () => {
    // The mirror image, and the half that is easy to break: a cold or expired
    // prompt cache genuinely reads 0 cached tokens. That is a measurement, and
    // collapsing it to null would hide a true answer.
    //
    // Rewritten 2026-09-03: this used to prove the point with a statusline
    // fixture, back when the card's token counts came from there. They come
    // from session totals now (the statusline's are one request's, not the
    // session's), so the same point is made where it now lives — a counted turn
    // with a cold cache. inputTokens > 0 is what says "a turn was counted"; the
    // zeros beside it are then real.
    const totals = {
      ...emptyTotals(), inputTokens: 4_000, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
    };
    const snap = buildUsageSnapshot({
      ...base,
      session: nativeSession(turn(), totals),
      stats: {
        costUsd: null, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: null,
        duration: null, apiDuration: null, linesAdded: 0, linesRemoved: 0,
      },
    });
    expect(snap!.inputTokens).toBe(4_000);
    expect(snap!.outputTokens).toBe(0);
    expect(snap!.cacheReadTokens).toBe(0);
    expect(snap!.cacheCreationTokens).toBe(0);
    expect(snap!.linesAdded).toBe(0);
  });

  it('carries the real native totals through when there are some', () => {
    const totals = { ...emptyTotals(), inputTokens: 1200, outputTokens: 340, costUsd: 1.5, anyPriced: true, specialistRuns: 2 };
    const snap = buildUsageSnapshot({ ...base, isNative: true, session: nativeSession(turn(), totals) });
    expect(snap!.inputTokens).toBe(1200);
    expect(snap!.outputTokens).toBe(340);
    expect(snap!.costUsd).toBe(1.5);
    expect(snap!.specialistRuns).toBe(2);
  });
});

describe('buildUsageSnapshot — context', () => {
  // Task 26 item 1: the bar showed a context pill for a native session and the
  // card showed no context row at all, because the card only ever read the
  // Claude Code statusline's contextPercent. Two surfaces, one session, two
  // answers — the exact thing this work exists to prevent. The card now reads
  // the SAME selector the bar does, with the same `??` precedence.
  const usage = turn({ contextLength: 200_000, contextUsedTokens: 78_000 });

  it('fills a native session’s context from the same figure the status bar shows', () => {
    const snap = buildUsageSnapshot({ ...base, isNative: true, session: nativeSession(usage) });
    const barPct = selectNativeStatusChips(usage, usage.contextLength)!.contextPct;
    expect(barPct).toBe(61);
    expect(snap!.contextPercent).toBe(barPct);
  });

  it('lets the Claude Code statusline win where it exists, exactly as the bar does', () => {
    const snap = buildUsageSnapshot({ ...base, isNative: true, contextPercent: 12, session: nativeSession(usage) });
    expect(snap!.contextPercent).toBe(12);
  });

  it('leaves context absent when a native session has no context reading', () => {
    const snap = buildUsageSnapshot({ ...base, isNative: true, session: nativeSession(turn()) });
    expect(snap!.contextPercent).toBeNull();
  });

  it('never borrows native context for a Claude Code session', () => {
    // A CC session writes no native turn usage, but the gate is explicit rather
    // than incidental: the runtime split is what keeps one label from meaning
    // two different measurements.
    //
    // Task 29 item 3: this fixture used to also pass `contextPercent: 30`, so
    // the statusline figure won no matter what the gate did and the test stayed
    // green with `isNative ?` deleted — it proved nothing its name claimed.
    // With no statusline reading at all, the ONLY way a number can appear here
    // is the native fallback firing where it must not.
    const snap = buildUsageSnapshot({ ...base, isNative: false, session: nativeSession(usage), usage: { five_hour: { utilization: 10, resets_at: 'x' } } });
    expect(snap!.contextPercent).toBeNull();
  });

  // Task 29 item 2: EVERY fixture in this file had a single-entry timeline, so
  // `lastTurnUsage` walking FORWARD instead of backward passed all 30 tests.
  // The regression that hides behind that: a native session that has run
  // several turns shows turn 1's context on this card and turn N's on the
  // status bar — two surfaces disagreeing about one session, which is the exact
  // failure this whole branch exists to stop.
  it('reads the LATEST completed turn, not the first one', () => {
    const first = turn({ contextLength: 200_000, contextUsedTokens: 20_000 });   // 90% remaining
    const latest = turn({ contextLength: 200_000, contextUsedTokens: 150_000 }); // 25% remaining
    const snap = buildUsageSnapshot({
      ...base,
      isNative: true,
      session: {
        timeline: [
          { kind: 'assistant-turn' as const, turnId: 't1' },
          { kind: 'assistant-turn' as const, turnId: 't2' },
        ],
        assistantTurns: new Map([['t1', { usage: first }], ['t2', { usage: latest }]]),
        totals: emptyTotals(),
      },
    });
    expect(snap!.contextPercent).toBe(25);
    expect(snap!.contextPercent).not.toBe(90);
  });
});

describe('buildUsageSnapshot — the rest of the shape', () => {
  it('stamps the snapshot with the time it was taken', () => {
    const snap = buildUsageSnapshot({ ...base, isNative: true, session: nativeSession(turn()) });
    expect(snap!.timestamp).toBe(base.now);
    expect(snap!.entryId).toBe(`usage-s1-${base.now}`);
  });

  it('drops an unpriced cost rather than showing a false zero, and says it is partial', () => {
    const totals = { ...emptyTotals(), inputTokens: 10, anyPriced: false, anyUnpriced: true };
    const snap = buildUsageSnapshot({ ...base, isNative: true, session: nativeSession(turn(), totals) });
    expect(snap!.costUsd).toBeNull();
    expect(snap!.costIsPartial).toBe(true);
  });

  it('carries the Claude subscription figures through untouched, in every session', () => {
    const snap = buildUsageSnapshot({
      ...base,
      isNative: true,
      session: nativeSession(turn()),
      usage: { five_hour: { utilization: 42, resets_at: 'A' }, seven_day: { utilization: 15, resets_at: 'B' } },
    });
    expect(snap!.fiveHourUtilization).toBe(42);
    expect(snap!.sevenDayResetsAt).toBe('B');
  });

  it('returns null when there is nothing at all to describe', () => {
    expect(buildUsageSnapshot(base)).toBeNull();
  });
});

// The usage cache is only rewritten while a Claude Code session is live, so a
// window whose reset time has passed must not be shown as if it were current.
describe('pruneExpiredUsage', () => {
  const NOW = Date.parse('2026-09-03T12:00:00Z');
  it('keeps windows that reset in the future', () => {
    const u = { five_hour: { utilization: 42, resets_at: '2026-09-03T15:00:00Z' } };
    expect(pruneExpiredUsage(u, NOW)).toEqual(u);
  });
  it('drops a window whose reset time has passed and keeps the other', () => {
    const u = {
      five_hour: { utilization: 95, resets_at: '2026-09-03T09:00:00Z' },
      seven_day: { utilization: 30, resets_at: '2026-09-07T09:00:00Z' },
    };
    expect(pruneExpiredUsage(u, NOW)).toEqual({ seven_day: u.seven_day });
  });
  it('returns null when every window is expired, missing, or the input is not an object', () => {
    expect(pruneExpiredUsage({ five_hour: { utilization: 95, resets_at: '2026-09-03T09:00:00Z' } }, NOW)).toBeNull();
    expect(pruneExpiredUsage(null, NOW)).toBeNull();
    expect(pruneExpiredUsage(undefined, NOW)).toBeNull();
    expect(pruneExpiredUsage({}, NOW)).toBeNull();
  });
  // Words deck W-2 = a (2026-09-05): a free ChatGPT plan reports one 30-day
  // window under `other`, and it must age out exactly like the two named ones.
  it('prunes an expired `other` window and keeps a live one', () => {
    const u = {
      five_hour: { utilization: 42, resets_at: '2026-09-03T13:00:00Z' },
      other: [
        { minutes: 43200, utilization: 3, resets_at: '2026-10-01T12:00:00Z' },
        { minutes: 120, utilization: 90, resets_at: '2026-09-03T09:00:00Z' },
      ],
    };
    expect(pruneExpiredUsage(u, NOW)).toEqual({ five_hour: u.five_hour, other: [u.other[0]] });
  });
  it('drops a window whose length did not parse, instead of letting it paint "NaNh"', () => {
    // typeof NaN === 'number', so the first guard here let a broken window
    // through and the status bar drew a chip labelled "NaNh".
    const broken = { minutes: NaN, utilization: 12, resets_at: '2026-10-01T12:00:00Z' } as any;
    const zero = { minutes: 0, utilization: 12, resets_at: '2026-10-01T12:00:00Z' } as any;
    expect(pruneExpiredUsage({ other: [broken, zero] } as any, NOW)).toBeNull();
  });
  it('drops the `other` key when every entry has expired, and returns null when nothing is left', () => {
    const expired = { minutes: 43200, utilization: 3, resets_at: '2026-09-03T09:00:00Z' };
    expect(pruneExpiredUsage({ five_hour: { utilization: 42, resets_at: '2026-09-03T13:00:00Z' }, other: [expired] }, NOW))
      .toEqual({ five_hour: { utilization: 42, resets_at: '2026-09-03T13:00:00Z' } });
    expect(pruneExpiredUsage({ other: [expired] }, NOW)).toBeNull();
    expect(pruneExpiredUsage({ other: [] }, NOW)).toBeNull();
  });
  it('carries live `other` windows into the snapshot, and omits the field when there are none', () => {
    const other = [{ minutes: 43200, utilization: 3, resets_at: 'C' }];
    const snap = buildUsageSnapshot({ ...base, isNative: true, session: nativeSession(turn()), usage: { other } });
    expect(snap!.otherWindows).toEqual(other);
    expect(snap!.fiveHourUtilization).toBeNull();
    const plain = buildUsageSnapshot({ ...base, isNative: true, session: nativeSession(turn()), usage: { five_hour: { utilization: 1, resets_at: 'A' } } });
    expect('otherWindows' in plain!).toBe(false);
  });
  it('keeps a window with an unparseable reset time rather than guessing it expired', () => {
    const u = { five_hour: { utilization: 10, resets_at: 'garbage' } };
    expect(pruneExpiredUsage(u, NOW)).toEqual(u);
  });
});
