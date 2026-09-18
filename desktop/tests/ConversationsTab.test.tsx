// @vitest-environment jsdom
// Projects → Conversations draws one chunk of cards, grows as you scroll, and
// does not redraw cards when the tag registry answers.
//
// It used to draw every conversation (838 for a real project) on every visit,
// then draw them all again when the tag list arrived. Row renders are counted
// from INSIDE each card — SessionCardMeta is wrapped to count, the same probe
// status-bar-memo.test.tsx uses — because a Profiler around a memo'd row fires
// whenever the parent re-creates the element, bail-out or not.
import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const renders = vi.hoisted(() => ({ meta: 0 }));
vi.mock('../src/renderer/components/SessionCardDetails', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/components/SessionCardDetails')>();
  return {
    ...real,
    SessionCardMeta: (p: Parameters<typeof real.SessionCardMeta>[0]) => { renders.meta++; return real.SessionCardMeta(p); },
  };
});

import { ConversationsTab } from '../src/renderer/components/project-view/tabs/ConversationsTab';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';
import { REVEAL_CHUNK } from '../src/renderer/hooks/use-chunked-reveal';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';

const convs = Array.from({ length: 1000 }, (_, i) => ({
  sessionId: `s${i}`, name: `Conversation ${i}`, projectSlug: 'p', projectPath: '/p',
  lastModified: 1_700_000_000_000 - i, size: 1000,
})) as any[];

// WHY: this tab branches on viewport (the reveal root), and jsdom has no
// matchMedia — .claude/rules/narrow-viewport.md: a test of a viewport-branching
// component DECLARES the viewport.
function declareViewport(narrow: boolean) {
  (window as any).matchMedia = (q: string) => ({
    matches: narrow && q === NARROW_VIEWPORT_QUERY, media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

const cards = (c: HTMLElement) => c.querySelectorAll('button[title]').length;

describe('ConversationsTab', () => {
  let io: ReturnType<typeof installFiringIntersectionObserver>;
  beforeEach(() => {
    declareViewport(false);
    renders.meta = 0;
    // The tag registry itself is reset centrally (tests/setup-dom.ts afterEach).
    (window as any).claude = { tags: { list: vi.fn().mockResolvedValue([]) }, on: {} };
    io = installFiringIntersectionObserver();
  });
  afterEach(() => io.restore());

  it('draws one chunk of cards for 1,000 conversations and another on scroll', () => {
    const { container } = render(<ConversationsTab conversations={convs} onOpenPreview={() => {}} />);
    expect(cards(container)).toBe(REVEAL_CHUNK);
    act(() => io.fireAll());
    expect(cards(container)).toBe(REVEAL_CHUNK * 2);
  });

  it('does not redraw cards when the tag registry answers', async () => {
    render(<ConversationsTab conversations={convs} onOpenPreview={() => {}} />);
    const first = renders.meta;
    expect(first).toBeGreaterThan(0);
    // The registry answers (a new byId Map, even for an empty list). Rows with
    // no tags show nothing from it, so none may redraw.
    await act(async () => {});
    expect((window as any).claude.tags.list).toHaveBeenCalled();
    expect(renders.meta).toBe(first);
  });

  it('on a narrow screen still draws one chunk and grows on scroll', () => {
    // Below 640px the page itself scrolls, so the reveal watches the viewport;
    // this pins that the narrow branch gets an observer at all.
    declareViewport(true);
    const { container } = render(<ConversationsTab conversations={convs} onOpenPreview={() => {}} />);
    expect(cards(container)).toBe(REVEAL_CHUNK);
    act(() => io.fireAll());
    expect(cards(container)).toBe(REVEAL_CHUNK * 2);
  });
});
