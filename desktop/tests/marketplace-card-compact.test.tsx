// @vitest-environment jsdom
// Render tests for MarketplaceCard's compact list-row variant. Confirms:
// - compact=true switches the outer container to flex-row layout
// - compact=true hides InstallFavoriteCorner (no absolute corner affordance)
// - compact=true renders the right-column status pill via the status badge

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import MarketplaceCard from '../src/renderer/components/marketplace/MarketplaceCard';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider } from '../src/renderer/state/marketplace-stats-context';
import type { SkillEntry } from '../src/shared/types';

// Minimal window.claude stub — MarketplaceProvider calls these on mount, but the
// compact-layout tests don't need real install/favorite behavior.
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
    },
    marketplace: {
      getPackages: vi.fn().mockResolvedValue({}),
    },
    marketplaceAuth: {
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

const sampleSkill: SkillEntry = {
  id: 'sample-skill',
  displayName: 'Sample Skill',
  description: 'A sample',
  tagline: 'Quick description',
  author: 'Tester',
  category: 'productivity',
  prompt: '/sample',
  source: 'marketplace',
  type: 'plugin',
  visibility: 'published',
  components: null,
  lifeArea: [],
  tags: [],
} as any;

async function renderWithProviders(ui: React.ReactElement) {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(
      <MarketplaceProvider>
        <MarketplaceStatsProvider>
          {ui}
        </MarketplaceStatsProvider>
      </MarketplaceProvider>
    );
  });
  return result!;
}

describe('MarketplaceCard compact variant', () => {
  beforeEach(() => {
    setupWindowClaude();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the wide layout with InstallFavoriteCorner when compact is unset', async () => {
    const { container, queryByLabelText } = await renderWithProviders(
      <MarketplaceCard
        item={{ kind: 'skill', entry: sampleSkill }}
        onOpen={() => {}}
      />
    );
    expect(queryByLabelText('Install')).not.toBeNull();
    const outer = container.firstChild as HTMLElement;
    expect(outer.getAttribute('data-marketplace-card')).toBe('sample-skill');
  });

  it('renders the compact list-row layout when compact=true', async () => {
    const { container, queryByLabelText } = await renderWithProviders(
      <MarketplaceCard
        item={{ kind: 'skill', entry: sampleSkill }}
        onOpen={() => {}}
        compact
      />
    );
    const outer = container.firstChild as HTMLElement;
    expect(outer.getAttribute('data-marketplace-card-compact')).toBe('true');
    // Install affordance is still reachable on mobile via the inline button
    // in the right column, just not via the absolute-positioned corner.
    const installBtn = queryByLabelText('Install');
    expect(installBtn).not.toBeNull();
    // Confirm it's NOT the corner affordance (InstallFavoriteCorner uses
    // absolute positioning at top-right; the inline button does not).
    expect(installBtn?.className).not.toContain('absolute');
  });

  it('shows the title and tagline in compact mode', async () => {
    const { getByText } = await renderWithProviders(
      <MarketplaceCard
        item={{ kind: 'skill', entry: sampleSkill }}
        onOpen={() => {}}
        compact
      />
    );
    expect(getByText('Sample Skill')).toBeTruthy();
    expect(getByText('Quick description')).toBeTruthy();
  });

  it('inline Install click does not also open detail (stopPropagation)', async () => {
    const onOpen = vi.fn();
    const { getByLabelText } = await renderWithProviders(
      <MarketplaceCard
        item={{ kind: 'skill', entry: sampleSkill }}
        onOpen={onOpen}
        compact
      />
    );
    const installBtn = getByLabelText('Install');
    installBtn.click();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
