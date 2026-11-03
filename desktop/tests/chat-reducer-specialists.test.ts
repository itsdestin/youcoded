import { describe, it, expect, beforeEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction } from '../src/renderer/state/chat-types';
import type { SpecialistRunView, SubagentSegment } from '../src/shared/types';

// The reducer half of specialists: a Task card's status IS its ledger record; SPECIALIST_RUN_CHANGED folds a run view onto
// the launching card and rebuilds its Activity-trail note rows from run.notes.

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

/** Seeds one Task card, as the real Task tool-use event that always precedes a ledger write does. */
function seedTaskCard(state: ChatState, toolUseId = TASK_ID): ChatState {
  return dispatch(state, {
    type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
    sessionId: SESSION,
    uuid: `uuid-${toolUseId}`,
    toolUseId,
    toolName: 'Task',
    toolInput: { description: 'hire a specialist' },
  });
}

const runChanged = (state: ChatState, run: SpecialistRunView) => dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });

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

    // a deep-equal but distinct object exercises the short-circuit, not identity
    const stateAfterFirst = state;
    state = runChanged(state, JSON.parse(JSON.stringify(run)));
    expect(state).toBe(stateAfterFirst); // short-circuit: same object, not just same content
    notes = noteSegments(state);
    expect(notes).toHaveLength(2);
  });

  it('a run with a third note yields three rows in timestamp order', () => {
    state = runChanged(state, baseRun({ steps: 1, notes: [note('first', 100), note('second', 200)] }));
    state = runChanged(state, baseRun({ steps: 2, notes: [note('first', 100), note('second', 200), note('third', 300)] }));

    const notes = noteSegments(state);
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => (n as any).content)).toEqual(['first', 'second', 'third']);
    expect(notes.map((n) => (n as any).timestamp)).toEqual([100, 200, 300]);
  });

  it('two notes with the same timestamp and text are TWO rows', () => {
    // note segment ids are index-based so two notes in the same millisecond don't dedupe to one row
    const run = baseRun({ notes: [note('same', 500), note('same', 500)] });
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });

    const notes = noteSegments(state);
    expect(notes).toHaveLength(2);
    expect(notes[0].id).not.toBe(notes[1].id);
  });

  it('a run event for an unknown parentToolCallId is parked, never a stray card', () => {
    const run = baseRun({ parentToolCallId: 'no-such-card', childId: 'no-such-child', notes: [note('x', 1)] });
    const after = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });

    expect(after.get(SESSION)!.toolCalls.has('no-such-card')).toBe(false);
    expect(after.get(SESSION)!.toolCalls.size).toBe(1); // only the seeded Task card
    expect(after.get(SESSION)!.parkedSpecialistRuns?.get('no-such-child')).toBe(run);
  });

  // A reload sends history and helper records separately, and the history's
  // tool events are batched while the records are not — so the record can land
  // first. Dropping it left a finished helper's card with no notes for good.
  it('a record that arrives before its card is applied the moment the card appears', () => {
    let s = initState();
    const run = baseRun({ status: 'completed', notes: [note('look at the tests too', 5)] });
    s = dispatch(s, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });
    expect(s.get(SESSION)!.toolCalls.has(TASK_ID)).toBe(false);
    s = seedTaskCard(s);
    expect(s.get(SESSION)!.toolCalls.get(TASK_ID)!.specialistRun).toEqual(run);
    expect(noteSegments(s).map((n) => (n as any).content)).toEqual(['look at the tests too']);
    expect(s.get(SESSION)!.parkedSpecialistRuns).toBeUndefined();
  });

  it('only the newest parked record per helper is kept', () => {
    let s = initState();
    s = runChanged(s, baseRun({ seq: 5, status: 'completed' }));
    s = runChanged(s, baseRun({ seq: 3, status: 'running' }));
    s = seedTaskCard(s);
    expect(s.get(SESSION)!.toolCalls.get(TASK_ID)!.specialistRun!.status).toBe('completed');
  });

  it('a run view identical to the card’s current one returns the SAME state object (no churn)', () => {
    // the delivery cycle (claim / mark-attempted / confirm / release) projects byte-identical views; the reducer must absorb them
    const run = baseRun({ notes: [note('only', 1)] });
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });
    const settled = state;

    for (let i = 0; i < 4; i++) {
      state = runChanged(state, JSON.parse(JSON.stringify(run)));
      expect(state).toBe(settled);
    }
  });

  it('replay then live: a newer live run view lands after a replayed one and wins; the replayed one re-sent afterwards does not regress or duplicate note rows', () => {
    // After replay completes: replayed (older) lands, live (newer) wins, then the stale replayed run is re-sent.
    const replayedRun = baseRun({ steps: 1, notes: [note('first', 100)] });
    const liveRun = baseRun({ steps: 3, notes: [note('first', 100), note('second', 200)] });

    state = runChanged(state, replayedRun);
    state = runChanged(state, liveRun);

    let card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    expect(card.specialistRun).toEqual(liveRun);
    expect(noteSegments(state)).toHaveLength(2);

    // not deep-equal to the live run so the short-circuit doesn't apply; notes merge by id so fewer notes can't delete a shown row
    state = runChanged(state, replayedRun);

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
    state = runChanged(state, baseRun({ status: 'interrupted', endedAt: 2000 }));

    const card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    // The Task result acknowledges its launch; only a live run can keep the
    // group active after that run has reached a terminal status.
    expect(card.status).toBe('complete');
    expect(card.specialistRun?.status).toBe('interrupted');
  });
});

describe('SPECIALIST_RUN_CHANGED — stale pushes cannot rewind a card', () => {
  let state: ChatState;

  beforeEach(() => {
    state = seedTaskCard(initState());
  });

  function runOf(state: ChatState): SpecialistRunView {
    return state.get(SESSION)!.toolCalls.get(TASK_ID)!.specialistRun!;
  }

  it('a straggler with a lower seq is dropped, not applied', () => {
    // WHY: every push once overwrote the whole record, so a replay-then-live race could revert a finished card to "running".
    state = runChanged(state, baseRun({ seq: 5, status: 'completed', endedAt: 2000, steps: 9 }));
    expect(runOf(state).status).toBe('completed');

    const settled = state;
    state = runChanged(state, baseRun({ seq: 4, status: 'running', steps: 3 }));
    expect(state).toBe(settled);
    expect(runOf(state).status).toBe('completed');
  });

  it('a re-send of the SAME seq is dropped too', () => {
    state = runChanged(state, baseRun({ seq: 5, status: 'completed', endedAt: 2000 }));
    const settled = state;
    state = runChanged(state, baseRun({ seq: 5, status: 'running' }));
    expect(state).toBe(settled);
  });

  it('a genuinely newer push still applies', () => {
    state = runChanged(state, baseRun({ seq: 1, status: 'running' }));
    state = runChanged(state, baseRun({ seq: 2, status: 'completed', endedAt: 2000 }));
    expect(runOf(state).status).toBe('completed');
  });

  it('an unstamped push still applies — a card replayed from an older build must not freeze', () => {
    // seq is optional on purpose: unorderable pushes must apply or the card freezes.
    state = runChanged(state, baseRun({ status: 'running' }));
    state = runChanged(state, baseRun({ seq: 3, status: 'completed', endedAt: 2000 }));
    expect(runOf(state).status).toBe('completed');

    state = runChanged(state, baseRun({ status: 'failed', endedAt: 3000 }));
    expect(runOf(state).status).toBe('failed');
  });

  it('the delivery-cycle short-circuit still absorbs identical pushes that differ ONLY by seq', () => {
    // identical-but-for-seq pushes must hit the short-circuit, or every delivery cycle pushes four new state objects
    state = runChanged(state, baseRun({ seq: 1, status: 'completed', endedAt: 2000 }));
    const settled = state;
    for (const seq of [2, 3, 4]) {
      state = runChanged(state, baseRun({ seq, status: 'completed', endedAt: 2000 }));
    }
    expect(state).toBe(settled);
  });
});

describe('SPECIALIST_RUN_CHANGED — ask plumbing (pinning existing behavior)', () => {
  let state: ChatState;

  beforeEach(() => {
    state = seedTaskCard(initState());
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
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1,
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

// A helper's ask whose Task card isn't loaded must not bind to the PARENT's
// running tool of the same name (a card naming one command while its buttons
// approve another). With no timeout, such a mis-binding would never end.
describe('PERMISSION_REQUEST — a helper ask with no Task card', () => {
  it('gets its own card instead of taking over the parent\'s running Bash', () => {
    let state = initState();
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 1, sessionId: SESSION, uuid: 'u-parent-bash',
      toolUseId: 'parent-bash', toolName: 'Bash', toolInput: { command: 'npm test' },
    });
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Bash',
      input: { command: 'rm -rf dist' }, requestId: 'req-helper',
      specialist: { childId: 'child-x', agentType: 'worker', title: 'Wren', parentToolCallId: 'task-not-loaded' },
    });
    const calls = state.get(SESSION)!.toolCalls;
    expect(calls.get('parent-bash')!.status).toBe('running');
    expect(calls.get('parent-bash')!.requestId).toBeUndefined();
    const own = [...calls.values()].find((t) => t.requestId === 'req-helper')!;
    expect(own.toolUseId).not.toBe('parent-bash');
    expect(own.specialist?.title).toBe('Wren');
  });
});

describe('SPECIALIST_RUN_CHANGED — a note lands WHERE it happened in the Activity trail, not at the bottom', () => {
  // WHY: the ledger resends the FULL notes array and notes used to append at the tail, so on replay a note showed up AFTER tool calls that happened after it.
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
    state = runChanged(state, baseRun({ notes: [note('mid', 200)] }));
    expect(trail(state)).toEqual(['tool:t1', 'note:mid', 'tool:t2']);
  });

  it('a note later than every segment still appends (the live case)', () => {
    state = dispatch(state, childTool('t1', 100));
    state = dispatch(state, childTool('t2', 300));
    state = runChanged(state, baseRun({ notes: [note('late', 400)] }));
    expect(trail(state)).toEqual(['tool:t1', 'tool:t2', 'note:late']);
  });

  it('a note earlier than every segment goes first', () => {
    state = dispatch(state, childTool('t1', 100));
    state = runChanged(state, baseRun({ notes: [note('early', 50)] }));
    expect(trail(state)).toEqual(['note:early', 'tool:t1']);
  });

  it('the same run re-sent leaves the order and count untouched (index ids still dedupe)', () => {
    state = dispatch(state, childTool('t1', 100));
    state = dispatch(state, childTool('t2', 300));
    const run = baseRun({ notes: [note('mid', 200)] });
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });
    // A later push with MORE notes (steps moved so the short-circuit does not
    // absorb it) must keep 'mid' where it is and place the new note by time.
    state = runChanged(state, baseRun({ steps: 2, notes: [note('mid', 200), note('after', 350)] }));
    expect(trail(state)).toEqual(['tool:t1', 'note:mid', 'tool:t2', 'note:after']);
    // Order stays true even when a tool row arrives AFTER the note that
    // precedes it (a replay that splices child events late).
    state = dispatch(state, childTool('t3', 500));
    expect(trail(state)).toEqual(['tool:t1', 'note:mid', 'tool:t2', 'note:after', 'tool:t3']);
  });

  it('a tool row with no timestamp (an older event shape) never blocks placement — the note appends after it', () => {
    state = dispatch(state, { ...(childTool('t1', 100) as any), timestamp: undefined });
    state = dispatch(state, childTool('t2', 300));
    state = runChanged(state, baseRun({ notes: [note('mid', 200)] }));
    // t1 carries no time, so it cannot be ordered against the note; t2 (300)
    // can, and the note belongs before it.
    expect(trail(state)).toEqual(['tool:t1', 'note:mid', 'tool:t2']);
  });

  // WHY: placement was one-directional; a ROW arriving after a later-stamped note (rAF-batched transcript vs synchronous specialists:event) was appended below it.
  it('a tool row stamped EARLIER than a note already on the card is inserted before that note, not appended', () => {
    state = runChanged(state, baseRun({ notes: [note('mid', 200)] }));
    state = dispatch(state, childTool('t1', 100));
    expect(trail(state)).toEqual(['tool:t1', 'note:mid']);
  });

  it('a child text or thinking segment stamped earlier than a note goes before it too', () => {
    state = runChanged(state, baseRun({ notes: [note('mid', 200)] }));
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
    state = runChanged(state, baseRun({ notes: [note('mid', 200)] }));
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

  it('once an early row has been slotted before a note, a second note is still placed by time (no compounding misorder)', () => {
    state = runChanged(state, baseRun({ notes: [note('mid', 200)] }));
    state = dispatch(state, childTool('t1', 100));
    state = dispatch(state, childTool('t2', 300));
    state = runChanged(state, baseRun({ steps: 2, notes: [note('mid', 200), note('later', 250)] }));
    expect(trail(state)).toEqual(['tool:t1', 'note:mid', 'note:later', 'tool:t2']);
  });

  it('a row with no timestamp is never reordered — it appends even behind a later-stamped note', () => {
    state = runChanged(state, baseRun({ notes: [note('mid', 200)] }));
    state = dispatch(state, { ...(childTool('t1', 100) as any), timestamp: undefined });
    expect(trail(state)).toEqual(['note:mid', 'tool:t1']);
  });

  it('two rows stamped the same millisecond keep arrival order', () => {
    state = dispatch(state, childTool('t1', 100));
    state = dispatch(state, childTool('t2', 100));
    state = runChanged(state, baseRun({ notes: [note('mid', 100)] }));
    expect(trail(state)).toEqual(['tool:t1', 'tool:t2', 'note:mid']);
  });
});

// Resuming a finished helper restarts the SAME ledger row but stamps its events/asks with the NEW resume-call card; the run stays on the original card.
describe('a resumed child', () => {
  const RESUME_CALL = 'task-resume-call';
  const base = (): ChatState => {
    let s = seedTaskCard(initState());
    s = seedTaskCard(s, RESUME_CALL);   // the later Task call that resumed the child (no run record of its own)
    s = runChanged(s, baseRun({ status: 'failed', endedAt: 2000, seq: 5 }));
    // The first run's report was delivered and folded onto the card.
    return dispatch(s, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'rep1', text: 'It broke', timestamp: 2100,
      injected: 'specialist-report',
      injectedMeta: { childId: CHILD_ID, title: 'Nadia', agentType: 'explorer', status: 'failed', parentToolCallId: TASK_ID },
    } as ChatAction);
  };
  const card = (s: ChatState, id = TASK_ID) => s.get(SESSION)!.toolCalls.get(id)!;

  it('the old report goes when the same child starts a newer run (it would read Failed with the old text)', () => {
    let s = base();
    expect(card(s).specialistReport?.status).toBe('failed');
    s = runChanged(s, baseRun({ status: 'running', startedAt: 3000, seq: 6 }));
    expect(card(s).specialistRun?.status).toBe('running');
    expect(card(s).specialistReport).toBeUndefined();
  });
  it('a newer run is accepted even if the host restarted and its stamp counter began again', () => {
    let s = base();
    s = runChanged(s, baseRun({ status: 'running', startedAt: 3000, seq: 1 }));
    expect(card(s).specialistRun?.status).toBe('running');
  });
  it('an old straggler for the FIRST run still cannot revive it', () => {
    let s = base();
    s = runChanged(s, baseRun({ status: 'running', startedAt: 1000, seq: 2 }));
    expect(card(s).specialistRun?.status).toBe('failed');
    expect(card(s).specialistReport?.status).toBe('failed');
  });
  it('the resumed run’s own report replaces the old one', () => {
    let s = base();
    s = runChanged(s, baseRun({ status: 'running', startedAt: 3000, seq: 6 }));
    s = runChanged(s, baseRun({ status: 'completed', startedAt: 3000, endedAt: 4000, seq: 7 }));
    s = dispatch(s, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'rep2', text: 'Fixed it', timestamp: 4100,
      injected: 'specialist-report',
      injectedMeta: { childId: CHILD_ID, title: 'Nadia', agentType: 'explorer', status: 'completed', parentToolCallId: RESUME_CALL },
    } as ChatAction);
    // The report folds onto the card that carries the run, not the resume call.
    expect(card(s).specialistReport).toMatchObject({ status: 'completed', text: 'Fixed it' });
    expect(card(s, RESUME_CALL).specialistReport).toBeUndefined();
  });
  it('an ask from the resumed child lands on the card that carries its run', () => {
    let s = base();
    s = runChanged(s, baseRun({ status: 'running', startedAt: 3000, seq: 6 }));
    s = dispatch(s, {
      type: 'PERMISSION_REQUEST', sessionId: SESSION, toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-r',
      specialist: { childId: CHILD_ID, agentType: 'explorer', title: 'Nadia', parentToolCallId: RESUME_CALL },
    });
    expect(card(s).subagentSegments?.some(g => g.type === 'tool' && g.requestId === 'req-r')).toBe(true);
    expect(card(s, RESUME_CALL).subagentSegments?.length ?? 0).toBe(0);
  });
  it('the resumed child’s live activity lands there too', () => {
    let s = base();
    s = runChanged(s, baseRun({ status: 'running', startedAt: 3000, seq: 6 }));
    s = dispatch(s, {
      type: 'TRANSCRIPT_TOOL_USE', timestamp: 3500, sessionId: SESSION, uuid: 'cu', toolUseId: 'child-tool', toolName: 'Read', toolInput: { file_path: '/x' },
      parentAgentToolUseId: RESUME_CALL, agentId: CHILD_ID,
    });
    expect(card(s).subagentSegments?.some(g => g.type === 'tool' && g.toolUseId === 'child-tool')).toBe(true);
    expect(card(s, RESUME_CALL).subagentSegments?.length ?? 0).toBe(0);
  });
  it('a child’s activity for an ordinary (never resumed) card is unchanged', () => {
    let s = dispatch(seedTaskCard(initState()), { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: baseRun() });
    s = dispatch(s, { type: 'TRANSCRIPT_TOOL_USE', timestamp: 2, sessionId: SESSION, uuid: 'cu', toolUseId: 'ct', toolName: 'Read', toolInput: {}, parentAgentToolUseId: TASK_ID, agentId: CHILD_ID });
    expect(card(s).subagentSegments).toHaveLength(1);
  });
});
