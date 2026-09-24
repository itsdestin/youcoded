// @vitest-environment jsdom
// MarketplaceDetailOverlay's post-install "choose your projects" panel (T6,
// project-plugin-controls). The panel (ProjectSetupPanel) is production code
// reached through a real install, gated on the catalog entry having skills
// or tool connections — never a fixture id, never for a theme or a
// prompt-only skill. Panel-internal behaviour (toggles, the risk popup,
// per-row lazy fetch) is covered by ProjectSetupPanel.test.tsx; this file
// only proves the GATING and the overlay's own Done/close contract.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent, waitFor } from '@testing-library/react';
import MarketplaceDetailOverlay from '../src/renderer/components/marketplace/MarketplaceDetailOverlay';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider, __resetStatsCacheForTests } from '../src/renderer/state/marketplace-stats-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { AccountProvider } from '../src/renderer/state/account-context';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetStatsCacheForTests();
  cleanup();
});

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
    marketplace: { getPackages: vi.fn().mockResolvedValue({}) },
    account: { signedIn: vi.fn().mockResolvedValue(false), user: vi.fn().mockResolvedValue(null), start: vi.fn(), poll: vi.fn(), signOut: vi.fn() },
    marketplaceApi: {
      install: vi.fn().mockResolvedValue({ ok: true }),
      myThumb: vi.fn().mockResolvedValue({ ok: false }),
      thumb: vi.fn().mockResolvedValue({ ok: false }),
      comment: vi.fn().mockResolvedValue({ ok: false }),
      comments: vi.fn().mockResolvedValue({ ok: false }),
      likeTheme: vi.fn().mockResolvedValue({ ok: false }),
      report: vi.fn().mockResolvedValue({ ok: false }),
    },
    theme: {
      list: vi.fn().mockResolvedValue([]),
      marketplace: { list: vi.fn().mockResolvedValue([]), install: vi.fn().mockResolvedValue(undefined), uninstall: vi.fn().mockResolvedValue(undefined), update: vi.fn() },
    },
    appearance: { getFavoriteThemes: vi.fn().mockResolvedValue([]), favoriteTheme: vi.fn().mockResolvedValue(undefined) },
    // ProjectSetupPanel's own dependencies — a real install exercises it.
    artifacts: { listProjectsIndex: vi.fn().mockResolvedValue({ ok: true, projects: [{ id: 'p1', path: '/a', name: 'Alpha' }] }) },
    projectExtensions: {
      get: vi.fn().mockResolvedValue({
        ok: true,
        view: {
          projectKey: '/a', personal: [], needsSetup: [],
          builtIn: [],
          installed: [{ pluginId: 'youcoded-inbox', displayName: 'Inbox', bundled: false, on: false, paused: true, parts: [{ key: 'youcoded-inbox:process', kind: 'skill', displayName: 'Process inbox', on: false }] }],
        },
      }),
      set: vi.fn(),
    },
  };
}

async function renderWithProviders(ui: React.ReactElement) {
  await act(async () => {
    render(
      <AccountProvider pollIntervalMs={10}>
        <SkillProvider>
          <MarketplaceProvider>
            <MarketplaceStatsProvider>{ui}</MarketplaceStatsProvider>
          </MarketplaceProvider>
        </SkillProvider>
      </AccountProvider>,
    );
  });
}

const pluginWithParts = (overrides: Record<string, unknown> = {}) => ({
  id: 'youcoded-inbox', type: 'plugin', displayName: 'Inbox', description: 'd', tagline: 'd', category: 'development',
  prompt: '/inbox', source: 'marketplace', visibility: 'published', author: 'T', version: '1.0.0',
  components: { skills: ['process-inbox'], hooks: [], commands: [], agents: [], mcpServers: [], hasHooksManifest: false, hasMcpConfig: false },
  lifeArea: [], tags: [],
  sourceType: 'url', sourceRef: 'https://github.com/o/r.git', repoUrl: 'https://github.com/o/r',
  ...overrides,
} as any);

describe('MarketplaceDetailOverlay — post-install project setup panel', () => {
  it('shows the panel only after a SUCCESSFUL install of a plugin with parts', async () => {
    setupWindowClaude();
    (window as any).claude.skills.listMarketplace.mockResolvedValue([pluginWithParts()]);
    await renderWithProviders(<MarketplaceDetailOverlay target={{ kind: 'skill', id: 'youcoded-inbox' }} onClose={() => {}} />);

    // Before install: no panel, ordinary Details header.
    expect(screen.queryByText(/Choose where the assistant can use it/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install' }));
      await Promise.resolve();
    });

    expect(await screen.findByText('Set up Inbox')).toBeInTheDocument();
    expect(screen.getByText(/Installed on this device\. Choose where the assistant/)).toBeInTheDocument();
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });

  it('does not show the panel for a theme install', async () => {
    setupWindowClaude();
    (window as any).claude.theme.marketplace.list.mockResolvedValue([{
      slug: 'sunbreak', name: 'Sunbreak', description: 'd', author: 'T', installed: false,
    }]);
    await renderWithProviders(<MarketplaceDetailOverlay target={{ kind: 'theme', slug: 'sunbreak' }} onClose={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install' }));
      await Promise.resolve();
    });

    expect(screen.queryByText('Set up Sunbreak')).toBeNull();
    expect(screen.queryByText(/Choose where the assistant can use it/)).toBeNull();
  });

  it('does not show the panel for a prompt-only skill (no components)', async () => {
    setupWindowClaude();
    const promptSkill = pluginWithParts({
      id: 'writing-helper', type: 'prompt', displayName: 'Writing helper', components: null, prompt: 'You are a helpful writer.',
      sourceType: 'file',
    });
    (window as any).claude.skills.listMarketplace.mockResolvedValue([promptSkill]);
    await renderWithProviders(<MarketplaceDetailOverlay target={{ kind: 'skill', id: 'writing-helper' }} onClose={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install' }));
      await Promise.resolve();
    });

    expect(screen.queryByText('Set up Writing helper')).toBeNull();
    expect(screen.queryByText(/Choose where the assistant can use it/)).toBeNull();
  });

  it('Done closes the overlay without uninstalling', async () => {
    setupWindowClaude();
    (window as any).claude.skills.listMarketplace.mockResolvedValue([pluginWithParts()]);
    const onClose = vi.fn();
    await renderWithProviders(<MarketplaceDetailOverlay target={{ kind: 'skill', id: 'youcoded-inbox' }} onClose={onClose} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install' }));
      await Promise.resolve();
    });
    expect(await screen.findByText('Set up Inbox')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect((window as any).claude.skills.uninstall).not.toHaveBeenCalled();
  });
});
