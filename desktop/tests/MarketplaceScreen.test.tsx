// @vitest-environment jsdom
// Marketplace's "Explore everything" grid draws one chunk of cards for a big
// catalog and grows as you scroll, instead of every entry at once (~58,000
// page elements at stress scale — render-cost consolidation, Task 8), and the
// visible cards stay put — they don't all redraw on an unrelated re-render
// (fix round 1: a stable `item` identity is what actually lets
// React.memo(MarketplaceCard) skip them).
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// Render-count probe: MarketplaceCard itself is the memo boundary (its default
// export is memo(MarketplaceCard)), so counting calls to ITS function would
// require unwrapping that memo and losing the bail-out semantics under test.
// InstallFavoriteCorner is a plain (unmemoized) child MarketplaceCard always
// renders for an installable, not-yet-installed skill card — same technique
// tests/ConversationsTab.test.tsx uses on SessionCardMeta, a plain child of
// the memoized ConversationRow: when the memo bails out, React never
// reconciles children, so this child's render count is a faithful proxy for
// "did the card itself re-render".
const renders = vi.hoisted(() => ({ corner: 0 }));
vi.mock('../src/renderer/components/marketplace/InstallFavoriteCorner', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/components/marketplace/InstallFavoriteCorner')>();
  return {
    ...real,
    default: (p: Parameters<typeof real.default>[0]) => { renders.corner++; return real.default(p); },
  };
});

import MarketplaceScreen from '../src/renderer/components/marketplace/MarketplaceScreen';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider } from '../src/renderer/state/marketplace-stats-context';
import { AccountProvider } from '../src/renderer/state/account-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { installFiringIntersectionObserver } from './helpers/firing-intersection-observer';
import { REVEAL_CHUNK } from '../src/renderer/hooks/use-chunked-reveal';
import { NARROW_VIEWPORT_QUERY } from '../src/renderer/hooks/use-narrow-viewport';
import type { SkillEntry } from '../src/shared/types';

// WHY: MarketplaceScreen branches its grid layout via MarketplaceGrid's
// useNarrowViewport() call, and jsdom has no matchMedia — .claude/rules/
// narrow-viewport.md: a test of a viewport-branching surface DECLARES the
// viewport. Wide here, so the grid (not the compact list) renders.
function declareViewport(narrow: boolean) {
  (window as any).matchMedia = (q: string) => ({
    matches: narrow && q === NARROW_VIEWPORT_QUERY, media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}

// 300 installable skill entries with no catalog.partOf, so all 300 pass the
// "Explore everything" grouped-view filter (`!s.catalog?.partOf`).
const entries: SkillEntry[] = Array.from({ length: 300 }, (_, i) => ({
  id: `skill-${i}`,
  displayName: `Skill ${i}`,
  description: 'd',
  tagline: 'd',
  author: 'T',
  category: 'productivity',
  prompt: '/x',
  source: 'marketplace',
  type: 'plugin',
  visibility: 'published',
  sourceType: 'url',
  sourceRef: 'https://github.com/o/r.git',
  components: null,
  lifeArea: [],
  tags: [],
}) as any);

// Minimal window.claude stub — same shape as tests/marketplace-not-installable.test.tsx.
function setupWindowClaude() {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    skills: {
      listMarketplace: vi.fn().mockResolvedValue(entries),
      list: vi.fn().mockResolvedValue([]),
      getFavorites: vi.fn().mockResolvedValue([]),
      getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }),
      install: vi.fn().mockResolvedValue({}),
      uninstall: vi.fn().mockResolvedValue({}),
      setFavorite: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({ prUrl: '' }),
      getChips: vi.fn().mockResolvedValue([]),
      setChips: vi.fn().mockResolvedValue(undefined),
      setOverride: vi.fn().mockResolvedValue(undefined),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
    },
    marketplace: { getPackages: vi.fn().mockResolvedValue({}) },
    account: {
      signedIn: vi.fn().mockResolvedValue(false),
      user: vi.fn().mockResolvedValue(null),
      start: vi.fn(),
      poll: vi.fn(),
      signOut: vi.fn(),
    },
    marketplaceApi: { install: vi.fn().mockResolvedValue({ ok: true }) },
    theme: {
      list: vi.fn().mockResolvedValue([]),
      marketplace: { list: vi.fn().mockResolvedValue([]), install: vi.fn(), uninstall: vi.fn(), update: vi.fn() },
    },
    appearance: { getFavoriteThemes: vi.fn().mockResolvedValue([]) },
  };
}

async function renderScreen() {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(<Tree />);
  });
  return result!;
}

// The exact provider tree renderScreen() mounts — reused by `rerender()` below
// so React reconciles (same element types at every position = an update, not
// a remount) instead of tearing down and refetching the catalog.
function Tree() {
  return (
    <AccountProvider pollIntervalMs={10}>
      <SkillProvider>
        <MarketplaceProvider>
          <MarketplaceStatsProvider>
            <MarketplaceScreen onExit={() => {}} />
          </MarketplaceStatsProvider>
        </MarketplaceProvider>
      </SkillProvider>
    </AccountProvider>
  );
}

const cards = (c: HTMLElement) => c.querySelectorAll('[data-marketplace-card]').length;

describe('MarketplaceScreen', () => {
  let io: ReturnType<typeof installFiringIntersectionObserver>;
  beforeEach(() => {
    declareViewport(false);
    setupWindowClaude();
    renders.corner = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    io = installFiringIntersectionObserver();
  });
  afterEach(() => {
    cleanup();
    io.restore();
    vi.restoreAllMocks();
  });

  it('draws one chunk of the Explore-everything grid for 300 entries, and another on scroll', async () => {
    const { container } = await renderScreen();
    expect(cards(container)).toBe(REVEAL_CHUNK);
    act(() => io.fireAll());
    expect(cards(container)).toBe(REVEAL_CHUNK * 2);
  });

  // Fix round 1 (review finding #3): pins that a stable `item` identity is
  // what actually lets MarketplaceCard's memo skip unaffected cards. Before
  // the fix, the explore grid built `item={{ kind: "skill", entry: s }}`
  // fresh in its .map() — a new object every render — so EVERY visible card
  // redrew on every MarketplaceScreen render, unrelated ones included.
  //
  // `rerender()` re-renders the SAME provider tree (same element types at
  // every position, so React updates rather than remounts — the catalog
  // isn't refetched) with no data change: "a rerender with the same catalog".
  // This is the achievable half of the two triggers the brief names.
  // Its sibling half — "marketplace context value changing installingIds for
  // an entry NOT on screen" — does NOT stay green even after this fix:
  // MarketplaceCard calls `useMarketplace()` itself (installKey/isInstalling/
  // isFavorited), so it is a direct Context consumer, and Context propagation
  // forces every subscriber to re-render on ANY value change regardless of
  // memo or prop equality — confirmed empirically (all 50 cards re-rendered)
  // while developing this test. That's a real, separate limitation of the
  // shared marketplace Context (would need a selector-scoped read, e.g. the
  // chat-state pattern in state/chat-context.ts, to close) — out of this
  // fix round's scope; flagged in the report rather than silently narrowed.
  it('does not redraw visible explore cards on an unrelated MarketplaceScreen re-render', async () => {
    const { container, rerender } = await renderScreen();
    expect(cards(container)).toBe(REVEAL_CHUNK);
    const first = renders.corner;
    expect(first).toBe(REVEAL_CHUNK); // one InstallFavoriteCorner render per visible card, no double pass

    await act(async () => {
      rerender(<Tree />);
    });

    expect(renders.corner).toBe(first);
    expect(cards(container)).toBe(REVEAL_CHUNK);
  });
});
