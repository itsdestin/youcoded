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
import { render, fireEvent, screen, act } from '@testing-library/react';
import { FOLD_IDLE_MS, FOLD_ROOT_MARGIN } from '../src/renderer/hooks/use-entry-folding';
import { ChatMessageFindIndex } from '../src/renderer/components/chat-message-find';
import { useChatMessageFind } from '../src/renderer/hooks/use-chat-message-find';

vi.mock('../src/renderer/hooks/use-chat-message-find', async (original) => {
  const real = await original<typeof import('../src/renderer/hooks/use-chat-message-find')>();
  return { ...real, useChatMessageFind: vi.fn(real.useChatMessageFind) };
});
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
  it('mounts the search controller only while Find is open, never on ordinary streamed words', () => {
    const controller = vi.mocked(useChatMessageFind);
    controller.mockClear();
    const timeline = [{ kind: 'assistant-turn', turnId: 'a' }];
    mocks.state = sessionState({ timeline, assistantTurns: new Map([['a', textTurn('a', 'hello')]]) });
    const r = render(view());
    for (let i = 0; i < 40; i++) {
      mocks.state = { ...mocks.state, assistantTurns: new Map([['a', textTurn('a', `hello ${i}`)]]) };
      r.rerender(view());
    }
    expect(controller).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(controller).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Find in chat'), { key: 'Escape' });
    controller.mockClear();
    mocks.state = { ...mocks.state, assistantTurns: new Map([['a', textTurn('a', 'after close')]]) };
    r.rerender(view());
    expect(controller).not.toHaveBeenCalled();
    r.unmount();
  });
  it('a source and mounted Markdown mismatch leaves the Find counter pending instead of a wrong count', () => {
    // This suite's MarkdownContent mock shows literal syntax; the real renderer
    // strips it. The adapter must notice that mismatch before reporting a hit.
    mocks.state = sessionState({ timeline: [{ kind: 'assistant-turn', turnId: 'a' }], assistantTurns: new Map([['a', textTurn('a', '**bold**')]]) });
    const view = render(<ChatView sessionId="s1" visible sessionActive />);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    fireEvent.change(screen.getByLabelText('Find in chat'), { target: { value: 'bold' } });
    const counter = view.container.querySelector('.find-row .tabular-nums');
    expect(counter?.textContent).toBe('');
    view.unmount();
  });

  it('refreshes active Find after streamed text, appended page and removal without Enter', async () => {
    (globalThis as any).CSS = { highlights: new Map() };
    (window as any).Highlight = class { constructor(public range: Range) {} };
    const timeline = [{ kind: 'assistant-turn', turnId: 'a' }];
    mocks.state = sessionState({ timeline, assistantTurns: new Map([['a', textTurn('a', 'hello')]]) });
    const spy = vi.spyOn(ChatMessageFindIndex.prototype, 'prepareSearch');
    const r = render(view());
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(spy).not.toHaveBeenCalled(); // opening an empty Find never parses history
    fireEvent.change(screen.getByLabelText('Find in chat'), { target: { value: 'hello' } });
    await vi.waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());
    spy.mockClear();
    mocks.state = { ...mocks.state, assistantTurns: new Map([['a', textTurn('a', 'hello hello')]]) };
    r.rerender(view());
    expect(spy).not.toHaveBeenCalled(); // never reconcile synchronously per streamed word
    await vi.waitFor(() => expect(screen.getByText('1/2')).toBeTruthy());
    mocks.state = { ...mocks.state, timeline: [...timeline, { kind: 'assistant-turn', turnId: 'b' }], assistantTurns: new Map([['a', textTurn('a', 'hello hello')], ['b', textTurn('b', 'hello')]]) };
    r.rerender(view());
    await vi.waitFor(() => expect(screen.getByText('1/3')).toBeTruthy());
    mocks.state = { ...mocks.state, timeline: [{ kind: 'assistant-turn', turnId: 'b' }] };
    r.rerender(view());
    await vi.waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());
    r.unmount(); spy.mockRestore(); delete (globalThis as any).CSS; delete (window as any).Highlight;
  });

  it('continuous sub-80ms source updates still publish a completed Find count', async () => {
    const timeline = [{ kind: 'assistant-turn', turnId: 'a' }];
    mocks.state = sessionState({ timeline, assistantTurns: new Map([['a', textTurn('a', 'hello')]]) });
    const r = render(view());
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    fireEvent.change(screen.getByLabelText('Find in chat'), { target: { value: 'hello' } });
    await vi.waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());
    vi.useFakeTimers();
    for (let i = 0; i < 12; i++) {
      mocks.state = { ...mocks.state, assistantTurns: new Map([['a', textTurn('a', `hello ${i}`)]]) };
      r.rerender(view());
      await act(async () => { await vi.advanceTimersByTimeAsync(40); });
      expect(r.container.querySelector('.find-row .tabular-nums')?.textContent).not.toBe('');
    }
    vi.useRealTimers();
    r.unmount();
  });

  it('recovers pending count after a transient rendered-body mismatch without Enter', async () => {
    mocks.state = sessionState({ timeline: [{ kind: 'assistant-turn', turnId: 'a' }], assistantTurns: new Map([['a', textTurn('a', '**bold**')]]) });
    const r = render(view());
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    fireEvent.change(screen.getByLabelText('Find in chat'), { target: { value: 'bold' } });
    expect(r.container.querySelector('.find-row .tabular-nums')?.textContent).toBe('');
    // The mocked markdown catches up with the source projection on its own.
    const body = r.container.querySelector('[data-message-find-body]')!;
    await act(async () => { body.querySelector('[data-testid="md"]')!.textContent = 'bold'; await Promise.resolve(); });
    await vi.waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());
    r.unmount();
  });

  it('a streamed word refreshes only on Find navigation, not on every history render', async () => {
    const highlights = new Map();
    (globalThis as any).CSS = { highlights };
    (window as any).Highlight = class { constructor(public range: Range) {} };
    mocks.state = sessionState({ timeline: [{ kind: 'assistant-turn', turnId: 'a' }], assistantTurns: new Map([['a', textTurn('a', 'hello')]]) });
    const spy = vi.spyOn(ChatMessageFindIndex.prototype, 'prepareSearch');
    const view = render(<ChatView sessionId="s1" visible sessionActive />);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    fireEvent.change(screen.getByLabelText('Find in chat'), { target: { value: 'hello' } });
    await vi.waitFor(() => expect(screen.getByText('1/1')).toBeTruthy());
    spy.mockClear();
    mocks.state = { ...mocks.state, assistantTurns: new Map([['a', textTurn('a', 'hello hello')]]) };
    view.rerender(<ChatView sessionId="s1" visible sessionActive />);
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Next (Enter)'));
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.getByText('2/2')).toBeTruthy());
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2); // navigation and the coalesced source push
    view.unmount();
    spy.mockRestore();
    delete (globalThis as any).CSS;
    delete (window as any).Highlight;
  });

  it('Find selection releases bottom-stick before scrolling and growth cannot repin it', async () => {
    const originalResize = globalThis.ResizeObserver;
    const originalIO = globalThis.IntersectionObserver;
    let foldReport!: (entries: IntersectionObserverEntry[]) => void;
    (globalThis as any).IntersectionObserver = class {
      constructor(cb: (entries: IntersectionObserverEntry[]) => void, opts?: IntersectionObserverInit) {
        if (opts?.rootMargin === FOLD_ROOT_MARGIN) foldReport = cb;
      }
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    };
    const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.hasAttribute('data-entry-key') ? 120 : 0; } });
    const originalRect = Range.prototype.getBoundingClientRect;
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    const resizeCallbacks: Array<() => void> = [];
    (globalThis as any).ResizeObserver = class {
      constructor(cb: () => void) { resizeCallbacks.push(cb); }
      observe() {} disconnect() {} unobserve() {}
    };
    (globalThis as any).CSS = { highlights: new Map() };
    (window as any).Highlight = class { constructor(public range: Range) {} };
    let scroller: HTMLElement;
    Range.prototype.getBoundingClientRect = () => ({ top: scroller?.scrollTop === 250 ? 200 : -500, bottom: scroller?.scrollTop === 250 ? 220 : -480 } as DOMRect);
    const scroll = vi.fn(function (this: HTMLElement) { this.closest('.chat-scroll')!.scrollTop = 250; });
    HTMLElement.prototype.scrollIntoView = scroll;
    mocks.state = sessionState({ timeline: [
      { kind: 'assistant-turn', turnId: 'older' }, { kind: 'assistant-turn', turnId: 'latest' },
    ], assistantTurns: new Map([['older', textTurn('older', 'needle')], ['latest', textTurn('latest', 'latest')]]) });
    const r = render(view());
    scroller = r.container.querySelector('.chat-scroll') as HTMLElement;
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 800 } as DOMRect);
    let height = 2000;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => height });
    const older = r.container.querySelector<HTMLElement>('[data-entry-key="older"]')!;
    vi.useFakeTimers();
    act(() => {
      foldReport([{ target: older, isIntersecting: false } as unknown as IntersectionObserverEntry]);
      vi.advanceTimersByTime(FOLD_IDLE_MS);
    });
    vi.useRealTimers();
    expect(older.querySelector('[data-message-find-body]')).toBeNull();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(older.querySelector('[data-message-find-body]')).toBeNull();
    expect(screen.queryByText('Jump to bottom')).toBeNull(); // opening Find is not navigation
    fireEvent.change(screen.getByLabelText('Find in chat'), { target: { value: 'needle' } });
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(older.querySelector('[data-message-find-body]')).toBeTruthy();
    expect(scroller.scrollTop).toBe(250);
    expect(Range.prototype.getBoundingClientRect().top).toBeGreaterThan(scroller.getBoundingClientRect().top);
    expect(screen.getByText('Jump to bottom')).toBeTruthy();
    height = 2500; // content growth after search navigation
    act(() => { resizeCallbacks.forEach((cb) => cb()); });
    expect(scroller.scrollTop).toBe(250);
    expect(Range.prototype.getBoundingClientRect().bottom).toBeLessThan(scroller.getBoundingClientRect().bottom);
    r.unmount(); vi.restoreAllMocks();
    Range.prototype.getBoundingClientRect = originalRect;
    if (originalScroll) HTMLElement.prototype.scrollIntoView = originalScroll;
    else delete (HTMLElement.prototype as any).scrollIntoView;
    globalThis.ResizeObserver = originalResize;
    globalThis.IntersectionObserver = originalIO;
    if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight);
    else delete (HTMLElement.prototype as any).offsetHeight;
    delete (globalThis as any).CSS; delete (window as any).Highlight;
  });

  it('Find leaves offscreen loaded rows folded and reveals only the selected message', async () => {
    const previousIO = globalThis.IntersectionObserver;
    const previousHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    let report!: (entries: IntersectionObserverEntry[]) => void;
    (globalThis as any).IntersectionObserver = class {
      constructor(cb: (entries: IntersectionObserverEntry[]) => void) { report = cb; }
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    };
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.hasAttribute('data-entry-key') ? 120 : 0; } });
    const highlights = new Map();
    (globalThis as any).CSS = { highlights };
    (window as any).Highlight = class { constructor(public range: Range) {} };
    const timeline = ['a', 'b', 'c'].map((id) => ({ kind: 'assistant-turn', turnId: id }));
    mocks.state = sessionState({ timeline, assistantTurns: new Map(timeline.map(({ turnId }) => [turnId, textTurn(turnId, `message ${turnId}`)])) });
    const view = render(<ChatView sessionId="s1" visible sessionActive />);
    const entries = [...view.container.querySelectorAll<HTMLElement>('[data-entry-key]')];
    // Geometry makes a/c distant while b is the viewport's sole neighbor.
    entries.forEach((el, i) => { el.getBoundingClientRect = () => ({ top: (i - 1) * 5000, bottom: (i - 1) * 5000 + 120 } as DOMRect); });
    vi.useFakeTimers();
    act(() => { report(entries.map((target) => ({ target, isIntersecting: false }) as unknown as IntersectionObserverEntry)); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    vi.useRealTimers();
    expect(entries.every((el) => !el.querySelector('[data-message-find-body]'))).toBe(true);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(entries.every((el) => !el.querySelector('[data-message-find-body]'))).toBe(true);
    fireEvent.change(screen.getByLabelText('Find in chat'), { target: { value: 'message b' } });
    await vi.waitFor(() => expect(entries[1].querySelector('[data-message-find-body]')).toBeTruthy());
    expect(entries[0].querySelector('[data-message-find-body]')).toBeNull();
    expect(entries[2].querySelector('[data-message-find-body]')).toBeNull();
    expect(screen.getByText('1/1')).toBeTruthy();
    view.unmount();
    if (previousHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', previousHeight);
    else delete (HTMLElement.prototype as any).offsetHeight;
    globalThis.IntersectionObserver = previousIO;
    delete (globalThis as any).CSS;
    delete (window as any).Highlight;
  });

  it('Find uses message-only source rather than reasoning and metadata on the real timeline', async () => {
    const highlights = new Map();
    (globalThis as any).CSS = { highlights };
    (window as any).Highlight = class { constructor(public range: Range) {} };
    mocks.state = sessionState({ timeline: [
      { kind: 'user', message: { id: 'u', content: 'Hello user', timestamp: 1000 } },
      { kind: 'assistant-turn', turnId: 'a' },
      { kind: 'prompt', prompt: { promptId: 'p', title: 'Secret card', buttons: [] } },
    ], assistantTurns: new Map([['a', { ...textTurn('a', 'Hello assistant'), segments: [
      { type: 'reasoning', content: 'Secret thoughts', messageId: 'reasoning' },
      { type: 'text', content: 'Hello assistant', messageId: 'reply' },
    ] }]]) });
    const r = render(view());
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const input = screen.getByLabelText('Find in chat');
    fireEvent.change(input, { target: { value: 'Secret' } });
    await vi.waitFor(() => expect(screen.getByText('0/0')).toBeTruthy());
    fireEvent.change(input, { target: { value: 'Hello' } });
    await vi.waitFor(() => expect(screen.getByText('1/2')).toBeTruthy());
    expect(r.container.querySelectorAll('[data-message-find-body]')).toHaveLength(2);
    r.unmount();
    delete (globalThis as any).CSS;
    delete (window as any).Highlight;
  });
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
  it('re-pins after a late content shrink while stuck, but does not steal Find or wheel navigation', () => {
    const oldResize = globalThis.ResizeObserver;
    const observers: Array<{ target: Element | null; fire: () => void }> = [];
    (globalThis as any).ResizeObserver = class {
      target: Element | null = null;
      private cb: () => void;
      constructor(cb: () => void) { this.cb = cb; observers.push(this); }
      observe(el: Element) { this.target = el; }
      disconnect() {} unobserve() {}
      fire() { this.cb(); }
    };
    try {
      mocks.state = sessionState({ timeline: [{ kind: 'assistant-turn', turnId: 'a' }], assistantTurns: new Map([['a', textTurn('a', 'Latest')]]) });
      const r = render(view());
      const scroll = r.container.querySelector<HTMLElement>('.chat-scroll')!;
      const content = scroll.querySelector<HTMLElement>('.chat-content') ?? scroll.firstElementChild as HTMLElement;
      let height = 3000, contentHeight = 2800, top = 0, reads = 0;
      Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => { reads++; return height; } });
      Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 900 });
      Object.defineProperty(scroll, 'scrollTop', { configurable: true, get: () => top, set: v => { top = Math.max(0, Math.min(v, height - 900)); } });
      Object.defineProperty(content, 'scrollHeight', { configurable: true, get: () => contentHeight });
      const growth = observers.find(o => o.target === content);
      expect(growth).toBeTruthy();
      act(() => { growth!.fire(); }); // initial RO measurement
      act(() => { height = 3300; contentHeight = 3100; growth!.fire(); });
      expect(top).toBe(2400);
      // A late folded/laid-out body shrinks after the last pin; browser scroll
      // anchoring may leave us hundreds of pixels behind even while stick=true.
      act(() => { height = 3000; contentHeight = 2800; top = 1811; growth!.fire(); });
      expect(top).toBe(2100);
      // WHY: upstream restored browser-native scrolling. jsdom delivers intent
      // but has no default wheel action; model that physical movement explicitly.
      fireEvent.wheel(scroll, { deltaY: -120 });
      act(() => { scroll.scrollTop -= 120; scroll.dispatchEvent(new Event('scroll')); });
      reads = 0;
      act(() => { height = 3200; contentHeight = 3000; growth!.fire(); });
      expect(top).toBe(1980); // wheel moved up; later growth must not repin
      expect(reads).toBe(0); // no forced scrollHeight read when intent released stick
      r.unmount();
    } finally { (globalThis as any).ResizeObserver = oldResize; }
  });
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
