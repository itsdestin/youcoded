// @vitest-environment jsdom
// marketplace-context-install-telemetry.test.tsx
// Verifies that installSkill() and installTheme() fire POST /installs telemetry
// after a successful local install and that telemetry failures never surface to
// the caller. Themes report under a `theme:<slug>` plugin id — Task 22; without
// this call the installs table holds zero theme rows and a theme's download
// count would read 0 forever.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { SkillProvider } from "../src/renderer/state/skill-context";
import {
  MarketplaceProvider,
  useMarketplace,
} from "../src/renderer/state/marketplace-context";

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

// ── Theme installs (Task 22) ───────────────────────────────────────────────────
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
