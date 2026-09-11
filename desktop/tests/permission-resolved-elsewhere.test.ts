// Remote access batch 2, design §7 "consent does not lie" (T2): a permission
// the computer already answered is cleared on the phone with a neutral note —
// never marked failed, never blamed on a socket.
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';
import type { ChatState } from '../src/renderer/state/chat-types';

function withAsk(requestId: string, toolName = 'Bash'): ChatState {
  let s: ChatState = new Map();
  s = chatReducer(s, { type: 'SESSION_INIT', sessionId: 's1' });
  s = chatReducer(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 's1', uuid: 'm1', text: 'go', timestamp: 1 });
  s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: 's1', uuid: 'u1', toolUseId: 't1', toolName, toolInput: { command: 'ls' } });
  s = chatReducer(s, { type: 'PERMISSION_REQUEST', sessionId: 's1', toolName, input: { command: 'ls' }, requestId });
  return s;
}
const tool = (s: ChatState, id = 't1') => s.get('s1')!.toolCalls.get(id)!;

describe('PermissionResolved reaches the reducer', () => {
  it('the dispatcher maps it to PERMISSION_RESOLVED_ELSEWHERE', () => {
    expect(hookEventToAction({ type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: 'r1' }, timestamp: 1 } as any))
      .toEqual({ type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1' });
    expect(hookEventToAction({ type: 'PermissionResolved', sessionId: 's1', payload: {}, timestamp: 1 } as any)).toBeNull();
  });

  it('clears the ask and keeps the tool running with the neutral note — never failed, never a socket', () => {
    const before = withAsk('r1');
    expect(tool(before).status).toBe('awaiting-approval');
    const after = chatReducer(before, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1' });
    const t = tool(after);
    expect(t.status).toBe('running');
    expect(t.requestId).toBeUndefined();
    expect(t.answeredElsewhere).toBe(true);
    expect(t.error).toBeUndefined();
  });

  it('is a no-op for a card that is not awaiting — the answering device already moved it on', () => {
    const before = chatReducer(withAsk('r1'), { type: 'PERMISSION_RESPONDED', sessionId: 's1', requestId: 'r1' });
    const after = chatReducer(before, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1' });
    expect(after).toBe(before);
    expect(tool(after).answeredElsewhere).toBeUndefined();
  });

  it('closes a budget gate complete, as an answer would', () => {
    const before = withAsk('r1', 'max_steps');
    const after = chatReducer(before, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1' });
    expect(tool(after).status).toBe('complete');
  });
});

describe('hook:replay-complete clears every card not in the pending list', () => {
  it('leaves listed asks awaiting and resolves the rest with the note', () => {
    let s = withAsk('r1');
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: 's1', uuid: 'u2', toolUseId: 't2', toolName: 'Read', toolInput: { p: 1 } });
    s = chatReducer(s, { type: 'PERMISSION_REQUEST', sessionId: 's1', toolName: 'Read', input: { p: 1 }, requestId: 'r2' });
    expect(tool(s, 't2').status).toBe('awaiting-approval');

    const after = chatReducer(s, { type: 'PERMISSION_REPLAY_COMPLETE', sessionId: 's1', pendingRequestIds: ['r2'] });
    expect(tool(after, 't1')).toMatchObject({ status: 'running', answeredElsewhere: true });
    expect(tool(after, 't1').requestId).toBeUndefined();
    expect(tool(after, 't2')).toMatchObject({ status: 'awaiting-approval', requestId: 'r2' });
  });

  it('returns the same state when nothing was awaiting', () => {
    const s = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: 's1' });
    expect(chatReducer(s, { type: 'PERMISSION_REPLAY_COMPLETE', sessionId: 's1', pendingRequestIds: [] })).toBe(s);
  });
});
