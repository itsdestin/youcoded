// @vitest-environment jsdom
// The "archived — not in Claude's context" hint on chat entries.
//
// Only entries above the last /compact or /clear carry a hint, so only they may
// pay for a Tooltip: a wrapping Tooltip per entry used to run its state and
// effects for every message on every streamed word. And archiving an entry must
// NOT rebuild its element — that would drop its fade to 60% and collapse any
// card the reader had opened — so the hint sits beside the entry and forwards
// onto it. See src/renderer/components/TimelineEntryHint.tsx.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act, screen } from '@testing-library/react';
import { UnmemoizedChatView as ChatView } from '../src/renderer/components/ChatView';
import { Tooltip } from '../src/renderer/components/ui/Tooltip';

const mocks = vi.hoisted(() => ({ state: {} as any }));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatState: () => mocks.state,
  useChatDispatch: () => vi.fn(),
}));

vi.mock('../src/renderer/state/ArtifactContext', () => ({
  // ChatView reads the artifact store through narrow selectors (perf, 2026-09-23).
  useArtifactSelector: (select: (s: any) => unknown) => select({ drawerOpenBySession: {}, drawerExpanded: false }),
  useArtifactDispatch: () => vi.fn(),
}));

vi.mock('../src/renderer/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

// The real Tooltip, counted: one call per Tooltip render.
vi.mock('../src/renderer/components/ui/Tooltip', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/components/ui/Tooltip')>();
  return { ...real, Tooltip: vi.fn(real.Tooltip) };
});
const tooltipRenders = Tooltip as unknown as ReturnType<typeof vi.fn>;

if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}

afterEach(() => { vi.useRealTimers(); tooltipRenders.mockClear(); });

function turn(id: string, content: string) {
  return {
    id,
    segments: [{ type: 'text', content, messageId: `${id}-m`, partId: 'p1' }],
    timestamp: 1000, stopReason: null, model: null, usage: null, anthropicRequestId: null,
  };
}

const marker = { kind: 'system-marker', marker: { id: 'mk', variant: 'compact', label: 'Compacted', timestamp: 1000 } };

function state(timeline: any[], turns: string[]) {
  return {
    timeline,
    queuedMessages: [], toolCalls: new Map(), toolGroups: new Map(),
    assistantTurns: new Map(turns.map((t) => [t, turn(t, `text of ${t}`)])),
    activeTurnToolIds: new Set(), isThinking: false, promptProcessing: null,
    attentionState: 'ok', errorMessage: null, stallWarning: null,
    lastActivityAt: 1000, lastOutputAt: 1000,
    modelState: 'idle', modelInfo: null, modelLoadedBytes: 0, modelEverResident: false,
  };
}

const view = () => <ChatView sessionId="s1" visible sessionActive />;
const entry = (c: HTMLElement, key: string) => c.querySelector<HTMLElement>(`[data-entry-key="${key}"]`)!;
const ARCHIVED = 'Archived by compaction — not in Claude\'s active context';

describe('archived-entry hint', () => {
  it('builds no Tooltip for a conversation with nothing archived', () => {
    mocks.state = state(
      Array.from({ length: 20 }, (_, i) => ({ kind: 'assistant-turn', turnId: `t${i}` })),
      Array.from({ length: 20 }, (_, i) => `t${i}`),
    );
    const { container } = render(view());
    expect(tooltipRenders).not.toHaveBeenCalled();
    // The entry itself is unchanged: same classes, no hint attributes.
    const el = entry(container, 't3');
    expect(el.className).toBe('timeline-entry in-view');
    expect(el.hasAttribute('data-hint')).toBe(false);
    expect(el.hasAttribute('aria-label')).toBe(false);
  });

  it('gives only the archived entries a hint, on the entry element itself', () => {
    mocks.state = state(
      [{ kind: 'assistant-turn', turnId: 'a' }, { kind: 'assistant-turn', turnId: 'b' }, marker, { kind: 'assistant-turn', turnId: 'c' }],
      ['a', 'b', 'c'],
    );
    const { container } = render(view());
    // Two archived entries → two Tooltips, however many live ones follow.
    expect(tooltipRenders).toHaveBeenCalledTimes(2);
    for (const k of ['a', 'b']) {
      const el = entry(container, k);
      expect(el.className).toBe('timeline-entry in-view opacity-60 transition-opacity');
      expect(el.getAttribute('data-hint')).toBe(ARCHIVED);
      // Same accessible name the wrapping Tooltip gave it.
      expect(el.getAttribute('aria-label')).toBe(ARCHIVED);
    }
    expect(entry(container, 'c').hasAttribute('data-hint')).toBe(false);
    // Entries stay direct children of the content wrapper — nothing new in the DOM.
    expect(entry(container, 'a').parentElement).toBe(entry(container, 'c').parentElement);
  });

  it('opens on hover of the entry after the usual delay', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() + 86_400_000 });
    mocks.state = state([{ kind: 'assistant-turn', turnId: 'a' }, marker], ['a']);
    const { container } = render(view());
    fireEvent.pointerEnter(entry(container, 'a'), { pointerType: 'mouse' });
    expect(screen.queryByText(ARCHIVED)).toBeNull();
    act(() => { vi.advanceTimersByTime(800); });
    expect(screen.queryByRole('tooltip')?.textContent).toBe(ARCHIVED);
    fireEvent.pointerLeave(entry(container, 'a'), { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('archiving an entry keeps its element (so it fades instead of being rebuilt)', () => {
    const live = [{ kind: 'assistant-turn', turnId: 'a' }, { kind: 'assistant-turn', turnId: 'b' }];
    mocks.state = state(live, ['a', 'b']);
    const r = render(view());
    const before = entry(r.container, 'a');
    mocks.state = state([...live, marker], ['a', 'b']);
    r.rerender(view());
    const after = entry(r.container, 'a');
    expect(after).toBe(before);
    expect(after.getAttribute('data-hint')).toBe(ARCHIVED);
  });
});
