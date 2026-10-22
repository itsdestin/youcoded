// @vitest-environment jsdom
// The hook the Background chip will read: a cached selector over the per-session
// command list. It must follow launches and ends, and must NOT redraw for
// unrelated chat traffic (perf rule 3).
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import React from 'react';
import { ChatProvider, useChatDispatch } from '../src/renderer/state/chat-context';
import { useBackgroundCommands } from '../src/renderer/hooks/useBackgroundCommands';
import type { ChatAction } from '../src/renderer/state/chat-types';
import type { BackgroundCommand } from '../src/renderer/state/background-commands';

afterEach(cleanup);
const S = 's1';

function setup() {
  let dispatch!: (a: ChatAction) => void;
  const seen: BackgroundCommand[][] = [];
  function Probe() {
    dispatch = useChatDispatch();
    seen.push(useBackgroundCommands(S));
    return null;
  }
  render(<ChatProvider><Probe /></ChatProvider>);
  act(() => dispatch({ type: 'SESSION_INIT', sessionId: S } as ChatAction));
  return { dispatch: (a: ChatAction) => act(() => dispatch(a)), last: () => seen[seen.length - 1], renders: () => seen.length };
}
const launch = (id: string, task: string): ChatAction[] => [
  { type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: S, uuid: `u${id}`, toolUseId: id, toolName: 'Bash', toolInput: { command: 'sleep 99', run_in_background: true } } as ChatAction,
  { type: 'TRANSCRIPT_TOOL_RESULT', timestamp: 2, sessionId: S, uuid: `r${id}`, toolUseId: id, result: 'running', isError: false, backgroundTaskId: task } as ChatAction,
];

describe('useBackgroundCommands', () => {
  it('is empty, then follows a launch and its end', () => {
    const h = setup();
    expect(h.last()).toEqual([]);
    launch('t1', 'b1').forEach(h.dispatch);
    expect(h.last().map(c => [c.label, c.status])).toEqual([['sleep 99', 'running']]);
    h.dispatch({ type: 'TRANSCRIPT_BACKGROUND_TASK', sessionId: S, uuid: 'n', toolUseId: 't1', taskIds: ['b1'], status: 'failed', exitCode: 3 } as ChatAction);
    expect(h.last()[0]).toMatchObject({ status: 'failed', exitCode: 3 });
  });
  it('does not hand out a new array (so no redraw) for unrelated chat events', () => {
    const h = setup();
    launch('t1', 'b1').forEach(h.dispatch);
    const before = h.last();
    h.dispatch({ type: 'TRANSCRIPT_ASSISTANT_TEXT', timestamp: 3, sessionId: S, uuid: 'a1', text: 'hello' } as ChatAction);
    expect(h.last()).toBe(before);
  });
  it('is empty with no session', () => {
    let out: BackgroundCommand[] = [];
    function P() { out = useBackgroundCommands(undefined); return null; }
    render(<ChatProvider><P /></ChatProvider>);
    expect(out).toEqual([]);
  });
});
