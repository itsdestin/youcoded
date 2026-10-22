// @vitest-environment jsdom
// Freeze hunt 2026-10-22, item 3: a long conversation draws only its newest entries on first mount;
// the older ones are blank spacers (use-entry-folding.ts) until the observer reports them near the
// viewport. Real scroll stability is proven in real layout by desktop/scripts/first-draw-scroll-probe.mjs
// (jsdom has no layout); this pins the part jsdom CAN see: how much is drawn, and that a short one is whole.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ state: {} as any }));
vi.mock('../src/renderer/state/chat-context', async (importOriginal) => {
  // ToolCard reads the store directly; a real empty one answers "no specialist run" as the app does.
  const real = await importOriginal<any>();
  const store = real.createChatStore();
  return { useChatState: () => mocks.state, useChatDispatch: () => vi.fn(), useChatStore: () => store };
});
vi.mock('../src/renderer/state/ArtifactContext', async (importOriginal) => {
  const real = await importOriginal<any>();
  const state = { drawerOpenBySession: {}, drawerExpanded: false };
  return { ...real, useArtifactSelector: (select: (s: any) => unknown) => select(state), useArtifactDispatch: () => vi.fn() };
});
vi.mock('../src/renderer/components/MarkdownContent', () => ({ default: ({ content }: { content: string }) => <div data-testid="md">{content}</div> }));
if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
  (globalThis as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
}
// jsdom has no layout, and the first-frame unfold (useSwitchFirstFrame -> unfoldNearViewport) measures rects:
// with all-zero rects every spacer reads as "near the viewport". Give the rows a plausible layout instead:
// an 800 px window at the bottom of a column of 100 px rows.
const realRect = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const box = (top: number, h: number) => ({ top, bottom: top + h, height: h, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
  if (this.classList.contains('chat-scroll')) return box(0, 800);
  if (this.classList.contains('timeline-entry')) {
    const all = [...(this.parentElement?.querySelectorAll('.timeline-entry') ?? [])];
    return box(800 - (all.length - all.indexOf(this)) * 100, 100);
  }
  return realRect.call(this);
};
import ChatView from '../src/renderer/components/ChatView';

function conversation(turns: number) {
  const timeline: any[] = []; const assistantTurns = new Map<string, any>();
  for (let i = 0; i < turns; i++) {
    timeline.push({ kind: 'user', message: { id: `u${i}`, role: 'user', content: `question ${i}`, timestamp: i } });
    timeline.push({ kind: 'assistant-turn', turnId: `t${i}` });
    assistantTurns.set(`t${i}`, { id: `t${i}`, segments: [{ type: 'text', content: 'answer '.repeat(200), messageId: `m${i}` }], timestamp: i, stopReason: 'end_turn', model: null, usage: null, anthropicRequestId: null });
  }
  mocks.state = {
    timeline, queuedMessages: [], toolCalls: new Map(), toolGroups: new Map(), assistantTurns, activeTurnToolIds: new Set(),
    isThinking: false, promptProcessing: null, attentionState: 'ok', errorMessage: null, stallWarning: null, lastActivityAt: 0, lastOutputAt: 0,
    modelState: 'idle', modelInfo: null, modelLoadedBytes: 0, modelEverResident: false,
  };
}
const rows = (c: HTMLElement) => [...c.querySelectorAll('.timeline-entry')];
const drawn = (c: HTMLElement) => rows(c).filter((r) => r.childElementCount > 0);

describe('ChatView first draw of a long conversation', () => {
  it('draws only the newest entries, as many spacers as there are older ones, newest included', () => {
    conversation(60);
    const { container, unmount } = render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
    expect(rows(container).length).toBe(120);
    const d = drawn(container);
    expect(d.length).toBeGreaterThanOrEqual(10);
    expect(d.length).toBeLessThan(40);
    // The newest entry is a real body, and every spacer carries a height (so the scroll length is held).
    expect(rows(container).at(-1)!.childElementCount).toBeGreaterThan(0);
    for (const r of rows(container)) if (r.childElementCount === 0) expect((r as HTMLElement).style.height).toMatch(/px$/);
    unmount();
  });

  it('draws a short conversation whole', () => {
    conversation(6);
    const { container, unmount } = render(<ChatView sessionId="s1" visible={true} sessionActive={true} />);
    expect(drawn(container).length).toBe(rows(container).length);
    unmount();
  });
});
