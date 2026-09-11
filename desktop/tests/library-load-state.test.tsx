// @vitest-environment jsdom
/**
 * The Library never calls a load it could not finish "nothing installed".
 *
 * Error inventory 2026-09-10, false message 15: LibraryScreen reads `installedSkills` and
 * `themeEntries`, which start as [] and STAY [] when marketplace-context's fetchAll fails
 * (its Promise.all rejects before either is set). The screen never looked at `loading` or
 * `error`, so while the load was still running — and after it failed — it told someone
 * with plugins installed "Nothing installed yet." and "No themes installed yet.", and
 * offered to send them to the Marketplace for things they already had.
 *
 * Same provider tree as library-empty-state.test.tsx, which pins the REAL empty state.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';
import LibraryScreen from '../src/renderer/components/library/LibraryScreen';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider } from '../src/renderer/state/marketplace-stats-context';
import { SkillProvider } from '../src/renderer/state/skill-context';

// `skills.list` is one of the calls inside fetchAll's Promise.all that has no catch of
// its own, so its rejection is exactly the failure that leaves the lists empty.
function setupWindowClaude(list: (...args: unknown[]) => Promise<unknown>) {
  (window as any).claude = {
    skills: {
      listMarketplace: vi.fn().mockResolvedValue([]),
      list: vi.fn(list),
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
    account: { signedIn: vi.fn().mockResolvedValue(false) },
    marketplaceApi: { install: vi.fn().mockResolvedValue({ ok: true }) },
    theme: {
      marketplace: {
        list: vi.fn().mockResolvedValue([]),
        install: vi.fn().mockResolvedValue(undefined),
        uninstall: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    },
    appearance: {
      getFavoriteThemes: vi.fn().mockResolvedValue([]),
      favoriteTheme: vi.fn().mockResolvedValue(undefined),
    },
  };
  return (window as any).claude.skills.list as ReturnType<typeof vi.fn>;
}

async function renderLibrary() {
  await act(async () => {
    render(
      <SkillProvider>
        <MarketplaceProvider>
          <MarketplaceStatsProvider>
            <LibraryScreen onExit={() => {}} onOpenMarketplace={() => {}} />
          </MarketplaceStatsProvider>
        </MarketplaceProvider>
      </SkillProvider>,
    );
  });
}

const FAILURE = new Error("Error invoking remote method 'skills:list': Error: EACCES: permission denied, open '/home/me/.claude/plugins/installed_plugins.json'");

describe('LibraryScreen — a load that did not finish is not "nothing installed"', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as any).claude;
  });

  it('a failed load says it could not load, with Retry, instead of "Nothing installed yet."', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = setupWindowClaude(() => Promise.reject(FAILURE));
    await renderLibrary();

    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument();
    expect(screen.queryByText('Nothing installed yet.')).toBeNull();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();

    // Retry really reloads: once the list answers (empty, this time), the true empty
    // state is allowed to appear.
    list.mockResolvedValue([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(await screen.findByText('Nothing installed yet.')).toBeInTheDocument();
  });

  it('the Themes tab does not say "No themes installed yet." after a failed load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setupWindowClaude(() => Promise.reject(FAILURE));
    await renderLibrary();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /themes/i })); });

    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument();
    expect(screen.queryByText('No themes installed yet.')).toBeNull();
  });

  it('a THEME list that failed on its own does not say "No themes installed yet." (code review F4)', async () => {
    setupWindowClaude(() => Promise.resolve([]));
    (window as any).claude.theme.marketplace.list = vi.fn().mockRejectedValue(new Error('theme registry unreachable'));
    await renderLibrary();

    // The plugins half loaded fine, so its true empty state still shows.
    expect(await screen.findByText('Nothing installed yet.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: /themes/i })); });

    expect(await screen.findByText(/couldn.t load your installed themes/i)).toBeInTheDocument();
    expect(screen.queryByText('No themes installed yet.')).toBeNull();
  });

  it('a load still running says it is loading, not "Nothing installed yet."', async () => {
    setupWindowClaude(() => new Promise(() => {}));
    await renderLibrary();

    expect(await screen.findByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText('Nothing installed yet.')).toBeNull();
  });
});
