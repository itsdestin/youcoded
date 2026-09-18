// @vitest-environment jsdom
// MarketplaceCard — the marketplace's item card (wide and compact), plus the
// detail overlay, rail and Library surfaces that share its install/update
// actions. Every section renders inside the real providers.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent, waitFor } from '@testing-library/react';
import { isInstallableSource } from '../src/shared/catalog-types';
import MarketplaceCard from '../src/renderer/components/marketplace/MarketplaceCard';
import MarketplaceRail from '../src/renderer/components/marketplace/MarketplaceRail';
import MarketplaceDetailOverlay from '../src/renderer/components/marketplace/MarketplaceDetailOverlay';
import LibraryScreen from '../src/renderer/components/library/LibraryScreen';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import {
  MarketplaceStatsProvider,
  __resetStatsCacheForTests,
} from '../src/renderer/state/marketplace-stats-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { AccountProvider } from '../src/renderer/state/account-context';
import type { SkillEntry } from '../src/shared/types';

// WHY: each section below was its own file, so each started with an empty
// /stats cache and the environment's own fetch. One section replaces
// globalThis.fetch and fills the cache; put both back so it cannot leak.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetStatsCacheForTests();
});

// Render tests for MarketplaceCard's compact list-row variant. Confirms:
// - compact=true switches the outer container to flex-row layout
// - compact=true hides InstallFavoriteCorner (no absolute corner affordance)
// - compact=true renders the right-column status pill via the status badge
describe('MarketplaceCard compact variant', () => {
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
        // SkillProvider boot path — needs these even when the test doesn't exercise them.
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
    // Every non-deprecated row in the live registry carries a sourceType; without
    // one the card now (correctly) hides Install, because the installer could not
    // take it — see 'rows the installer cannot install' below.
    sourceType: 'url',
    sourceRef: 'https://github.com/o/r.git',
    components: null,
    lifeArea: [],
    tags: [],
  } as any;

  async function renderWithProviders(ui: React.ReactElement) {
    let result: ReturnType<typeof render> | undefined;
    await act(async () => {
      result = render(
        // SkillProvider is required because MarketplaceProvider calls
        // useSkills() to refresh the drawer-installed list after install/update
        // (added by f600625a). Without it, useSkills throws on mount.
        <SkillProvider>
          <MarketplaceProvider>
            <MarketplaceStatsProvider>
              {ui}
            </MarketplaceStatsProvider>
          </MarketplaceProvider>
        </SkillProvider>
      );
    });
    return result!;
  }

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

// A theme card must show its download count. MarketplaceCard read the
// count out of stats.plugins only — which holds nothing for a theme — so the
// number was always 0 and the whole row was hidden. /stats now reports
// themes[slug].installs; this pins that the card reads it.
describe('MarketplaceCard theme download count', () => {
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
      account: { signedIn: vi.fn().mockResolvedValue(false) },
      marketplaceApi: { install: vi.fn().mockResolvedValue({ ok: true }) },
      theme: {
        marketplace: {
          list: vi.fn().mockResolvedValue([]),
          install: vi.fn().mockResolvedValue({ status: 'installed' }),
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

  // The stats provider fetches GET /stats with the browser's own fetch.
  function mockStats(body: object) {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(body),
    });
  }

  const sampleTheme = {
    slug: 'ocean-depths',
    name: 'Ocean Depths',
    description: 'Deep blue',
    author: 'Tester',
    version: '1.0.0',
    manifestUrl: 'https://example.com/manifest.json',
    installed: false,
  } as any;

  async function renderCard() {
    let result: ReturnType<typeof render> | undefined;
    await act(async () => {
      result = render(
        <SkillProvider>
          <MarketplaceProvider>
            <MarketplaceStatsProvider>
              <MarketplaceCard item={{ kind: 'theme', entry: sampleTheme }} onOpen={() => {}} />
            </MarketplaceStatsProvider>
          </MarketplaceProvider>
        </SkillProvider>
      );
    });
    return result!;
  }

  beforeEach(() => {
    __resetStatsCacheForTests();
    setupWindowClaude();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the theme's install count from stats.themes", async () => {
    mockStats({
      generated_at: Date.now(),
      plugins: {},
      themes: { 'ocean-depths': { likes: 3, installs: 412 } },
    });
    const { getByTitle, getByText } = await renderCard();
    // The count renders as a download arrow whose title is the pluralised words.
    expect(getByTitle('412 installs')).toBeTruthy();
    expect(getByText('412')).toBeTruthy();
  });

  it('shows nothing when the theme has no installs yet', async () => {
    mockStats({
      generated_at: Date.now(),
      plugins: {},
      themes: { 'ocean-depths': { likes: 3, installs: 0 } },
    });
    const { queryByTitle } = await renderCard();
    expect(queryByTitle('0 installs')).toBeNull();
  });

  it('survives an older Worker that reports no installs field at all', async () => {
    mockStats({
      generated_at: Date.now(),
      plugins: {},
      themes: { 'ocean-depths': { likes: 3 } },
    });
    const { queryByTitle, getByText } = await renderCard();
    expect(queryByTitle('0 installs')).toBeNull();
    // The likes half still renders, so the card is not blank.
    expect(getByText('3 likes')).toBeTruthy();
  });
});

// Pins that rows the installer physically cannot take never show an Install
// button.
//
// WHY this test exists: the catalog lists things the app cannot install yet —
// Connections mirrored from the MCP registry (added through MCP settings, not as
// a plugin) and single-file rows. The installer answers both with "Unknown
// source type", so a green Install button on those cards was a button that could
// only ever fail. Showing where the item lives instead is the honest answer.
//
// The prompt case is the subtle one. A `type: "prompt"` row installs through the
// provider's prompt path — which tests/prompt-install-update.test.ts exercises
// end to end against the real config-store logic — but ONLY when the prompt text
// travels in the row. 193 mirrored "instructions" rows are prompt-typed pointers
// with no text; installing one would store an empty prompt.
describe('rows the installer cannot install', () => {
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
      theme: { list: vi.fn().mockResolvedValue([]), marketplace: { list: vi.fn().mockResolvedValue([]), install: vi.fn(), uninstall: vi.fn(), update: vi.fn() } },
      appearance: { getFavoriteThemes: vi.fn().mockResolvedValue([]) },
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

  const row = (sourceType: string, type: 'plugin' | 'prompt' = 'plugin', prompt = '/x') => ({
    id: 'x', type, displayName: 'X', description: 'd', tagline: 'd', category: 'development',
    prompt, source: 'marketplace', visibility: 'published', author: 'T', version: '1.0.0',
    components: null, lifeArea: [], tags: [],
    sourceType, sourceRef: 'mcp:x', repoUrl: 'https://github.com/o/r',
    catalog: { itemType: 'tool', origin: { tier: 'community' }, scan: { status: 'unchecked' }, capabilities: [] },
  } as any);

  beforeEach(() => { setupWindowClaude(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('isInstallableSource', () => {
    expect(isInstallableSource(row('url'))).toBe(true);
    expect(isInstallableSource(row('git-subdir'))).toBe(true);
    expect(isInstallableSource(row('local'))).toBe(true);
    expect(isInstallableSource(row('file', 'prompt', 'You are a Jetpack Compose expert…'))).toBe(true);
    expect(isInstallableSource(row('file', 'prompt', ''))).toBe(false);     // a prompt row with no text
    expect(isInstallableSource(row('mcp-registry'))).toBe(false);
    expect(isInstallableSource(row('file'))).toBe(false);
    expect(isInstallableSource({})).toBe(false);                            // unknown source
  });

  it('the card shows no install button for an mcp-registry row', async () => {
    await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: row('mcp-registry') }} onOpen={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('the compact card row shows no install button either', async () => {
    await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: row('mcp-registry') }} onOpen={() => {}} compact />);
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('the card still shows Install for a plugin from git', async () => {
    await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: row('url') }} onOpen={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeNull();
  });

  it('an INSTALLED item keeps Uninstall even though its scanned entry has no sourceType', async () => {
    // The hazard this guards: an installed plugin is described by the locally
    // scanned entry, which carries no sourceType at all. Testing installability
    // before installed-ness would strip Uninstall from every installed item on
    // the machine — and its favorite star on the card.
    const scanned = { ...row('mcp-registry'), catalog: undefined };
    delete (scanned as any).sourceType;
    (globalThis as any).window.claude.skills.listMarketplace.mockResolvedValue([scanned]);
    (globalThis as any).window.claude.skills.list.mockResolvedValue([scanned]);
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open source' })).toBeNull();
  });

  it('the detail overlay offers Open source instead, and says why', async () => {
    // The overlay looks its target up in the marketplace context, so the row has
    // to come back from listMarketplace rather than being handed in directly.
    (globalThis as any).window.claude.skills.listMarketplace.mockResolvedValue([row('mcp-registry')]);
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open source' })).toBeTruthy();
    expect(screen.getByText(/isn't installable from here yet/i)).toBeTruthy();
  });
});

// Three small marketplace fixes that share these files:
//   1. a theme preview whose image fails to load must not leave a blank box
//   2. rails must show that there is more to scroll
//   3. the detail overlay's long description must render markdown, not print it
describe('marketplace small fixes', () => {
  const LONG_DESC = 'A **bold** claim.\n\n- first\n- second';

  const skillRow = (): SkillEntry => ({
    id: 'x',
    displayName: 'Example Plugin',
    description: 'An example',
    tagline: 'An example',
    author: 'Tester',
    category: 'productivity',
    prompt: '/x',
    source: 'marketplace',
    type: 'plugin',
    visibility: 'published',
    version: '1.0.0',
    longDescription: LONG_DESC,
    components: null,
    lifeArea: [],
    tags: [],
  } as any);

  const themeRow = () => ({
    slug: 'devils-garden',
    name: "Devil's Garden",
    description: 'Dark and floral',
    author: 'Tester',
    version: '1.0.0',
    installed: true,
    preview: 'https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/devils-garden/preview.png',
    previewTokens: { canvas: '#221020', accent: '#c0392b', fg: '#eeeeee' },
  } as any);

  function setupWindowClaude() {
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.claude = {
      skills: {
        listMarketplace: vi.fn().mockResolvedValue([skillRow()]),
        list: vi.fn().mockResolvedValue([skillRow()]),
        getFavorites: vi.fn().mockResolvedValue([]),
        getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }),
        install: vi.fn().mockResolvedValue({}),
        uninstall: vi.fn().mockResolvedValue({}),
        setFavorite: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue({ ok: true }),
        publish: vi.fn().mockResolvedValue({ prUrl: '' }),
        getChips: vi.fn().mockResolvedValue([]),
        setChips: vi.fn().mockResolvedValue(undefined),
        setOverride: vi.fn().mockResolvedValue(undefined),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
      marketplace: { getPackages: vi.fn().mockResolvedValue({}) },
      account: {
        start: vi.fn(), poll: vi.fn(),
        signedIn: vi.fn().mockResolvedValue(false),
        user: vi.fn().mockResolvedValue(null),
        signOut: vi.fn().mockResolvedValue(undefined),
        updateProfile: vi.fn().mockResolvedValue({ ok: true }),
        setHandle: vi.fn().mockResolvedValue({ ok: true }),
        deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
      },
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
        marketplace: {
          list: vi.fn().mockResolvedValue([themeRow()]),
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

  async function renderWithProviders(ui: React.ReactElement) {
    let result: ReturnType<typeof render> | undefined;
    await act(async () => {
      result = render(
        <AccountProvider pollIntervalMs={10}>
          <SkillProvider>
            <MarketplaceProvider>
              <MarketplaceStatsProvider>{ui}</MarketplaceStatsProvider>
            </MarketplaceProvider>
          </SkillProvider>
        </AccountProvider>,
      );
    });
    return result!;
  }

  beforeEach(() => {
    setupWindowClaude();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  // 1 — the blank theme previews (ROADMAP: Devil's Garden, Kuromi Dreamer).
  it('a theme preview that fails to load falls back to its colours, not a blank box', async () => {
    const { container } = await renderWithProviders(
      <MarketplaceCard item={{ kind: 'theme', entry: themeRow() }} onOpen={() => {}} installed />,
    );
    const img = container.querySelector('img[src*="preview.png"]') as HTMLImageElement;
    expect(img).toBeTruthy();
    await act(async () => { fireEvent.error(img); });
    expect(container.querySelector('img[src*="preview.png"]')).toBeNull();
    // The card still shows something in that band — the theme's own colours.
    expect(container.querySelector('[data-theme-swatches]')).toBeTruthy();
  });

  it('the compact theme row survives a failed preview too', async () => {
    const { container } = await renderWithProviders(
      <MarketplaceCard item={{ kind: 'theme', entry: themeRow() }} onOpen={() => {}} installed compact />,
    );
    const img = container.querySelector('img[src*="preview.png"]') as HTMLImageElement;
    await act(async () => { fireEvent.error(img); });
    expect(container.querySelector('img[src*="preview.png"]')).toBeNull();
  });

  // 2 — rails clip with no affordance at phone width (P-17 / audit #26).
  it('the rail says there is more to scroll in each direction', async () => {
    render(<MarketplaceRail title="Featured"><div>a</div><div>b</div></MarketplaceRail>);
    const list = screen.getByRole('list');
    // jsdom has no layout, so nothing overflows on mount → no fade.
    expect(list.getAttribute('data-fade')).toBe('none');

    // Fake the metrics of a rail whose content is wider than its box.
    Object.defineProperty(list, 'scrollWidth', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientWidth', { value: 300, configurable: true });
    list.scrollLeft = 0;
    act(() => { fireEvent.scroll(list); });
    expect(list.getAttribute('data-fade')).toBe('right');

    list.scrollLeft = 350;
    act(() => { fireEvent.scroll(list); });
    expect(list.getAttribute('data-fade')).toBe('both');

    list.scrollLeft = 700;
    act(() => { fireEvent.scroll(list); });
    expect(list.getAttribute('data-fade')).toBe('left');
  });

  // 3 — longDescription printed its markdown source instead of rendering it.
  it('the detail overlay renders the long description as markdown', async () => {
    const { container } = await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelectorAll('li').length).toBe(2);
    // The literal source must not be on screen anywhere.
    expect(container.textContent).not.toContain('**bold**');
  });
});

// Pins the Update action end-to-end.
//
// WHY this test exists: the word "Update" was rendered as a plain <span> on
// every card and nowhere else in the app — no click handler, no button, no
// route to `mp.update()`. The main process could update a plugin or a theme;
// a user could not. These tests assert that every surface that SAYS "Update"
// (marketplace card, detail overlay for skills AND themes, the Library
// "Updates" tab) actually calls through, and that a failure shows the real
// message the updater returned instead of a guessed cause.
describe('the Update action is wired to mp.update()', () => {
  // The marketplace row under test: installed at 1.0.0, published at 2.0.0, so
  // the provider's version compare flags it as updatable.
  const skillRow = (): SkillEntry => ({
    id: 'x',
    displayName: 'Example Plugin',
    description: 'An example',
    tagline: 'An example',
    author: 'Tester',
    category: 'productivity',
    prompt: '/x',
    source: 'marketplace',
    type: 'plugin',
    visibility: 'published',
    version: '2.0.0',
    components: null,
    lifeArea: [],
    tags: [],
  } as any);

  const themeRow = () => ({
    slug: 'golden-sunbreak',
    name: 'Golden Sunbreak',
    description: 'Warm',
    author: 'Tester',
    version: '2.0.0',
    installed: true,
  } as any);

  let claudeStub: any;

  function setupWindowClaude() {
    (globalThis as any).window = (globalThis as any).window ?? {};
    claudeStub = {
      skills: {
        listMarketplace: vi.fn().mockResolvedValue([skillRow()]),
        list: vi.fn().mockResolvedValue([skillRow()]),
        getFavorites: vi.fn().mockResolvedValue([]),
        getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }),
        install: vi.fn().mockResolvedValue({}),
        uninstall: vi.fn().mockResolvedValue({}),
        setFavorite: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue({ ok: true }),
        publish: vi.fn().mockResolvedValue({ prUrl: '' }),
        getChips: vi.fn().mockResolvedValue([]),
        setChips: vi.fn().mockResolvedValue(undefined),
        setOverride: vi.fn().mockResolvedValue(undefined),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
      marketplace: {
        // Installed at 1.0.0 for both kinds → updateAvailable is true.
        getPackages: vi.fn().mockResolvedValue({
          x: { version: '1.0.0', source: 'marketplace' },
          'theme:golden-sunbreak': { version: '1.0.0', source: 'marketplace' },
        }),
      },
      account: {
        start: vi.fn(),
        poll: vi.fn(),
        signedIn: vi.fn().mockResolvedValue(false),
        user: vi.fn().mockResolvedValue(null),
        signOut: vi.fn().mockResolvedValue(undefined),
        updateProfile: vi.fn().mockResolvedValue({ ok: true }),
        setHandle: vi.fn().mockResolvedValue({ ok: true }),
        deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
      },
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
        marketplace: {
          list: vi.fn().mockResolvedValue([themeRow()]),
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
    (globalThis as any).window.claude = claudeStub;
  }

  async function renderWithProviders(ui: React.ReactElement) {
    let result: ReturnType<typeof render> | undefined;
    await act(async () => {
      result = render(
        <AccountProvider pollIntervalMs={10}>
          <SkillProvider>
            <MarketplaceProvider>
              <MarketplaceStatsProvider>{ui}</MarketplaceStatsProvider>
            </MarketplaceProvider>
          </SkillProvider>
        </AccountProvider>,
      );
    });
    return result!;
  }

  beforeEach(() => {
    setupWindowClaude();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('the card Update label is a button that calls update()', async () => {
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: skillRow() }} onOpen={() => {}} installed updateAvailable />,
    );
    const btn = screen.getByRole('button', { name: 'Update' });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(claudeStub.skills.update).toHaveBeenCalledWith('x'));
  });

  it('clicking Update does not also open the detail overlay', async () => {
    const onOpen = vi.fn();
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: skillRow() }} onOpen={onOpen} installed updateAvailable />,
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })); });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a theme card updates through the theme path', async () => {
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'theme', entry: themeRow() }} onOpen={() => {}} installed updateAvailable />,
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })); });
    await waitFor(() =>
      expect(claudeStub.theme.marketplace.update).toHaveBeenCalledWith('golden-sunbreak'),
    );
  });

  it('shows the real failure message, not a guess', async () => {
    claudeStub.skills.update.mockResolvedValueOnce({
      ok: false,
      error: "fatal: couldn't find remote ref abc123",
    });
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: skillRow() }} onOpen={() => {}} installed updateAvailable />,
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })); });
    await waitFor(() => expect(screen.getByText(/couldn't find remote ref/i)).toBeTruthy());
  });

  it('the compact card renders Update as a button too', async () => {
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: skillRow() }} onOpen={() => {}} installed updateAvailable compact />,
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })); });
    await waitFor(() => expect(claudeStub.skills.update).toHaveBeenCalledWith('x'));
  });

  it('the skill detail overlay offers Update beside Uninstall', async () => {
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Update' });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(claudeStub.skills.update).toHaveBeenCalledWith('x'));
  });

  it('the theme detail overlay offers Update — no uninstall-then-reinstall dance', async () => {
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'theme', slug: 'golden-sunbreak' }} onClose={() => {}} />,
    );
    const btn = screen.getByRole('button', { name: 'Update' });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() =>
      expect(claudeStub.theme.marketplace.update).toHaveBeenCalledWith('golden-sunbreak'),
    );
  });

  it('the Library Updates tab can actually update', async () => {
    await renderWithProviders(<LibraryScreen onExit={() => {}} initialTab="updates" />);
    const buttons = screen.getAllByRole('button', { name: 'Update' });
    expect(buttons.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(buttons[0]); });
    await waitFor(() => expect(claudeStub.skills.update).toHaveBeenCalled());
  });
});
