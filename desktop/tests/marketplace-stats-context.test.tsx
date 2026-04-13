// @vitest-environment jsdom
// marketplace-stats-context.test.tsx
// Tests for MarketplaceStatsProvider — live /stats fetcher that replaces static stats.json.
// Uses vi.fn() to mock globalThis.fetch directly (no window.claude involvement — the api
// client calls fetch directly from the renderer, same as a browser would).

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import {
  MarketplaceStatsProvider,
  useMarketplaceStats,
  __resetStatsCacheForTests,
} from "../src/renderer/state/marketplace-stats-context";

// ── Probe component ────────────────────────────────────────────────────────────

function Probe({ onRefresh }: { onRefresh?: (refresh: () => Promise<void>) => void }) {
  const { loading, plugins, themes, refresh } = useMarketplaceStats();
  // Surface refresh to the test via callback, once on mount
  React.useEffect(() => { onRefresh?.(refresh); }, []);
  return (
    <div>
      <span data-testid="loading">{loading ? "loading" : "idle"}</span>
      <span data-testid="pluginCount">{Object.keys(plugins).length}</span>
      <span data-testid="themeCount">{Object.keys(themes).length}</span>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeStatsResponse() {
  return {
    generated_at: Date.now(),
    plugins: {
      "my-plugin": { installs: 42, review_count: 5, rating: 4.2 },
    },
    themes: {
      "ocean": { likes: 10 },
    },
  };
}

function mockFetchSuccess(body: object) {
  (globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  });
}

function mockFetchFailure() {
  (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error("network error"));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("MarketplaceStatsProvider", () => {
  beforeEach(() => {
    // Reset module-level cache before each test so tests are independent
    __resetStatsCacheForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows loading:true before fetch settles", async () => {
    // fetch returns a never-resolving promise so we can observe the loading state
    (globalThis as any).fetch = vi.fn().mockReturnValue(new Promise(() => {}));

    const { getByTestId } = render(
      <MarketplaceStatsProvider>
        <Probe />
      </MarketplaceStatsProvider>
    );

    // Before the first await the fetch has been kicked off but hasn't resolved
    expect(getByTestId("loading").textContent).toBe("loading");
  });

  it("populates plugins and themes after a successful fetch", async () => {
    mockFetchSuccess(makeStatsResponse());

    const { getByTestId } = render(
      <MarketplaceStatsProvider>
        <Probe />
      </MarketplaceStatsProvider>
    );

    // Wait for the fetch to complete and React state to update
    await act(async () => {});

    expect(getByTestId("loading").textContent).toBe("idle");
    expect(getByTestId("pluginCount").textContent).toBe("1");
    expect(getByTestId("themeCount").textContent).toBe("1");
  });

  it("does not re-fetch within the 5-minute cache window on re-mount", async () => {
    mockFetchSuccess(makeStatsResponse());

    // First mount — should fetch once
    const { unmount } = render(
      <MarketplaceStatsProvider>
        <Probe />
      </MarketplaceStatsProvider>
    );
    await act(async () => {});
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);

    unmount();

    // Re-mount within the cache window — should NOT fetch again
    const { getByTestId } = render(
      <MarketplaceStatsProvider>
        <Probe />
      </MarketplaceStatsProvider>
    );
    await act(async () => {});

    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1); // still only 1
    // Data is still available from cache
    expect(getByTestId("pluginCount").textContent).toBe("1");
  });

  it("bypasses cache and re-fetches when refresh() is called", async () => {
    mockFetchSuccess(makeStatsResponse());

    let capturedRefresh: (() => Promise<void>) | undefined;

    const { getByTestId } = render(
      <MarketplaceStatsProvider>
        <Probe onRefresh={(r) => { capturedRefresh = r; }} />
      </MarketplaceStatsProvider>
    );
    await act(async () => {});

    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);

    // Call refresh — should bypass cache and fetch again
    await act(async () => {
      await capturedRefresh!();
    });

    expect((globalThis as any).fetch).toHaveBeenCalledTimes(2);
    expect(getByTestId("loading").textContent).toBe("idle");
  });

  it("returns empty aggregates and does not throw when fetch rejects", async () => {
    mockFetchFailure();

    const { getByTestId } = render(
      <MarketplaceStatsProvider>
        <Probe />
      </MarketplaceStatsProvider>
    );

    // Should NOT throw — the provider catches the error and falls back gracefully
    await act(async () => {});

    expect(getByTestId("loading").textContent).toBe("idle");
    expect(getByTestId("pluginCount").textContent).toBe("0");
    expect(getByTestId("themeCount").textContent).toBe("0");

    // Should have logged a warning, not thrown
    expect(console.warn).toHaveBeenCalled();
  });
});
