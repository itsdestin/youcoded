// @vitest-environment jsdom
// Pins the Library empty state (UI review P-2 #1).
//
// WHY this test exists: `Section` in LibraryScreen used to decide "has content"
// with `React.Children.count(children) > 0`, and every call site passes
// `{cond && <MarketplaceGrid/>}`. When `cond` is false the child is the literal
// `false` — and React.Children.count(false) === 1, so the empty state was
// unreachable and never rendered on any theme from the day it was written.
// This mounts the screen against an EMPTY marketplace and asserts the empty
// copy and its "Browse the Marketplace" button actually appear.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';
import LibraryScreen from '../src/renderer/components/library/LibraryScreen';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider } from '../src/renderer/state/marketplace-stats-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
// WHY ArtifactProvider: the screen's band (ScreenBand, decisions "Full-screen titles") holds the
// header's Pages / Projects buttons, which read the artifact store.
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';

// Minimal window.claude stub — every list call resolves empty so the provider
// boots with nothing installed, nothing favorited, no themes.
function setupWindowClaude() {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    skills: {
      listMarketplace: vi.fn().mockResolvedValue([]),
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
    marketplace: {
      getPackages: vi.fn().mockResolvedValue({}),
    },
    account: {
      signedIn: vi.fn().mockResolvedValue(false),
    },
    marketplaceApi: {
      install: vi.fn().mockResolvedValue({ ok: true }),
    },
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
}

async function renderLibrary(props: Partial<React.ComponentProps<typeof LibraryScreen>> = {}) {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(
      // SkillProvider is required because MarketplaceProvider calls useSkills().
      <SkillProvider>
        <MarketplaceProvider>
          <MarketplaceStatsProvider>
            <ArtifactProvider value={{ state: initialArtifactState, dispatch: () => {} }}><LibraryScreen onExit={() => {}} settingsOpen={false} onToggleSettings={() => {}} {...props} /></ArtifactProvider>
          </MarketplaceStatsProvider>
        </MarketplaceProvider>
      </SkillProvider>,
    );
  });
  return result!;
}

describe('LibraryScreen empty state', () => {
  beforeEach(() => {
    setupWindowClaude();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the Installed empty state with a Browse button when nothing is installed', async () => {
    const onOpenMarketplace = vi.fn();
    await renderLibrary({ onOpenMarketplace });

    expect(screen.getByText('Nothing installed yet.')).toBeInTheDocument();
    expect(screen.getByText('Star an installed plugin and it appears here.')).toBeInTheDocument();

    const browse = screen.getByRole('button', { name: 'Browse the Marketplace' });
    expect(browse).toBeInTheDocument();
    fireEvent.click(browse);
    expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
  });

  it('omits the Browse button when no marketplace destination was provided', async () => {
    await renderLibrary();
    expect(screen.getByText('Nothing installed yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Browse the Marketplace' })).toBeNull();
  });

  it('renders the Themes empty states on the Themes tab', async () => {
    await renderLibrary({ onOpenMarketplace: () => {}, initialTab: 'themes' });
    expect(screen.getByText('No themes installed yet.')).toBeInTheDocument();
    expect(screen.getByText('Star an installed theme and it appears here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse the Marketplace' })).toBeInTheDocument();
  });

  it('uses the pill switcher with icon + label + count segments', async () => {
    await renderLibrary();
    const tablist = screen.getByRole('tablist', { name: 'Library sections' });
    // Pill container recipe shared with ProjectView's header switcher.
    expect(tablist.className).toContain('layer-surface');
    // The theme's control corner, not a fixed pill (decisions "Control shape follows the theme").
    expect(tablist.className).toContain('!rounded-control-group');
    const skills = screen.getByRole('tab', { name: /Plugins/ });
    expect(skills.className).toContain('rounded-control');
    // Count of installed skills — 0 with an empty marketplace.
    expect(skills).toHaveTextContent('Plugins0');
    expect(screen.getByRole('tab', { name: /Themes/ })).toHaveTextContent('Themes0');
  });
});
