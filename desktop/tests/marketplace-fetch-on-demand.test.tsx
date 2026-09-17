// @vitest-environment jsdom
// The marketplace providers sit at the app root but fetch nothing until a
// screen that shows their data mounts (2026-09-16 audit W16), and the
// installed-skills list and favourites are fetched once, by SkillContext,
// not a second time by the marketplace (audit W17).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { MarketplaceProvider, useMarketplace } from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider, useMarketplaceStats, __resetStatsCacheForTests } from '../src/renderer/state/marketplace-stats-context';
import CommandDrawer from '../src/renderer/components/CommandDrawer';

vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ reloadUserThemes: vi.fn(async () => {}) }),
}));

if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}

// The real / drawer, as App mounts it under every session: present while closed.
function Drawer({ open }: { open: boolean }) {
  return (
    <CommandDrawer open={open} searchMode={false} onSelect={() => {}} onSelectCommand={() => {}}
      onClose={() => {}} onOpenManager={() => {}} onOpenMarketplace={() => {}} />
  );
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function bridge() {
  const skills = {
    list: vi.fn(async (): Promise<any[]> => []),
    getFavorites: vi.fn(async (): Promise<string[]> => []),
    getChips: vi.fn(async () => []),
    getCuratedDefaults: vi.fn(async () => []),
    listMarketplace: vi.fn(async () => []),
    getFeatured: vi.fn(async () => ({ hero: [], rails: [] })),
    setFavorite: vi.fn(async () => {}),
  };
  const themeList = vi.fn(async () => []);
  const getFavoriteThemes = vi.fn(async () => []);
  const getPackages = vi.fn(async () => ({}));
  (window as any).claude = {
    skills,
    commands: { list: vi.fn(async () => []) },
    marketplace: { getPackages },
    theme: { marketplace: { list: themeList }, onReload: vi.fn(() => () => {}) },
    appearance: { getFavoriteThemes, onSync: vi.fn(() => () => {}) },
  };
  return { skills, themeList, getFavoriteThemes, getPackages };
}

const marketplaceCalls = (b: ReturnType<typeof bridge>) =>
  b.skills.listMarketplace.mock.calls.length + b.themeList.mock.calls.length
  + b.getFavoriteThemes.mock.calls.length + b.getPackages.mock.calls.length + b.skills.getFeatured.mock.calls.length;

function Root({ children }: { children?: React.ReactNode }) {
  return (
    <MarketplaceStatsProvider>
      <SkillProvider>
        <MarketplaceProvider>{children}</MarketplaceProvider>
      </SkillProvider>
    </MarketplaceStatsProvider>
  );
}
function MarketplaceConsumer() { useMarketplace(); return null; }
function StatsConsumer() { useMarketplaceStats(); return null; }

let b: ReturnType<typeof bridge>;
beforeEach(() => {
  b = bridge();
  __resetStatsCacheForTests();
  (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ plugins: {}, themes: {} }) });
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (window as any).claude; });

describe('the marketplace providers at the app root', () => {
  it('mounting the root issues no marketplace call and no /stats request', async () => {
    render(<Root />);
    await flush();
    expect(marketplaceCalls(b)).toBe(0);
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
    // The command drawer's own data still loads at boot, once each.
    expect(b.skills.list).toHaveBeenCalledTimes(1);
    expect(b.skills.getFavorites).toHaveBeenCalledTimes(1);
  });

  it('a session\'s CLOSED / drawer is not a demand; opening it is, once', async () => {
    const { rerender } = render(<Root><Drawer open={false} /></Root>);
    await flush();
    expect(marketplaceCalls(b)).toBe(0);
    expect((globalThis as any).fetch).not.toHaveBeenCalled();

    rerender(<Root><Drawer open={true} /></Root>);
    await flush();
    expect(b.skills.listMarketplace).toHaveBeenCalledTimes(1);
    expect(marketplaceCalls(b)).toBe(5);

    rerender(<Root><Drawer open={false} /></Root>);
    rerender(<Root><Drawer open={true} /></Root>);
    await flush();
    expect(marketplaceCalls(b)).toBe(5);
  });

  it('the first consumer starts the fetch once; a second consumer does not repeat it', async () => {
    const { rerender } = render(<Root><MarketplaceConsumer /><StatsConsumer /></Root>);
    await flush();
    expect(b.skills.listMarketplace).toHaveBeenCalledTimes(1);
    expect(b.themeList).toHaveBeenCalledTimes(1);
    expect(b.getFavoriteThemes).toHaveBeenCalledTimes(1);
    expect(b.getPackages).toHaveBeenCalledTimes(1);
    expect(b.skills.getFeatured).toHaveBeenCalledTimes(1);
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);

    rerender(<Root><MarketplaceConsumer /><StatsConsumer /><MarketplaceConsumer /><StatsConsumer /></Root>);
    await flush();
    expect(marketplaceCalls(b)).toBe(5);
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
  });

  it('installed skills and favourites are fetched once at boot even with a consumer open (W17)', async () => {
    render(<Root><MarketplaceConsumer /></Root>);
    await flush();
    expect(b.skills.list).toHaveBeenCalledTimes(1);
    expect(b.skills.getFavorites).toHaveBeenCalledTimes(1);
  });

  it('the marketplace exposes SkillContext\'s installed list and favourites under its old names', async () => {
    b.skills.list = vi.fn(async () => [{ id: 'one', name: 'One' }]);
    b.skills.getFavorites = vi.fn(async () => ['one']);
    (window as any).claude.skills = b.skills;
    let seen: { installedSkills: unknown[]; favorites: string[] } | null = null;
    function Probe() { const mp = useMarketplace(); seen = { installedSkills: mp.installedSkills, favorites: mp.favorites }; return null; }
    render(<Root><Probe /></Root>);
    await flush();
    expect(seen!.installedSkills).toEqual([{ id: 'one', name: 'One' }]);
    expect(seen!.favorites).toEqual(['one']);
  });
});
