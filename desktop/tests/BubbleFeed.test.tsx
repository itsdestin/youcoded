// @vitest-environment jsdom
// The buddy floater's twin of tests/session-preview-pane.test.tsx's
// "PreviewTimeline folding" block (Task 7 of the render-cost consolidation
// plan — Task 6 gave the conversation preview pane the same treatment first).
//
// BubbleFeed grows forever without folding, same as the main chat and the
// preview pane did before their own perf-cycle-3 passes: it renders the same
// long-running conversation the main chat renders, so its DOM cost grows
// exactly the same way as a session gets long.
//
// BubbleFeed runs in the buddy window's OWN renderer process with no
// ArtifactProvider (ArtifactContext.tsx's useArtifactOptional degrades
// gracefully rather than throwing) — mounted bare here too, matching how it
// runs for real. Mocking shape follows tests/bubblefeed-scroll-pin-deps.test.tsx,
// which established it first for this component.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { FOLD_IDLE_MS } from '../src/renderer/hooks/use-entry-folding';
import { MATRIX } from './helpers/transcript-event-matrix';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { BUDDY_LIVE } from '../src/renderer/components/buddy/buddy-live-events';

const mocks = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn() }));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => mocks.dispatch,
}));

vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ showTimestamps: false }),
}));

vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

// Same shape as session-preview-pane.test.tsx's FoldIO — a controllable
// IntersectionObserver stub whose constructed instances are inspectable, so
// the fold hook's own observer (not BubbleFeed's separate bottom-sentinel
// one, also built unconditionally) can be found by what it actually observed.
class FoldIO {
  static instances: FoldIO[] = [];
  cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
  observed: Element[] = [];
  constructor(cb: FoldIO['cb']) { this.cb = cb; FoldIO.instances.push(this); }
  observe(el: Element) { this.observed.push(el); }
  unobserve(el: Element) { this.observed = this.observed.filter((o) => o !== el); }
  disconnect() { this.observed = []; }
  takeRecords() { return []; }
}

beforeEach(() => {
  mocks.dispatch.mockClear();
  FoldIO.instances = [];
  vi.stubGlobal('IntersectionObserver', FoldIO);
  // BubbleFeed owns its own IPC subscriptions (separate renderer from
  // App.tsx). No event is ever delivered here — tests drive state through
  // the mocked useChatState instead. Mirrors bubblefeed-scroll-pin-deps.test.tsx.
  (window as any).claude = {
    on: {
      transcriptEvent: (h: unknown) => h,
      hookEvent: (h: unknown) => h,
      specialistEvent: () => () => {},
      shellEvent: () => () => {},
    },
    off: () => {},
    detach: { requestTranscriptPage: () => Promise.resolve(null) },
  };
});

import { BubbleFeed } from '../src/renderer/components/buddy/BubbleFeed';

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
    isThinking: false,
    compactionPending: false,
    promptProcessing: null,
    attentionState: 'ok',
    errorMessage: null,
    stallWarning: null,
    lastActivityAt: 1000,
    lastOutputAt: 1000,
    modelState: 'idle',
    modelInfo: null,
    ...overrides,
  };
}

function twoTurnState() {
  return sessionState({
    timeline: [
      { kind: 'assistant-turn', turnId: 'turn_1' },
      { kind: 'assistant-turn', turnId: 'turn_2' },
    ],
    assistantTurns: new Map([
      ['turn_1', textTurn('turn_1', 'First')],
      ['turn_2', textTurn('turn_2', 'Second')],
    ]),
  });
}

describe('BubbleFeed paging', () => {
  it('passes the first page’s interrupted tools to its own chat reducer', async () => {
    mocks.state = sessionState({ history: { cursor: null, hasMore: false, loading: false } });
    (window as any).claude.detach.requestTranscriptPage = vi.fn().mockResolvedValue({
      events: [], cursor: null, hasMore: false, reconcileInterrupted: true,
      reconcileInterruptedToolIds: ['pre-resume-tool'],
    });
    render(<BubbleFeed sessionId="s1" />);
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'HISTORY_PAGE_LOADED', sessionId: 's1', reconcileInterrupted: true,
      reconcileInterruptedToolIds: ['pre-resume-tool'],
    })));
  });
});

describe('BubbleFeed folding', () => {
  // (a) alone is a lookalike, per Task 6's own note on this pair — it passes
  // with the attribute wired up and nothing ever folded. Kept anyway because
  // it pins the registration key every entry must carry for folding to find
  // it at all.
  it("gives every timeline entry a data-entry-key, the fold hook's registration key", () => {
    mocks.state = twoTurnState();
    const { container } = render(<BubbleFeed sessionId="s1" />);

    const entries = container.querySelectorAll('.timeline-entry');
    expect(entries.length).toBe(2);
    for (const el of entries) {
      expect(el.getAttribute('data-entry-key')).toBeTruthy();
    }
  });

  it('folds an entry the observer reports out of view into a same-height, contentless spacer, while an intersecting entry keeps its content', async () => {
    mocks.state = twoTurnState();
    const { container } = render(<BubbleFeed sessionId="s1" />);

    const entryEls = [...container.querySelectorAll<HTMLElement>('.timeline-entry[data-entry-key]')];
    const target = entryEls[0];
    const kept = entryEls[1];
    const targetText = target.textContent;
    // jsdom measures every element at 0; the hook REFUSES to fold a 0-height
    // entry, so a real fold needs a stubbed, non-zero offsetHeight — exactly
    // as use-entry-folding.test.ts's own `entry()` helper does.
    Object.defineProperty(target, 'offsetHeight', { get: () => 240, configurable: true });

    // BubbleFeed also builds its own bottom-sentinel IntersectionObserver
    // (atBottomRef) unconditionally, so two FoldIO instances exist. Passive
    // effects fire in hook-call order, and useEntryFolding() is called
    // before the bottom-sentinel useEffect in BubbleFeed's body, so its
    // observer is always instances[0] — the same "grab the single instance"
    // shape session-preview-pane.test.tsx uses (there only one exists).
    //
    // Note: registerEntry's own io.observe(el) call fires from the ref
    // CALLBACK during commit, which runs before this effect creates the
    // observer — so an entry present at the INITIAL render is never actually
    // in `observed` (same characteristic use-entry-folding.ts already has in
    // ChatView/PreviewTimeline; not a Task 7 regression). Driving the stub's
    // `cb` directly, as Task 6's test does, exercises the fold logic itself
    // without depending on that.
    expect(FoldIO.instances.length).toBe(2);
    const io = FoldIO.instances[0];

    vi.useFakeTimers();
    act(() => { io.cb([{ target, isIntersecting: false }]); });
    // Folding waits for scrolling to go IDLE before it commits (FOLD_IDLE_MS)
    // — advance past exactly that settle delay.
    await act(async () => { await vi.advanceTimersByTimeAsync(FOLD_IDLE_MS); });
    vi.useRealTimers();

    expect(target.style.height).toBe('240px');
    expect(target.children.length).toBe(0);
    expect(target.textContent).toBe('');
    expect(targetText).not.toBe('');

    // `kept` was never reported out of view, so it stays intersecting (the
    // hook's default) and must never fold.
    expect(kept.style.height).toBe('');
    expect(kept.children.length).toBeGreaterThan(0);
  });
});

describe('BubbleFeed live transcript events', () => {
  // Delivers one live event the way the buddy window's IPC would, with the
  // animation-frame batcher flushed by hand, and returns what was dispatched.
  function deliver(event: Record<string, unknown>, state: Record<string, unknown> = {}) {
    mocks.state = sessionState(state);
    let handler: (e: unknown) => void = () => {};
    (window as any).claude.on.transcriptEvent = (h: (e: unknown) => void) => { handler = h; return h; };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    render(<BubbleFeed sessionId="s1" />);
    mocks.dispatch.mockClear();
    handler({ sessionId: 's1', uuid: 'u1', timestamp: 500, ...event });
    act(() => { for (const f of frames.splice(0)) f(0); });
    return mocks.dispatch.mock.calls.map((c) => c[0] as { type: string });
  }

  it('shows the same compaction marker as the main window: event id, freed-token counts, summary', () => {
    const calls = deliver(
      { type: 'compact-summary', data: { summary: 'S', autoCompaction: true, contextUsedBefore: 900, contextUsedAfter: 100 } },
    );
    expect(calls).toContainEqual(expect.objectContaining({
      type: 'COMPACTION_COMPLETE', markerId: 'compact-done-u1',
      beforeContextTokens: 900, afterContextTokens: 100, summary: 'S', auto: true,
    }));
  });

  it('draws no compaction marker for a compaction this window did not start', () => {
    const calls = deliver({ type: 'compact-summary', data: { summary: 'S', contextUsedAfter: 100 } }, { compactionPending: false });
    expect(calls.map((c) => c.type)).not.toContain('COMPACTION_COMPLETE');
  });

  it('draws every other event type and payload exactly as the shared translator says', () => {
    // The buddy listener must route through eventToAction for everything its ledger
    // does not skip, so it can never again forget a type (replay-complete, PR #287).
    for (const c of MATRIX) {
      if (BUDDY_LIVE[c.event.type] !== 'same') continue;
      const expected = eventToAction(c.event, { live: true, compactionPending: c.ctx?.compactionPending, fallbackContextTokens: null });
      expect(deliver({ ...c.event }, { compactionPending: c.ctx?.compactionPending ?? false }), c.name).toEqual(expected);
    }
  });

  it('still skips its three known live gaps', () => {
    for (const type of ['user-interrupt', 'skill-invoked', 'context-clear']) {
      expect(deliver({ type, data: { skillId: 'x', contextUsedAfter: 1 } }), type).toEqual([]);
    }
  });

  it('ignores an event type nobody has heard of without throwing', () => {
    expect(deliver({ type: 'streaming-text' })).toEqual([]);
  });

  it('treats a wire type named after an inherited object property as unknown, not as a ledger row', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(deliver({ type }), type).toEqual([]);
    }
  });

  it('stamps a tool-use with the event timestamp', () => {
    expect(deliver({ type: 'tool-use', data: { toolUseId: 't', toolName: 'Read' } }))
      .toContainEqual(expect.objectContaining({ type: 'TRANSCRIPT_TOOL_USE', timestamp: 500 }));
  });
});
