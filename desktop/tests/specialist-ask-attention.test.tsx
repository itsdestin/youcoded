// @vitest-environment jsdom
/**
 * Specialists plans, Task 8 (controller decision 10, deck answer Q6-1): a
 * specialist waiting on the user — an ordinary hired specialist OR a plan's —
 * turns the conversation's dot red, exactly like the assistant's own ask.
 * The alert sound and the buddy's "awaiting approval" both follow that same
 * signal (App.tsx plays 'attention' on a change TO red; the buddy reads the
 * reported `awaitingApproval`), so this pins the signal itself: it lights,
 * it clears when the ask is answered or expires, and a second ask while the
 * first is open does not flip it (no second sound).
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ChatProvider, useChatDispatch } from '../src/renderer/state/chat-context';
import { useSessionAttention } from '../src/renderer/hooks/useSessionAttention';
import type { ChatAction } from '../src/renderer/state/chat-types';
import type { PlanView } from '../src/shared/types';

const S = 's1';
const SESSIONS = [{ id: S }];
const VIEWED = new Set<string>([S]);

function Providers({ children }: { children: React.ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

function useHarness() {
  const dispatch = useChatDispatch();
  const attention = useSessionAttention(SESSIONS, VIEWED, S);
  return { dispatch, attention };
}

const TURN_DONE: ChatAction = {
  type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: S, uuid: 'tc', timestamp: 2,
  stopReason: 'end_turn', model: null, anthropicRequestId: null, usage: null,
};

function ask(requestId: string, over: Partial<Extract<ChatAction, { type: 'PERMISSION_REQUEST' }>> = {}): ChatAction {
  return {
    type: 'PERMISSION_REQUEST', sessionId: S, toolName: 'Bash', input: { command: 'npm test' }, requestId,
    specialist: { childId: 'child-1', agentType: 'worker', title: 'Wren the Worker', parentToolCallId: 'task-1' },
    ...over,
  } as ChatAction;
}

/** A background specialist: its Task card belongs to a turn that already ended. */
function seedBackgroundTask(dispatch: (a: ChatAction) => void) {
  dispatch({ type: 'SESSION_INIT', sessionId: S });
  dispatch({ type: 'USER_PROMPT', sessionId: S, content: 'go', timestamp: 1 });
  dispatch({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'u1', toolUseId: 'task-1', toolName: 'Task', toolInput: { description: 'check', background: true } });
  dispatch({ type: 'TRANSCRIPT_TOOL_RESULT', sessionId: S, uuid: 'u2', toolUseId: 'task-1', result: 'started in the background', isError: false } as ChatAction);
  dispatch(TURN_DONE);
}

const PLAN: PlanView = {
  planId: 'plan-1', toolUseId: 'plan-card', title: 'Review', status: 'running',
  steps: [{ id: 's1', kind: 'map', title: 'Review', specialist: 'reviewer', fanOut: 1, status: 'running',
    children: [{ childId: 'kid-a', parentToolCallId: 'plan-card', agentType: 'reviewer', title: 'Idris the Reviewer', background: false, status: 'running', startedAt: 1 }] }],
  model: { label: 'm' }, seq: 1,
};

describe('a specialist waiting on the user lights the conversation dot', () => {
  it('an ordinary background specialist\'s ask turns the dot red; answering clears it', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => seedBackgroundTask(result.current.dispatch));
    expect(result.current.attention.get(S)?.status).not.toBe('red');
    act(() => result.current.dispatch(ask('req-1')));
    expect(result.current.attention.get(S)).toMatchObject({ status: 'red', awaitingApproval: true });
    act(() => result.current.dispatch({ type: 'PERMISSION_RESPONDED', sessionId: S, requestId: 'req-1' } as ChatAction));
    expect(result.current.attention.get(S)).toMatchObject({ awaitingApproval: false });
    expect(result.current.attention.get(S)?.status).not.toBe('red');
  });

  it('an ask that expires clears it too', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => seedBackgroundTask(result.current.dispatch));
    act(() => result.current.dispatch(ask('req-1')));
    expect(result.current.attention.get(S)?.status).toBe('red');
    act(() => result.current.dispatch({ type: 'PERMISSION_EXPIRED', sessionId: S, requestId: 'req-1' } as ChatAction));
    expect(result.current.attention.get(S)).toMatchObject({ awaitingApproval: false });
    expect(result.current.attention.get(S)?.status).not.toBe('red');
  });

  it('an ask answered on another device clears it', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => seedBackgroundTask(result.current.dispatch));
    act(() => result.current.dispatch(ask('req-1')));
    act(() => result.current.dispatch({ type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: S, requestId: 'req-1' } as ChatAction));
    expect(result.current.attention.get(S)?.status).not.toBe('red');
  });

  it('a second ask while the first is open keeps the SAME answer (no second alert)', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => seedBackgroundTask(result.current.dispatch));
    act(() => result.current.dispatch(ask('req-1')));
    const first = result.current.attention;
    act(() => result.current.dispatch(ask('req-2', { input: { command: 'npm run lint' } })));
    // Same Map identity = App's sound effect does not run again.
    expect(result.current.attention).toBe(first);
    act(() => result.current.dispatch({ type: 'PERMISSION_RESPONDED', sessionId: S, requestId: 'req-1' } as ChatAction));
    // One still open: still red.
    expect(result.current.attention.get(S)?.status).toBe('red');
  });

  it('a plan specialist\'s ask turns the dot red; answering clears it', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => {
      const d = result.current.dispatch;
      d({ type: 'SESSION_INIT', sessionId: S });
      d({ type: 'TRANSCRIPT_TOOL_USE', sessionId: S, uuid: 'p', toolUseId: 'plan-card', toolName: 'propose_plan', toolInput: {} });
      d({ type: 'PLAN_CHANGED', sessionId: S, plan: PLAN });
      d(TURN_DONE);
    });
    expect(result.current.attention.get(S)?.status).not.toBe('red');
    act(() => result.current.dispatch(ask('req-p', {
      specialist: { childId: 'kid-a', agentType: 'reviewer', title: 'Idris the Reviewer', parentToolCallId: 'plan-card', plan: { planId: 'plan-1', stepId: 's1', attemptId: 'a1' } },
    })));
    expect(result.current.attention.get(S)).toMatchObject({ status: 'red', awaitingApproval: true });
    act(() => result.current.dispatch({ type: 'PERMISSION_RESPONDED', sessionId: S, requestId: 'req-p' } as ChatAction));
    expect(result.current.attention.get(S)?.status).not.toBe('red');
  });
});
