import { describe, it, expect, beforeEach, vi } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction } from '../src/renderer/state/chat-types';

const SESSION = 'test-session';

function initState(): ChatState {
  const state: ChatState = new Map();
  return chatReducer(state, { type: 'SESSION_INIT', sessionId: SESSION });
}

function dispatch(state: ChatState, action: ChatAction): ChatState {
  return chatReducer(state, action);
}

describe('Attention state reducer actions', () => {
  let state: ChatState;

  beforeEach(() => {
    state = initState();
  });

  it('default attentionState is "ok"', () => {
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });

  it('ATTENTION_STATE_CHANGED updates the state', () => {
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'stuck',
    });
    expect(state.get(SESSION)!.attentionState).toBe('stuck');
  });

  it('ATTENTION_STATE_CHANGED is a no-op when the value matches', () => {
    const before = state;
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'ok',
    });
    // Map reference is preserved when no change occurred
    expect(state).toBe(before);
  });

  it('SESSION_PROCESS_EXITED with exitCode=0 and no in-flight → no-op', () => {
    const before = state;
    state = dispatch(state, {
      type: 'SESSION_PROCESS_EXITED',
      sessionId: SESSION,
      exitCode: 0,
    });
    expect(state).toBe(before);
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });

  it('SESSION_PROCESS_EXITED with nonzero exitCode → session-died + endTurn', () => {
    // Start a turn
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'u1',
      text: 'hi',
      timestamp: 1000,
    });
    expect(state.get(SESSION)!.isThinking).toBe(true);

    state = dispatch(state, {
      type: 'SESSION_PROCESS_EXITED',
      sessionId: SESSION,
      exitCode: 137,
    });

    const session = state.get(SESSION)!;
    expect(session.attentionState).toBe('session-died');
    expect(session.isThinking).toBe(false);
    expect(session.activeTurnToolIds.size).toBe(0);
  });

  it('SESSION_PROCESS_EXITED with in-flight tools fails them and sets session-died', () => {
    // Start a turn + emit a tool
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'u1',
      text: 'hi',
      timestamp: 1000,
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
      sessionId: SESSION,
      uuid: 'u2',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    expect(state.get(SESSION)!.toolCalls.get('tool-1')!.status).toBe('running');

    state = dispatch(state, {
      type: 'SESSION_PROCESS_EXITED',
      sessionId: SESSION,
      exitCode: 0, // clean exit, but a tool was in flight
    });

    const session = state.get(SESSION)!;
    expect(session.attentionState).toBe('session-died');
    expect(session.toolCalls.get('tool-1')!.status).toBe('failed');
  });

  it('transcript events clear a prior non-ok attentionState back to ok', () => {
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'stuck',
    });
    expect(state.get(SESSION)!.attentionState).toBe('stuck');

    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'u1',
      text: 'here is my answer',
      timestamp: 2000,
    });
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });

  it('TRANSCRIPT_TURN_COMPLETE (via endTurn) clears attentionState to ok', () => {
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'stuck',
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE',
      sessionId: SESSION,
      uuid: 'u1',
      timestamp: 3000,
      stopReason: null,
      model: null,
      anthropicRequestId: null,
      usage: null,
    });
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });

  it('TRANSCRIPT_THINKING_HEARTBEAT bumps lastActivityAt and clears attentionState', () => {
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'stuck',
    });
    const before = state.get(SESSION)!.lastActivityAt;

    // Tiny wait to guarantee Date.now() advances
    const now = Date.now();
    while (Date.now() === now) { /* spin */ }

    state = dispatch(state, {
      type: 'TRANSCRIPT_THINKING_HEARTBEAT',
      sessionId: SESSION,
    });
    const session = state.get(SESSION)!;
    expect(session.attentionState).toBe('ok');
    expect(session.lastActivityAt).toBeGreaterThan(before);
  });

  it('PERMISSION_REQUEST clears attentionState (no redundant banner over the card)', () => {
    // Set up a running tool so the permission can find a match
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'u1',
      text: 'hi',
      timestamp: 1000,
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
      sessionId: SESSION,
      uuid: 'u2',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    state = dispatch(state, {
      type: 'ATTENTION_STATE_CHANGED',
      sessionId: SESSION,
      state: 'stuck',
    });

    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'ls' },
      requestId: 'req-1',
    });
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });
});

describe('stalled turn', () => {
  let state: ChatState;
  beforeEach(() => { state = initState(); });

  it('a stalled heartbeat sets attentionState "stalled" and stamps stalledSince', () => {
    state = dispatch(state, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION, stalled: true });
    const s = state.get(SESSION)!;
    expect(s.attentionState).toBe('stalled');
    expect(typeof s.stalledSince).toBe('number');
  });

  it('repeat stalled heartbeats do NOT restart the elapsed clock', () => {
    // Load-bearing fake clock: two synchronous Date.now() calls can land in the
    // same millisecond, which makes this assertion pass even against a broken
    // reducer that restamps stalledSince unconditionally (dropping the
    // `session.stalledSince ?? Date.now()` guard) — proven empirically by
    // temporarily removing that guard and watching this test still pass.
    // Advancing fake time between dispatches forces a real elapsed gap so the
    // test can only pass if the guard is actually holding the original stamp.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      state = dispatch(state, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION, stalled: true });
      const first = state.get(SESSION)!.stalledSince;

      vi.setSystemTime(1_050_000);
      state = dispatch(state, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION, stalled: true });
      expect(state.get(SESSION)!.stalledSince).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  // Fix (M8, whole-branch review 2026-08-16). The "hold the stamp" rule used to
  // be unconditional, so any path that put the session back to 'ok' WITHOUT
  // clearing stalledSince (nine of the fourteen sites in the reducer do exactly
  // that — a tool call arriving is the common one) left a second park counting
  // from the first one's timestamp.
  it('park -> resume -> park restarts the elapsed clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      state = dispatch(state, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION, stalled: true });
      const firstPark = state.get(SESSION)!.stalledSince;
      expect(firstPark).toBe(1_000_000);

      // The stream wakes up with a TOOL CALL rather than text — a real un-park
      // shape (the 2026-08-12 incident stalled mid-tool-arguments). This case
      // sets attentionState back to 'ok' and does NOT touch stalledSince, which
      // is precisely the gap being closed.
      vi.setSystemTime(1_030_000);
      state = dispatch(state, {
        type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION, uuid: 'u1',
        toolUseId: 't1', toolName: 'Bash', toolInput: { command: 'ls' },
      });
      expect(state.get(SESSION)!.attentionState).toBe('ok');

      // It goes quiet again five minutes later. The new card must count from
      // NOW, not from the first park — otherwise it opens claiming 5m 20s.
      vi.setSystemTime(1_320_000);
      state = dispatch(state, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION, stalled: true });
      const s = state.get(SESSION)!;
      expect(s.attentionState).toBe('stalled');
      expect(s.stalledSince).toBe(1_320_000);
      expect(s.stalledSince).not.toBe(firstPark);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a plain heartbeat clears the stall (the stream resumed)', () => {
    state = dispatch(state, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION, stalled: true });
    state = dispatch(state, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION });
    const s = state.get(SESSION)!;
    expect(s.attentionState).toBe('ok');
    expect(s.stalledSince).toBeNull();
  });

  it('a stall warning does NOT assert health — the dot must not go green', () => {
    // Regression: the warning heartbeat used to set attentionState 'ok', so the
    // dot stayed GREEN for the whole countdown while the UI said it may be hanging.
    state = dispatch(state, {
      type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SESSION,
      stallWarning: { retryInMs: 15_000, willRetry: false },
    });
    expect(state.get(SESSION)!.attentionState).not.toBe('ok');
  });

  it('NATIVE_PARTS_DROPPED removes the abandoned segments from the current turn', () => {
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, text: 'Now I will', partId: 'p1' } as any);
    state = dispatch(state, { type: 'NATIVE_PARTS_DROPPED', sessionId: SESSION, partIds: ['p1'] });
    const s = state.get(SESSION)!;
    const turn = s.assistantTurns.get(s.currentTurnId!)!;
    expect(turn.segments.filter((seg: any) => seg.partId === 'p1')).toHaveLength(0);
  });

  it('NATIVE_PARTS_DROPPED leaves segments from other parts alone', () => {
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, text: 'keep', partId: 'keep-me' } as any);
    state = dispatch(state, { type: 'NATIVE_PARTS_DROPPED', sessionId: SESSION, partIds: ['p1'] });
    const s = state.get(SESSION)!;
    const turn = s.assistantTurns.get(s.currentTurnId!)!;
    expect(turn.segments).toHaveLength(1);
  });

  // Regression (defect found in cross-task review): the AI SDK's part id
  // falls back to the literal 'text-0' when the provider omits one, and a
  // turn can contain multiple steps (each tool call starts a new step) that
  // each reuse that same fallback id. NATIVE_PARTS_DROPPED must only erase
  // the ABANDONED attempt's trailing segments, never an earlier, finished
  // step's text that happens to share the same id. This test fails against
  // the whole-list `.filter()` implementation, which deletes both.
  it('NATIVE_PARTS_DROPPED drops only the trailing run, even when an earlier finished step reused the same partId', () => {
    // Step 1: a finished text segment using the fallback partId.
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION,
      uuid: 'u1', text: 'finished step one', timestamp: 1, partId: 'text-0',
    });
    // A tool call starts a new step — this is the separator that guarantees
    // the abandoned text below cannot MERGE into step one's bubble, but does
    // nothing to protect a naive id-based filter from deleting step one too.
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION,
      uuid: 'u2', toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'ls' },
    });
    // Step 2 reuses the SAME fallback partId 'text-0' (provider omitted an
    // id again) — this is the abandoned half-sentence the stall Retry drops.
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION,
      uuid: 'u3', text: 'abandoned half sentence', timestamp: 2, partId: 'text-0',
    });

    state = dispatch(state, { type: 'NATIVE_PARTS_DROPPED', sessionId: SESSION, partIds: ['text-0'] });

    const s = state.get(SESSION)!;
    const turn = s.assistantTurns.get(s.currentTurnId!)!;
    // Step one's finished text must survive untouched.
    const texts = turn.segments
      .filter((seg: any) => seg.type === 'text')
      .map((seg: any) => seg.content);
    expect(texts).toEqual(['finished step one']);
    // Only the trailing abandoned text is gone; the tool-group separator stays.
    expect(turn.segments.map((seg: any) => seg.type)).toEqual(['text', 'tool-group']);
  });

  it('NATIVE_PARTS_DROPPED removes a multi-segment trailing run (reasoning + text from the same abandoned attempt)', () => {
    // Step 1: finished text (kept — not in the drop set, not trailing).
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION,
      uuid: 'u1', text: 'finished step', timestamp: 1, partId: 'text-0',
    });
    // New step boundary.
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION,
      uuid: 'u2', toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'ls' },
    });
    // The abandoned attempt: a reasoning segment followed by a text segment,
    // both belonging to the retried step and both in the drop set.
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION,
      uuid: 'u3', text: 'abandoned reasoning', timestamp: 2, partId: 'reason-1',
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION,
      uuid: 'u4', text: 'abandoned text', timestamp: 3, partId: 'text-1',
    });

    state = dispatch(state, {
      type: 'NATIVE_PARTS_DROPPED', sessionId: SESSION, partIds: ['reason-1', 'text-1'],
    });

    const s = state.get(SESSION)!;
    const turn = s.assistantTurns.get(s.currentTurnId!)!;
    expect(turn.segments.map((seg: any) => seg.type)).toEqual(['text', 'tool-group']);
    expect((turn.segments[0] as any).content).toBe('finished step');
  });
});
