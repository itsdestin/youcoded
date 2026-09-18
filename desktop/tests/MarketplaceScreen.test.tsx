// @vitest-environment jsdom
// Marketplace's "Explore everything" grid draws one chunk of cards for a big
// catalog and grows as you scroll, instead of every entry at once (~58,000
// page elements at stress scale — render-cost consolidation, Task 8).
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
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
    result = render(
      <AccountProvider pollIntervalMs={10}>
        <SkillProvider>
          <MarketplaceProvider>
            <MarketplaceStatsProvider>
              <MarketplaceScreen onExit={() => {}} />
            </MarketplaceStatsProvider>
          </MarketplaceProvider>
        </SkillProvider>
      </AccountProvider>,
    );
  });
  return result!;
}

const cards = (c: HTMLElement) => c.querySelectorAll('[data-marketplace-card]').length;

describe('MarketplaceScreen', () => {
  let io: ReturnType<typeof installFiringIntersectionObserver>;
  beforeEach(() => {
    declareViewport(false);
    setupWindowClaude();
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
});
