// @vitest-environment jsdom
// marketplace-context-refreshes-skills.test.tsx
// Verifies that MarketplaceContext mutations (install/uninstall) trigger a
// SkillContext.refreshInstalled() so the CommandDrawer doesn't go stale.
//
// Without the wiring this test exercises, plugins installed from the
// marketplace would not appear in the drawer until app restart — latent on
// desktop but newly visible on Android once the cold-start race fix exposes
// installed plugins in the first place.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { MarketplaceProvider, useMarketplace } from '../src/renderer/state/marketplace-context';

describe('MarketplaceContext refreshes SkillContext after install/uninstall', () => {
  let listCalls = 0;
  let installCalls = 0;

  beforeEach(() => {
    listCalls = 0;
    installCalls = 0;
    (window as any).claude = {
      skills: {
        // Counts both SkillProvider mount fetch and MarketplaceProvider fetchAll —
        // and crucially, the post-install refreshInstalled() that this test asserts.
        list: vi.fn(async () => { listCalls++; return []; }),
        listMarketplace: vi.fn(async () => []),
        getFavorites: vi.fn(async () => []),
        getChips: vi.fn(async () => []),
        getCuratedDefaults: vi.fn(async () => []),
        install: vi.fn(async () => { installCalls++; }),
        uninstall: vi.fn(async () => {}),
        getFeatured: vi.fn(async () => ({ hero: [], rails: [] })),
        setFavorite: vi.fn(async () => {}),
      },
      commands: { list: vi.fn(async () => []) },
      marketplace: { getPackages: vi.fn(async () => ({})) },
      marketplaceAuth: { signedIn: vi.fn(async () => false) },
      marketplaceApi: { install: vi.fn(async () => ({ ok: true, value: {} })) },
      theme: {
        marketplace: {
          list: vi.fn(async () => []),
          install: vi.fn(async () => {}),
          uninstall: vi.fn(async () => {}),
        },
      },
      appearance: {
        getFavoriteThemes: vi.fn(async () => []),
        favoriteTheme: vi.fn(async () => {}),
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('calls skills.list a second time after installSkill', async () => {
    let installFn: ((id: string) => Promise<void>) | null = null;
    function Probe() {
      const mp = useMarketplace();
      installFn = mp.installSkill;
      return null;
    }
    render(
      <SkillProvider>
        <MarketplaceProvider>
          <Probe />
        </MarketplaceProvider>
      </SkillProvider>,
    );
    // Wait for initial mount fetches (SkillProvider + MarketplaceProvider each fetch)
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const baseline = listCalls;
    await act(async () => { await installFn!('foo'); });
    // After install: MarketplaceContext.fetchAll() calls skills.list once,
    // and SkillContext.refreshInstalled() also calls skills.list once.
    // So listCalls should be baseline + 2 (or more if there's any other call).
    expect(listCalls).toBeGreaterThanOrEqual(baseline + 2);
    expect(installCalls).toBe(1);
  });

  it('calls skills.list a second time after uninstallSkill', async () => {
    let uninstallFn: ((id: string) => Promise<void>) | null = null;
    function Probe() {
      const mp = useMarketplace();
      uninstallFn = mp.uninstallSkill;
      return null;
    }
    render(
      <SkillProvider>
        <MarketplaceProvider>
          <Probe />
        </MarketplaceProvider>
      </SkillProvider>,
    );
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const baseline = listCalls;
    await act(async () => { await uninstallFn!('foo'); });
    expect(listCalls).toBeGreaterThanOrEqual(baseline + 2);
  });
});
