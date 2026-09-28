// @vitest-environment jsdom
// Perf cycle 1, N1 (docs/active/handoffs/2026-08-27-perf-cycle-1-handoff.md §3).
//
// findArchiveBoundary scans the WHOLE timeline backwards. ChatView used to call
// it inline in the render body, so a streaming session — which renders once per
// delta — paid a full-timeline scan per token. The timeline array's identity
// only changes when an entry is appended (a delta replaces assistantTurns, not
// timeline), so the scan must run once per appended entry and NOT per delta.
//
// Scaffolding mirrors chatview-empty-response-gate.test.tsx (the established
// ChatView mounting pattern). The archive-boundary module is wrapped in a spy
// around the REAL implementation so the render output is unchanged and only
// the call count is observed.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
// The unmemoised view: this harness delivers new state by re-rendering with the
// SAME props, which the memoised default export skips by design (see ChatView.tsx).
import { UnmemoizedChatView as ChatView } from '../src/renderer/components/ChatView';
import { findArchiveBoundary } from '../src/renderer/state/archive-boundary';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatAction, ChatState } from '../src/renderer/state/chat-types';
import { entryRenders, resetEntryRenders } from './helpers/entry-render-probes';

const mocks = vi.hoisted(() => ({ state: {} as any }));

vi.mock('../src/renderer/state/chat-context', async (importOriginal) => {
  // ToolCard's specialist lookup reads the store directly; an empty real store
  // answers "no specialist run" exactly as the app does for a plain Bash call.
  const real = await importOriginal<any>();
  const store = real.createChatStore();
  return {
    useChatState: () => mocks.state,
    useChatDispatch: () => vi.fn(),
    useChatStore: () => store,
  };
});

vi.mock('../src/renderer/state/ArtifactContext', async (importOriginal) => {
  // ChatView reads the artifact store through narrow selectors (perf, 2026-09-23).
  // The rest is real: ToolCard's optional selector degrades to "no provider".
  const real = await importOriginal<any>();
  const state = { drawerOpenBySession: {}, drawerExpanded: false };
  return {
    ...real,
    useArtifactSelector: (select: (s: any) => unknown) => select(state),
    useArtifactDispatch: () => vi.fn(),
  };
});

// Per-entry render counters (tests/helpers/entry-render-probes.tsx): each wraps
// the real component, keeping its memo, and counts renders under its entry id.
// Only the streamed-word budget below reads them; they change nothing else.
vi.mock('../src/renderer/components/UserMessage', async (orig) => {
  const real = await orig<any>();
  const { probeEntry } = await import('./helpers/entry-render-probes');
  return { ...real, default: probeEntry(real.default, 'UserMessage', (p: any) => p.message.id) };
});
vi.mock('../src/renderer/components/AssistantTurnBubble', async (orig) => {
  const real = await orig<any>();
  const { probeEntry } = await import('./helpers/entry-render-probes');
  return { ...real, default: probeEntry(real.default, 'AssistantTurnBubble', (p: any) => p.turn.id) };
});
vi.mock('../src/renderer/components/ToolCard', async (orig) => {
  const real = await orig<any>();
  const { probeEntry } = await import('./helpers/entry-render-probes');
  return { ...real, default: probeEntry(real.default, 'ToolCard', (p: any) => p.tool.toolUseId) };
});
vi.mock('../src/renderer/components/PromptCard', async (orig) => {
  const real = await orig<any>();
  const { probeEntry } = await import('./helpers/entry-render-probes');
  return { ...real, default: probeEntry(real.default, 'PromptCard', (p: any) => p.prompt.promptId) };
});
vi.mock('../src/renderer/components/UsageCard', async (orig) => {
  const real = await orig<any>();
  const { probeEntry } = await import('./helpers/entry-render-probes');
  return { ...real, default: probeEntry(real.default, 'UsageCard', (p: any) => p.snapshot.entryId) };
});
vi.mock('../src/renderer/components/SystemMarker', async (orig) => {
  const real = await orig<any>();
  const { probeEntry } = await import('./helpers/entry-render-probes');
  return { ...real, default: probeEntry(real.default, 'SystemMarker', (p: any) => p.marker.id) };
});
vi.mock('../src/renderer/components/SkillInvocationCard', async (orig) => {
  const real = await orig<any>();
  const { probeEntry } = await import('./helpers/entry-render-probes');
  return { ...real, default: probeEntry(real.default, 'SkillInvocationCard', (p: any) => p.skillId) };
});
vi.mock('../src/renderer/components/CopyPicker', async (orig) => {
  const real = await orig<any>();
  const { probeEntry } = await import('./helpers/entry-render-probes');
  return { ...real, default: probeEntry(real.default, 'CopyPicker', (p: any) => p.id) };
});
vi.mock('../src/renderer/components/TimelineEntryHint', async (orig) => {
  const real = await orig<any>();
  const { probeEntry } = await import('./helpers/entry-render-probes');
  return { ...real, TimelineEntryHint: probeEntry(real.TimelineEntryHint, 'TimelineEntryHint', (p: any) => p.entryKey) };
});

// The real markdown pipeline is irrelevant here and slow to mount.
vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

vi.mock('../src/renderer/state/archive-boundary', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/state/archive-boundary')>();
  return { ...real, findArchiveBoundary: vi.fn(real.findArchiveBoundary) };
});

if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

const scan = findArchiveBoundary as unknown as ReturnType<typeof vi.fn>;

function textTurn(id: string, content: string) {
  return {
    id,
    segments: [{ type: 'text', content, messageId: `${id}-m1`, partId: 'p1' }],
    timestamp: 1000,
    stopReason: null,
    model: null,
    usage: null,
    anthropicRequestId: null,
  };
}

function sessionState(overrides: Record<string, unknown>) {
  return {
    timeline: [] as any[],
    queuedMessages: [] as any[],
    toolCalls: new Map(),
    toolGroups: new Map(),
    assistantTurns: new Map(),
    activeTurnToolIds: new Set(),
    isThinking: true,
    promptProcessing: null,
    attentionState: 'ok',
    errorMessage: null,
    stallWarning: null,
    lastActivityAt: 1000,
    lastOutputAt: 1000,
    modelState: 'idle',
    modelInfo: null,
    modelLoadedBytes: 0,
    modelEverResident: false,
    ...overrides,
  };
}

const view = () => <ChatView sessionId="s1" visible={true} sessionActive={true} />;

describe('ChatView — the archive-boundary scan runs per appended entry, not per streamed delta', () => {
  it('a delta (same timeline reference, new turn object, new timestamps) does not rescan', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'Hel')]]),
    });
    const r = render(view());
    const afterMount = scan.mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(1);

    // Exactly what the reducer does on TRANSCRIPT_ASSISTANT_TEXT with a partId:
    // a fresh assistantTurns Map holding a fresh turn object, lastActivityAt /
    // lastOutputAt re-stamped, and the SAME timeline array.
    for (const content of ['Hello', 'Hello, ', 'Hello, wor', 'Hello, world']) {
      mocks.state = {
        ...mocks.state,
        assistantTurns: new Map([['turn_1', textTurn('turn_1', content)]]),
        lastActivityAt: mocks.state.lastActivityAt + 7,
        lastOutputAt: mocks.state.lastOutputAt + 7,
      };
      r.rerender(view());
    }
    expect(r.container.textContent).toContain('Hello, world');
    expect(scan.mock.calls.length).toBe(afterMount);
  });

  it('an appended entry (new timeline reference) rescans exactly once', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'First')]]),
    });
    const r = render(view());
    scan.mockClear();

    mocks.state = {
      ...mocks.state,
      timeline: [...timeline, { kind: 'assistant-turn', turnId: 'turn_2' }],
      assistantTurns: new Map([
        ...mocks.state.assistantTurns,
        ['turn_2', textTurn('turn_2', 'Second')],
      ]),
      lastActivityAt: mocks.state.lastActivityAt + 7,
    };
    r.rerender(view());
    expect(r.container.textContent).toContain('Second');
    expect(scan.mock.calls.length).toBe(1);
  });
});

// Perf cycle 1, N2 (docs/active/handoffs/2026-08-27-perf-cycle-1-handoff.md §3).
//
// ChatView's auto-scroll effect calls scrollToBottom(), which READS scrollHeight
// and WRITES scrollTop. Reading scrollHeight after a commit whose DOM is still
// dirty forces a synchronous layout of the document — the hook's own PERF note
// calls it "a FULL forced reflow of a large transcript". That effect used to
// depend on state.lastActivityAt, a timestamp the reducer re-stamps on EVERY
// streamed delta (and on tool events, heartbeats, …), so a streaming session
// paid one forced reflow per token even though the content growth those deltas
// cause is already re-pinned by the ResizeObserver on the content wrapper —
// which runs AFTER layout, where the read is free.
//
// This pins the fix: a state change that touches only the timestamps (and the
// live turn's object) must not read the scroll container's geometry; a change
// that appends a timeline entry still must.

/** Count reads of the layout-forcing property on the scroll container. jsdom
 *  never lays out, so the value is a stand-in; only the COUNT matters. */
function countScrollHeightReads(scroller: HTMLElement): () => number {
  let reads = 0;
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    get: () => { reads++; return 2000; },
  });
  return () => reads;
}

describe('ChatView — auto-scroll pins on content, never on the activity timestamp', () => {
  it('a streamed delta (timestamps + live turn changed, same timeline) forces no layout read', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'Hel')]]),
    });
    const r = render(view());
    const scroller = r.container.querySelector('.chat-scroll') as HTMLElement;
    expect(scroller).not.toBeNull();
    const reads = countScrollHeightReads(scroller);

    for (const content of ['Hello', 'Hello, ', 'Hello, wor', 'Hello, world']) {
      mocks.state = {
        ...mocks.state,
        assistantTurns: new Map([['turn_1', textTurn('turn_1', content)]]),
        lastActivityAt: mocks.state.lastActivityAt + 7,
        lastOutputAt: mocks.state.lastOutputAt + 7,
      };
      r.rerender(view());
    }
    expect(r.container.textContent).toContain('Hello, world');
    expect(reads()).toBe(0);
  });

  it('an appended timeline entry still pins to the bottom (reads the geometry once)', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'First')]]),
    });
    const r = render(view());
    const scroller = r.container.querySelector('.chat-scroll') as HTMLElement;
    const reads = countScrollHeightReads(scroller);

    mocks.state = {
      ...mocks.state,
      timeline: [...timeline, { kind: 'assistant-turn', turnId: 'turn_2' }],
      assistantTurns: new Map([
        ...mocks.state.assistantTurns,
        ['turn_2', textTurn('turn_2', 'Second')],
      ]),
      lastActivityAt: mocks.state.lastActivityAt + 7,
    };
    r.rerender(view());
    expect(reads()).toBeGreaterThanOrEqual(1);
  });

  it('the thinking indicator toggling still pins to the bottom', () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'turn_1' }];
    mocks.state = sessionState({
      timeline,
      isThinking: false,
      assistantTurns: new Map([['turn_1', textTurn('turn_1', 'First')]]),
    });
    const r = render(view());
    const scroller = r.container.querySelector('.chat-scroll') as HTMLElement;
    const reads = countScrollHeightReads(scroller);

    mocks.state = { ...mocks.state, isThinking: true, lastActivityAt: mocks.state.lastActivityAt + 7 };
    r.rerender(view());
    expect(reads()).toBeGreaterThanOrEqual(1);
  });
});

// Perf (2026-09-24): a word streamed into the chat on screen re-renders only
// the reply being written.
//
// ChatView re-renders once per streamed word — it has to, the live reply is
// growing. It used to build every timeline row inline, so each word also
// re-rendered every card that is not memoised on its own: with the 24-entry
// conversation below and 40 words, 40 renders EACH of the /clear and model
// markers, the skill, prompt, usage and copy cards, and all seven archived-entry
// hints. Now each row is ChatTimelineRow (memoised, stable props), so a word
// reaches only the live turn. User bubbles, finished turns and their tool cards
// were already 0 (memoised themselves) and must stay 0.
//
// State is built by the REAL reducer, so the entry/turn/Map identities the
// memo depends on are exactly the ones the app produces.
describe('ChatView — a streamed word re-renders only the entry being written', () => {
  /** Renders of every OTHER entry for a whole 40-word reply. */
  const BUDGET_OTHER_ENTRIES_PER_REPLY = 0;
  const WORDS = 40;
  const SID = 's1';

  function build() {
    let chat: ChatState = new Map();
    let n = 0;
    const d = (a: Record<string, unknown>) => {
      chat = chatReducer(chat, { sessionId: SID, timestamp: 1_000 + n, uuid: `x-${++n}`, ...a } as ChatAction);
    };
    const exchange = (i: number) => {
      d({ type: 'TRANSCRIPT_USER_MESSAGE', text: `question ${i}` });
      d({ type: 'TRANSCRIPT_ASSISTANT_TEXT', text: `Answer ${i}.` });
      d({ type: 'TRANSCRIPT_TOOL_USE', toolUseId: `tool-${i}`, toolName: 'Bash', toolInput: { command: `ls ${i}` } });
      d({ type: 'TRANSCRIPT_TOOL_RESULT', toolUseId: `tool-${i}`, result: 'a\nb', isError: false });
      d({ type: 'TRANSCRIPT_ASSISTANT_TEXT', text: `Done ${i}.` });
      d({ type: 'TRANSCRIPT_TURN_COMPLETE', stopReason: 'end_turn', model: null, anthropicRequestId: null, usage: null });
    };
    d({ type: 'SESSION_INIT' });
    for (let i = 0; i < 3; i++) exchange(i);
    d({ type: 'TRANSCRIPT_SKILL_INVOKED', skillId: 'sk-1', displayName: 'Skill One' });
    // /clear: everything above is archived (faded, with a hint beside it).
    d({ type: 'CLEAR_TIMELINE', markerId: 'clear-1' });
    for (let i = 3; i < 5; i++) exchange(i);
    d({ type: 'SHOW_PROMPT', promptId: 'prompt-1', title: 'Pick', buttons: [{ label: 'Yes', input: 'y' }, { label: 'No', input: 'n' }] });
    d({ type: 'SHOW_USAGE_CARD', snapshot: { entryId: 'usage-1', timestamp: 1, costUsd: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheCreationTokens: null, contextTokens: null, contextPercent: null, duration: null, apiDuration: null, linesAdded: null, linesRemoved: null } });
    d({ type: 'SHOW_COPY_PICKER', id: 'copy-1', options: [{ id: 'o1', label: 'Full', preview: 'p', content: 'c' }] });
    d({ type: 'MODEL_SWITCH_MARKER', markerId: 'model-1', label: 'Model switched to Opus' });
    for (let i = 5; i < 8; i++) exchange(i);
    d({ type: 'TRANSCRIPT_USER_MESSAGE', text: 'last question' });
    d({ type: 'TRANSCRIPT_ASSISTANT_TEXT', text: 'Streaming ', partId: 'live' });
    return { state: () => chat.get(SID)!, word: () => d({ type: 'TRANSCRIPT_ASSISTANT_TEXT', text: 'word ', partId: 'live' }) };
  }

  it('a streamed word re-renders the live reply and no other entry', () => {
    const convo = build();
    mocks.state = convo.state();
    const kinds = mocks.state.timeline.map((e: any) => e.kind);
    // The fixture really has every kind this budget is about (else a 0 proves nothing).
    for (const k of ['user', 'assistant-turn', 'skill-invocation', 'system-marker', 'prompt', 'usage-card', 'copy-picker']) {
      expect(kinds).toContain(k);
    }
    expect(kinds.length).toBeGreaterThanOrEqual(20);
    const liveTurnId = mocks.state.currentTurnId;
    const r = render(view());
    resetEntryRenders();

    for (let w = 0; w < WORDS; w++) {
      convo.word();
      mocks.state = convo.state();
      r.rerender(view());
    }

    const live = `AssistantTurnBubble:${liveTurnId}`;
    // Control: the probes see renders at all — the live reply redraws per word.
    expect(entryRenders.get(live)).toBe(WORDS);
    const others = Object.fromEntries([...entryRenders].filter(([k]) => k !== live));
    const allowed = Object.fromEntries(Object.keys(others).map((k) => [k, BUDGET_OTHER_ENTRIES_PER_REPLY]));
    expect(others).toEqual(allowed);
    expect(r.container.textContent).toContain('word word');
    resetEntryRenders();
  });
});
