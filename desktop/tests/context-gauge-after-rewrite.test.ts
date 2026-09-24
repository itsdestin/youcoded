// The renderer half of "a /compact or /clear moves the context gauge".
//
// The native gauge is derived from the usage stamped on the last COMPLETED turn,
// and neither /compact nor /clear runs a turn — so the chip kept showing the
// pre-compaction window until the user happened to send another message, and
// after /clear it could sit at "3% remaining" over an empty conversation
// (Destin, 2026-09-16). The harness now re-bases its own figure and ships it on
// the rewrite's event; these pin what the renderer does with it.
//
// Companion files: native-context-occupancy.test.ts (the harness half),
// statusbar-native-usage.test.ts (the rest of the chip selector).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState, ChatAction } from '../src/renderer/state/chat-types';
import { selectNativeStatusChips } from '../src/renderer/components/StatusBar';
import { buildUsageSnapshot } from '../src/renderer/state/usage-snapshot';
import { pageEventToAction } from '../src/renderer/state/transcript-page-actions';
import { emptyTotals } from '../src/renderer/state/session-totals';
import type { TranscriptEvent } from '../src/shared/types';

const SESSION = 'gauge-session';
const init = (): ChatState => chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SESSION });
const run = (state: ChatState, action: ChatAction) => chatReducer(state, action);
const sess = (state: ChatState) => state.get(SESSION)!;

const TURN_USAGE = {
  inputTokens: 60_000, outputTokens: 900, cacheReadTokens: 0, cacheCreationTokens: 0,
  contextLength: 100_000, contextUsedTokens: 80_000,
};

describe('selectNativeStatusChips — the re-based occupancy wins', () => {
  it('prefers the override over the last turn’s measurement', () => {
    const stale = selectNativeStatusChips(TURN_USAGE, 100_000)!;
    expect(stale.contextPct).toBe(20);              // 80k of 100k used

    const rebased = selectNativeStatusChips(TURN_USAGE, 100_000, 12_000)!;
    expect(rebased.contextUsedTokens).toBe(12_000);
    expect(rebased.contextPct).toBe(88);
  });

  it('treats a re-based ZERO as a reading, not as absent', () => {
    // A /clear on a session with no system prompt genuinely leaves nothing
    // behind. `?? ` and not a truthiness check is what keeps that from falling
    // through to the stale turn — the difference between "empty" and "80% full".
    const cleared = selectNativeStatusChips(TURN_USAGE, 100_000, 0)!;
    expect(cleared.contextUsedTokens).toBe(0);
    expect(cleared.contextPct).toBe(100);
  });

  it('falls back to the turn when there is no override', () => {
    expect(selectNativeStatusChips(TURN_USAGE, 100_000, null)!.contextPct).toBe(20);
    expect(selectNativeStatusChips(TURN_USAGE, 100_000, undefined)!.contextPct).toBe(20);
  });

  it('the /usage card reads the override through the SAME selector as the bar', () => {
    // The two surfaces resolving context separately is how they came to disagree
    // before; this pins that the card cannot drift from the chip again.
    const session = {
      timeline: [{ kind: 'assistant-turn' as const, turnId: 't1' }],
      assistantTurns: new Map([['t1', { usage: TURN_USAGE }]]),
      totals: emptyTotals(),
      contextUsedOverride: 12_000,
    };
    const snap = buildUsageSnapshot({
      sessionId: SESSION, now: 1, stats: null, contextPercent: null, usage: null,
      isNative: true, session,
    })!;
    expect(snap.contextPercent).toBe(88);
    expect(snap.contextPercent).toBe(selectNativeStatusChips(TURN_USAGE, 100_000, 12_000)!.contextPct);
  });
});

describe('NATIVE_HISTORY_REWRITTEN', () => {
  it('records the new occupancy and bills the summarize call once', () => {
    let state = init();
    state = run(state, {
      type: 'NATIVE_HISTORY_REWRITTEN', sessionId: SESSION, uuid: 'evt-1',
      contextUsedTokens: 12_000,
      usage: { inputTokens: 40_000, outputTokens: 600, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.13 },
    });
    expect(sess(state).contextUsedOverride).toBe(12_000);
    expect(sess(state).totals.inputTokens).toBe(40_000);
    expect(sess(state).totals.costUsd).toBeCloseTo(0.13, 10);

    // A re-dock replay re-delivers the same event. addTurnUsage is not
    // idempotent, so the uuid guard is what stops the summary being billed twice.
    state = run(state, {
      type: 'NATIVE_HISTORY_REWRITTEN', sessionId: SESSION, uuid: 'evt-1',
      contextUsedTokens: 12_000,
      usage: { inputTokens: 40_000, outputTokens: 600, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.13 },
    });
    expect(sess(state).totals.inputTokens).toBe(40_000);
    expect(sess(state).totals.costUsd).toBeCloseTo(0.13, 10);
  });

  it('a /clear carries occupancy and no bill', () => {
    let state = init();
    state = run(state, {
      type: 'NATIVE_HISTORY_REWRITTEN', sessionId: SESSION, uuid: 'evt-clear', contextUsedTokens: 800,
    });
    expect(sess(state).contextUsedOverride).toBe(800);
    expect(sess(state).totals.inputTokens).toBe(0);
  });

  it('a completed turn supersedes the override — a measurement beats a re-base', () => {
    let state = init();
    state = run(state, {
      type: 'NATIVE_HISTORY_REWRITTEN', sessionId: SESSION, uuid: 'evt-2', contextUsedTokens: 12_000,
    });
    expect(sess(state).contextUsedOverride).toBe(12_000);

    state = run(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SESSION, uuid: 'turn-1', timestamp: 2,
      stopReason: 'end_turn', model: 'm', anthropicRequestId: null, usage: TURN_USAGE,
    } as ChatAction);
    expect(sess(state).contextUsedOverride).toBeNull();
  });
});

describe('the compaction marker can finally say what it freed', () => {
  it('uses the harness’s own before/after pair', () => {
    // A native session writes no Claude Code statusline, so compactionPending's
    // beforeContextTokens is null for it — and a SPONTANEOUS compaction has no
    // compactionPending at all. Both operands had to come from the event.
    let state = init();
    state = run(state, {
      type: 'COMPACTION_COMPLETE', sessionId: SESSION, markerId: 'm1', auto: true,
      beforeContextTokens: 80_000, afterContextTokens: 12_000,
    });
    const marker = sess(state).timeline.find((e: any) => e.kind === 'system-marker') as any;
    expect(marker.marker.label).toBe('Compacted · freed 68,000 tokens');
  });

  it('auto compaction keeps an active native turn and its running tool alive, with one marker on replay', () => {
    let state = init();
    const current = sess(state);
    state = new Map(state).set(SESSION, { ...current, isThinking: true,
      activeTurnToolIds: new Set(['running-tool']), currentTurnId: 'turn-live',
      toolCalls: new Map([['background-specialist', { status: 'running', name: 'Task' } as any]]),
      timeline: [...current.timeline, { kind: 'compacting', id: 'spinner' } as any],
    });
    const action: ChatAction = { type: 'COMPACTION_COMPLETE', sessionId: SESSION,
      markerId: 'compact-1', auto: true, beforeContextTokens: 80_000,
      afterContextTokens: 12_000, summary: 'summary' };
    state = run(state, action);
    expect(sess(state).isThinking).toBe(true);
    expect(sess(state).currentTurnId).toBe('turn-live');
    expect(sess(state).activeTurnToolIds.has('running-tool')).toBe(true);
    expect(sess(state).toolCalls.get('background-specialist')?.status).toBe('running');
    expect(sess(state).timeline.filter(e => e.kind === 'compacting')).toHaveLength(0);
    expect(sess(state).timeline.filter(e => e.kind === 'system-marker' && e.marker.id === 'compact-1')).toHaveLength(1);
    state = run(state, action);
    expect(sess(state).timeline.filter(e => e.kind === 'system-marker' && e.marker.id === 'compact-1')).toHaveLength(1);
  });

  it('carries the kept tail\'s first user message onto the marker (null too); CC markers stay without it', () => {
    for (const retainedFromUuid of ['u-kept', null] as const) {
      const state = run(init(), { type: 'COMPACTION_COMPLETE', sessionId: SESSION, markerId: 'k', auto: true,
        afterContextTokens: 1, retainedFromUuid });
      const marker = sess(state).timeline.find((e: any) => e.kind === 'system-marker') as any;
      expect(marker.marker.retainedFromUuid).toBe(retainedFromUuid);
    }
    let cc = run(init(), { type: 'COMPACTION_PENDING', sessionId: SESSION, cardId: 'p', beforeContextTokens: 1 });
    cc = run(cc, { type: 'COMPACTION_COMPLETE', sessionId: SESSION, markerId: 'cc', afterContextTokens: 1 });
    const marker = sess(cc).timeline.find((e: any) => e.kind === 'system-marker') as any;
    expect('retainedFromUuid' in marker.marker).toBe(false);
  });

  it('a stopped native summary drops its card with no marker; awaitsResult is kept for the watchdog', () => {
    let state = run(init(), { type: 'COMPACTION_PENDING', sessionId: SESSION, cardId: 'p', beforeContextTokens: null, awaitsResult: true });
    expect(sess(state).compactionPending?.awaitsResult).toBe(true);
    state = run(state, { type: 'COMPACTION_CANCELLED', sessionId: SESSION });
    expect(sess(state).compactionPending).toBeNull();
    expect(sess(state).timeline.filter(e => e.kind === 'compacting' || e.kind === 'system-marker')).toHaveLength(0);
    // Idempotent: nothing pending → same state object.
    expect(run(state, { type: 'COMPACTION_CANCELLED', sessionId: SESSION })).toBe(state);
  });

  it('native /compact marks its card awaitsResult so the 3-minute watchdog never guesses; CC does not', async () => {
    const { dispatchSlashCommand } = await import('../src/renderer/state/slash-command-dispatcher');
    for (const native of [true, false]) {
      const dispatch = vi.fn();
      dispatchSlashCommand({ raw: '/compact', sessionId: SESSION, view: 'chat', files: [], dispatch, timeline: [],
        callbacks: {}, deferUiEffectsToRuntime: native } as any);
      const pending = dispatch.mock.calls.map(c => c[0]).find(a => a.type === 'COMPACTION_PENDING');
      expect(pending.awaitsResult).toBe(native ? true : undefined);
    }
  });

  it('a Stop during native /compact cancels the card instead of "Compaction may have failed"', async () => {
    const { runNativeSlashAction } = await import('../src/renderer/state/native-slash-actions');
    const dispatch = vi.fn();
    const onToast = vi.fn();
    (globalThis as any).window = { claude: { native: { compact: async () => ({ ok: false, reason: 'interrupted' }) } } };
    try {
      expect(await runNativeSlashAction({ kind: 'compact' }, { sessionId: SESSION, dispatch, onToast })).toBe(false);
    } finally { delete (globalThis as any).window; }
    expect(dispatch).toHaveBeenCalledWith({ type: 'COMPACTION_CANCELLED', sessionId: SESSION });
    expect(onToast).toHaveBeenCalledWith('Compaction stopped. The conversation was left as it was.');
  });

  it('manual /compact and Claude Code completion still close the active turn', () => {
    for (const native of [true, false]) {
      let state = init();
      const current = sess(state);
      state = new Map(state).set(SESSION, { ...current, isThinking: true,
        activeTurnToolIds: new Set(['tool']), currentTurnId: 'turn-live' });
      state = run(state, { type: 'COMPACTION_PENDING', sessionId: SESSION, cardId: 'pending', beforeContextTokens: 80_000 });
      state = run(state, { type: 'COMPACTION_COMPLETE', sessionId: SESSION,
        markerId: native ? 'manual-native' : 'manual-cc', afterContextTokens: 12_000 });
      expect(sess(state).isThinking).toBe(false);
      expect(sess(state).currentTurnId).toBeNull();
      expect(sess(state).activeTurnToolIds.size).toBe(0);
    }
  });

  it('uses the transcript uuid as the marker id so the reducer can dedupe event replay', () => {
    // WHY a cross-file source guard: the App transcript callback depends on live
    // IPC wiring, while the reducer's replay test above alone cannot catch a
    // fresh clock-based id minted by the event adapter on every delivery.
    const source = readFileSync(fileURLToPath(new URL('../src/renderer/App.tsx', import.meta.url)), 'utf8');
    const compactCase = source.split("case 'compact-summary': {")[1]?.split("case '")[0];
    expect(compactCase).toMatch(/markerId:\s*`compact-done-\$\{event\.uuid\}`/);
  });

  it('still falls back to Claude Code’s own reading when the event carries none', () => {
    let state = init();
    state = run(state, { type: 'COMPACTION_PENDING', sessionId: SESSION, cardId: 'c1', beforeContextTokens: 50_000 });
    state = run(state, {
      type: 'COMPACTION_COMPLETE', sessionId: SESSION, markerId: 'm2', afterContextTokens: 20_000,
    });
    const marker = sess(state).timeline.find((e: any) => e.kind === 'system-marker') as any;
    expect(marker.marker.label).toBe('Compacted · freed 30,000 tokens');
  });
});

describe('page replay carries the bookkeeping a resumed session would otherwise lose', () => {
  const ev = (over: Partial<TranscriptEvent>): TranscriptEvent => ({
    type: 'turn-complete', sessionId: SESSION, uuid: 'u', timestamp: 1, data: {}, ...over,
  } as TranscriptEvent);

  it('maps subagent-usage — a specialist’s whole spend used to vanish on every reopen', () => {
    const action = pageEventToAction(ev({
      type: 'subagent-usage', uuid: 'sa-1',
      data: {
        usage: { inputTokens: 5000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.02 },
        parentAgentToolUseId: 'tool-9', agentId: 'agent-3',
      },
    }))!;
    expect(action.type).toBe('TRANSCRIPT_SUBAGENT_USAGE');

    let state = init();
    state = run(state, action);
    expect(sess(state).totals.specialistRuns).toBe(1);
    expect(sess(state).totals.inputTokens).toBe(5000);
  });

  it('maps compact-summary to its bookkeeping half, and to nothing when it carries none', () => {
    const action = pageEventToAction(ev({
      type: 'compact-summary', uuid: 'cs-1',
      data: { summary: 'they discussed X', contextUsedAfter: 12_000, usage: { inputTokens: 40_000, outputTokens: 600, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    }))!;
    expect(action.type).toBe('NATIVE_HISTORY_REWRITTEN');

    // A Claude Code compact-summary has neither field — nothing to replay.
    expect(pageEventToAction(ev({ type: 'compact-summary', uuid: 'cs-2', data: { summary: 'cc summary' } }))).toBeNull();
  });

  // Review finding, 2026-09-16: the protection here is that HISTORY_PAGE_LOADED
  // does NOT take the scratch replay's override. That was an omission rather
  // than a mechanism, and nothing drove the action, so a later "consistency fix"
  // adding `contextUsedOverride: pageSess.contextUsedOverride` would have rolled
  // the gauge backwards in silence.
  it('an OLDER page’s compaction cannot roll the live gauge backwards', () => {
    let state = init();
    // Live: an old compaction, then a turn that measured the window for real.
    state = run(state, {
      type: 'NATIVE_HISTORY_REWRITTEN', sessionId: SESSION, uuid: 'old-compact', contextUsedTokens: 12_000,
    });
    state = run(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SESSION, uuid: 'turn-live', timestamp: 3,
      stopReason: 'end_turn', model: 'm', anthropicRequestId: null, usage: TURN_USAGE,
    } as ChatAction);
    expect(sess(state).contextUsedOverride).toBeNull();

    // A page of OLDER history arrives and is prepended. It contains that same
    // compaction, plus a specialist's spend that SHOULD still be counted.
    state = run(state, {
      type: 'HISTORY_PAGE_LOADED', sessionId: SESSION, cursor: null, hasMore: false,
      events: [
        { type: 'compact-summary', sessionId: SESSION, uuid: 'older-compact', timestamp: 1,
          data: { summary: 's', contextUsedAfter: 4_000 } },
        { type: 'subagent-usage', sessionId: SESSION, uuid: 'older-spec', timestamp: 2,
          data: { usage: { inputTokens: 700, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 }, parentAgentToolUseId: 't', agentId: 'a' } },
      ],
    } as unknown as ChatAction);

    // The gauge keeps the LIVE answer (a real measurement)…
    expect(sess(state).contextUsedOverride).toBeNull();
    // …while the page's bookkeeping still lands: the live turn's 60,000 plus the
    // 700 the older page's specialist spent.
    expect(sess(state).totals.inputTokens).toBe(60_700);
    expect(sess(state).totals.specialistRuns).toBe(1);
  });

  it('a re-delivered rewrite does not roll back a newer measurement', () => {
    let state = init();
    state = run(state, {
      type: 'NATIVE_HISTORY_REWRITTEN', sessionId: SESSION, uuid: 'c1', contextUsedTokens: 12_000,
    });
    state = run(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SESSION, uuid: 'turn-x', timestamp: 2,
      stopReason: 'end_turn', model: 'm', anthropicRequestId: null, usage: TURN_USAGE,
    } as ChatAction);
    expect(sess(state).contextUsedOverride).toBeNull();

    // The same compaction event again (a re-dock replay). Its figure is stale now.
    state = run(state, {
      type: 'NATIVE_HISTORY_REWRITTEN', sessionId: SESSION, uuid: 'c1', contextUsedTokens: 12_000,
    });
    expect(sess(state).contextUsedOverride).toBeNull();
  });

  it('carries an interrupted turn’s usage, deduped against the live stream', () => {
    const action = pageEventToAction(ev({
      type: 'user-interrupt', uuid: 'int-1',
      data: { usage: { inputTokens: 300_000, outputTokens: 8000, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1.02 } },
    }))! as any;
    expect(action.type).toBe('TRANSCRIPT_INTERRUPT');

    let state = init();
    state = run(state, action);
    expect(sess(state).totals.inputTokens).toBe(300_000);
    expect(sess(state).totals.costUsd).toBeCloseTo(1.02, 10);

    state = run(state, action);   // replayed
    expect(sess(state).totals.inputTokens).toBe(300_000);
  });
});
