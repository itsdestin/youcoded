import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState, serializeChatState, deserializeChatState } from '../src/renderer/state/chat-types';
import type { ChatState } from '../src/renderer/state/chat-types';
import type { TranscriptEvent } from '../src/shared/types';

function withSession(id: string): ChatState {
  const m: ChatState = new Map();
  m.set(id, createSessionChatState());
  return m;
}

// Pages arrive as parsed TranscriptEvents, exactly as the main handler returns them.
const userEvent = (sid: string, uuid: string, text: string): TranscriptEvent =>
  ({ type: 'user-message', sessionId: sid, uuid, timestamp: 1, data: { text } });
const asstEvent = (sid: string, uuid: string, text: string): TranscriptEvent =>
  ({ type: 'assistant-text', sessionId: sid, uuid, timestamp: 2, data: { text } });

describe('history paging reducer', () => {
  it('createSessionChatState seeds an empty history block', () => {
    expect(createSessionChatState().history).toEqual({ cursor: null, hasMore: false, loading: false });
  });

  it('HISTORY_PAGE_REQUESTED sets loading', () => {
    const next = chatReducer(withSession('s'), { type: 'HISTORY_PAGE_REQUESTED', sessionId: 's' });
    expect(next.get('s')!.history.loading).toBe(true);
  });

  it('a first page builds the timeline and records the cursor', () => {
    let st = withSession('s');
    st = chatReducer(st, { type: 'HISTORY_PAGE_REQUESTED', sessionId: 's' });
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u1', 'hello'), asstEvent('s', 'a1', 'hi')],
      cursor: { path: 'p', offset: 100, sizeAtRead: 500 }, hasMore: true,
    });
    const sess = st.get('s')!;
    expect(sess.timeline.filter((e) => e.kind === 'user')).toHaveLength(1);
    expect(sess.timeline.filter((e) => e.kind === 'assistant-turn')).toHaveLength(1);
    expect(sess.history).toEqual({ cursor: { path: 'p', offset: 100, sizeAtRead: 500 }, hasMore: true, loading: false });
  });

  it('marks an interrupted historical tool as failed without ending a newer live turn', () => {
    const oldTool: TranscriptEvent = {
      type: 'tool-use', sessionId: 's', uuid: 'old-use', timestamp: 2,
      data: { toolUseId: 'old', toolName: 'Bash', toolInput: { command: 'sleep 30' } },
    };
    let st = withSession('s');
    st = chatReducer(st, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: 's', uuid: 'live-use',
      toolUseId: 'live', toolName: 'Bash', toolInput: { command: 'sleep 10' },
    });
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'old-user', 'before crash'), oldTool],
      cursor: null, hasMore: false, reconcileInterrupted: true,
    });
    expect(st.get('s')!.toolCalls.get('old')?.status).toBe('failed');
    expect(st.get('s')!.toolCalls.get('old')?.error).toMatch(/interrupted/i);
    expect(st.get('s')!.toolCalls.get('live')?.status).toBe('running');
    expect(st.get('s')!.activeTurnToolIds.has('live')).toBe(true);
  });

  it('does not leave an idle resumed session looking like it is working', () => {
    const st = chatReducer(withSession('s'), { type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'prompt', 'before crash'), {
        type: 'tool-use', sessionId: 's', uuid: 'tool', timestamp: 2,
        data: { toolUseId: 'old', toolName: 'Bash', toolInput: {} },
      }], cursor: null, hasMore: false, reconcileInterrupted: true,
    });
    expect(st.get('s')!.toolCalls.get('old')?.status).toBe('failed');
    expect(st.get('s')!.activeTurnToolIds.size).toBe(0);
    expect(st.get('s')!.isThinking).toBe(false);
  });

  it('fails only pre-resume tools when new tool calls share the same page', () => {
    const tool = (id: string): TranscriptEvent => ({ type: 'tool-use', sessionId: 's', uuid: `use-${id}`,
      timestamp: 2, data: { toolUseId: id, toolName: 'Bash', toolInput: {} } });
    const st = chatReducer(withSession('s'), { type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [tool('old'), tool('new')], cursor: null, hasMore: false,
      reconcileInterruptedToolIds: ['old'],
    });
    expect(st.get('s')!.toolCalls.get('old')?.status).toBe('failed');
    expect(st.get('s')!.toolCalls.get('new')?.status).toBe('running');
  });

  it('does not mark an inherited live tool as interrupted', () => {
    const tool: TranscriptEvent = {
      type: 'tool-use', sessionId: 's', uuid: 'live-use', timestamp: 2,
      data: { toolUseId: 'live', toolName: 'Bash', toolInput: {} },
    };
    const st = chatReducer(withSession('s'), {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's', events: [tool], cursor: null, hasMore: false,
    });
    expect(st.get('s')!.toolCalls.get('live')?.status).toBe('running');
  });

  it('a second (older) page PREPENDS before the first', () => {
    let st = withSession('s');
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u2', 'newer')],
      cursor: { path: 'p', offset: 50, sizeAtRead: 500 }, hasMore: true,
    });
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u1', 'older')],
      cursor: null, hasMore: false,
    });
    const users = st.get('s')!.timeline.filter((e) => e.kind === 'user') as any[];
    expect(users.map((u) => u.message.content)).toEqual(['older', 'newer']);
    expect(st.get('s')!.history.hasMore).toBe(false);
    expect(st.get('s')!.history.cursor).toBeNull();
  });

  it('a prepended page does not collide with the ids already on screen', () => {
    let st = withSession('s');
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u2', 'newer'), asstEvent('s', 'a2', 'reply newer')],
      cursor: { path: 'p', offset: 50, sizeAtRead: 500 }, hasMore: true,
    });
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u1', 'older'), asstEvent('s', 'a1', 'reply older')],
      cursor: null, hasMore: false,
    });
    const sess = st.get('s')!;
    const turnIds = sess.timeline.filter((e) => e.kind === 'assistant-turn').map((e: any) => e.turnId);
    expect(new Set(turnIds).size).toBe(turnIds.length);
    // Every rendered turn resolves to a real entry in the turns map.
    for (const id of turnIds) expect(sess.assistantTurns.has(id)).toBe(true);
  });

  it('never re-renders an entry that is already on screen', () => {
    // The transcript a page is read from contains what the live stream ALREADY
    // delivered. Without the live session's seenUuids seeded into the replay,
    // a just-sent prompt comes back as a second identical bubble — the perf
    // rig's native-chat screenshot caught exactly that.
    let st = withSession('s');
    st = chatReducer(st, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 's', uuid: 'u1', text: 'Once upon a time', timestamp: 1,
    } as any);
    st = chatReducer(st, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 's', uuid: 'a1', text: 'a reply', timestamp: 2,
    } as any);
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u0', 'older'), userEvent('s', 'u1', 'Once upon a time'), asstEvent('s', 'a1', 'a reply')],
      cursor: null, hasMore: false,
    });
    const users = st.get('s')!.timeline.filter((e) => e.kind === 'user') as any[];
    expect(users.map((u) => u.message.content)).toEqual(['older', 'Once upon a time']);
    expect(st.get('s')!.timeline.filter((e) => e.kind === 'assistant-turn')).toHaveLength(1);
  });

  it('folds the page\'s usage totals into the session', () => {
    // session-totals' contract is "rebuilt for free when a resumed session
    // replays its record" — true while resume replayed the WHOLE transcript.
    // Paging replays onto a scratch state, so the page's totals have to be
    // folded in explicitly or a resumed session counts nothing at all.
    let st = withSession('s');
    const turn = (uuid: string, out: number): TranscriptEvent => ({
      type: 'turn-complete', sessionId: 's', uuid, timestamp: 3,
      data: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: out, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    } as TranscriptEvent);
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u1', 'hi'), asstEvent('s', 'a1', 'yo'), turn('t1', 40)],
      cursor: { path: 'p', offset: 5, sizeAtRead: 9 }, hasMore: true,
    });
    expect(st.get('s')!.totals.outputTokens).toBe(40);

    // A second, older page ADDS to the running figure rather than replacing it.
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u0', 'older'), asstEvent('s', 'a0', 'older reply'), turn('t0', 25)],
      cursor: null, hasMore: false,
    });
    expect(st.get('s')!.totals.outputTokens).toBe(65);
  });

  it('HISTORY_PAGE_FAILED clears loading and keeps the cursor', () => {
    let st = withSession('s');
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's', events: [userEvent('s', 'u1', 'x')],
      cursor: { path: 'p', offset: 7, sizeAtRead: 9 }, hasMore: true,
    });
    st = chatReducer(st, { type: 'HISTORY_PAGE_REQUESTED', sessionId: 's' });
    st = chatReducer(st, { type: 'HISTORY_PAGE_FAILED', sessionId: 's' });
    expect(st.get('s')!.history.loading).toBe(false);
    expect(st.get('s')!.history.cursor).toEqual({ path: 'p', offset: 7, sizeAtRead: 9 });
  });

  it('history survives a serialize/deserialize round trip, and a pre-field snapshot defaults', () => {
    let st = withSession('s');
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's', events: [userEvent('s', 'u1', 'x')],
      cursor: { path: 'p', offset: 7, sizeAtRead: 9 }, hasMore: true,
    });
    const round = deserializeChatState(serializeChatState(st));
    expect(round.get('s')!.history).toEqual({ cursor: { path: 'p', offset: 7, sizeAtRead: 9 }, hasMore: true, loading: false });

    // An older host's snapshot has no `history` field at all.
    const legacy = serializeChatState(st);
    delete (legacy.sessions[0][1] as any).history;
    expect(deserializeChatState(legacy).get('s')!.history).toEqual({ cursor: null, hasMore: false, loading: false });
  });

  it('an unknown session is a no-op, not a crash', () => {
    const st = withSession('s');
    expect(chatReducer(st, { type: 'HISTORY_PAGE_REQUESTED', sessionId: 'nope' })).toBe(st);
    expect(chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 'nope', events: [], cursor: null, hasMore: false,
    })).toBe(st);
  });
});
