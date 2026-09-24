/**
 * Specialists plans, Task 5a — every first-page path (app start, resume,
 * window handoff) re-sends main's memory-only state AFTER the page has been
 * reduced. Plan card records arrive in that re-send (plans:event) and are
 * dropped by the reducer when their card does not exist yet, so the order is
 * the feature.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatAction, ChatState } from '../src/renderer/state/chat-types';
import type { PlanView, TranscriptEvent, TranscriptPageResult } from '../src/shared/types';
import { loadFirstPageThenReplay } from '../src/renderer/state/first-page-load';
import { readStripped, RENDERER } from './helpers/guard-scope';

const S = 'sess';
const planEvent = (seq: number): PlanView => ({
  planId: 'plan-1', toolUseId: 'call-plan', title: 'Plan', status: 'interrupted', steps: [],
  model: { label: 'm' }, seq,
});
const pageWithPlanCard: TranscriptPageResult = {
  events: [
    { type: 'user-message', sessionId: S, uuid: 'u1', timestamp: 1, data: { text: 'plan it' } },
    { type: 'tool-use', sessionId: S, uuid: 'u2', timestamp: 2, data: { toolUseId: 'call-plan', toolName: 'propose_plan', toolInput: {} } },
  ] as TranscriptEvent[],
  cursor: null,
  hasMore: false,
};

function harness(page: () => Promise<TranscriptPageResult | null>) {
  let state: ChatState = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S });
  const log: string[] = [];
  const dispatch = (a: ChatAction) => { log.push(a.type); state = chatReducer(state, a); };
  // What main's replay does: push the current plan records (plans:event).
  const replayLiveState = vi.fn(async () => {
    log.push('replay');
    await Promise.resolve();
    dispatch({ type: 'PLAN_CHANGED', sessionId: S, plan: planEvent(4) });
  });
  return { get state() { return state; }, log, dispatch, replayLiveState, requestPage: vi.fn(page) };
}

describe('first page, then the live-state re-send', () => {
  it('replays after the page is reduced, so the plan record finds its card', async () => {
    const h = harness(async () => pageWithPlanCard);
    const done = loadFirstPageThenReplay(S, { requestPage: h.requestPage, dispatch: h.dispatch, replayLiveState: h.replayLiveState, sleep: async () => {} });
    await done;
    expect(h.log).toEqual(['HISTORY_PAGE_LOADED', 'replay', 'PLAN_CHANGED']);
    expect(h.state.get(S)!.toolCalls.get('call-plan')!.plan).toMatchObject({ status: 'interrupted', seq: 4 });
  });

  it('is not finished until the re-send is', async () => {
    let release!: () => void;
    const h = harness(async () => pageWithPlanCard);
    const replay = vi.fn(() => new Promise<void>((r) => { release = r; }));
    let finished = false;
    const done = loadFirstPageThenReplay(S, { requestPage: h.requestPage, dispatch: h.dispatch, replayLiveState: replay }).then(() => { finished = true; });
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    release();
    await done;
    expect(finished).toBe(true);
  });

  it('still re-sends when the page failed (an open ask must reach the user)', async () => {
    const h = harness(async () => null);
    expect(await loadFirstPageThenReplay(S, { requestPage: h.requestPage, dispatch: h.dispatch, replayLiveState: h.replayLiveState })).toBe('failed');
    expect(h.log.slice(0, 2)).toEqual(['HISTORY_PAGE_FAILED', 'replay']);
  });

  it('retries an unresolved page before recording it, then replays once', async () => {
    const pages: TranscriptPageResult[] = [{ events: [], cursor: null, hasMore: false, unresolved: true }, pageWithPlanCard];
    const h = harness(async () => pages.shift()!);
    await loadFirstPageThenReplay(S, { requestPage: h.requestPage, dispatch: h.dispatch, replayLiveState: h.replayLiveState, sleep: async () => {} });
    expect(h.requestPage).toHaveBeenCalledTimes(2);
    expect(h.replayLiveState).toHaveBeenCalledTimes(1);
    expect(h.log[0]).toBe('HISTORY_PAGE_LOADED');
  });

  it('a failed re-send leaves the page in place', async () => {
    const h = harness(async () => pageWithPlanCard);
    await expect(loadFirstPageThenReplay(S, { requestPage: h.requestPage, dispatch: h.dispatch, replayLiveState: async () => { throw new Error('gone'); } })).resolves.toBe('loaded');
    expect(h.state.get(S)!.toolCalls.has('call-plan')).toBe(true);
  });
});

describe('App.tsx sends every first-page path through the chained loader', () => {
  const app = readStripped(join(RENDERER, 'App.tsx'));

  it('loadFirstPage is the chained loader, given the live-state re-send', () => {
    const at = app.indexOf('const loadFirstPage = useCallback(');
    expect(at).toBeGreaterThan(0);
    const body = app.slice(at, app.indexOf('}, [dispatch, chatStore]);', at));
    expect(body).toMatch(/loadFirstPageThenReplay\(/);
    expect(body).toMatch(/replayLiveState/);
    // The retry loop now lives in the helper; a second copy here would skip the re-send.
    expect(body).not.toMatch(/decideFirstPage\(/);
  });

  it('no call site chains its own re-send (it would run before the page on a shared load)', () => {
    // Each call's whole statement (up to its semicolon).
    const calls = [...app.matchAll(/loadFirstPage\(/g)].map((m) => app.slice(m.index!, app.indexOf(';', m.index!)));
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) expect(c).not.toMatch(/replayLiveState/);
  });

  it('plan records reach the reducer in order with the transcript events they depend on', () => {
    const at = app.indexOf('on.planEvent');
    expect(at).toBeGreaterThan(0);
    const block = app.slice(at, app.indexOf('});', at));
    expect(block).toMatch(/batchTranscriptDispatch\(\{ type: 'PLAN_CHANGED'/);
  });

  // The buddy floater is a separate window with its own reducer and its own
  // first page — the same rules apply there (MUST mirror App.tsx).
  it('the buddy feed uses the same chained loader and batches plan records', () => {
    const buddy = readStripped(join(RENDERER, 'components/buddy/BubbleFeed.tsx'));
    expect(buddy).toMatch(/loadFirstPageThenReplay\(sessionId/);
    expect(buddy).not.toMatch(/decideFirstPage\(/);
    const at = buddy.indexOf('on.planEvent');
    expect(at).toBeGreaterThan(0);
    expect(buddy.slice(at, buddy.indexOf('});', at))).toMatch(/batchDispatch\(\{ type: 'PLAN_CHANGED'/);
  });
});
