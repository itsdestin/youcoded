/**
 * Specialists plans, Task 5a — the renderer half of real plan state.
 *
 * A plan card's state is the host's journal projection (PlanView), landed by
 * PLAN_CHANGED and carried on the propose_plan tool events. Its specialist
 * rows get their live activity and their permission asks from the SAME
 * stamped events an ordinary specialist's card gets — except a plan card has
 * many specialists, so every row is filed by the child that produced it.
 */
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState, ChatAction } from '../src/renderer/state/chat-types';
import type { PlanView, PlanChildView, SubagentSegment } from '../src/shared/types';
import { planWithActivity } from '../src/renderer/components/plans/plan-activity';
import { hasNestedAsk, hasPlanChildAsk, helperAsksOf, hasOpenSpecialistAsk } from '../src/renderer/utils/specialist-cards';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';

const S = 'sess';
const CARD = 'call-plan';
const A = 'child-a';
const B = 'child-b';

const run = (state: ChatState, ...actions: ChatAction[]) => actions.reduce(chatReducer, state);

function child(childId: string, over: Partial<PlanChildView> = {}): PlanChildView {
  return {
    childId, parentToolCallId: CARD, agentType: 'reviewer', title: `${childId} the Reviewer`,
    background: false, status: 'running', startedAt: 1,
    planAttempt: { stepId: 's1', attemptId: `att-${childId}`, itemIndex: 0, iteration: 0 },
    ...over,
  };
}

function plan(over: Partial<PlanView> = {}): PlanView {
  return {
    planId: 'plan-1', toolUseId: CARD, title: 'Review two files', status: 'running',
    steps: [{ id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 2, status: 'running', children: [child(A), child(B)] }],
    ceilingTokens: 4000, ceilingUsd: null, model: { label: 'm' }, seq: 3,
    ...over,
  };
}

function seeded(): ChatState {
  return run(new Map(),
    { type: 'SESSION_INIT', sessionId: S },
    { type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u-plan', toolUseId: CARD, toolName: 'propose_plan', toolInput: {} },
    { type: 'TRANSCRIPT_TOOL_RESULT', sessionId: S, uuid: 'u-plan-r', toolUseId: CARD, result: 'Plan proposed.', isError: false, plan: plan({ status: 'proposed', seq: 1 }) },
  );
}

const card = (state: ChatState) => state.get(S)!.toolCalls.get(CARD)!;
const segsOf = (state: ChatState, childId: string) => (card(state).subagentSegments ?? []).filter((s) => s.childId === childId);

const toolUse = (agentId: string | undefined, toolUseId: string, input: Record<string, unknown> = { file_path: 'a.ts' }, name = 'Read'): ChatAction => ({
  type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: `u-${agentId}-${toolUseId}`, toolUseId, toolName: name, toolInput: input,
  timestamp: 10, parentAgentToolUseId: CARD, agentId,
});
const toolResult = (agentId: string, toolUseId: string, result = 'ok'): ChatAction => ({
  type: 'TRANSCRIPT_TOOL_RESULT', sessionId: S, uuid: `r-${agentId}-${toolUseId}`, toolUseId, result, isError: false,
  parentAgentToolUseId: CARD, agentId,
});
const text = (agentId: string, t: string, partId = 'p1', uuid = `t-${agentId}-${t}`): ChatAction => ({
  type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: S, uuid, text: t, timestamp: 11, partId, parentAgentToolUseId: CARD, agentId,
});
const thinking = (agentId: string, t: string, partId = 'r1'): ChatAction => ({
  type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: S, uuid: `th-${agentId}-${t}`, text: t, timestamp: 12, partId, parentAgentToolUseId: CARD, agentId,
});
const ask = (childId: string, requestId: string, input: Record<string, unknown> = { command: 'rm -rf build' }, toolName = 'Bash'): ChatAction => ({
  type: 'PERMISSION_REQUEST', sessionId: S, toolName, input, requestId,
  specialist: { childId, agentType: 'reviewer', title: `${childId} the Reviewer`, parentToolCallId: CARD, plan: { planId: 'plan-1', stepId: 's1', attemptId: `att-${childId}` } },
});

describe('plan records: latest seq wins', () => {
  it('lands a newer record, ignores an older one, and never touches a card it does not name', () => {
    let s = seeded();
    expect(card(s).plan).toMatchObject({ status: 'proposed', seq: 1 });
    s = run(s, { type: 'PLAN_CHANGED', sessionId: S, plan: plan({ status: 'running', seq: 3 }) });
    expect(card(s).plan).toMatchObject({ status: 'running', seq: 3 });
    const before = s;
    s = run(s, { type: 'PLAN_CHANGED', sessionId: S, plan: plan({ status: 'proposed', seq: 2 }) });
    expect(s).toBe(before);
    // A card not on screen: nothing visible changes (the record is only kept —
    // see "a plan record whose card is on a page not loaded yet" below).
    s = run(s, { type: 'PLAN_CHANGED', sessionId: S, plan: plan({ toolUseId: 'call-unknown', seq: 9 }) });
    expect(s.get(S)!.toolCalls).toBe(before.get(S)!.toolCalls);
    expect(s.get(S)!.timeline).toBe(before.get(S)!.timeline);
    const kept = s;
    s = run(s, { type: 'PLAN_CHANGED', sessionId: 'no-such-session', plan: plan({ seq: 9 }) });
    expect(s).toBe(kept);
  });

  it('a replayed propose_plan event never rewinds a newer record or wipes it', () => {
    let s = run(seeded(), { type: 'PLAN_CHANGED', sessionId: S, plan: plan({ status: 'running', seq: 5 }) });
    // The tool-result replays with the proposal-time projection…
    s = run(s, { type: 'TRANSCRIPT_TOOL_RESULT', sessionId: S, uuid: 'u-plan-r2', toolUseId: CARD, result: 'Plan proposed.', isError: false, plan: plan({ status: 'proposed', seq: 1 }) });
    expect(card(s).plan).toMatchObject({ status: 'running', seq: 5 });
    // …and a re-emitted tool-use carries no plan at all.
    s = run(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u-plan-again', toolUseId: CARD, toolName: 'propose_plan', toolInput: {} });
    expect(card(s).plan).toMatchObject({ status: 'running', seq: 5 });
  });
});

describe('plan specialists: live activity lands in the owning row', () => {
  it('files tool calls, text and thinking under the specialist that produced them', () => {
    const s = run(seeded(),
      toolUse(A, 'call_0'), toolUse(B, 'call_0', { file_path: 'b.ts' }),
      toolResult(A, 'call_0', 'A read'), toolResult(B, 'call_0', 'B read'),
      text(A, 'Hello '), text(B, 'Other '), text(A, 'world'),
      thinking(A, 'hmm'), thinking(B, 'huh'),
    );
    const a = segsOf(s, A);
    const b = segsOf(s, B);
    // Local models reuse ids like call_0 and part ids like p1: each child keeps its own.
    expect(a.filter((x) => x.type === 'tool')).toMatchObject([{ toolUseId: 'call_0', status: 'complete', response: 'A read', input: { file_path: 'a.ts' } }]);
    expect(b.filter((x) => x.type === 'tool')).toMatchObject([{ toolUseId: 'call_0', status: 'complete', response: 'B read', input: { file_path: 'b.ts' } }]);
    expect(a.filter((x) => x.type === 'text').map((x) => (x as any).content)).toEqual(['Hello world']);
    expect(b.filter((x) => x.type === 'text').map((x) => (x as any).content)).toEqual(['Other ']);
    expect(a.filter((x) => x.type === 'thinking').map((x) => (x as any).content)).toEqual(['hmm']);
    expect(b.filter((x) => x.type === 'thinking').map((x) => (x as any).content)).toEqual(['huh']);
    // Nothing unowned piles up on the card.
    expect((card(s).subagentSegments ?? []).every((x) => x.childId === A || x.childId === B)).toBe(true);
  });

  it('drops a plan-card event that names no specialist instead of piling it up unrendered', () => {
    const s = seeded();
    const after = run(s, toolUse(undefined, 'x1'), { ...(text(A, 'x') as any), agentId: undefined });
    expect(card(after).subagentSegments ?? []).toEqual([]);
  });

  it('the row a specialist renders is built from its own segments', () => {
    const s = run(seeded(), { type: 'PLAN_CHANGED', sessionId: S, plan: plan() }, toolUse(A, 'call_0'), text(B, 'b says'));
    const view = planWithActivity(card(s).plan!, card(s).subagentSegments);
    const [ra, rb] = view.steps[0].children!;
    expect(ra.segments!.map((x) => x.type)).toEqual(['tool']);
    expect(rb.segments!.map((x) => x.type)).toEqual(['text']);
    // Nothing to add → the very same record (memo-friendly).
    const bare = plan();
    expect(planWithActivity(bare, [])).toBe(bare);
    // A record that already carries segments (workbench fixtures) keeps them when the card has none for that row.
    const fixture = plan({ steps: [{ ...plan().steps[0], children: [child(A, { segments: [{ type: 'text', id: 'f', content: 'fixture' }] })] }] });
    expect(planWithActivity(fixture, undefined).steps[0].children![0].segments).toEqual([{ type: 'text', id: 'f', content: 'fixture' }]);
  });
});

describe('plan specialists: routed asks are answerable in the owning row', () => {
  it('parses the plan identity a routed ask carries', () => {
    const action = hookEventToAction({
      type: 'PermissionRequest', sessionId: S, timestamp: 1,
      payload: {
        tool_name: 'Bash', tool_input: { command: 'ls' }, _requestId: 'r1',
        specialist: { childId: A, agentType: 'reviewer', title: 'A', parentToolCallId: CARD, plan: { planId: 'plan-1', stepId: 's1', attemptId: 'att' } },
      },
    } as any);
    expect(action).toMatchObject({ type: 'PERMISSION_REQUEST', specialist: { childId: A, parentToolCallId: CARD, plan: { planId: 'plan-1', stepId: 's1', attemptId: 'att' } } });
  });

  it('binds to the asking specialist\'s own running call, never a sibling\'s same-named one', () => {
    let s = run(seeded(),
      toolUse(B, 'call_b', { command: 'rm -rf build' }, 'Bash'),
      toolUse(A, 'call_a', { command: 'rm -rf build' }, 'Bash'),
      ask(A, 'req-1'),
    );
    expect(segsOf(s, A)).toMatchObject([{ toolUseId: 'call_a', status: 'awaiting-approval', requestId: 'req-1' }]);
    expect(segsOf(s, B)).toMatchObject([{ toolUseId: 'call_b', status: 'running' }]);
    expect(segsOf(s, B)[0]).not.toHaveProperty('requestId');
    expect(hasPlanChildAsk(card(s))).toBe(true);
    // Task cards keep their own predicate; the plan card is not force-opened by it.
    expect(hasNestedAsk(card(s))).toBe(false);
    // The ordinary answer path clears it (PermissionButtons → respondToPermission → PERMISSION_RESPONDED).
    s = run(s, { type: 'PERMISSION_RESPONDED', sessionId: S, requestId: 'req-1' });
    expect(segsOf(s, A)).toMatchObject([{ toolUseId: 'call_a', status: 'running' }]);
    expect(hasPlanChildAsk(card(s))).toBe(false);
  });

  it('an ask that beats its tool call is reclaimed only by the same specialist', () => {
    let s = run(seeded(), ask(A, 'req-2'));
    expect(segsOf(s, A)).toMatchObject([{ id: 'sa-perm-req-2', status: 'awaiting-approval', childId: A }]);
    // A sibling's identical call must not take A's ask.
    s = run(s, toolUse(B, 'call_b', { command: 'rm -rf build' }, 'Bash'));
    expect(segsOf(s, B)).toMatchObject([{ toolUseId: 'call_b', status: 'running' }]);
    expect(segsOf(s, A)).toMatchObject([{ id: 'sa-perm-req-2', status: 'awaiting-approval' }]);
    s = run(s, toolUse(A, 'call_a', { command: 'rm -rf build' }, 'Bash'));
    expect(segsOf(s, A)).toMatchObject([{ id: 'sa-tool-call_a', toolUseId: 'call_a', status: 'awaiting-approval', requestId: 'req-2' }]);
  });

  // Merge with master (2026-09-16): the 5-minute "held" state no longer
  // exists, so only expiry is left to reach a nested plan ask.
  it('expiry reaches the nested plan ask like any specialist ask', () => {
    let s = run(seeded(), toolUse(A, 'call_a', { command: 'rm -rf build' }, 'Bash'), ask(A, 'req-3'));
    expect(segsOf(s, A)[0]).toMatchObject({ status: 'awaiting-approval' });
    s = run(s, { type: 'PERMISSION_EXPIRED', sessionId: S, requestId: 'req-3' });
    expect(segsOf(s, A)[0]).toMatchObject({ status: 'failed' });
  });
});

// Merge with master (2026-09-16, #489): master lifts every waiting specialist
// request into the bottom-of-chat approval cards and the buddy feed
// (helperAsksOf), scanning Task cards. A plan's specialist asks from inside the
// PLAN card, and the branch already turns the dot red for it — so the bottom
// cards must list it too, or the dot would point at nothing to answer.
describe('plan specialists: a waiting ask joins the bottom-of-chat cards', () => {
  it('lists a plan specialist\'s ask under that specialist\'s own name, once, until answered', () => {
    let s = run(seeded(),
      { type: 'PLAN_CHANGED', sessionId: S, plan: plan() },
      toolUse(A, 'call_a', { command: 'rm -rf build' }, 'Bash'),
      toolUse(B, 'call_b', { command: 'ls' }, 'Bash'),
      ask(A, 'req-9'),
    );
    const calls = s.get(S)!.toolCalls;
    expect(hasOpenSpecialistAsk(calls)).toBe(true);
    const asks = helperAsksOf(calls);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      toolUseId: 'call_a', toolName: 'Bash', status: 'awaiting-approval', requestId: 'req-9',
      // Named from the plan record's row for THIS child, never the sibling's.
      specialist: { childId: A, agentType: 'reviewer', title: `${A} the Reviewer` },
    });
    s = run(s, { type: 'PERMISSION_RESPONDED', sessionId: S, requestId: 'req-9' });
    expect(helperAsksOf(s.get(S)!.toolCalls)).toEqual([]);
    expect(hasOpenSpecialistAsk(s.get(S)!.toolCalls)).toBe(false);
  });

  it('still names the ask when the plan record has not arrived yet', () => {
    const s = run(seeded(), toolUse(A, 'call_a', { command: 'rm -rf build' }, 'Bash'), ask(A, 'req-10'));
    // seeded() carries a proposal-time record whose rows do not include A yet.
    const calls = new Map(s.get(S)!.toolCalls);
    calls.set(CARD, { ...calls.get(CARD)!, plan: undefined });
    expect(helperAsksOf(calls)).toMatchObject([{ requestId: 'req-10', specialist: { childId: A, title: 'A specialist' } }]);
  });
});

describe('hasPlanChildAsk', () => {
  it('is true only for a plan card holding an open specialist ask', () => {
    const seg = (over: Partial<Extract<SubagentSegment, { type: 'tool' }>>): SubagentSegment => ({
      type: 'tool', id: 'x', toolUseId: 'x', toolName: 'Bash', input: {}, status: 'awaiting-approval', requestId: 'r', childId: A, ...over,
    });
    const base = { toolUseId: CARD, toolName: 'propose_plan', input: {}, status: 'complete' as const };
    expect(hasPlanChildAsk({ ...base, subagentSegments: [seg({})] })).toBe(true);
    expect(hasPlanChildAsk({ ...base, subagentSegments: [seg({ status: 'running', requestId: undefined })] })).toBe(false);
    expect(hasPlanChildAsk({ ...base, toolName: 'Task', subagentSegments: [seg({})] })).toBe(false);
  });
});

describe('a plan specialist\'s thinking reaches its row on every surface', () => {
  // The three transcript switches (App.tsx, the buddy's BubbleFeed.tsx, and the
  // history page) must all forward WHICH specialist thought it, or a plan card
  // drops the row (it cannot tell its specialists apart without it).
  it('the history page forwards agentId on reasoning', async () => {
    const { pageEventToAction } = await import('../src/renderer/state/transcript-page-actions');
    const action = pageEventToAction({
      type: 'assistant-thinking', sessionId: S, uuid: 'x', timestamp: 1,
      data: { text: 'hmm', partId: 'p', parentAgentToolUseId: CARD, agentId: A },
    } as any);
    expect(action).toMatchObject({ type: 'TRANSCRIPT_ASSISTANT_REASONING', agentId: A, parentAgentToolUseId: CARD });
  });

  it('App.tsx and BubbleFeed.tsx forward agentId on reasoning', async () => {
    const { readStripped, RENDERER } = await import('./helpers/guard-scope');
    const { join } = await import('node:path');
    for (const file of ['App.tsx', 'components/buddy/BubbleFeed.tsx']) {
      // Comments stripped: a commented-out forward must not pass.
      const src = readStripped(join(RENDERER, file));
      const at = src.indexOf("type: 'TRANSCRIPT_ASSISTANT_REASONING'");
      expect(at, file).toBeGreaterThan(0);
      const block = src.slice(at, src.indexOf('});', at));
      expect(block, file).toMatch(/agentId: event\.data\.agentId/);
    }
  });
});

describe('a plan record whose card is on a page not loaded yet', () => {
  // The re-send after the FIRST page carries every plan in the conversation;
  // a plan proposed further back has no card until the user scrolls to it.
  // Its record must be kept, not dropped, or that card comes back in its
  // proposal-time state with live Approve/Comment buttons.
  const olderPage = (events: any[]) => ({ type: 'HISTORY_PAGE_LOADED' as const, sessionId: S, events, cursor: null, hasMore: false });
  const planToolUse = { type: 'tool-use', sessionId: S, uuid: 'old-u', timestamp: 1, data: { toolUseId: CARD, toolName: 'propose_plan', toolInput: {} } };
  const planToolResult = (p: PlanView) => ({ type: 'tool-result', sessionId: S, uuid: 'old-r', timestamp: 2, data: { toolUseId: CARD, toolResult: 'Plan proposed.', plan: p } });

  it('keeps the newest record and applies it when a page creates the card', () => {
    let s = run(new Map(), { type: 'SESSION_INIT', sessionId: S },
      { type: 'PLAN_CHANGED', sessionId: S, plan: plan({ status: 'completed', seq: 7 }) },
      { type: 'PLAN_CHANGED', sessionId: S, plan: plan({ status: 'running', seq: 5 }) },
    );
    expect(s.get(S)!.toolCalls.has(CARD)).toBe(false);
    s = run(s, olderPage([planToolUse, planToolResult(plan({ status: 'proposed', seq: 1 }))]) as any);
    expect(card(s).plan).toMatchObject({ status: 'completed', seq: 7 });
    // Applied once: the kept copy is gone, so it can never resurface later.
    expect(Object.keys(s.get(S)!.pendingPlanRecords ?? {})).toEqual([]);
  });

  it('a live or replayed tool-use that creates the card applies it too', () => {
    let s = run(new Map(), { type: 'SESSION_INIT', sessionId: S },
      { type: 'PLAN_CHANGED', sessionId: S, plan: plan({ status: 'interrupted', seq: 4 }) });
    s = run(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u', toolUseId: CARD, toolName: 'propose_plan', toolInput: {} });
    expect(card(s).plan).toMatchObject({ status: 'interrupted', seq: 4 });
  });

  it('an older kept record never rewinds what the page itself carries', () => {
    let s = run(new Map(), { type: 'SESSION_INIT', sessionId: S },
      { type: 'PLAN_CHANGED', sessionId: S, plan: plan({ status: 'proposed', seq: 1 }) });
    s = run(s, olderPage([planToolUse, planToolResult(plan({ status: 'stopped', seq: 3 }))]) as any);
    expect(card(s).plan).toMatchObject({ status: 'stopped', seq: 3 });
  });

  it('survives the JSON chat:hydrate hop', async () => {
    const { serializeChatState, deserializeChatState } = await import('../src/renderer/state/chat-types');
    const s = run(new Map(), { type: 'SESSION_INIT', sessionId: S },
      { type: 'PLAN_CHANGED', sessionId: S, plan: plan({ status: 'paused', seq: 6 }) });
    const round = deserializeChatState(JSON.parse(JSON.stringify(serializeChatState(s))));
    const after = run(round, olderPage([planToolUse]) as any);
    expect(card(after).plan).toMatchObject({ status: 'paused', seq: 6 });
  });
});
