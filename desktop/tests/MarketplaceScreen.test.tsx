// @vitest-environment jsdom
// Marketplace's "Explore everything" grid draws one chunk of cards for a big
// catalog and grows as you scroll, instead of every entry at once (~58,000
// page elements at stress scale — render-cost consolidation, Task 8), and the
// visible cards stay put — they don't all redraw on an unrelated re-render
// (fix round 1: a stable `item` identity is what actually lets
// React.memo(MarketplaceCard) skip them).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';

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
    // ProjectSetupPanel's own dependencies (U2 fix test below) — reached once
    // a card install with parts opens the detail overlay in its setup state.
    artifacts: { listProjectsIndex: vi.fn().mockResolvedValue({ ok: true, projects: [{ id: 'p1', path: '/a', name: 'Alpha' }] }) },
    projectExtensions: {
      get: vi.fn().mockResolvedValue({
        ok: true,
        view: { projectKey: '/a', personal: [], needsSetup: [], builtIn: [], installed: [] },
      }),
      set: vi.fn(),
    },
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

  // U2 fix (beta review 2): the beta tester installed "Remember" from the
  // Marketplace grid's OWN Install button (never opening the detail page
  // first) and it then showed up nowhere — no project let them turn it on.
  // The product decision is that EVERY plugin install with parts reaches the
  // post-install "choose your projects" panel, not just the one started from
  // the detail page's own Install button (already covered by
  // MarketplaceDetailOverlay.test.tsx). This proves the card path specifically.
  it('installing a plugin with parts from the grid CARD opens the detail overlay in its setup state', async () => {
    const withParts: SkillEntry = {
      id: 'remember', displayName: 'Remember', description: 'd', tagline: 'd', author: 'T',
      category: 'productivity', prompt: '/remember', source: 'marketplace', type: 'plugin', visibility: 'published',
      sourceType: 'url', sourceRef: 'https://github.com/o/r.git', repoUrl: 'https://github.com/o/r',
      components: { skills: ['remember'], hooks: [], commands: [], agents: [], mcpServers: [], hasHooksManifest: false, hasMcpConfig: false },
      lifeArea: [], tags: [],
    } as any;
    (window as any).claude.skills.listMarketplace.mockResolvedValue([withParts]);

    const { container } = await renderScreen();
    expect(cards(container)).toBe(1);

    // The card's own corner affordance, NOT MarketplaceDetailOverlay's
    // Install button — the detail page is never opened before this click.
    const installButton = container.querySelector('[aria-label="Install"]') as HTMLElement | null;
    expect(installButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(installButton!);
      // installSkill() chains window.claude.skills.install → account.signedIn
      // → fetchAll()/refreshDrawerSkills() before resolving — flush the
      // microtask queue enough times for that chain to settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText('Set up Remember')).toBeInTheDocument();
    expect(screen.getByText(/Installed on this device\. Choose where the assistant/)).toBeInTheDocument();
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });
});
