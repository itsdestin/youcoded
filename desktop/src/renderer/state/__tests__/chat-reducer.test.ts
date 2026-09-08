import { describe, it, expect, vi } from 'vitest';
import { chatReducer } from '../chat-reducer';
import { createSessionChatState, serializeChatState } from '../chat-types';
import type { ChatState } from '../chat-types';
import type { ToolCallState } from '../../../shared/types';

function stateWithInFlightTurn(sessionId = 'sess-1', turnId = 'turn-1'): ChatState {
  const session = createSessionChatState();
  session.currentTurnId = turnId;
  session.isThinking = true;
  const runningTool: ToolCallState = {
    toolUseId: 'tool-1',
    toolName: 'Bash',
    status: 'running',
    input: { command: 'sleep 1000' },
  } as any;
  const awaitingTool: ToolCallState = {
    toolUseId: 'tool-2',
    toolName: 'Edit',
    status: 'awaiting-approval',
    input: {},
  } as any;
  session.toolCalls.set('tool-1', runningTool);
  session.toolCalls.set('tool-2', awaitingTool);
  session.activeTurnToolIds.add('tool-1');
  session.activeTurnToolIds.add('tool-2');
  session.assistantTurns.set(turnId, {
    id: turnId,
    segments: [],
    timestamp: 1000,
    stopReason: null,
    model: null,
    usage: null,
    anthropicRequestId: null,
  });
  return new Map([[sessionId, session]]);
}

describe('chatReducer TRANSCRIPT_INTERRUPT', () => {
  it('attaches stopReason=interrupted to the in-flight turn', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    const session = next.get('sess-1')!;
    expect(session.assistantTurns.get('turn-1')?.stopReason).toBe('interrupted');
  });

  it('flips running/awaiting-approval tools to failed with error "Turn interrupted"', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'tool-use',
    });
    const session = next.get('sess-1')!;
    expect(session.toolCalls.get('tool-1')?.status).toBe('failed');
    expect((session.toolCalls.get('tool-1') as any).error).toBe('Turn interrupted');
    expect(session.toolCalls.get('tool-2')?.status).toBe('failed');
    expect((session.toolCalls.get('tool-2') as any).error).toBe('Turn interrupted');
  });

  it('clears turn-scoped state via endTurn()', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    const session = next.get('sess-1')!;
    expect(session.isThinking).toBe(false);
    expect(session.currentTurnId).toBeNull();
    expect(session.activeTurnToolIds.size).toBe(0);
    expect(session.attentionState).toBe('ok');
  });

  it('is a no-op-safe call when there is no in-flight turn', () => {
    const session = createSessionChatState();
    session.isThinking = false;
    session.currentTurnId = null;
    const state: ChatState = new Map([['sess-1', session]]);
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    const nextSession = next.get('sess-1')!;
    expect(nextSession.isThinking).toBe(false);
    expect(nextSession.currentTurnId).toBeNull();
  });

  it('returns original state if sessionId is unknown', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'no-such-session',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    expect(next).toBe(state);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Transcript replay dedup (renderer-crash rehydration). After a renderer
// reload, the mount effect replays every session's transcript from disk while
// the live transcript:event stream is ALSO delivering. An event that lands in
// both streams (uuid present in the replayed file AND re-broadcast live) must
// collapse to a single timeline entry — the reducer is now the dedup layer for
// the two append-prone event types. Keyed on the JSONL line uuid.
// ─────────────────────────────────────────────────────────────────────────
describe('chatReducer transcript replay dedup', () => {
  function initState(sessionId = 'sess-1'): ChatState {
    return new Map([[sessionId, createSessionChatState()]]);
  }

  function userCount(state: ChatState, sessionId = 'sess-1'): number {
    return state.get(sessionId)!.timeline.filter((e) => e.kind === 'user').length;
  }

  it('drops a duplicate TRANSCRIPT_USER_MESSAGE with the same uuid', () => {
    let state = initState();
    const action = {
      type: 'TRANSCRIPT_USER_MESSAGE' as const,
      sessionId: 'sess-1',
      uuid: 'user-uuid-1',
      text: 'hello',
      timestamp: 1000,
    };
    state = chatReducer(state, action);
    state = chatReducer(state, action); // replay re-delivery
    expect(userCount(state)).toBe(1);
  });

  it('keeps two user messages that share text but have DIFFERENT uuids', () => {
    // Guards the rapid-fire "yes yes yes" case — dedup must be uuid-based,
    // never content-based, or legitimate repeats get eaten.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 'sess-1',
      uuid: 'u-a', text: 'yes', timestamp: 1000,
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 'sess-1',
      uuid: 'u-b', text: 'yes', timestamp: 1001,
    });
    expect(userCount(state)).toBe(2);
  });

  it('drops a duplicate TRANSCRIPT_ASSISTANT_TEXT with the same uuid', () => {
    let state = initState();
    const action = {
      type: 'TRANSCRIPT_ASSISTANT_TEXT' as const,
      sessionId: 'sess-1',
      uuid: 'asst-uuid-1',
      text: 'the answer',
      timestamp: 2000,
    };
    state = chatReducer(state, action);
    state = chatReducer(state, action); // replay re-delivery
    const turns = [...state.get('sess-1')!.assistantTurns.values()];
    const textSegments = turns.flatMap((t) => t.segments).filter((s) => s.type === 'text');
    expect(textSegments).toHaveLength(1);
  });

  it('merges native streaming deltas (unique uuids, shared partId) — never drops them', () => {
    // Native emits one assistant-text event per token, each with a FRESH
    // randomUUID but the same partId. uuid dedup must NOT collapse these —
    // they merge into one growing segment by partId.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 'sess-1',
      uuid: 'delta-1', text: 'Hel', timestamp: 3000, partId: 'text-0',
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 'sess-1',
      uuid: 'delta-2', text: 'lo', timestamp: 3001, partId: 'text-0',
    });
    const turns = [...state.get('sess-1')!.assistantTurns.values()];
    const textSegments = turns.flatMap((t) => t.segments).filter((s) => s.type === 'text');
    expect(textSegments).toHaveLength(1);
    expect((textSegments[0] as any).content).toBe('Hello');
  });

  it('confirms a pending optimistic bubble then drops the replayed duplicate', () => {
    // The live user-message confirms the optimistic bubble (pending→false) and
    // records the uuid; a later replay of the same uuid must not re-append.
    let state = initState();
    state = chatReducer(state, {
      type: 'USER_PROMPT', sessionId: 'sess-1', content: 'run it', timestamp: 900,
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 'sess-1',
      uuid: 'confirm-uuid', text: 'run it', timestamp: 1000,
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 'sess-1',
      uuid: 'confirm-uuid', text: 'run it', timestamp: 1000,
    });
    expect(userCount(state)).toBe(1);
    expect(state.get('sess-1')!.timeline.find((e) => e.kind === 'user')).toMatchObject({ pending: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tool cards must not duplicate on re-emit. Unlike user/assistant text, the
// watcher deliberately RE-EMITS tool-use for a repeated uuid (a rewritten CC
// JSONL line may carry new tool_use blocks), so the reducer must absorb the
// repeat structurally rather than by uuid — a uuid guard here would silently
// swallow tools that arrive in a rewrite. See transcript-watcher.ts
// readNewLines (~line 679).
// ─────────────────────────────────────────────────────────────────────────
describe('chatReducer tool card duplication', () => {
  function initState(sessionId = 'sess-1'): ChatState {
    return new Map([[sessionId, createSessionChatState()]]);
  }

  function cardCount(state: ChatState, toolUseId: string, sessionId = 'sess-1'): number {
    // Count every rendered slot, not Map entries — AssistantTurnBubble maps
    // group.toolIds → cards, so a doubled id is a doubled card on screen.
    const groups = [...state.get(sessionId)!.toolGroups.values()];
    return groups.flatMap((g) => g.toolIds).filter((id) => id === toolUseId).length;
  }

  const askAction = {
    type: 'TRANSCRIPT_TOOL_USE' as const,
    sessionId: 'sess-1',
    uuid: 'line-uuid-1',
    toolUseId: 'toolu_ask_1',
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Which?', header: 'Pick', options: [] }] },
  };

  it('renders one card when the same tool_use is re-emitted (rewritten JSONL line)', () => {
    let state = initState();
    state = chatReducer(state, askAction);
    state = chatReducer(state, askAction);
    state = chatReducer(state, askAction);
    expect(cardCount(state, 'toolu_ask_1')).toBe(1);
  });

  it('renders one card when a tool_use is re-emitted after the turn ended', () => {
    // The stale-currentGroupId path: endTurn() clears currentGroupId, so a
    // later re-emit used to mint a SECOND group + segment for the same tool.
    let state = initState();
    state = chatReducer(state, askAction);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 'sess-1', uuid: 'turn-1',
    } as any);
    state = chatReducer(state, askAction);
    expect(cardCount(state, 'toolu_ask_1')).toBe(1);
    expect(state.get('sess-1')!.toolGroups.size).toBe(1);
  });

  it('still renders a genuinely NEW tool that arrives in a rewritten line', () => {
    // Guards against "fixing" this with a uuid guard: two different tools can
    // share one line uuid when CC rewrites a growing assistant message.
    let state = initState();
    state = chatReducer(state, askAction);
    state = chatReducer(state, {
      ...askAction, toolUseId: 'toolu_bash_2', toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    expect(cardCount(state, 'toolu_ask_1')).toBe(1);
    expect(cardCount(state, 'toolu_bash_2')).toBe(1);
  });

  it('does not synthesize a second placeholder for a re-delivered requestId', () => {
    // PERMISSION_REQUEST matches only 'running' tools, so a re-delivery after
    // the tool flipped to awaiting-approval used to fall through and mint a
    // duplicate perm-* card.
    let state = initState();
    state = chatReducer(state, askAction);
    const perm = {
      type: 'PERMISSION_REQUEST' as const,
      sessionId: 'sess-1',
      requestId: 'req-1',
      toolName: 'AskUserQuestion',
      input: askAction.toolInput,
    };
    state = chatReducer(state, perm as any);
    state = chatReducer(state, perm as any);
    expect(cardCount(state, 'toolu_ask_1')).toBe(1);
    const synthetic = [...state.get('sess-1')!.toolCalls.keys()].filter((k) => k.startsWith('perm-'));
    expect(synthetic).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A permission ask must render the input IT is about. Reported symptom: the
// second AskUserQuestion of a session re-displayed the FIRST one's question
// and options in chat view, while the terminal showed the correct one.
//
// PERMISSION_REQUEST binds a requestId to an existing card via a 3-tier match
// (exact input → same name → any running tool) but never refreshed that card's
// `input`. Tier 1 cannot match a *new* AskUserQuestion by construction — its
// questions differ from every earlier ask — so whenever the hook beat the
// transcript watcher (the documented ordering) tier 2 bound the new request to
// an older AskUserQuestion card and rendered its stale questions.
// ─────────────────────────────────────────────────────────────────────────
describe('chatReducer permission ask renders the requesting tool input', () => {
  const Q1 = { questions: [{ question: 'Which framework?', header: 'Framework', options: [{ label: 'React' }] }] };
  const Q2 = { questions: [{ question: 'Which database?', header: 'Database', options: [{ label: 'Postgres' }] }] };

  function initState(): ChatState {
    return new Map([['sess-1', createSessionChatState()]]);
  }

  /** The card the given requestId is currently asking through. */
  function cardFor(state: ChatState, requestId: string): ToolCallState | undefined {
    return [...state.get('sess-1')!.toolCalls.values()]
      .find((t) => t.requestId === requestId && t.status === 'awaiting-approval');
  }

  const perm = (requestId: string, input: unknown) => ({
    type: 'PERMISSION_REQUEST' as const,
    sessionId: 'sess-1', requestId, toolName: 'AskUserQuestion', input,
  });

  it('shows the NEW questions when a later ask binds to an earlier ask card', () => {
    // Ask #1: transcript first, then hook, then answered. PERMISSION_RESPONDED
    // returns the card to 'running' and it stays there until the watcher
    // delivers its tool_result — a window in which it is still a match target.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: 'sess-1', uuid: 'u1',
      toolUseId: 'toolu_ask_1', toolName: 'AskUserQuestion', toolInput: Q1,
    } as any);
    state = chatReducer(state, perm('req-1', Q1) as any);
    state = chatReducer(state, {
      type: 'PERMISSION_RESPONDED', sessionId: 'sess-1', requestId: 'req-1',
    } as any);

    // Ask #2: the hook beats the transcript, so no card for it exists yet.
    state = chatReducer(state, perm('req-2', Q2) as any);

    const card = cardFor(state, 'req-2');
    expect(card).toBeDefined();
    expect((card!.input as any).questions[0].question).toBe('Which database?');
  });

  it('does not strand an answered perm-* placeholder as a permanent match target', () => {
    // Answering before the watcher delivers the tool_use breaks the synthetic
    // merge in TRANSCRIPT_TOOL_USE (it required status 'awaiting-approval'), so
    // the placeholder was never reclaimed, never received a tool_result, and
    // stayed 'running' for the rest of the session — catching every later ask.
    let state = initState();
    state = chatReducer(state, perm('req-1', Q1) as any);
    state = chatReducer(state, {
      type: 'PERMISSION_RESPONDED', sessionId: 'sess-1', requestId: 'req-1',
    } as any);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: 'sess-1', uuid: 'u1',
      toolUseId: 'toolu_ask_1', toolName: 'AskUserQuestion', toolInput: Q1,
    } as any);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_RESULT', sessionId: 'sess-1', uuid: 'u2',
      toolUseId: 'toolu_ask_1', result: 'answered', isError: false,
    } as any);

    const stranded = [...state.get('sess-1')!.toolCalls.entries()]
      .filter(([id, t]) => id.startsWith('perm-') && t.status === 'running');
    expect(stranded).toHaveLength(0);
  });

  it('does not let a later same-name tool_use steal an answered placeholder', () => {
    // The reclaim widening must not swallow the EARLIER card: reclaiming by
    // name alone would delete perm-req-1 and drop ask #2 into its timeline
    // slot, erasing ask #1 from the transcript view entirely.
    let state = initState();
    state = chatReducer(state, perm('req-1', Q1) as any);
    state = chatReducer(state, {
      type: 'PERMISSION_RESPONDED', sessionId: 'sess-1', requestId: 'req-1',
    } as any);
    // Ask #2's tool_use lands before ask #1's did — different questions.
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: 'sess-1', uuid: 'u2',
      toolUseId: 'toolu_ask_2', toolName: 'AskUserQuestion', toolInput: Q2,
    } as any);

    const calls = state.get('sess-1')!.toolCalls;
    expect(calls.has('toolu_ask_2')).toBe(true);
    expect((calls.get('toolu_ask_2')!.input as any).questions[0].question).toBe('Which database?');
    // ask #1's placeholder survives with its own questions intact
    const ph = calls.get('perm-req-1');
    expect((ph?.input as any).questions[0].question).toBe('Which framework?');
  });

  it('does not swap input onto a card matched by the any-running fallback', () => {
    // Tier 3 matches a DIFFERENT tool name. Overwriting there would render
    // Bash's name above AskUserQuestion's questions.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: 'sess-1', uuid: 'u1',
      toolUseId: 'toolu_bash_1', toolName: 'Bash', toolInput: { command: 'ls' },
    } as any);
    state = chatReducer(state, perm('req-1', Q1) as any);

    const bash = state.get('sess-1')!.toolCalls.get('toolu_bash_1')!;
    expect((bash.input as any).command).toBe('ls');
  });

  it('does not blank a card when the hook omits tool_input', () => {
    // hook-dispatcher.ts defaults a missing payload.tool_input to `{}`.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: 'sess-1', uuid: 'u1',
      toolUseId: 'toolu_ask_1', toolName: 'AskUserQuestion', toolInput: Q1,
    } as any);
    state = chatReducer(state, {
      type: 'PERMISSION_RESPONDED', sessionId: 'sess-1', requestId: 'none',
    } as any);
    state = chatReducer(state, perm('req-2', {}) as any);

    const card = state.get('sess-1')!.toolCalls.get('toolu_ask_1')!;
    expect((card.input as any).questions[0].question).toBe('Which framework?');
  });

  it('still prefers the exact-input match over an older same-name card', () => {
    // Guards against "fixing" this by always overwriting input: when the real
    // card for ask #2 already exists, the request must bind to THAT card.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: 'sess-1', uuid: 'u1',
      toolUseId: 'toolu_ask_1', toolName: 'AskUserQuestion', toolInput: Q1,
    } as any);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: 'sess-1', uuid: 'u2',
      toolUseId: 'toolu_ask_2', toolName: 'AskUserQuestion', toolInput: Q2,
    } as any);
    state = chatReducer(state, perm('req-2', Q2) as any);

    const card = cardFor(state, 'req-2');
    expect(card?.toolUseId).toBe('toolu_ask_2');
    expect((state.get('sess-1')!.toolCalls.get('toolu_ask_1')!.input as any).questions[0].question)
      .toBe('Which framework?');
  });
});

// Remote-access hydration guards. Both invariants here are the kind that fail
// silently in production — a wrong-looking timeline, or a chat that vanishes —
// so they are pinned rather than left to manual verification.
describe('chatReducer HYDRATE_CHAT_STATE', () => {
  /** A snapshot as a long-running host would send it: ids from its own counter. */
  function snapshotWithLegacyIds() {
    const session = createSessionChatState();
    session.timeline.push({
      kind: 'user',
      message: { id: 'msg-1', role: 'user', content: 'hydrated message', timestamp: 1000 },
    } as any);
    return serializeChatState(new Map([['sess-1', session]]));
  }

  /** Timeline message ids — they live on entry.message.id, not entry.id. */
  function messageIds(state: ChatState, sessionId = 'sess-1'): string[] {
    return state
      .get(sessionId)!
      .timeline.filter((e: any) => e.kind === 'user')
      .map((e: any) => e.message.id);
  }

  it('never mints a live message id that collides with a hydrated one', async () => {
    // The bug: the module-level id counter restarts at 0 on a fresh remote
    // client while the snapshot already holds msg-1..msg-N, so the next live
    // message reused an existing React key and the list mis-reconciled.
    //
    // resetModules() is load-bearing. This MUST run against a freshly-imported
    // reducer so the counter really is at 0 — reusing the file-level import
    // makes the test vacuous, because earlier tests here have already advanced
    // the counter past the ids in the snapshot and no collision can occur.
    vi.resetModules();
    const { chatReducer: freshReducer } = await import('../chat-reducer');

    let state: ChatState = new Map();
    state = freshReducer(state, {
      type: 'HYDRATE_CHAT_STATE',
      sessions: snapshotWithLegacyIds(),
    } as any);

    const hydratedIds = new Set(messageIds(state));
    expect(hydratedIds.has('msg-1')).toBe(true);

    state = freshReducer(state, {
      type: 'USER_PROMPT',
      sessionId: 'sess-1',
      content: 'live message',
      timestamp: 2000,
    } as any);

    const ids = messageIds(state);
    const liveId = ids[ids.length - 1];
    expect(liveId).toBeDefined();
    expect(hydratedIds.has(liveId)).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ignores an empty snapshot instead of blanking live state', () => {
    // An empty payload is what the host sends on export timeout or serialize
    // failure — not a claim that there are no sessions. Applying it wiped a
    // reconnecting client's chat with no error surfaced.
    let state: ChatState = new Map();
    state = chatReducer(state, {
      type: 'HYDRATE_CHAT_STATE',
      sessions: snapshotWithLegacyIds(),
    } as any);

    const before = state;
    state = chatReducer(state, {
      type: 'HYDRATE_CHAT_STATE',
      sessions: { sessions: [], degraded: true },
    } as any);

    expect(state).toBe(before);
    expect(state.get('sess-1')!.timeline).toHaveLength(1);
  });

  it('still replaces state for a non-empty snapshot', () => {
    // Guard against over-correcting the empty-snapshot fix into "never replaces".
    let state: ChatState = new Map();
    state = chatReducer(state, {
      type: 'HYDRATE_CHAT_STATE',
      sessions: snapshotWithLegacyIds(),
    } as any);

    const replacement = createSessionChatState();
    replacement.timeline.push({
      id: 'msg-99',
      role: 'user',
      content: 'replacement',
      timestamp: 3000,
    } as any);

    state = chatReducer(state, {
      type: 'HYDRATE_CHAT_STATE',
      sessions: serializeChatState(new Map([['sess-2', replacement]])),
    } as any);

    expect(state.has('sess-1')).toBe(false);
    expect(state.get('sess-2')!.timeline).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Task 12: queued messages leave the timeline — docked strip + true-position
// confirm. Replaces the Task 3/11 timeline-based queued mechanics (the
// `queued`/`queueId` USER_PROMPT variant, QUEUED_PROMPT_CANCELED): a queued
// native send now only touches SessionChatState.queuedMessages
// (QUEUED_MESSAGE_ADDED/REMOVED) — NEVER the timeline or turn state — and
// joins the timeline for the first time when TRANSCRIPT_USER_MESSAGE's
// no-pending-match fallback appends it at the END, its true position,
// instead of freezing an enqueue-time position above content the
// still-streaming prior turn hadn't emitted yet ("assistant responding to
// itself").
// ─────────────────────────────────────────────────────────────────────────
const SID = 'sess-1';

function withStreamingTurn(sessionId = SID, turnId = 't1', groupId = 'g1'): ChatState {
  // Mirrors stateWithInFlightTurn above — a turn mid-stream via
  // TRANSCRIPT_ASSISTANT_TEXT leaves currentTurnId/currentGroupId set and
  // isThinking true. Constructed directly rather than by dispatching the
  // action, matching this file's existing helper convention.
  const session = createSessionChatState();
  session.currentTurnId = turnId;
  session.currentGroupId = groupId;
  session.isThinking = true;
  return new Map([[sessionId, session]]);
}

describe('chatReducer QUEUED_MESSAGE_ADDED / QUEUED_MESSAGE_REMOVED (Task 12)', () => {
  it('QUEUED_MESSAGE_ADDED appends to queuedMessages and touches NEITHER the timeline NOR turn state', () => {
    let s = withStreamingTurn(); // currentTurnId 't1', currentGroupId 'g1', isThinking true
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'next msg', timestamp: 5 });
    const sess = s.get(SID)!;
    expect(sess.currentTurnId).toBe('t1');   // NOT nulled — later deltas keep merging into the live turn
    expect(sess.currentGroupId).toBe('g1');  // NOT nulled — tool grouping unaffected
    expect(sess.timeline).toHaveLength(0);   // NO timeline entry — the whole point of Task 12
    expect(sess.queuedMessages).toEqual([{ queueId: 'q-1', content: 'next msg', timestamp: 5 }]);
  });

  it('QUEUED_MESSAGE_ADDED is a no-op for an unknown session id', () => {
    const s = new Map<string, ReturnType<typeof createSessionChatState>>();
    const before = s;
    const after = chatReducer(before, { type: 'QUEUED_MESSAGE_ADDED', sessionId: 'ghost', queueId: 'q-1', content: 'x', timestamp: 1 });
    expect(after).toBe(before);
  });

  it('QUEUED_MESSAGE_REMOVED removes only the matching entry by queueId', () => {
    let s: ChatState = new Map([[SID, createSessionChatState()]]);
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'first', timestamp: 1 });
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-2', content: 'second', timestamp: 2 });
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: SID, queueId: 'q-1' });
    expect(s.get(SID)!.queuedMessages).toEqual([{ queueId: 'q-2', content: 'second', timestamp: 2 }]);
  });

  it('QUEUED_MESSAGE_REMOVED is a no-op when the queueId is not present', () => {
    let s: ChatState = new Map([[SID, createSessionChatState()]]);
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'first', timestamp: 1 });
    const before = s;
    const after = chatReducer(before, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: SID, queueId: 'ghost-id' });
    expect(after).toBe(before);
  });

  it('QUEUED_MESSAGE_REMOVED is a no-op for an unknown session id', () => {
    const before: ChatState = new Map([[SID, createSessionChatState()]]);
    const after = chatReducer(before, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: 'ghost-session', queueId: 'q-1' });
    expect(after).toBe(before);
  });
});

describe('chatReducer TRANSCRIPT_USER_MESSAGE — true-position confirm for a drained queued message (Task 12)', () => {
  it('a queued message with NO pending bubble appends at the END (true position), even mid-stream', () => {
    // The prior turn is still streaming (currentTurnId/currentGroupId set,
    // isThinking true) when the queued send drains — the bug this task
    // fixes was freezing the queued bubble ABOVE this content because it
    // rendered at enqueue time. With no timeline write on enqueue, the ONLY
    // possible landing position is wherever TRANSCRIPT_USER_MESSAGE appends
    // it: the end.
    let s = withStreamingTurn();
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'queued text', timestamp: 1 });
    s = chatReducer(s, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u-1', text: 'queued text', timestamp: 2,
    });
    const timeline = s.get(SID)!.timeline;
    expect(timeline).toHaveLength(1);
    const entry = timeline[0];
    expect(entry).toMatchObject({ kind: 'user', pending: false });
    if (entry.kind === 'user') {
      expect(entry.message.content).toBe('queued text');
      expect('queued' in entry).toBe(false); // field is gone from the type entirely
    }
  });

  it('drain-confirm removes the oldest queuedMessages entry with matching content', () => {
    let s: ChatState = new Map([[SID, createSessionChatState()]]);
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'hi', timestamp: 1 });
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-2', content: 'hi', timestamp: 2 });
    s = chatReducer(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u-1', text: 'hi', timestamp: 3 });
    // Oldest-content-match discipline (mirrors the pending-bubble dedup):
    // q-1 (the OLDER entry) is removed, q-2 survives for the next drain.
    expect(s.get(SID)!.queuedMessages).toEqual([{ queueId: 'q-2', content: 'hi', timestamp: 2 }]);
  });

  it('a sent-path pending bubble confirm is untouched: no queuedMessages entry exists, so nothing is removed', () => {
    let s: ChatState = new Map([[SID, createSessionChatState()]]);
    s = chatReducer(s, { type: 'USER_PROMPT', sessionId: SID, content: 'plain send', timestamp: 1 });
    expect(s.get(SID)!.timeline).toHaveLength(1);
    s = chatReducer(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u-1', text: 'plain send', timestamp: 2 });
    const timeline = s.get(SID)!.timeline;
    expect(timeline).toHaveLength(1); // confirmed IN PLACE, not appended again
    expect(timeline[0]).toMatchObject({ kind: 'user', pending: false });
    expect(s.get(SID)!.queuedMessages).toEqual([]);
  });

  it('list removal runs independent of which branch confirms: a queuedMessages entry with content matching an unrelated sent bubble is still cleaned up', () => {
    // Minimal-correct-rule pin: the list scan is NOT gated on confirmedIdx
    // finding (or failing to find) a pending bubble — it is a separate,
    // unconditional content-match attempt against queuedMessages. Construct
    // the (edge-case) situation where a 'sent' pending bubble and a queued
    // list entry share content; the sent bubble confirms via the
    // pending-bubble branch, and the list entry is independently cleaned up
    // by the same TRANSCRIPT_USER_MESSAGE dispatch.
    let s: ChatState = new Map([[SID, createSessionChatState()]]);
    s = chatReducer(s, { type: 'USER_PROMPT', sessionId: SID, content: 'same text', timestamp: 1 });
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'same text', timestamp: 2 });
    s = chatReducer(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u-1', text: 'same text', timestamp: 3 });
    const timeline = s.get(SID)!.timeline;
    expect(timeline).toHaveLength(1); // pending bubble confirmed in place, not double-appended
    expect(s.get(SID)!.queuedMessages).toEqual([]); // list entry ALSO cleaned up by the same dispatch
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Task 8 / BUG B: tool-group collapse semantics. Collapse is per tool-group;
// group membership is decided by currentGroupId — TRANSCRIPT_TOOL_USE joins
// the current group if set, else opens a new one. TRANSCRIPT_ASSISTANT_TEXT
// and TRANSCRIPT_ASSISTANT_REASONING deliberately reset currentGroupId to
// null (a tool following its own text/reasoning renders under it in a new
// bubble) — that reset is intended and NOT under test here. What IS pinned:
// tools with nothing but heartbeats between them must stay in one group.
// ─────────────────────────────────────────────────────────────────────────
describe('chatReducer tool-group collapse semantics (Task 8 / BUG B)', () => {
  function initState(sessionId = SID): ChatState {
    return new Map([[sessionId, createSessionChatState()]]);
  }

  function toolUse(toolUseId: string, uuid: string, sessionId = SID) {
    return {
      type: 'TRANSCRIPT_TOOL_USE' as const,
      sessionId,
      uuid,
      toolUseId,
      toolName: 'Bash',
      toolInput: { command: `echo ${toolUseId}` },
    };
  }

  /** Group id each tool currently belongs to, in group-insertion order. */
  function groupIdsFor(state: ChatState, toolUseIds: string[], sessionId = SID): (string | undefined)[] {
    const groups = [...state.get(sessionId)!.toolGroups.values()];
    return toolUseIds.map((id) => groups.find((g) => g.toolIds.includes(id))?.id);
  }

  it('tools batched in one step share a group (collapse works)', () => {
    let state = initState();
    state = chatReducer(state, toolUse('tool-1', 'u-1'));
    state = chatReducer(state, toolUse('tool-2', 'u-2'));
    state = chatReducer(state, toolUse('tool-3', 'u-3'));
    const [g1, g2, g3] = groupIdsFor(state, ['tool-1', 'tool-2', 'tool-3']);
    expect(g1).toBeDefined();
    expect(g1).toBe(g2);
    expect(g2).toBe(g3);
    expect(state.get(SID)!.toolGroups.size).toBe(1);
  });

  it('a reasoning delta between tools starts a new group (intended bubble semantics)', () => {
    let state = initState();
    state = chatReducer(state, toolUse('tool-1', 'u-1'));
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SID,
      uuid: 'r-1', text: 'thinking about the next step', timestamp: 1000,
    });
    state = chatReducer(state, toolUse('tool-2', 'u-2'));
    const [g1, g2] = groupIdsFor(state, ['tool-1', 'tool-2']);
    expect(g1).toBeDefined();
    expect(g2).toBeDefined();
    expect(g1).not.toBe(g2);
    expect(state.get(SID)!.toolGroups.size).toBe(2);
  });

  it('a thinking HEARTBEAT between tools does NOT split the group (spurious-split guard)', () => {
    let state = initState();
    state = chatReducer(state, toolUse('tool-1', 'u-1'));
    state = chatReducer(state, {
      type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SID,
    });
    state = chatReducer(state, toolUse('tool-2', 'u-2'));
    const [g1, g2] = groupIdsFor(state, ['tool-1', 'tool-2']);
    expect(g1).toBeDefined();
    expect(g1).toBe(g2);
    expect(state.get(SID)!.toolGroups.size).toBe(1);
  });

  it('a stall-warning HEARTBEAT between tools also does NOT split the group', () => {
    // Stall warnings are still content-free liveness signals — same guard.
    let state = initState();
    state = chatReducer(state, toolUse('tool-1', 'u-1'));
    state = chatReducer(state, {
      type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SID,
      stallWarning: { retryInMs: 5000, willRetry: true },
    });
    state = chatReducer(state, toolUse('tool-2', 'u-2'));
    const [g1, g2] = groupIdsFor(state, ['tool-1', 'tool-2']);
    expect(g1).toBeDefined();
    expect(g1).toBe(g2);
    expect(state.get(SID)!.toolGroups.size).toBe(1);
  });
});

describe('chatReducer COMPACTION_COMPLETE — native auto-compaction (I2b)', () => {
  it('inserts a compact SystemMarker for a native auto-compaction WITHOUT a compactionPending flag', () => {
    // A spontaneous native compaction never sets compactionPending (only /compact
    // does), so action.auto must bypass the stale-event guard — else the user sees
    // NOTHING after ~all their history is replaced by a model-written summary.
    const session = createSessionChatState();
    expect(session.compactionPending).toBeNull();
    const state: ChatState = new Map([['sess-1', session]]);
    const next = chatReducer(state, {
      type: 'COMPACTION_COMPLETE',
      sessionId: 'sess-1',
      markerId: 'auto-marker-1',
      afterContextTokens: null,
      auto: true,
      summary: 'Earlier: user asked X; did Y.',
    });
    const timeline = next.get('sess-1')!.timeline;
    const marker = timeline.find((e) => e.kind === 'system-marker') as any;
    expect(marker).toBeTruthy();
    expect(marker.marker.variant).toBe('compact');
    expect(marker.marker.summary).toBe('Earlier: user asked X; did Y.');
  });

  it('still IGNORES a non-auto COMPACTION_COMPLETE with no compactionPending (CC resume-from-summary path unchanged)', () => {
    const session = createSessionChatState();
    const state: ChatState = new Map([['sess-1', session]]);
    const next = chatReducer(state, {
      type: 'COMPACTION_COMPLETE',
      sessionId: 'sess-1',
      markerId: 'stale-marker',
      afterContextTokens: null,
      // no `auto`, no compactionPending → stale, must be dropped
    });
    expect(next).toBe(state);   // untouched — no spurious marker
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A permission ask must never describe a tool other than the one it approves.
// Found by Destin in the 2026-08-09 M1–M3 dogfood: Bash 1 → "Allow Bash 1?"
// → Read 1 → "Allow Bash 1?" → Read 1 runs. The card named Bash while its
// buttons authorized Read. This is a consent bug, not a cosmetic one.
describe('chatReducer PERMISSION_REQUEST tool identity', () => {
  function initState(): ChatState {
    return new Map([['sess-1', createSessionChatState()]]);
  }

  const bashUse = {
    type: 'TRANSCRIPT_TOOL_USE' as const,
    sessionId: 'sess-1',
    uuid: 'u-bash',
    toolUseId: 'toolu_bash_1',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
  };

  it('does not bind an ask to a running tool with a DIFFERENT name', () => {
    let state = initState();
    state = chatReducer(state, bashUse);
    // Read's ask arrives before Read's tool_use event. The only running tool
    // is Bash, which this ask has nothing to do with.
    state = chatReducer(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: 'sess-1',
      requestId: 'req-read-1',
      toolName: 'Read',
      input: { file_path: '/etc/hosts' },
    } as any);

    const bash = state.get('sess-1')!.toolCalls.get('toolu_bash_1')!;
    expect(bash.toolName).toBe('Bash');
    // The Bash card must be left alone — it is not what is being approved.
    expect(bash.status).toBe('running');
    expect(bash.requestId).toBeUndefined();

    // The ask gets its own card, naming the tool it actually authorizes.
    const synthetic = state.get('sess-1')!.toolCalls.get('perm-req-read-1');
    expect(synthetic).toBeDefined();
    expect(synthetic!.toolName).toBe('Read');
    expect(synthetic!.status).toBe('awaiting-approval');
  });

  it('still binds to a running tool of the SAME name', () => {
    let state = initState();
    state = chatReducer(state, bashUse);
    state = chatReducer(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: 'sess-1',
      requestId: 'req-bash-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    } as any);

    const bash = state.get('sess-1')!.toolCalls.get('toolu_bash_1')!;
    expect(bash.status).toBe('awaiting-approval');
    expect(bash.requestId).toBe('req-bash-1');
    // No duplicate synthetic card when a real one was matched.
    expect(state.get('sess-1')!.toolCalls.get('perm-req-bash-1')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A replayed transcript ends where the process died. A tool_use with no
// result is history, not live work — the card must not keep spinning after
// a resume. Found by Destin in the same dogfood pass.
describe('chatReducer TRANSCRIPT_REPLAY_COMPLETE', () => {
  function initState(): ChatState {
    return new Map([['sess-1', createSessionChatState()]]);
  }

  it('fails a tool left running by an interrupted transcript', () => {
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: 'sess-1',
      uuid: 'u-1',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      toolInput: { command: 'sleep 1000' },
    } as any);
    expect(state.get('sess-1')!.toolCalls.get('toolu_1')!.status).toBe('running');

    state = chatReducer(state, { type: 'TRANSCRIPT_REPLAY_COMPLETE', sessionId: 'sess-1', sessionIdle: true } as any);

    const tool = state.get('sess-1')!.toolCalls.get('toolu_1')!;
    // Not 'complete' — we do not know whether it finished before the process
    // died, and claiming success for work that may never have run is the
    // misleading-success failure error-message-standards.md exists to prevent.
    expect(tool.status).toBe('failed');
    expect(tool.error).toMatch(/closed/i);
    // The replayed turn is over; nothing is in flight.
    expect(state.get('sess-1')!.isThinking).toBe(false);
  });

  it('fails both the tool and its unmatched writing plan projection', () => {
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: 'sess-1', uuid: 'u-plan',
      toolUseId: 'plan-writing', toolName: 'propose_plan', toolInput: {},
      plan: {
        planId: 'writing:plan-writing', toolUseId: 'plan-writing', title: 'Writing plan',
        status: 'writing', steps: [], ceilingTokens: 0, ceilingUsd: null,
        model: { label: 'Model' }, seq: 0,
      },
    } as any);

    state = chatReducer(state, { type: 'TRANSCRIPT_REPLAY_COMPLETE', sessionId: 'sess-1', sessionIdle: true } as any);

    const tool = state.get('sess-1')!.toolCalls.get('plan-writing')!;
    expect(tool.status).toBe('failed');
    expect(tool.plan).toMatchObject({ status: 'failed', seq: 1 });
  });

  it('leaves a completed replayed tool alone', () => {
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: 'sess-1', uuid: 'u-1',
      toolUseId: 'toolu_1', toolName: 'Bash', toolInput: { command: 'ls' },
    } as any);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_RESULT',
      sessionId: 'sess-1', uuid: 'u-2',
      toolUseId: 'toolu_1', result: 'a.txt', isError: false,
    } as any);
    state = chatReducer(state, { type: 'TRANSCRIPT_REPLAY_COMPLETE', sessionId: 'sess-1', sessionIdle: true } as any);

    expect(state.get('sess-1')!.toolCalls.get('toolu_1')!.status).toBe('complete');
  });

  it('is a no-op for an unknown session', () => {
    const state = initState();
    const next = chatReducer(state, { type: 'TRANSCRIPT_REPLAY_COMPLETE', sessionId: 'nope', sessionIdle: true } as any);
    expect(next).toBe(state);
  });
});

// The same replay fires when a window re-docks a session that is genuinely
// mid-turn. Reaping there would fail a tool that really is running, so the
// reap is gated on main affirming the session is idle.
describe('chatReducer TRANSCRIPT_REPLAY_COMPLETE on a live session', () => {
  it('leaves a running tool alone when the session is NOT idle', () => {
    let state: ChatState = new Map([['sess-1', createSessionChatState()]]);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: 'sess-1', uuid: 'u-1',
      toolUseId: 'toolu_1', toolName: 'Bash', toolInput: { command: 'sleep 1000' },
    } as any);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_REPLAY_COMPLETE', sessionId: 'sess-1', sessionIdle: false,
    } as any);
    expect(state.get('sess-1')!.toolCalls.get('toolu_1')!.status).toBe('running');
  });
});

describe('chatReducer NATIVE_TOOL_PREPARING', () => {
  const SESSION = 'sess-1';
  function initState(): ChatState {
    return new Map([[SESSION, createSessionChatState()]]);
  }
  const prep = (chars: number, extra: Record<string, unknown> = {}) => ({
    type: 'NATIVE_TOOL_PREPARING' as const,
    sessionId: SESSION,
    toolCallId: 'c1',
    toolName: 'Write',
    chars,
    ...extra,
  });
  const groupsOf = (s: ChatState) => [...s.get(SESSION)!.toolGroups.values()];
  const idCount = (s: ChatState, id: string) =>
    groupsOf(s).flatMap((g) => g.toolIds).filter((t) => t === id).length;

  it('creates a running+preparing card with empty input, placed in a group', () => {
    const next = chatReducer(initState(), prep(0));
    const session = next.get(SESSION)!;
    const card = session.toolCalls.get('c1')!;
    expect(card).toMatchObject({
      toolUseId: 'c1', toolName: 'Write', status: 'running', preparing: true, preparingChars: 0,
    });
    expect(card.input).toEqual({});
    expect(idCount(next, 'c1')).toBe(1);
    expect(session.activeTurnToolIds.has('c1')).toBe(true);
  });

  it('a later progress update changes only the count — no second card, no re-placement', () => {
    let state = chatReducer(initState(), prep(0));
    const groupIdBefore = groupsOf(state)[0].id;
    state = chatReducer(state, prep(512));
    state = chatReducer(state, prep(2048));
    expect(state.get(SESSION)!.toolCalls.size).toBe(1);
    expect(state.get(SESSION)!.toolCalls.get('c1')!.preparingChars).toBe(2048);
    expect(idCount(state, 'c1')).toBe(1);
    expect(groupsOf(state)[0].id).toBe(groupIdBefore);
  });

  it('TRANSCRIPT_TOOL_USE with the same id supersedes it IN PLACE', () => {
    // This is the load-bearing behavior: the completed tool-call carries the
    // SAME provider id as tool-input-start, and TRANSCRIPT_TOOL_USE is already
    // idempotent by toolUseId, so no merge machinery is needed. If the
    // idempotent group placement ever regresses, this test is what catches it.
    let state = chatReducer(initState(), prep(2048));
    const groupIdBefore = groupsOf(state)[0].id;
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: SESSION, uuid: 'u-1',
      toolUseId: 'c1', toolName: 'Write', toolInput: { file_path: 'a.ts', content: 'x' },
    } as any);

    const card = state.get(SESSION)!.toolCalls.get('c1')!;
    expect(card.preparing).toBeUndefined();
    expect(card.status).toBe('running');
    expect(card.input).toEqual({ file_path: 'a.ts', content: 'x' });
    expect(idCount(state, 'c1')).toBe(1);
    expect(groupsOf(state)[0].id).toBe(groupIdBefore);
  });

  it('cleared removes the card and prunes the emptied group and its turn segment', () => {
    let state = chatReducer(initState(), prep(2048));
    const turnId = state.get(SESSION)!.currentTurnId!;
    state = chatReducer(state, prep(2048, { cleared: true }));

    const session = state.get(SESSION)!;
    expect(session.toolCalls.has('c1')).toBe(false);
    expect(session.activeTurnToolIds.has('c1')).toBe(false);
    expect(session.toolGroups.size).toBe(0);
    expect(session.assistantTurns.get(turnId)!.segments).toEqual([]);
  });

  it('cleared is a NO-OP once the id became a real tool card', () => {
    // A retry-clear must never delete a real card. The clear can only race a
    // tool-use that already landed, and deleting THAT would drop a tool whose
    // result is still coming — the dangling-pair failure the runtime forbids.
    let state = chatReducer(initState(), prep(2048));
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: SESSION, uuid: 'u-1',
      toolUseId: 'c1', toolName: 'Write', toolInput: { file_path: 'a.ts' },
    } as any);
    state = chatReducer(state, prep(2048, { cleared: true }));

    expect(state.get(SESSION)!.toolCalls.get('c1')).toBeDefined();
    expect(state.get(SESSION)!.toolCalls.get('c1')!.input).toEqual({ file_path: 'a.ts' });
  });

  it('endTurn DELETES preparing cards but still FAILS real running ones', () => {
    // No tool was ever invoked for a preparing card, so "Write · failed" would
    // describe an event that did not happen (Destin, 2026-08-12).
    let state = chatReducer(initState(), prep(2048));
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE', sessionId: SESSION, uuid: 'u-1',
      toolUseId: 'real-1', toolName: 'Bash', toolInput: { command: 'ls' },
    } as any);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SESSION, uuid: 'u-2', timestamp: 2000,
    } as any);

    const session = state.get(SESSION)!;
    expect(session.toolCalls.has('c1')).toBe(false);
    expect(session.toolCalls.get('real-1')!.status).toBe('failed');
  });
});

// Empty-step recovery, spec 2026-08-21 decision 4: assistant turns are minted
// by CONTENT actions, so a turn whose every step was contentless had no entry
// to carry its honest stopReason — the footer had nothing to render on and the
// worst-case empty_response turn stayed visually silent.
describe('TRANSCRIPT_TURN_COMPLETE — fully-silent turn (empty-step recovery)', () => {
  function initState(sessionId = 'sess-1'): ChatState {
    return new Map([[sessionId, createSessionChatState()]]);
  }

  it('creates a footer-only turn when turn-complete carries an abnormal stopReason and no content streamed', () => {
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 'sess-1', uuid: 'u-1', timestamp: 1000,
      stopReason: 'empty_response', model: 'stealth/ox-alpha', anthropicRequestId: null,
      usage: { inputTokens: 21, outputTokens: 5 },
    } as any);

    const session = state.get('sess-1')!;
    expect(session.assistantTurns.size).toBe(1);
    const turn = [...session.assistantTurns.values()][0];
    expect(turn.segments).toEqual([]);
    expect(turn.stopReason).toBe('empty_response');
    expect(turn.model).toBe('stealth/ox-alpha');
    expect(turn.usage).toMatchObject({ inputTokens: 21, outputTokens: 5 });
    // The turn is on the timeline (it must render), and the turn still ENDED.
    expect(session.timeline.some((e: any) => e.kind === 'assistant-turn' && e.turnId === turn.id)).toBe(true);
    expect(session.currentTurnId).toBeNull();
    expect(session.isThinking).toBe(false);
  });

  it('end_turn with no content still creates no turn', () => {
    // Pins today's skip: normal CC/native completions with no streamed content
    // must not grow ghost turns on the timeline.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 'sess-1', uuid: 'u-1', timestamp: 1000,
      stopReason: 'end_turn', model: null, anthropicRequestId: null, usage: null,
    } as any);

    const session = state.get('sess-1')!;
    expect(session.assistantTurns.size).toBe(0);
    expect(session.timeline).toEqual([]);
  });

  it('the mint is IDEMPOTENT by uuid: a replayed turn-complete never appends a second ghost turn', () => {
    // The watcher's re-emit contract and re-dock replay both re-deliver
    // turn-complete relying on the reducer absorbing duplicates (readNewLines:
    // "the reducer absorbs them"). Content actions are uuid-deduped on replay,
    // so the replayed turn-complete arrives with currentTurnId null — without
    // a uuid guard EVERY replay appended a fresh ghost turn + timeline row.
    const complete = {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 'sess-1', uuid: 'u-1', timestamp: 1000,
      stopReason: 'empty_response', model: null, anthropicRequestId: null,
      usage: { inputTokens: 21, outputTokens: 5 },
    } as any;
    let state = initState();
    state = chatReducer(state, complete);
    state = chatReducer(state, complete);   // replay of the same event
    state = chatReducer(state, complete);   // and again

    const session = state.get('sess-1')!;
    expect(session.assistantTurns.size).toBe(1);
    expect(session.timeline.filter((e: any) => e.kind === 'assistant-turn')).toHaveLength(1);
  });

  it('a replayed abnormal turn-complete for a turn that HAD content re-mints nothing', () => {
    // Live pass: text creates the turn, turn-complete 'max_tokens' stamps it.
    // Replay into EXISTING state: the text action is uuid-deduped (no turn is
    // re-created, currentTurnId stays null), then the same turn-complete
    // arrives again — it must be absorbed, not minted as a segment-less ghost
    // beside the real turn.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 'sess-1', uuid: 'text-1',
      timestamp: 900, text: 'partial answer',
    } as any);
    const complete = {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 'sess-1', uuid: 'u-1', timestamp: 1000,
      stopReason: 'max_tokens', model: null, anthropicRequestId: null, usage: null,
    } as any;
    state = chatReducer(state, complete);
    // Re-dock replay: text drops via seenUuids, turn-complete re-delivers.
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 'sess-1', uuid: 'text-1',
      timestamp: 900, text: 'partial answer',
    } as any);
    state = chatReducer(state, complete);

    const session = state.get('sess-1')!;
    expect(session.assistantTurns.size).toBe(1);   // the real turn only — no ghost
    expect(session.timeline.filter((e: any) => e.kind === 'assistant-turn')).toHaveLength(1);
    expect([...session.assistantTurns.values()][0].stopReason).toBe('max_tokens');
  });

  it('a minted turn is stamped with the EVENT timestamp, not the replay-time clock', () => {
    // getOrCreateTurn defaults to Date.now(); on a re-dock replay that is the
    // dock time, which the footer row's timestamp would then display. The mint
    // overrides it with the event's own timestamp.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 'sess-1', uuid: 'u-1', timestamp: 12345,
      stopReason: 'empty_response', model: null, anthropicRequestId: null, usage: null,
    } as any);

    const turn = [...state.get('sess-1')!.assistantTurns.values()][0];
    expect(turn.timestamp).toBe(12345);
  });
});
