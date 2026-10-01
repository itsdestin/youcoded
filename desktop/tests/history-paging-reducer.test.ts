import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { SessionStore, type NativeSessionHeader } from '../src/main/harness/session-store';
import { readTranscriptPage } from '../src/main/transcript-page';
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
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: 's', uuid: 'live-use',
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

  // 2026-09-27 review: a page read to EOF (a rebuilt renderer's toEnd, a
  // transfer) overlaps what already arrived live. A tool already on screen must
  // not come back as a second card — tool cards dedup by toolUseId, not uuid.
  it('a page overlapping the live stream does not duplicate a tool card already on screen', () => {
    const liveTool: TranscriptEvent = {
      type: 'tool-use', sessionId: 's', uuid: 'use-1', timestamp: 3,
      data: { toolUseId: 't1', toolName: 'Bash', toolInput: { command: 'sleep 10' } },
    };
    let st = withSession('s');
    st = chatReducer(st, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 's', uuid: 'u1', text: 'run it', timestamp: 1 } as any);
    st = chatReducer(st, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: 's', uuid: 'use-1',
      toolUseId: 't1', toolName: 'Bash', toolInput: { command: 'sleep 10' },
    });
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u0', 'earlier'), asstEvent('s', 'a0', 'done'), userEvent('s', 'u1', 'run it'), liveTool],
      cursor: null, hasMore: false,
    });
    const sess = st.get('s')!;
    const groupsHoldingT1 = [...sess.toolGroups.values()].filter((g) => g.toolIds.includes('t1'));
    expect(groupsHoldingT1).toHaveLength(1);
    expect(sess.timeline.filter((e) => e.kind === 'user').map((e: any) => e.message.content)).toEqual(['earlier', 'run it']);
    expect(sess.toolCalls.get('t1')?.status).toBe('running');
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
    });
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

  it('a page request for an unknown session is a no-op, not a crash', () => {
    const st = withSession('s');
    expect(chatReducer(st, { type: 'HISTORY_PAGE_REQUESTED', sessionId: 'nope' })).toBe(st);
  });

  // A LOADED page for a session with no chat state yet is KEPT, not dropped: a
  // resumed session's first page can land before its SESSION_INIT, and
  // dropping it opened resumed sessions empty (2026-09-24; pinned in
  // chat-reducer.test.ts → "HISTORY_PAGE_LOADED for a session with no chat
  // state yet"). Still never a crash, and other sessions are untouched.
  it('a page loaded for a not-yet-initialized session creates its state and leaves others alone', () => {
    const st = withSession('s');
    const out = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 'early', events: [], cursor: null, hasMore: false,
    });
    expect(out.has('early')).toBe(true);
    expect(out.get('s')).toBe(st.get('s'));
  });
});

// A retry's discarded part (`assistant-thinking` carrying `dropPart`) is a saved
// marker. The live stream honours it; history pages used to skip it, so a reopened
// conversation showed the discarded half-answer glued in front of the real one
// (found 2026-10-01, one-core R5-0). These pin the page path to the live one.
describe('history page honours saved dropPart markers', () => {
  const text = (uuid: string, t: string, partId: string): TranscriptEvent =>
    ({ type: 'assistant-text', sessionId: 's', uuid, timestamp: 2, data: { text: t, partId } });
  const drop = (uuid: string, partIds: string[]): TranscriptEvent =>
    ({ type: 'assistant-thinking', sessionId: 's', uuid, timestamp: 3, data: { dropPart: { partIds } } });
  const done = (uuid: string): TranscriptEvent =>
    ({ type: 'turn-complete', sessionId: 's', uuid, timestamp: 4, data: { stopReason: 'end_turn' } });
  const load = (events: TranscriptEvent[], base: ChatState = withSession('s')) =>
    chatReducer(base, { type: 'HISTORY_PAGE_LOADED', sessionId: 's', events, cursor: null, hasMore: false });
  const texts = (st: ChatState) => [...st.get('s')!.assistantTurns.values()]
    .flatMap((t) => t.segments.map((g) => (g.type === 'text' ? g.content : `<${g.type}>`)));

  it('removes a part the same page already drew (marker follows the part it drops)', () => {
    const st = load([userEvent('s', 'u1', 'hi'), text('a1', 'HALF-ANSWER', 'text-0'),
      drop('d1', ['text-0']), text('a2', 'REPLACEMENT', 'text-0'), done('t1')]);
    expect(texts(st)).toEqual(['REPLACEMENT']);
  });

  it('drops only the trailing run: an earlier finished step with the same part id survives', () => {
    const tool: TranscriptEvent = { type: 'tool-use', sessionId: 's', uuid: 'tu', timestamp: 2,
      data: { toolUseId: 't', toolName: 'Bash', toolInput: { command: 'ls' } } };
    const st = load([userEvent('s', 'u1', 'hi'), text('a1', 'FINISHED', 'text-0'), tool,
      text('a2', 'HALF-ANSWER', 'text-0'), drop('d1', ['text-0']), text('a3', 'REPLACEMENT', 'text-0'), done('t1')]);
    expect(texts(st)).toEqual(['FINISHED', '<tool-group>', 'REPLACEMENT']);
  });

  it('a marker whose target is on an OLDER page (page cut mid-turn) is a harmless no-op', () => {
    // Pages cut only at a user message, and a retry marker lives inside one turn, so
    // this should not happen; the one exception is a single turn over the 2 MB page
    // cap. The newer page then starts mid-turn with no open turn: the marker finds
    // nothing to drop and must not throw or erase anything.
    const st = load([drop('d1', ['text-0']), text('a2', 'REPLACEMENT', 'text-0'), done('t1')]);
    expect(texts(st)).toEqual(['REPLACEMENT']);
  });

  it('replaying the same marker twice changes nothing the second time', () => {
    const page = [userEvent('s', 'u1', 'hi'), text('a1', 'HALF-ANSWER', 'text-0'),
      drop('d1', ['text-0']), text('a2', 'REPLACEMENT', 'text-0'), done('t1')];
    const once = load(page);
    // The same page again (uuids already seen) and a second raw drop must both leave it alone.
    const twice = chatReducer(load(page, once), { type: 'NATIVE_PARTS_DROPPED', sessionId: 's', partIds: ['text-0'] });
    expect(texts(once)).toEqual(['REPLACEMENT']);
    expect(texts(twice)).toContain('REPLACEMENT');
    expect(JSON.stringify(texts(twice))).not.toContain('HALF-ANSWER');
  });

  it('an older page carrying a marker leaves a live open turn untouched', () => {
    let live = withSession('s');
    live = chatReducer(live, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 's', uuid: 'lu', text: 'now', timestamp: 9 } as any);
    live = chatReducer(live, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 's', uuid: 'la', text: 'LIVE-PARTIAL', timestamp: 9, partId: 'text-0' } as any);
    const st = load([userEvent('s', 'u1', 'hi'), text('a1', 'HALF-ANSWER', 'text-0'),
      drop('d1', ['text-0']), text('a2', 'REPLACEMENT', 'text-0'), done('t1')], live);
    expect(texts(st)).toContain('LIVE-PARTIAL');
    expect(texts(st)).toContain('REPLACEMENT');
    expect(JSON.stringify(texts(st))).not.toContain('HALF-ANSWER');
  });

  describe('end to end from the saved file', () => {
    let root = '';
    afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

    it('a reopened conversation does not show the discarded half-answer', async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-dropdisk-'));
      const store = new SessionStore(new NativeHome(root));
      const header: NativeSessionHeader = { v: 1, sessionId: 's', harnessId: 'chat',
        binding: { providerId: 'openrouter', modelId: 'm' }, cwd: root, createdAt: 1 };
      await store.create(header);
      for (const e of [userEvent('s', 'u1', 'hi'), text('a1', 'HALF-ANSWER-TO-BE-DISCARDED', 'text-0'),
        // a reasoning part forces the half-answer onto disk before the marker arrives
        { type: 'assistant-thinking', sessionId: 's', uuid: 'r1', timestamp: 2, data: { text: 'hmm', partId: 'reasoning-0' } } as TranscriptEvent,
        drop('d1', ['text-0', 'reasoning-0']), text('a2', 'REPLACEMENT', 'text-0'), done('t1')]) {
        await store.append(root, e);
      }
      const page = await readTranscriptPage({ jsonlPath: store.transcriptPath('s', root), sessionId: 's', endOffset: null, format: 'native' });
      const st = load(page.events);
      expect(JSON.stringify(texts(st))).not.toContain('HALF-ANSWER');
      expect(texts(st)).toEqual(['REPLACEMENT']);
    });
  });
});
