// @vitest-environment jsdom
// marketplace-context-install-telemetry.test.tsx
// Verifies that installSkill() fires POST /installs telemetry after a successful
// local install and that telemetry failures never surface to the caller.

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
}: {
  onInstall: (fn: (id: string) => Promise<void>) => void;
}) {
  const { installSkill } = useMarketplace();
  React.useEffect(() => { onInstall(installSkill); }, []);
  return null;
}

// ── window.claude mock ─────────────────────────────────────────────────────────

function makeMock({
  installResolves = true,
  signedIn = true,
  telemetryReject = false,
}: {
  installResolves?: boolean;
  signedIn?: boolean;
  telemetryReject?: boolean;
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

  const marketplaceAuth = {
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
      install: vi.fn().mockResolvedValue(undefined),
      uninstall: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
  };

  return { skills, marketplace, marketplaceAuth, marketplaceApi, theme };
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
    expect(mock.marketplaceAuth.signedIn).toHaveBeenCalled();
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
