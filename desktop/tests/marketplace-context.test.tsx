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

// WHY: each section below was its own file, so each started with an empty
// /stats cache and the environment's own fetch; put both back after every case.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetStatsCacheForTests();
});

// Bug: MarketplaceCard asked `installingIds` for a BARE marketplace id while
// marketplace-context records progress under `skill:<id>`. The two strings can
// never be equal, so a plugin install showed no "Installing…" state at all.
// Themes hid the bug because both sides already agreed on `theme:<slug>`.
//
// These tests pin the two halves together: the writer (the context) and every
// reader (the card, the detail overlay, the footer strip) must derive the key
// from the same helper — `installTrackingKey` in marketplace-context.
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

// Verifies that installSkill() and installTheme() fire POST /installs telemetry
// after a successful local install and that telemetry failures never surface to
// the caller. Themes report under a `theme:<slug>` plugin id; without
// this call the installs table holds zero theme rows and a theme's download
// count would read 0 forever.
describe('install telemetry', () => {
  // ── Probe ──────────────────────────────────────────────────────────────────────

  function Probe({
    onInstall,
    onInstallTheme,
  }: {
    onInstall?: (fn: (id: string) => Promise<void>) => void;
    onInstallTheme?: (fn: (slug: string) => Promise<void>) => void;
  }) {
    const { installSkill, installTheme } = useMarketplace();
    React.useEffect(() => {
      onInstall?.(installSkill);
      onInstallTheme?.(installTheme);
    }, []);
    return null;
  }

  // ── window.claude mock ─────────────────────────────────────────────────────────

  function makeMock({
    installResolves = true,
    signedIn = true,
    telemetryReject = false,
    themeInstallFails = false,
  }: {
    installResolves?: boolean;
    signedIn?: boolean;
    telemetryReject?: boolean;
    themeInstallFails?: boolean;
  } = {}) {
    const skills = {
      install: installResolves
        ? vi.fn().mockResolvedValue({ status: "installed", type: "plugin" })
        : vi.fn().mockRejectedValue(new Error("install failed")),
      uninstall: vi.fn().mockResolvedValue({ type: "plugin" }),
      list: vi.fn().mockResolvedValue([]),
      listMarketplace: vi.fn().mockResolvedValue([]),
      getFavorites: vi.fn().mockResolvedValue([]),
      // Added when MarketplaceProvider began calling useSkills() — SkillProvider
      // mount fetches getChips and getCuratedDefaults too.
      getChips: vi.fn().mockResolvedValue([]),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ ok: true }),
      setFavorite: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue({ prUrl: "http://example.com/pr/1" }),
    };

    const marketplace = {
      getPackages: vi.fn().mockResolvedValue({}),
    };

    const account = {
      signedIn: vi.fn().mockResolvedValue(signedIn),
    };

    const marketplaceApi = {
      install: telemetryReject
        ? vi.fn().mockRejectedValue(new Error("Worker down"))
        : vi.fn().mockResolvedValue({ ok: true }),
    };

    const theme = {
      marketplace: {
        list: vi.fn().mockResolvedValue([]),
        // theme-marketplace:install resolves { status } — it does not throw on
        // failure, which is why the telemetry call has to read the status.
        install: themeInstallFails
          ? vi.fn().mockResolvedValue({ status: "failed", error: "Theme not found in registry" })
          : vi.fn().mockResolvedValue({ status: "installed" }),
        uninstall: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const appearance = {
      getFavoriteThemes: vi.fn().mockResolvedValue([]),
      favoriteTheme: vi.fn().mockResolvedValue(undefined),
    };

    return { skills, marketplace, account, marketplaceApi, theme, appearance };
  }

  // ── Tests ──────────────────────────────────────────────────────────────────────

  describe("installSkill telemetry", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      (globalThis as any).window = (globalThis as any).window ?? {};
    });

    afterEach(() => {
      cleanup();
      vi.restoreAllMocks();
    });

    it("fires marketplaceApi.install() after successful local install when signed in", async () => {
      const mock = makeMock({ signedIn: true });
      (globalThis as any).window.claude = mock;

      let capturedInstall: ((id: string) => Promise<void>) | undefined;

      render(
        <SkillProvider>
          <MarketplaceProvider>
            <Probe onInstall={(fn) => { capturedInstall = fn; }} />
          </MarketplaceProvider>
        </SkillProvider>
      );

      // Let fetchAll on mount settle
      await act(async () => {});

      await act(async () => {
        await capturedInstall!("my-plugin");
      });

      expect(mock.skills.install).toHaveBeenCalledWith("my-plugin");
      expect(mock.account.signedIn).toHaveBeenCalled();
      expect(mock.marketplaceApi.install).toHaveBeenCalledWith("my-plugin");
    });

    it("skips telemetry when signed out", async () => {
      const mock = makeMock({ signedIn: false });
      (globalThis as any).window.claude = mock;

      let capturedInstall: ((id: string) => Promise<void>) | undefined;

      render(
        <SkillProvider>
          <MarketplaceProvider>
            <Probe onInstall={(fn) => { capturedInstall = fn; }} />
          </MarketplaceProvider>
        </SkillProvider>
      );
      await act(async () => {});

      await act(async () => {
        await capturedInstall!("my-plugin");
      });

      expect(mock.skills.install).toHaveBeenCalledWith("my-plugin");
      // When signed out, telemetry call should NOT fire
      expect(mock.marketplaceApi.install).not.toHaveBeenCalled();
    });

    it("resolves successfully even when telemetry rejects (non-fatal)", async () => {
      const mock = makeMock({ signedIn: true, telemetryReject: true });
      (globalThis as any).window.claude = mock;

      let capturedInstall: ((id: string) => Promise<void>) | undefined;

      render(
        <SkillProvider>
          <MarketplaceProvider>
            <Probe onInstall={(fn) => { capturedInstall = fn; }} />
          </MarketplaceProvider>
        </SkillProvider>
      );
      await act(async () => {});

      // Must NOT throw — telemetry failure is non-fatal
      await act(async () => {
        await expect(capturedInstall!("my-plugin")).resolves.toBeUndefined();
      });

      // Local install still happened
      expect(mock.skills.install).toHaveBeenCalledWith("my-plugin");
      // Telemetry was attempted
      expect(mock.marketplaceApi.install).toHaveBeenCalled();
      // Failure was logged as a warning
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("[marketplace] install telemetry threw"),
        expect.any(Error),
      );
    });
  });

  // ── Theme installs ───────────────────────────────────────────────────
  // Themes are recorded under a `theme:<slug>` plugin id so the Worker can count
  // them separately from plugins. Before this, installTheme() never told the
  // Worker anything, so the installs table had no theme rows at all.

  describe("installTheme telemetry", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      (globalThis as any).window = (globalThis as any).window ?? {};
    });

    afterEach(() => {
      cleanup();
      vi.restoreAllMocks();
    });

    async function mount(mock: ReturnType<typeof makeMock>) {
      (globalThis as any).window.claude = mock;
      let captured: ((slug: string) => Promise<void>) | undefined;
      render(
        <SkillProvider>
          <MarketplaceProvider>
            <Probe onInstallTheme={(fn) => { captured = fn; }} />
          </MarketplaceProvider>
        </SkillProvider>
      );
      await act(async () => {});
      return captured!;
    }

    it("fires marketplaceApi.install('theme:<slug>') after a successful theme install", async () => {
      const mock = makeMock({ signedIn: true });
      const installTheme = await mount(mock);

      await act(async () => { await installTheme("ocean-depths"); });

      expect(mock.theme.marketplace.install).toHaveBeenCalledWith("ocean-depths");
      expect(mock.marketplaceApi.install).toHaveBeenCalledWith("theme:ocean-depths");
    });

    it("skips theme telemetry when signed out", async () => {
      const mock = makeMock({ signedIn: false });
      const installTheme = await mount(mock);

      await act(async () => { await installTheme("ocean-depths"); });

      expect(mock.theme.marketplace.install).toHaveBeenCalledWith("ocean-depths");
      expect(mock.marketplaceApi.install).not.toHaveBeenCalled();
    });

    it("records nothing when the theme did not actually install — and reports the failure", async () => {
      const mock = makeMock({ signedIn: true, themeInstallFails: true });
      const installTheme = await mount(mock);

      // The failure is REPORTED now (error inventory 2026-09-10, false message 14): the
      // provider used to resolve quietly on { status: 'failed' }, so a theme that never
      // landed on disk looked like nothing at all to the person who asked for it.
      await act(async () => {
        await expect(installTheme("ocean-depths")).rejects.toThrow("Theme not found in registry");
      });

      expect(mock.marketplaceApi.install).not.toHaveBeenCalled();
      // A theme that did not install is not starred as a favorite either.
      expect(mock.appearance.favoriteTheme).not.toHaveBeenCalled();
    });

    it("still resolves when theme telemetry rejects (non-fatal)", async () => {
      const mock = makeMock({ signedIn: true, telemetryReject: true });
      const installTheme = await mount(mock);

      await act(async () => {
        await expect(installTheme("ocean-depths")).resolves.toBeUndefined();
      });

      expect(mock.theme.marketplace.install).toHaveBeenCalledWith("ocean-depths");
      expect(mock.marketplaceApi.install).toHaveBeenCalledWith("theme:ocean-depths");
    });
  });
});

// Verifies that MarketplaceContext mutations (install/uninstall) trigger a
// SkillContext.refreshInstalled() so the CommandDrawer doesn't go stale.
//
// Without the wiring this test exercises, plugins installed from the
// marketplace would not appear in the drawer until app restart — latent on
// desktop but newly visible on Android once the cold-start race fix exposes
// installed plugins in the first place.
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
    // After install exactly ONE skills.list: SkillContext.refreshInstalled().
    // The marketplace no longer keeps its own copy of the installed list
    // (2026-09-16 audit W17), so its fetchAll() makes no second call.
    expect(listCalls).toBe(baseline + 1);
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
    expect(listCalls).toBe(baseline + 1);
  });
});

// Pins how the marketplace decides an item has an update.
//
// WHY this test exists: the only signal used to be the version number, which is
// whatever the author last typed into plugin.json. Half the catalog mirrors
// repos whose authors never bump it, so real changes went unannounced. The app now
// records the exact commit each install landed on, and the catalog publishes the
// commit it currently lists — so "the code moved" is now visible even when the
// version did not. The two checks stay SEPARATE and are OR'd: a deliberate
// version bump and a silent repo change are different facts, and either one
// means there is something new to fetch.
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

  it('flags a newer version, as it always did', async () => {
    entries = [row({ version: '2.0.0' })];
    packages = { x: { version: '1.0.0', source: 'marketplace' } };
    expect((await readUpdateAvailable()).x).toBe(true);
  });

  it('flags a moved commit even when the version never changed', async () => {
    entries = [row({ catalog: { itemType: 'plugin', origin: { tier: 'community' }, scan: { status: 'unchecked' }, capabilities: [], sourceCommit: NEW } })];
    packages = { x: { version: '1.0.0', source: 'marketplace', commit: OLD } };
    expect((await readUpdateAvailable()).x).toBe(true);
  });

  it('says nothing when both the version and the commit match', async () => {
    entries = [row({ catalog: { itemType: 'plugin', origin: { tier: 'community' }, scan: { status: 'unchecked' }, capabilities: [], sourceCommit: OLD } })];
    packages = { x: { version: '1.0.0', source: 'marketplace', commit: OLD } };
    expect((await readUpdateAvailable()).x).toBeUndefined();
  });

  it('an install made before commits were recorded never grows a badge from the commit check', async () => {
    // Every package installed before Task 17 has no `commit`. Treating "missing"
    // as "different" would light an Update badge on the user's whole library at
    // once, for nothing.
    entries = [row({ catalog: { itemType: 'plugin', origin: { tier: 'community' }, scan: { status: 'unchecked' }, capabilities: [], sourceCommit: NEW } })];
    packages = { x: { version: '1.0.0', source: 'marketplace' } };
    expect((await readUpdateAvailable()).x).toBeUndefined();
  });

  it('says nothing when the catalog lists no commit for an install that has one', async () => {
    // The reverse gap: a row that lost its catalog block (Worker outage → the
    // index.json fallback) must not read as "downgraded".
    entries = [row()];
    packages = { x: { version: '1.0.0', source: 'marketplace', commit: OLD } };
    expect((await readUpdateAvailable()).x).toBeUndefined();
  });
});

/**
 * The marketplace footer names the operation that actually ran — and a failure that
 * came back as an ANSWER counts as a failure.
 *
 * marketplace-context recorded uninstall
 * and update exceptions in the same map, under the same key shape, as installs, and
 * InstallingFooterStrip printed every entry as "Failed to install {label}". Its in-flight
 * line said "Installing" for all three operations too. The refreshes that run AFTER a
 * mutation succeeded sat inside the same try, so a failed drawer refresh reported a
 * working install as failed. And install/update/uninstall mostly RESOLVE their failures
 * (`{ status: 'failed', error }`, `{ ok: false, error }`) — the context never read them,
 * so a failed install looked like nothing at all and still posted install telemetry.
 */
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

  it('an uninstall in progress says "Uninstalling", not "Installing"', async () => {
    setupWindowClaude({ uninstall: vi.fn(() => new Promise(() => {})) });
    await renderFooter();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'uninstall' })); });

    expect(screen.getByText(/uninstalling/i)).toBeInTheDocument();
    expect(screen.queryByText(/^\s*installing/i)).toBeNull();
  });
});
