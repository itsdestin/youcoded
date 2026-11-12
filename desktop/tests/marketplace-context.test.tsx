// @vitest-environment jsdom
// marketplace-context — MarketplaceProvider's install / uninstall / update
// bookkeeping: progress keys, install telemetry, the SkillContext refresh after
// a mutation, update detection, and the footer that reports each operation.
// Its fetch-on-demand behaviour lives in marketplace-context-fetch-on-demand.test.tsx
// (WHY a second file: that one replaces theme-context with a file-wide vi.mock,
// which this file's sections use for real).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';
import MarketplaceCard from '../src/renderer/components/marketplace/MarketplaceCard';
import InstallingFooterStrip from '../src/renderer/components/marketplace/InstallingFooterStrip';
import {
  MarketplaceProvider,
  installTrackingKey,
  useMarketplace,
} from '../src/renderer/state/marketplace-context';
import {
  MarketplaceStatsProvider,
  __resetStatsCacheForTests,
} from '../src/renderer/state/marketplace-stats-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import type { SkillEntry } from '../src/shared/types';
import { themeFingerprint } from '../src/shared/theme-fingerprint';

// WHY: each section below was its own file, so each started with an empty
// /stats cache and the environment's own fetch; put both back after every case.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetStatsCacheForTests();
});

// Regression: the card asked installingIds for a BARE id while the context records `skill:<id>`, so a plugin install showed no
// "Installing…". Writer and every reader must derive the key from `installTrackingKey`.
describe('install progress key parity', () => {
  // Held open so the install stays "in flight" while we assert on the card.
  let releaseInstall: (() => void) | undefined;
  let releaseThemeInstall: (() => void) | undefined;

  function setupWindowClaude() {
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.claude = {
      skills: {
        listMarketplace: vi.fn().mockResolvedValue([]),
        list: vi.fn().mockResolvedValue([]),
        getFavorites: vi.fn().mockResolvedValue([]),
        getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }),
        install: vi.fn(
          () => new Promise<any>(resolve => { releaseInstall = () => resolve({ status: 'installed', type: 'plugin' }); }),
        ),
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
          install: vi.fn(
            () => new Promise<any>(resolve => { releaseThemeInstall = () => resolve({ status: 'installed' }); }),
          ),
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
        <SkillProvider>
          <MarketplaceProvider>
            <MarketplaceStatsProvider>{ui}</MarketplaceStatsProvider>
          </MarketplaceProvider>
        </SkillProvider>,
      );
    });
    return result!;
  }

  beforeEach(() => {
    setupWindowClaude();
    releaseInstall = undefined;
    releaseThemeInstall = undefined;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Let any in-flight install settle so React isn't left updating after unmount.
    releaseInstall?.();
    releaseThemeInstall?.();
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows "Installing…" on a plugin card while its install is in flight', async () => {
    const { queryByLabelText, findByText } = await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: sampleSkill }} onOpen={() => {}} />,
    );

    const installBtn = queryByLabelText('Install');
    expect(installBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(installBtn!);
    });

    // The install promise is still pending — the card must say so.
    expect(await findByText('Installing…')).not.toBeNull();
  });

  // A theme card carries no Install button until it is installed (themes are
  // installed from the detail overlay), so the theme half is checked one level
  // down: the key the context marks must be the key the readers ask for.
  it('marks the same key the readers ask for, for both kinds', async () => {
    let seen: string[] = [];
    let api: any;

    function Probe() {
      const mp = useMarketplace();
      api = mp;
      seen = Array.from(mp.installingIds);
      return null;
    }

    await renderWithProviders(<Probe />);

    let pending: Promise<void>;
    await act(async () => {
      pending = api.installSkill('sample-skill');
    });
    expect(seen).toContain(installTrackingKey('skill', 'sample-skill'));
    await act(async () => { releaseInstall?.(); await pending; });

    await act(async () => {
      pending = api.installTheme('sample-theme');
    });
    expect(seen).toContain(installTrackingKey('theme', 'sample-theme'));
    await act(async () => { releaseThemeInstall?.(); await pending; });
  });

  // The shape of the key itself is load-bearing beyond the card:
  // InstallingFooterStrip splits on the `skill:` / `theme:` prefix to decide
  // which registry to look the display name up in. Bare ids would render as
  // raw slugs there.
  it('builds prefixed keys for both kinds', () => {
    expect(installTrackingKey('skill', 'sample-skill')).toBe('skill:sample-skill');
    expect(installTrackingKey('theme', 'sample-theme')).toBe('theme:sample-theme');
  });
});

// WHY: themes report under a `theme:<slug>` plugin id; without the telemetry call the installs table holds no theme rows and a
// theme's download count reads 0 forever. Telemetry failures must never surface to the caller.
describe('install telemetry', () => {
  function makeMock({ signedIn = true, telemetryReject = false, themeInstallFails = false } = {}) {
    const resolved = (v: unknown) => vi.fn().mockResolvedValue(v);
    return {
      skills: {
        install: resolved({ status: 'installed', type: 'plugin' }), uninstall: resolved({ type: 'plugin' }), list: resolved([]),
        listMarketplace: resolved([]), getFavorites: resolved([]), getChips: resolved([]), getCuratedDefaults: resolved([]),
        update: resolved({ ok: true }), setFavorite: resolved(undefined), publish: resolved({ prUrl: 'http://example.com/pr/1' }),
      },
      marketplace: { getPackages: resolved({}) },
      account: { signedIn: resolved(signedIn) },
      marketplaceApi: { install: telemetryReject ? vi.fn().mockRejectedValue(new Error('Worker down')) : resolved({ ok: true }) },
      theme: {
        marketplace: {
          list: resolved([]),
          // theme-marketplace:install resolves { status } rather than throwing, so telemetry has to read the status.
          install: resolved(themeInstallFails ? { status: 'failed', error: 'Theme not found in registry' } : { status: 'installed' }),
          uninstall: resolved(undefined), update: resolved({ ok: true }),
        },
      },
      appearance: { getFavoriteThemes: resolved([]), favoriteTheme: resolved(undefined) },
    };
  }

  /** Mounts the real providers and hands back the two install functions. */
  async function mount(mock: ReturnType<typeof makeMock>) {
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.claude = mock;
    let fns!: { installSkill: (id: string) => Promise<void>; installTheme: (slug: string) => Promise<void> };
    function Probe() { fns = useMarketplace(); return null; }
    render(<SkillProvider><MarketplaceProvider><Probe /></MarketplaceProvider></SkillProvider>);
    await act(async () => {});
    return fns;
  }

  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('fires marketplaceApi.install() after a successful local install when signed in', async () => {
    const mock = makeMock();
    const { installSkill } = await mount(mock);
    await act(async () => { await installSkill('my-plugin'); });
    expect(mock.skills.install).toHaveBeenCalledWith('my-plugin');
    expect(mock.account.signedIn).toHaveBeenCalled();
    expect(mock.marketplaceApi.install).toHaveBeenCalledWith('my-plugin');
  });

  it('skips telemetry when signed out, for plugins and themes', async () => {
    const mock = makeMock({ signedIn: false });
    const { installSkill, installTheme } = await mount(mock);
    await act(async () => { await installSkill('my-plugin'); await installTheme('ocean-depths'); });
    expect(mock.skills.install).toHaveBeenCalledWith('my-plugin');
    expect(mock.theme.marketplace.install).toHaveBeenCalledWith('ocean-depths');
    expect(mock.marketplaceApi.install).not.toHaveBeenCalled();
  });

  it('resolves successfully even when telemetry rejects (non-fatal), and logs a warning for plugins', async () => {
    const mock = makeMock({ telemetryReject: true });
    const { installSkill } = await mount(mock);
    await act(async () => { await expect(installSkill('my-plugin')).resolves.toBeUndefined(); });
    expect(mock.skills.install).toHaveBeenCalledWith('my-plugin');
    expect(mock.marketplaceApi.install).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('[marketplace] install telemetry threw'), expect.any(Error));
  });

  it("fires marketplaceApi.install('theme:<slug>') after a successful theme install", async () => {
    const mock = makeMock();
    const { installTheme } = await mount(mock);
    await act(async () => { await installTheme('ocean-depths'); });
    expect(mock.theme.marketplace.install).toHaveBeenCalledWith('ocean-depths');
    expect(mock.marketplaceApi.install).toHaveBeenCalledWith('theme:ocean-depths');
  });

  it('records nothing when the theme did not actually install, and reports the failure', async () => {
    const mock = makeMock({ themeInstallFails: true });
    const { installTheme } = await mount(mock);
    // WHY: the provider once resolved quietly on { status: 'failed' }, so a theme that never landed looked like nothing happened.
    await act(async () => { await expect(installTheme('ocean-depths')).rejects.toThrow('Theme not found in registry'); });
    expect(mock.marketplaceApi.install).not.toHaveBeenCalled();
    expect(mock.appearance.favoriteTheme).not.toHaveBeenCalled(); // not starred either
  });

  it('still resolves when theme telemetry rejects (non-fatal)', async () => {
    const mock = makeMock({ telemetryReject: true });
    const { installTheme } = await mount(mock);
    await act(async () => { await expect(installTheme('ocean-depths')).resolves.toBeUndefined(); });
    expect(mock.marketplaceApi.install).toHaveBeenCalledWith('theme:ocean-depths');
  });
});

// WHY: without the SkillContext.refreshInstalled() wiring, marketplace installs would not appear in the drawer until restart.
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
      account: { signedIn: vi.fn(async () => false) },
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

  // After a mutation exactly ONE skills.list runs: SkillContext.refreshInstalled() (the marketplace keeps no copy of the installed list).
  it.each([['installSkill', 'installCalls'], ['uninstallSkill', null]] as const)('calls skills.list once more after %s', async (fn, counter) => {
    let run: ((id: string) => Promise<void>) | null = null;
    function Probe() { run = useMarketplace()[fn]; return null; }
    render(<SkillProvider><MarketplaceProvider><Probe /></MarketplaceProvider></SkillProvider>);
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const baseline = listCalls;
    await act(async () => { await run!('foo'); });
    expect(listCalls).toBe(baseline + 1);
    if (counter) expect(installCalls).toBe(1);
  });
});

// WHY: version numbers alone miss repos whose authors never bump them, so the app also compares the installed commit with the
// catalog's; the two checks stay separate and are OR'd.
describe('updateAvailable: version OR commit', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'x', displayName: 'Example', description: 'd', tagline: 'd', author: 'T',
    category: 'productivity', prompt: '/x', source: 'marketplace', type: 'plugin',
    visibility: 'published', version: '1.0.0', components: null, lifeArea: [], tags: [],
    ...over,
  } as any);

  let packages: Record<string, any>;
  let entries: any[];

  function setupWindowClaude() {
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.claude = {
      skills: {
        listMarketplace: vi.fn(async () => entries),
        list: vi.fn(async () => []),
        getFavorites: vi.fn(async () => []),
        getFeatured: vi.fn(async () => ({ hero: [], rails: [] })),
        install: vi.fn(), uninstall: vi.fn(), setFavorite: vi.fn(), update: vi.fn(),
        publish: vi.fn(), getChips: vi.fn(async () => []), setChips: vi.fn(),
        setOverride: vi.fn(), getCuratedDefaults: vi.fn(async () => []),
      },
      marketplace: { getPackages: vi.fn(async () => packages) },
      theme: { marketplace: { list: vi.fn(async () => []), install: vi.fn(), uninstall: vi.fn(), update: vi.fn() } },
      appearance: { getFavoriteThemes: vi.fn(async () => []) },
    };
  }

  let seen: Record<string, boolean> = {};
  function Probe() {
    seen = useMarketplace().updateAvailable;
    return null;
  }

  async function readUpdateAvailable() {
    await act(async () => {
      render(<SkillProvider><MarketplaceProvider><Probe /></MarketplaceProvider></SkillProvider>);
    });
    return seen;
  }

  const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  beforeEach(() => { setupWindowClaude(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const catalogCommit = (sourceCommit: string) => ({ catalog: { itemType: 'plugin', origin: { tier: 'community' }, scan: { status: 'unchecked' }, capabilities: [], sourceCommit } });

  // Packages installed before commits were recorded have no `commit`: treating "missing" as "different" would badge the whole library.
  // A row that lost its catalog block (Worker outage -> index.json fallback) must not read as "downgraded".
  it.each([
    ['flags a newer version, as it always did', { version: '2.0.0' }, { version: '1.0.0' }, true],
    ['flags a moved commit even when the version never changed', catalogCommit(NEW), { version: '1.0.0', commit: OLD }, true],
    ['says nothing when both the version and the commit match', catalogCommit(OLD), { version: '1.0.0', commit: OLD }, false],
    ['never badges an install made before commits were recorded', catalogCommit(NEW), { version: '1.0.0' }, false],
    ['says nothing when the catalog lists no commit for an install that has one', {}, { version: '1.0.0', commit: OLD }, false],
  ])('%s', async (_t, rowOver, pkg, flagged) => {
    entries = [row(rowOver)];
    packages = { x: { source: 'marketplace', ...pkg } };
    expect((await readUpdateAvailable()).x).toBe(flagged ? true : undefined);
  });
});

// Pins when a THEME shows Update (marketplace-context.tsx, the themeEntries loop).
// WHY: a theme edited in place with no version bump (Morning Rounds) never offered Update. The
// store's file list is now stamped at install time (shared/theme-fingerprint.ts), and a different
// stamp means "the files changed". Every "stay quiet" case below is one where guessing would
// put a false Update badge on someone's library.
describe('theme updateAvailable: version OR changed files', () => {
  const FH_A = themeFingerprint({ fileHashes: { 'manifest.json': 'aa', 'assets/m.svg': 'bb' } })!;
  const FH_B = themeFingerprint({ fileHashes: { 'manifest.json': 'aa', 'assets/m.svg': 'cc' } })!;
  const themeRow = (over: Record<string, unknown> = {}) => ({
    slug: 't', name: 'T', author: 'a', dark: false, source: 'community', features: [],
    manifestUrl: '', version: '1.0.0', ...over,
  } as any);

  let packages: Record<string, any>;
  let themes: any[];

  function setupWindowClaude() {
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.claude = {
      skills: {
        listMarketplace: vi.fn(async () => []), list: vi.fn(async () => []),
        getFavorites: vi.fn(async () => []), getFeatured: vi.fn(async () => ({ hero: [], rails: [] })),
        install: vi.fn(), uninstall: vi.fn(), setFavorite: vi.fn(), update: vi.fn(), publish: vi.fn(),
        getChips: vi.fn(async () => []), setChips: vi.fn(), setOverride: vi.fn(),
        getCuratedDefaults: vi.fn(async () => []),
      },
      marketplace: { getPackages: vi.fn(async () => packages) },
      theme: { marketplace: { list: vi.fn(async () => themes), install: vi.fn(), uninstall: vi.fn(), update: vi.fn() } },
      appearance: { getFavoriteThemes: vi.fn(async () => []) },
    };
  }

  let seen: Record<string, boolean> = {};
  function Probe() { seen = useMarketplace().updateAvailable; return null; }
  async function read() {
    await act(async () => {
      render(<SkillProvider><MarketplaceProvider><Probe /></MarketplaceProvider></SkillProvider>);
    });
    return seen;
  }
  const pkg = (over: Record<string, unknown> = {}) => ({ version: '1.0.0', source: 'marketplace', ...over });

  beforeEach(() => { setupWindowClaude(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows Update when the listed file stamp differs from the recorded one', async () => {
    themes = [themeRow({ fileHashes: { 'manifest.json': 'aa', 'assets/m.svg': 'cc' } })];
    packages = { 'theme:t': pkg({ themeFingerprint: FH_A }) };
    expect((await read()).t).toBe(true);
    expect(FH_A).not.toBe(FH_B);
  });

  it('says nothing when the stamp is unchanged', async () => {
    themes = [themeRow({ fileHashes: { 'assets/m.svg': 'bb', 'manifest.json': 'aa' } })];
    packages = { 'theme:t': pkg({ themeFingerprint: FH_A }) };
    expect((await read()).t).toBeUndefined();
  });

  it('says nothing for an install made before stamps were recorded', async () => {
    themes = [themeRow({ fileHashes: { 'manifest.json': 'aa', 'assets/m.svg': 'cc' } })];
    packages = { 'theme:t': pkg() };
    expect((await read()).t).toBeUndefined();
  });

  it('says nothing when the listed entry carries no hashes', async () => {
    themes = [themeRow()];
    packages = { 'theme:t': pkg({ themeFingerprint: FH_A }) };
    expect((await read()).t).toBeUndefined();
  });

  it('says nothing when the evidence kind changed (recorded contentHash, now listed fileHashes)', async () => {
    themes = [themeRow({ fileHashes: { 'manifest.json': 'aa' } })];
    packages = { 'theme:t': pkg({ themeFingerprint: 'ch:sha256:abc' }) };
    expect((await read()).t).toBeUndefined();
  });

  it('still shows Update for a newer version when no stamp was recorded', async () => {
    themes = [themeRow({ version: '1.1.0' })];
    packages = { 'theme:t': pkg() };
    expect((await read()).t).toBe(true);
  });
});

// WHY: the footer once printed every failure as "Failed to install", counted a failed post-install refresh as a failed install,
// and ignored failures that come back as an ANSWER ({ status: 'failed' } / { ok: false }), still posting install telemetry.
describe('InstallingFooterStrip — the words match the operation and its result', () => {
  let lastAction: Promise<unknown> = Promise.resolve();
  let listFails = false;

  function setupWindowClaude(overrides: { install?: any; uninstall?: any; update?: any; signedIn?: boolean } = {}) {
    listFails = false;
    (window as any).claude = {
      skills: {
        listMarketplace: vi.fn().mockResolvedValue([{ id: 'notes', displayName: 'Notes', type: 'plugin' }]),
        // Every list after `listFails` flips rejects — the refresh that follows a mutation.
        list: vi.fn(() => (listFails ? Promise.reject(new Error('list unavailable')) : Promise.resolve([]))),
        getFavorites: vi.fn().mockResolvedValue([]),
        getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }),
        install: overrides.install ?? vi.fn().mockResolvedValue({ status: 'installed', type: 'plugin' }),
        uninstall: overrides.uninstall ?? vi.fn().mockResolvedValue({ type: 'plugin' }),
        update: overrides.update ?? vi.fn().mockResolvedValue({ ok: true }),
        setFavorite: vi.fn().mockResolvedValue(undefined),
        getChips: vi.fn().mockResolvedValue([]),
        setChips: vi.fn().mockResolvedValue(undefined),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
      marketplace: { getPackages: vi.fn().mockResolvedValue({}) },
      account: { signedIn: vi.fn().mockResolvedValue(overrides.signedIn ?? false) },
      marketplaceApi: { install: vi.fn().mockResolvedValue({ ok: true }) },
      theme: { marketplace: { list: vi.fn().mockResolvedValue([]) } },
      appearance: { getFavoriteThemes: vi.fn().mockResolvedValue([]), favoriteTheme: vi.fn().mockResolvedValue(undefined) },
    };
    return (window as any).claude;
  }

  function Actions() {
    const mp = useMarketplace();
    // The provider re-throws a failed mutation to its caller; swallow it here so the
    // test observes what the USER sees, which is the footer.
    const run = (p: () => Promise<unknown>) => () => { lastAction = p().catch(() => {}); };
    return (
      <>
        <button onClick={run(() => mp.installSkill('notes'))}>install</button>
        <button onClick={run(() => mp.uninstallSkill('notes'))}>uninstall</button>
        <button onClick={run(() => mp.update('notes', 'skill'))}>update</button>
        <InstallingFooterStrip />
      </>
    );
  }

  async function renderFooter() {
    await act(async () => {
      render(<SkillProvider><MarketplaceProvider><Actions /></MarketplaceProvider></SkillProvider>);
    });
  }

  async function press(name: string) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name })); await lastAction; });
  }

  afterEach(() => { cleanup(); delete (window as any).claude; });

  it('a failed uninstall is reported as an uninstall, without the transport wrapper', async () => {
    setupWindowClaude({ uninstall: vi.fn().mockRejectedValue(new Error("Error invoking remote method 'skills:uninstall': Error: EBUSY: resource busy")) });
    await renderFooter();
    await press('uninstall');

    expect(screen.getByText(/couldn.t uninstall Notes/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed to install/i)).toBeNull();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
  });

  it('a failed update is reported as an update', async () => {
    setupWindowClaude({ update: vi.fn().mockRejectedValue(new Error('git clone failed: repository not found')) });
    await renderFooter();
    await press('update');

    expect(screen.getByText(/couldn.t update Notes/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed to install/i)).toBeNull();
  });

  it('an install that ANSWERED failed is shown as failed, and is not counted as a download', async () => {
    const claude = setupWindowClaude({
      install: vi.fn().mockResolvedValue({ status: 'failed', error: 'git clone failed: repository not found', type: 'plugin' }),
      signedIn: true,
    });
    await renderFooter();
    await press('install');

    expect(screen.getByText(/couldn.t install Notes: git clone failed/i)).toBeInTheDocument();
    expect(claude.marketplaceApi.install).not.toHaveBeenCalled();
  });

  it('an install that worked is not reported as failed because the refresh after it failed', async () => {
    setupWindowClaude();
    await renderFooter();
    listFails = true;
    await press('install');

    expect(screen.queryByText(/couldn.t install/i)).toBeNull();
    expect(screen.queryByText(/failed to install/i)).toBeNull();
  });

  // A failure used to clear itself after 6 seconds, taking its reason with it — the detail
  // page then showed a plain Install button as if nothing had happened (2026-10-05).
  it('a failed install stays until it is dismissed, however long it is left', async () => {
    setupWindowClaude({ install: vi.fn().mockResolvedValue({ status: 'failed', error: 'repository not found', type: 'plugin' }) });
    await renderFooter();
    // Fake timers BEFORE the failure, so any timer it schedules is one this test controls.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await press('install');
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(screen.getByText(/couldn.t install Notes: repository not found/i)).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(screen.queryByText(/couldn.t install Notes/i)).toBeNull();
  });

  it('trying again puts the old failure away', async () => {
    const install = vi.fn()
      .mockResolvedValueOnce({ status: 'failed', error: 'repository not found', type: 'plugin' })
      .mockImplementationOnce(() => new Promise(() => {}));
    setupWindowClaude({ install });
    await renderFooter();
    await press('install');
    expect(screen.getByText(/couldn.t install Notes/i)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'install' })); });
    expect(screen.queryByText(/couldn.t install Notes/i)).toBeNull();
  });

  it('an uninstall in progress says "Uninstalling", not "Installing"', async () => {
    setupWindowClaude({ uninstall: vi.fn(() => new Promise(() => {})) });
    await renderFooter();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'uninstall' })); });

    expect(screen.getByText(/uninstalling/i)).toBeInTheDocument();
    expect(screen.queryByText(/^\s*installing/i)).toBeNull();
  });
});
