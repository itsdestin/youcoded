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
// WHY ArtifactProvider: the screen's band (ScreenBand, decisions "Full-screen titles") holds the
// header's Pages / Projects buttons, which read the artifact store.
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';

/** Each fact chip's words, with the number and word spaced as they read. */
function chipTexts(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('[data-chip]')).map((el) =>
    Array.from(el.childNodes).map((n) => n.textContent ?? '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());
}

// WHY: sections once ran as separate files with an empty /stats cache and the environment's own fetch; one replaces
// globalThis.fetch and fills the cache, so put both back.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetStatsCacheForTests();
});

const ok = { ok: false };
/** The window.claude every section needs; a section passes only the rows it is about. */
function setupClaude(o: { marketplace?: unknown[]; installed?: unknown[]; themes?: unknown[]; packages?: object; skillUpdate?: object } = {}) {
  const resolved = (v: unknown) => vi.fn().mockResolvedValue(v);
  const stub = {
    skills: {
      listMarketplace: resolved(o.marketplace ?? []), list: resolved(o.installed ?? []), getFavorites: resolved([]),
      getFeatured: resolved({ hero: [], rails: [] }), install: resolved({}), uninstall: resolved({}), setFavorite: resolved(undefined),
      update: resolved(o.skillUpdate ?? { ok: true }), publish: resolved({ prUrl: '' }),
      // SkillProvider boot path.
      getChips: resolved([]), setChips: resolved(undefined), setOverride: resolved(undefined), getCuratedDefaults: resolved([]),
    },
    marketplace: { getPackages: resolved(o.packages ?? {}) },
    account: {
      start: vi.fn(), poll: vi.fn(), signedIn: resolved(false), user: resolved(null), signOut: resolved(undefined),
      updateProfile: resolved({ ok: true }), setHandle: resolved({ ok: true }), deleteAccount: resolved({ ok: true }),
    },
    marketplaceApi: {
      install: resolved({ ok: true }), myThumb: resolved(ok), thumb: resolved(ok), comment: resolved(ok),
      comments: resolved(ok), likeTheme: resolved(ok), report: resolved(ok),
    },
    theme: {
      list: resolved([]),
      marketplace: { list: resolved(o.themes ?? []), install: resolved(undefined), uninstall: resolved(undefined), update: resolved({ ok: true }) },
    },
    appearance: { getFavoriteThemes: resolved([]), favoriteTheme: resolved(undefined) },
  };
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = stub;
  return stub;
}

// WHY the providers: MarketplaceProvider calls useSkills() after install/update, and the Library band reads accounts.
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

/** Every section starts with fresh stubs and no console noise. */
function useCleanStubs() {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
}

const clickUpdate = async (name = 'Update') => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };

describe('MarketplaceCard compact variant', () => {
  useCleanStubs();
  beforeEach(() => { setupClaude(); });
  const sampleSkill: SkillEntry = {
    id: 'sample-skill', displayName: 'Sample Skill', description: 'A sample', tagline: 'Quick description', author: 'Tester',
    category: 'productivity', prompt: '/sample', source: 'marketplace', type: 'plugin', visibility: 'published',
    // Without a sourceType the card (correctly) hides Install; see 'rows the installer cannot install'.
    sourceType: 'url', sourceRef: 'https://github.com/o/r.git', components: null, lifeArea: [], tags: [],
  } as any;

  it('renders the wide layout with the Install corner when compact is unset', async () => {
    const { container, queryByLabelText } = await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: sampleSkill }} onOpen={() => {}} />);
    expect(queryByLabelText('Install')).not.toBeNull();
    expect((container.querySelector('[data-marketplace-card]') as HTMLElement).getAttribute('data-marketplace-card')).toBe('sample-skill');
  });

  it('renders the compact list row with an inline Install (not the corner), title and tagline', async () => {
    const { container, queryByLabelText, getByText } = await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: sampleSkill }} onOpen={() => {}} compact />);
    expect(container.querySelector('[data-marketplace-card-compact]')?.getAttribute('data-marketplace-card-compact')).toBe('true');
    expect(getByText('Sample Skill')).toBeTruthy();
    expect(getByText('Quick description')).toBeTruthy();
  });

  it('inline Install click does not also open detail (stopPropagation)', async () => {
    const onOpen = vi.fn();
    const { getByLabelText } = await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: sampleSkill }} onOpen={onOpen} compact />);
    getByLabelText('Install').click();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// Regression: the card read the count from stats.plugins only, which holds nothing for a theme, so a theme's row was always hidden.
describe('MarketplaceCard theme download count', () => {
  useCleanStubs();
  beforeEach(() => { setupClaude(); });
  const sampleTheme = { slug: 'ocean-depths', name: 'Ocean Depths', description: 'Deep blue', author: 'Tester', version: '1.0.0', manifestUrl: 'https://example.com/manifest.json', installed: false } as any;
  async function chipsFor(themeStats: object) {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ generated_at: Date.now(), plugins: {}, themes: { 'ocean-depths': themeStats } }) });
    const { container } = await renderWithProviders(<MarketplaceCard item={{ kind: 'theme', entry: sampleTheme }} onOpen={() => {}} />);
    return chipTexts(container);
  }

  it("shows the theme's install count from stats.themes", async () => {
    expect(await chipsFor({ likes: 3, installs: 412 })).toContain('412 installs');
  });

  it.each([['no installs yet', { likes: 3, installs: 0 }], ['an older Worker with no installs field', { likes: 3 }]])('shows no install chip for %s, and the likes chip still renders', async (_t, stats) => {
    const chips = await chipsFor(stats);
    expect(chips.some((t) => t.includes('install'))).toBe(false);
    expect(chips).toContain('3 likes');
  });
});

// WHY: the catalog lists things the installer cannot take (MCP-registry connections, single-file rows); a green Install on them
// could only fail. A prompt-typed row installs only when its text travels in the row (193 mirrored "instructions" rows have none).
describe('rows the installer cannot install', () => {
  useCleanStubs();

  const row = (sourceType: string, type: 'plugin' | 'prompt' = 'plugin', prompt = '/x') => ({
    id: 'x', type, displayName: 'X', description: 'd', tagline: 'd', category: 'development',
    prompt, source: 'marketplace', visibility: 'published', author: 'T', version: '1.0.0',
    components: null, lifeArea: [], tags: [],
    sourceType, sourceRef: 'mcp:x', repoUrl: 'https://github.com/o/r',
    catalog: { itemType: 'tool', origin: { tier: 'community' }, scan: { status: 'unchecked' }, capabilities: [] },
  } as any);

  it.each([
    [row('url'), true], [row('git-subdir'), true], [row('local'), true],
    [row('file', 'prompt', 'You are a Jetpack Compose expert…'), true],
    [row('file', 'prompt', ''), false],   // a prompt row with no text
    [row('mcp-registry'), false], [row('file'), false],
    [{}, false],                           // unknown source
  ])('isInstallableSource(%#) is %s', (entry, expected) => { expect(isInstallableSource(entry)).toBe(expected); });

  it.each([['wide', false], ['compact', true]])('the %s card shows no install button for an mcp-registry row', async (_t, compact) => {
    setupClaude();
    await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: row('mcp-registry') }} onOpen={() => {}} compact={compact} />);
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('the card still shows Install for a plugin from git', async () => {
    setupClaude();
    await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: row('url') }} onOpen={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeNull();
  });

  it('an INSTALLED item keeps Uninstall even though its scanned entry has no sourceType', async () => {
    // WHY: an installed plugin's locally scanned entry has no sourceType; checking installability before installed-ness would strip Uninstall everywhere.
    const scanned = { ...row('mcp-registry'), catalog: undefined };
    delete (scanned as any).sourceType;
    setupClaude({ marketplace: [scanned], installed: [scanned] });
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open source' })).toBeNull();
  });

  it('the detail overlay offers Open source instead, and says why', async () => {
    setupClaude({ marketplace: [row('mcp-registry')] });  // the overlay looks its target up in the context
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open source' })).toBeTruthy();
    expect(screen.getByText(/isn't installable from here yet/i)).toBeTruthy();
  });
});

// Small fixes: a failed theme preview must not leave a blank box, rails must show there is more to scroll,
// and the overlay's long description must render markdown rather than print it.
describe('marketplace small fixes', () => {
  useCleanStubs();
  const skillRow = (): SkillEntry => ({
    id: 'x', displayName: 'Example Plugin', description: 'An example', tagline: 'An example', author: 'Tester', category: 'productivity',
    prompt: '/x', source: 'marketplace', type: 'plugin', visibility: 'published', version: '1.0.0',
    longDescription: 'A **bold** claim.\n\n- first\n- second', components: null, lifeArea: [], tags: [],
  } as any);
  const themeRow = () => ({
    slug: 'devils-garden', name: "Devil's Garden", description: 'Dark and floral', author: 'Tester', version: '1.0.0', installed: true,
    preview: 'https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/devils-garden/preview.png',
    previewTokens: { canvas: '#221020', accent: '#c0392b', fg: '#eeeeee' },
  } as any);
  beforeEach(() => { setupClaude({ marketplace: [skillRow()], installed: [skillRow()], themes: [themeRow()] }); });

  it.each([['wide', false], ['compact', true]])('a %s theme preview that fails to load falls back to its colours, not a blank box', async (_t, compact) => {
    const { container } = await renderWithProviders(
      <MarketplaceCard item={{ kind: 'theme', entry: themeRow() }} onOpen={() => {}} installed compact={compact} />,
    );
    const img = container.querySelector('img[src*="preview.png"]') as HTMLImageElement;
    expect(img).toBeTruthy();
    await act(async () => { fireEvent.error(img); });
    expect(container.querySelector('img[src*="preview.png"]')).toBeNull();
    if (!compact) expect(container.querySelector('[data-theme-swatches]')).toBeTruthy();
  });

  it('the detail overlay renders the long description as markdown', async () => {
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    // The shared popup (Dialog) renders into document.body, not the test container.
    const page = document.body;
    expect(page.querySelector('strong')?.textContent).toBe('bold');
    expect(page.querySelectorAll('li').length).toBe(2);
    // The literal source must not be on screen anywhere.
    expect(page.textContent).not.toContain('**bold**');
  });
});

// WHY: "Update" was once a plain <span> on every card with no route to mp.update(). Every surface that says it must call through,
// and a failure must show the updater's real message.
describe('the Update action is wired to mp.update()', () => {
  useCleanStubs();
  // Installed at 1.0.0 and published at 2.0.0, so the provider flags both as updatable.
  const skillRow = (): SkillEntry => ({
    id: 'x', displayName: 'Example Plugin', description: 'An example', tagline: 'An example', author: 'Tester', category: 'productivity',
    prompt: '/x', source: 'marketplace', type: 'plugin', visibility: 'published', version: '2.0.0', components: null, lifeArea: [], tags: [],
  } as any);
  const themeRow = () => ({ slug: 'golden-sunbreak', name: 'Golden Sunbreak', description: 'Warm', author: 'Tester', version: '2.0.0', installed: true } as any);
  let claudeStub: any;
  beforeEach(() => {
    claudeStub = setupClaude({
      marketplace: [skillRow()], installed: [skillRow()], themes: [themeRow()],
      packages: { x: { version: '1.0.0', source: 'marketplace' }, 'theme:golden-sunbreak': { version: '1.0.0', source: 'marketplace' } },
    });
  });

  it.each([['wide', false], ['compact', true]])('the %s card Update label is a button that calls update() without opening the detail', async (_t, compact) => {
    const onOpen = vi.fn();
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: skillRow() }} onOpen={onOpen} installed updateAvailable compact={compact} />,
    );
    await clickUpdate();
    await waitFor(() => expect(claudeStub.skills.update).toHaveBeenCalledWith('x'));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a theme card updates through the theme path', async () => {
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'theme', entry: themeRow() }} onOpen={() => {}} installed updateAvailable />,
    );
    await clickUpdate();
    await waitFor(() => expect(claudeStub.theme.marketplace.update).toHaveBeenCalledWith('golden-sunbreak'));
  });

  it('shows the real failure message, not a guess', async () => {
    claudeStub.skills.update.mockResolvedValueOnce({
      ok: false,
      error: "fatal: couldn't find remote ref abc123",
    });
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: skillRow() }} onOpen={() => {}} installed updateAvailable />,
    );
    await clickUpdate();
    await waitFor(() => expect(screen.getByText(/couldn't find remote ref/i)).toBeTruthy());
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
    await renderWithProviders(<ArtifactProvider value={{ state: initialArtifactState, dispatch: () => {} }}><LibraryScreen onExit={() => {}} settingsOpen={false} onToggleSettings={() => {}} initialTab="updates" /></ArtifactProvider>);
    const buttons = screen.getAllByRole('button', { name: 'Update' });
    expect(buttons.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(buttons[0]); });
    await waitFor(() => expect(claudeStub.skills.update).toHaveBeenCalled());
  });
});
