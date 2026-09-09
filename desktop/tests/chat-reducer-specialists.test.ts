import { describe, it, expect, beforeEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction } from '../src/renderer/state/chat-types';
import type { SpecialistRunView, SubagentSegment } from '../src/shared/types';

// Task 11: the reducer half of "specialists". A Task card's status IS its
// ledger record — SPECIALIST_RUN_CHANGED folds a run view onto the launching
// card and rebuilds its Activity-trail note rows from run.notes. This file is
// the branch's FIRST renderer specialist reducer test — several cases below
// pin behavior that already shipped (the ask nesting/reclaim plumbing); the
// note-rebuild and short-circuit cases are what actually drive new code.

const SESSION = 'test-session';
const TASK_ID = 'task-1';
const CHILD_ID = 'child-1';

function initState(): ChatState {
  const state: ChatState = new Map();
  return chatReducer(state, { type: 'SESSION_INIT', sessionId: SESSION });
}

function dispatch(state: ChatState, action: ChatAction): ChatState {
  return chatReducer(state, action);
}

/** Seeds a session with one Task card (the way a real Task tool-use event
 *  creates it) so SPECIALIST_RUN_CHANGED / PERMISSION_REQUEST / PERMISSION_HELD
 *  have a card to fold onto — mirrors the real event that always precedes a
 *  ledger write (chat-reducer.ts's SPECIALIST_RUN_CHANGED comment). */
function seedTaskCard(state: ChatState, toolUseId = TASK_ID): ChatState {
  return dispatch(state, {
    type: 'TRANSCRIPT_TOOL_USE',
    sessionId: SESSION,
    uuid: `uuid-${toolUseId}`,
    toolUseId,
    toolName: 'Task',
    toolInput: { description: 'hire a specialist' },
  });
}

function note(text: string, at: number, from: 'user' | 'assistant' = 'user') {
  return { text, from, at };
}

function baseRun(overrides: Partial<SpecialistRunView> = {}): SpecialistRunView {
  return {
    childId: CHILD_ID,
    parentToolCallId: TASK_ID,
    agentType: 'explorer',
    title: 'Nadia the Rambling Researcher',
    background: false,
    status: 'running',
    startedAt: 1000,
    steps: 1,
    ...overrides,
  };
}

function noteSegments(state: ChatState, toolUseId = TASK_ID): SubagentSegment[] {
  const card = state.get(SESSION)!.toolCalls.get(toolUseId)!;
  return (card.subagentSegments ?? []).filter((s) => s.type === 'note');
}

describe('SPECIALIST_RUN_CHANGED — note rows from run.notes', () => {
  let state: ChatState;

  beforeEach(() => {
    state = seedTaskCard(initState());
  });

  it('with two notes yields two rows; the same event again yields two rows (idempotent by construction)', () => {
    const run = baseRun({ notes: [note('first', 100), note('second', 200)] });

    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });
    let notes = noteSegments(state);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => (n as any).content)).toEqual(['first', 'second']);

    // Re-processing the identical run (a deep-equal but distinct object —
    // exercises the short-circuit below, not object identity) must not grow
    // the row count.
    const stateAfterFirst = state;
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED',
      sessionId: SESSION,
      run: JSON.parse(JSON.stringify(run)),
    });
    expect(state).toBe(stateAfterFirst); // short-circuit: same object, not just same content
    notes = noteSegments(state);
    expect(notes).toHaveLength(2);
  });

  it('a run with a third note yields three rows in timestamp order', () => {
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED',
      sessionId: SESSION,
      run: baseRun({ steps: 1, notes: [note('first', 100), note('second', 200)] }),
    });
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED',
      sessionId: SESSION,
      run: baseRun({ steps: 2, notes: [note('first', 100), note('second', 200), note('third', 300)] }),
    });

    const notes = noteSegments(state);
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => (n as any).content)).toEqual(['first', 'second', 'third']);
    expect(notes.map((n) => (n as any).timestamp)).toEqual([100, 200, 300]);
  });

  it('two notes with the same timestamp and text are TWO rows', () => {
    // Ambiguity resolved for the implementer: note segment ids are
    // index-based (sa-note-<childId>-<i>), not timestamp-based, precisely so
    // two notes landing in the same millisecond don't collide on id and get
    // deduped down to one row.
    const run = baseRun({ notes: [note('same', 500), note('same', 500)] });
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });

    const notes = noteSegments(state);
    expect(notes).toHaveLength(2);
    expect(notes[0].id).not.toBe(notes[1].id);
  });

  it('a run event for an unknown parentToolCallId is dropped, never a stray card', () => {
    const before = state;
    const run = baseRun({ parentToolCallId: 'no-such-card', childId: 'no-such-child', notes: [note('x', 1)] });
    const after = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });

    // Dropped, not parked: the reducer returns state itself, unchanged.
    expect(after).toBe(before);
    expect(after.get(SESSION)!.toolCalls.has('no-such-card')).toBe(false);
    expect(after.get(SESSION)!.toolCalls.size).toBe(1); // only the seeded Task card
  });

  it('a run view identical to the card’s current one returns the SAME state object (no churn)', () => {
    // Models the delivery-bookkeeping cycle (claim / mark-attempted / confirm
    // / release): the projection reaching the renderer is byte-identical
    // across up to four ledger writes, and the reducer — not the emit path —
    // must absorb them.
    const run = baseRun({ notes: [note('only', 1)] });
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });
    const settled = state;

    for (let i = 0; i < 4; i++) {
      state = dispatch(state, {
        type: 'SPECIALIST_RUN_CHANGED',
        sessionId: SESSION,
        run: JSON.parse(JSON.stringify(run)),
      });
      expect(state).toBe(settled);
    }
  });

  it('replay then live: a newer live run view lands after a replayed one and wins; the replayed one re-sent afterwards does not regress or duplicate note rows', () => {
    // The main-process replay loop is synchronous — a live event cannot land
    // INSIDE it. This models the window right after replay completes: the
    // replayed (older, fewer notes) run lands first, a live (newer, more
    // notes) run lands right after and wins, and then — the case this test
    // actually exists to pin — the stale replayed run is re-sent.
    const replayedRun = baseRun({ steps: 1, notes: [note('first', 100)] });
    const liveRun = baseRun({ steps: 3, notes: [note('first', 100), note('second', 200)] });

    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: replayedRun });
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: liveRun });

    let card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    expect(card.specialistRun).toEqual(liveRun);
    expect(noteSegments(state)).toHaveLength(2);

    // The stale replayed run is re-sent. It is NOT deep-equal to the card's
    // current (live) run, so the short-circuit does not apply — per the
    // reducer's stated contract that only fires on an exact match, this run
    // event still applies normally (SPECIALIST_RUN_CHANGED has no notion of
    // "older"; there is no sequence/version field on SpecialistRunView to
    // detect staleness). What must NOT happen is losing the note row the live
    // run already added: notes are merged by id (never replaced wholesale),
    // so a resend that carries fewer notes cannot delete one already shown.
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: replayedRun });

    card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    const notes = noteSegments(state);
    expect(notes).toHaveLength(2); // 'second' must not have been dropped
    expect(notes.map((n) => (n as any).content)).toEqual(['first', 'second']);
    // No duplicate row for 'first' either — the resend's note is already known.
    expect(new Set(notes.map((n) => n.id)).size).toBe(2);
  });
});

describe('tool-group status — stopped specialist', () => {
  it('keeps its Task card complete after the specialist is stopped', () => {
    let state = seedTaskCard(initState());
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_RESULT', sessionId: SESSION, uuid: 'task-launch-ack',
      toolUseId: TASK_ID, result: 'The specialist is working in the background.',
      isError: false,
    });
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ status: 'interrupted', endedAt: 2000 }),
    });

    const card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    // The Task result acknowledges its launch; only a live run can keep the
    // group active after that run has reached a terminal status.
    expect(card.status).toBe('complete');
    expect(card.specialistRun?.status).toBe('interrupted');
  });
});

describe('SPECIALIST_RUN_CHANGED — stale pushes cannot rewind a card (ROADMAP L259)', () => {
  let state: ChatState;

  beforeEach(() => {
    state = seedTaskCard(initState());
  });

  function runOf(state: ChatState): SpecialistRunView {
    return state.get(SESSION)!.toolCalls.get(TASK_ID)!.specialistRun!;
  }

  it('a straggler with a lower seq is dropped, not applied', () => {
    // The bug: every push overwrote the WHOLE run record and the reducer
    // applied whichever arrived LAST, so a replay-then-live race could revert
    // a finished card to "running" with nothing later to correct it.
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ seq: 5, status: 'completed', endedAt: 2000, steps: 9 }),
    });
    expect(runOf(state).status).toBe('completed');

    const settled = state;
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ seq: 4, status: 'running', steps: 3 }),
    });
    expect(state).toBe(settled);
    expect(runOf(state).status).toBe('completed');
  });

  it('a re-send of the SAME seq is dropped too', () => {
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ seq: 5, status: 'completed', endedAt: 2000 }),
    });
    const settled = state;
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ seq: 5, status: 'running' }),
    });
    expect(state).toBe(settled);
  });

  it('a genuinely newer push still applies', () => {
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ seq: 1, status: 'running' }),
    });
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ seq: 2, status: 'completed', endedAt: 2000 }),
    });
    expect(runOf(state).status).toBe('completed');
  });

  it('an unstamped push still applies — a card replayed from an older build must not freeze', () => {
    // `seq` is optional on purpose. If either side has none the two cannot be
    // ordered, and refusing the update would leave the card stuck forever.
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ status: 'running' }),
    });
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ seq: 3, status: 'completed', endedAt: 2000 }),
    });
    expect(runOf(state).status).toBe('completed');

    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ status: 'failed', endedAt: 3000 }),
    });
    expect(runOf(state).status).toBe('failed');
  });

  it('the delivery-cycle short-circuit still absorbs identical pushes that differ ONLY by seq', () => {
    // One delivery cycle (claim / mark-attempted / confirm / release) rewrites
    // the ledger four times and projects four views. They are byte-identical
    // apart from the stamp, so the structural comparison must ignore it — or
    // Task 11's short-circuit would never fire again and every cycle would
    // push four new state objects through the tree.
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
      run: baseRun({ seq: 1, status: 'completed', endedAt: 2000 }),
    });
    const settled = state;
    for (const seq of [2, 3, 4]) {
      state = dispatch(state, {
        type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION,
        run: baseRun({ seq, status: 'completed', endedAt: 2000 }),
      });
    }
    expect(state).toBe(settled);
  });
});

describe('SPECIALIST_RUN_CHANGED — ask plumbing (pinning existing behavior)', () => {
  let state: ChatState;

  beforeEach(() => {
    state = seedTaskCard(initState());
  });

  it('PERMISSION_HELD sets askHeld on the nested row and nowhere else', () => {
    // First, a specialist child's ask nests under the Task card as a
    // synthetic sa-perm-<requestId> segment (PERMISSION_REQUEST, no matching
    // running tool segment yet).
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'ls' },
      requestId: 'req-1',
      specialist: { childId: CHILD_ID, agentType: 'explorer', title: 'Nadia', parentToolCallId: TASK_ID },
    });

    let card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    let segs = card.subagentSegments ?? [];
    expect(segs).toHaveLength(1);
    expect((segs[0] as any).status).toBe('awaiting-approval');

    state = dispatch(state, { type: 'PERMISSION_HELD', sessionId: SESSION, requestId: 'req-1' });

    card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    segs = card.subagentSegments ?? [];
    expect((segs[0] as any).askHeld).toBe(true);
    // ToolCallState has no askHeld field at all — the top-level card itself
    // must be untouched by this action.
    expect((card as any).askHeld).toBeUndefined();
  });

  it('the sa-perm- placeholder is reclaimed when the tool-use event lands after the ask', () => {
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'ls' },
      requestId: 'req-2',
      specialist: { childId: CHILD_ID, agentType: 'explorer', title: 'Nadia', parentToolCallId: TASK_ID },
    });

    let card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    let segs = card.subagentSegments ?? [];
    expect(segs).toHaveLength(1);
    expect(segs[0].id).toBe('sa-perm-req-2');

    // The child's real tool-use event lands after the ask, naming the same
    // tool and input. It must reclaim the placeholder in place, not push a
    // second segment.
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'uuid-child-tool-1',
      toolUseId: 'child-tool-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      parentAgentToolUseId: TASK_ID,
    });

    card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    segs = card.subagentSegments ?? [];
    expect(segs).toHaveLength(1); // reclaimed, not duplicated
    const seg = segs[0] as any;
    expect(seg.id).toBe('sa-tool-child-tool-1');
    expect(seg.toolUseId).toBe('child-tool-1');
    // The ask state survives the handover — this is the whole point of the
    // reclaim: a real tool-use event must not blow away a pending approval.
    expect(seg.status).toBe('awaiting-approval');
    expect(seg.requestId).toBe('req-2');
  });
});

describe('SPECIALIST_RUN_CHANGED — a note lands WHERE it happened in the Activity trail, not at the bottom', () => {
  // Investigation 2026-09-01 (specialist-notes-not-interleaved): the ledger
  // always resends the FULL notes array, and reconcileNoteSegments used to
  // APPEND every unseen note to the tail of the segment list. Live that is
  // usually right (nothing later has arrived yet), but on a card replay —
  // reattach, restart, a late run push — every tool row is already on the
  // card, so a note sent mid-run showed up AFTER tool calls that happened
  // after it. The trail is an audit log; the order has to be true.
  let state: ChatState;

  /** A child tool-use event the way the harness stamps it — parented to the
   *  Task card so the reducer routes it to applySubagentEvent. */
  function childTool(toolUseId: string, timestamp: number): ChatAction {
    return {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: `uuid-${toolUseId}`,
      toolUseId,
      toolName: 'Read',
      toolInput: { file_path: `${toolUseId}.ts` },
      timestamp,
      parentAgentToolUseId: TASK_ID,
      agentId: CHILD_ID,
    } as ChatAction;
  }

  function trail(s: ChatState): string[] {
    const card = s.get(SESSION)!.toolCalls.get(TASK_ID)!;
    return (card.subagentSegments ?? []).map((seg) => seg.type === 'note' ? `note:${seg.content}` : `tool:${(seg as any).toolUseId}`);
  }

  beforeEach(() => {
    state = seedTaskCard(initState());
  });

  it('a note timestamped between two tool calls is placed between them', () => {
    state = dispatch(state, childTool('t1', 100));
    state = dispatch(state, childTool('t2', 300));
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ notes: [note('mid', 200)] }) });
    expect(trail(state)).toEqual(['tool:t1', 'note:mid', 'tool:t2']);
  });

  it('a note later than every segment still appends (the live case)', () => {
    state = dispatch(state, childTool('t1', 100));
    state = dispatch(state, childTool('t2', 300));
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ notes: [note('late', 400)] }) });
    expect(trail(state)).toEqual(['tool:t1', 'tool:t2', 'note:late']);
  });

  it('a note earlier than every segment goes first', () => {
    state = dispatch(state, childTool('t1', 100));
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ notes: [note('early', 50)] }) });
    expect(trail(state)).toEqual(['note:early', 'tool:t1']);
  });

  it('the same run re-sent leaves the order and count untouched (index ids still dedupe)', () => {
    state = dispatch(state, childTool('t1', 100));
    state = dispatch(state, childTool('t2', 300));
    const run = baseRun({ notes: [note('mid', 200)] });
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });
    // A later push with MORE notes (steps moved so the short-circuit does not
    // absorb it) must keep 'mid' where it is and place the new note by time.
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ steps: 2, notes: [note('mid', 200), note('after', 350)] }) });
    expect(trail(state)).toEqual(['tool:t1', 'note:mid', 'tool:t2', 'note:after']);
    // Order stays true even when a tool row arrives AFTER the note that
    // precedes it (a replay that splices child events late).
    state = dispatch(state, childTool('t3', 500));
    expect(trail(state)).toEqual(['tool:t1', 'note:mid', 'tool:t2', 'note:after', 'tool:t3']);
  });

  it('a tool row with no timestamp (an older event shape) never blocks placement — the note appends after it', () => {
    state = dispatch(state, { ...(childTool('t1', 100) as any), timestamp: undefined });
    state = dispatch(state, childTool('t2', 300));
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ notes: [note('mid', 200)] }) });
    // t1 carries no time, so it cannot be ordered against the note; t2 (300)
    // can, and the note belongs before it.
    expect(trail(state)).toEqual(['tool:t1', 'note:mid', 'tool:t2']);
  });

  // Review of fix/specialists-ledger-bugs (2026-09-04, F2/F6): placement used
  // to be one-directional — a note was slotted by time among rows already on
  // the card, but a ROW arriving after a later-stamped note was still appended
  // below it. Reachable live: transcript events are rAF-batched (one frame),
  // `specialists:event` is dispatched synchronously, so a child tool-use
  // stamped in the frame before the user's note lands after it.
  it('a tool row stamped EARLIER than a note already on the card is inserted before that note, not appended', () => {
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ notes: [note('mid', 200)] }) });
    state = dispatch(state, childTool('t1', 100));
    expect(trail(state)).toEqual(['tool:t1', 'note:mid']);
  });

  it('a child text or thinking segment stamped earlier than a note goes before it too', () => {
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ notes: [note('mid', 200)] }) });
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'u-txt', text: 'looking',
      timestamp: 100, parentAgentToolUseId: TASK_ID, agentId: CHILD_ID,
    } as ChatAction);
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'u-thk', text: 'hmm',
      timestamp: 150, parentAgentToolUseId: TASK_ID, agentId: CHILD_ID,
    } as ChatAction);
    const card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    expect((card.subagentSegments ?? []).map((s) => s.type)).toEqual(['text', 'thinking', 'note']);
  });

  it('a later delta of the same partId still merges into its text segment after a note was slotted behind it', () => {
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ notes: [note('mid', 200)] }) });
    const delta = (uuid: string, text: string) => ({
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid, text, partId: 'p1',
      timestamp: 100, parentAgentToolUseId: TASK_ID, agentId: CHILD_ID,
    } as ChatAction);
    state = dispatch(state, delta('d1', 'look'));
    state = dispatch(state, delta('d2', 'ing'));
    const card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    const segs = card.subagentSegments ?? [];
    expect(segs.map((s) => s.type)).toEqual(['text', 'note']);
    expect((segs[0] as any).content).toBe('looking');
  });

  it('F6: once an early row has been slotted before a note, a second note is still placed by time (no compounding misorder)', () => {
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ notes: [note('mid', 200)] }) });
    state = dispatch(state, childTool('t1', 100));
    state = dispatch(state, childTool('t2', 300));
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ steps: 2, notes: [note('mid', 200), note('later', 250)] }) });
    expect(trail(state)).toEqual(['tool:t1', 'note:mid', 'note:later', 'tool:t2']);
  });

  it('a row with no timestamp is never reordered — it appends even behind a later-stamped note', () => {
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ notes: [note('mid', 200)] }) });
    state = dispatch(state, { ...(childTool('t1', 100) as any), timestamp: undefined });
    expect(trail(state)).toEqual(['note:mid', 'tool:t1']);
  });

  it('two rows stamped the same millisecond keep arrival order', () => {
    state = dispatch(state, childTool('t1', 100));
    state = dispatch(state, childTool('t2', 100));
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun({ notes: [note('mid', 100)] }) });
    expect(trail(state)).toEqual(['tool:t1', 'tool:t2', 'note:mid']);
  });
});
