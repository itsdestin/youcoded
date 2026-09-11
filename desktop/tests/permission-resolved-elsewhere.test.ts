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


// Review of T2 (2026-09-10): the note must never outlive the truth.
describe('answered elsewhere, against the events that follow it', () => {
  const EXPIRED = 'Permission request expired — socket closed before a response was sent';

  it('a cancelled native ask (broker order: Resolved, then Expired) ends failed as expired, with no note', () => {
    let s = withAsk('r1');
    s = chatReducer(s, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1' });
    s = chatReducer(s, { type: 'PERMISSION_EXPIRED', sessionId: 's1', requestId: 'r1' });
    expect(tool(s)).toMatchObject({ status: 'failed', error: EXPIRED });
    expect(tool(s).answeredElsewhere).toBeUndefined();
  });

  it('the reverse order ends the same way', () => {
    let s = withAsk('r1');
    s = chatReducer(s, { type: 'PERMISSION_EXPIRED', sessionId: 's1', requestId: 'r1' });
    s = chatReducer(s, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1' });
    expect(tool(s)).toMatchObject({ status: 'failed', error: EXPIRED });
    expect(tool(s).answeredElsewhere).toBeUndefined();
  });

  it('a watching device keeps its note when the answering device\'s broadcast arrives after the resolution', () => {
    // Every answering device broadcasts PERMISSION_RESPONDED, and the host's resolution
    // always reaches a watcher first. The note is true for the watcher; the broadcast must
    // not erase it (T2 re-review, 2).
    let s = withAsk('r1');
    s = chatReducer(s, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1' });
    s = chatReducer(s, { type: 'PERMISSION_RESPONDED', sessionId: 's1', requestId: 'r1' });
    expect(tool(s)).toMatchObject({ status: 'running', answeredElsewhere: true });
  });

  it('a desktop window clears a resolved card without the note, and a later expiry still fails it', () => {
    // A desktop window never says "Answered on the computer" (T2 re-review, 4), but must
    // not keep live buttons for an answer a phone gave either.
    let s = withAsk('r1');
    s = chatReducer(s, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1', silent: true } as any);
    expect(tool(s).status).toBe('running');
    expect(tool(s).requestId).toBeUndefined();
    expect(tool(s).answeredElsewhere).toBeUndefined();
    s = chatReducer(s, { type: 'PERMISSION_EXPIRED', sessionId: 's1', requestId: 'r1' });
    expect(tool(s)).toMatchObject({ status: 'failed', error: EXPIRED });
  });

  it('a nested specialist ask cancelled from its parent (Resolved, then Expired) ends expired', () => {
    let s = withAsk('r1', 'Task');
    s = chatReducer(s, { type: 'PERMISSION_RESPONDED', sessionId: 's1', requestId: 'r1' });
    const session = s.get('s1')!;
    const toolCalls = new Map(session.toolCalls);
    toolCalls.set('t1', { ...toolCalls.get('t1')!, subagentSegments: [
      { type: 'tool', id: 'n1', toolUseId: 'n1', toolName: 'Bash', input: {}, status: 'awaiting-approval', requestId: 'nested' },
    ] as any });
    s = new Map(s).set('s1', { ...session, toolCalls });
    s = chatReducer(s, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'nested' });
    expect((tool(s).subagentSegments as any[])[0].status).toBe('running');
    s = chatReducer(s, { type: 'PERMISSION_EXPIRED', sessionId: 's1', requestId: 'nested' });
    expect((tool(s).subagentSegments as any[])[0]).toMatchObject({ status: 'failed', error: EXPIRED });
  });

  it('the note and the resolved id survive the real tool-use reclaiming a synthetic card', () => {
    // On a phone the ask usually arrives before the transcript, so it binds a synthetic
    // card; the tool-use that replaces it must keep what the resolution recorded (T2 re-review, 6).
    let s = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: 's1' });
    s = chatReducer(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 's1', uuid: 'm1', text: 'go', timestamp: 1 });
    s = chatReducer(s, { type: 'PERMISSION_REQUEST', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, requestId: 'early' });
    s = chatReducer(s, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'early' });
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: 's1', uuid: 'u1', toolUseId: 'real', toolName: 'Bash', toolInput: { command: 'ls' } });
    const real = s.get('s1')!.toolCalls.get('real')!;
    expect(real).toMatchObject({ answeredElsewhere: true, resolvedRequestId: 'early' });
    s = chatReducer(s, { type: 'PERMISSION_EXPIRED', sessionId: 's1', requestId: 'early' });
    expect(s.get('s1')!.toolCalls.get('real')).toMatchObject({ status: 'failed', error: EXPIRED });
  });

  it('a running card that still carries a stale request id is left alone', () => {
    let s = withAsk('r1');
    const session = s.get('s1')!;
    const toolCalls = new Map(session.toolCalls);
    toolCalls.set('t1', { ...toolCalls.get('t1')!, status: 'running' });   // the overwritten-ask shape keeps requestId
    s = new Map(s).set('s1', { ...session, toolCalls });
    expect(tool(s).requestId).toBe('r1');
    expect(chatReducer(s, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1' })).toBe(s);
    expect(chatReducer(s, { type: 'PERMISSION_REPLAY_COMPLETE', sessionId: 's1', pendingRequestIds: [] })).toBe(s);
  });

  it('a new ask binding the same card drops the old note', () => {
    let s = withAsk('r1');
    s = chatReducer(s, { type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1' });
    s = chatReducer(s, { type: 'PERMISSION_REQUEST', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, requestId: 'r2' });
    expect(tool(s)).toMatchObject({ status: 'awaiting-approval', requestId: 'r2' });
    expect(tool(s).answeredElsewhere).toBeUndefined();
  });

  it('replay-complete also clears a nested specialist ask that is not listed', () => {
    let s = withAsk('r1', 'Task');
    s = chatReducer(s, { type: 'PERMISSION_RESPONDED', sessionId: 's1', requestId: 'r1' });
    const session = s.get('s1')!;
    const toolCalls = new Map(session.toolCalls);
    toolCalls.set('t1', { ...toolCalls.get('t1')!, subagentSegments: [
      { type: 'tool', id: 'n1', toolUseId: 'n1', toolName: 'Bash', input: {}, status: 'awaiting-approval', requestId: 'nested-gone' },
      { type: 'tool', id: 'n2', toolUseId: 'n2', toolName: 'Bash', input: {}, status: 'awaiting-approval', requestId: 'nested-open' },
    ] as any });
    s = new Map(s).set('s1', { ...session, toolCalls });
    const after = chatReducer(s, { type: 'PERMISSION_REPLAY_COMPLETE', sessionId: 's1', pendingRequestIds: ['nested-open'] });
    const segs = tool(after).subagentSegments as any[];
    expect(segs[0]).toMatchObject({ status: 'running' });
    expect(segs[0].requestId).toBeUndefined();
    expect(segs[1]).toMatchObject({ status: 'awaiting-approval', requestId: 'nested-open' });
  });
});
