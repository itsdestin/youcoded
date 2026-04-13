// marketplace-stats-context.tsx
// Live /stats fetcher — replaces the static stats.json fetch that skill-provider.ts
// previously performed on the main process side.
//
// GET /stats is unauthenticated so no token is needed. The response is cached
// in a module-level ref for 5 minutes. A provider re-mount within that window
// serves the cached value without a network round-trip. A full page reload clears
// the cache (module is reloaded), which is an acceptable tradeoff for the TTL.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createMarketplaceApiClient,
  MARKETPLACE_API_HOST,
  type StatsResponse,
} from "./marketplace-api-client";

const CACHE_MS = 5 * 60 * 1000; // 5 minutes

// ── Context shape ─────────────────────────────────────────────────────────────

interface Ctx {
  loading: boolean;
  plugins: StatsResponse["plugins"];
  themes: StatsResponse["themes"];
  refresh(): Promise<void>;
}

const MarketplaceStatsContext = createContext<Ctx | null>(null);

// ── Module-level cache ────────────────────────────────────────────────────────
// Survives provider re-mount within the same page session.
// Cleared on full page reload; acceptable for a 5-min TTL.

let cachedStats: { fetchedAt: number; value: StatsResponse } | null = null;

// ── Provider ──────────────────────────────────────────────────────────────────

export function MarketplaceStatsProvider({
  children,
  onNetworkResult,
}: {
  children: React.ReactNode;
  /** Optional callback fired after each /stats fetch attempt. Used by WorkerHealthProvider. */
  onNetworkResult?: (ok: boolean) => void;
}) {
  const [loading, setLoading] = useState(
    // If we have a fresh cache entry, we can start idle; otherwise show loading.
    () => cachedStats == null || Date.now() - cachedStats.fetchedAt > CACHE_MS
  );
  const [plugins, setPlugins] = useState<Ctx["plugins"]>(
    cachedStats?.value.plugins ?? {}
  );
  const [themes, setThemes] = useState<Ctx["themes"]>(
    cachedStats?.value.themes ?? {}
  );

  // cancelledRef — prevents setState calls after the provider unmounts.
  // Mirrors the pattern in ThemeProvider and MarketplaceAuthProvider.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const fetchStats = useCallback(async (bypassCache: boolean) => {
    // Serve from cache if valid and bypass not requested
    if (
      !bypassCache &&
      cachedStats &&
      Date.now() - cachedStats.fetchedAt < CACHE_MS
    ) {
      if (cancelledRef.current) return;
      setPlugins(cachedStats.value.plugins);
      setThemes(cachedStats.value.themes);
      setLoading(false);
      return;
    }

    setLoading(true);

    // /stats is unauthenticated — pass null token
    const client = createMarketplaceApiClient({
      host: MARKETPLACE_API_HOST,
      getToken: () => null,
    });

    try {
      const stats = await client.getStats();
      cachedStats = { fetchedAt: Date.now(), value: stats };
      if (cancelledRef.current) return;
      setPlugins(stats.plugins);
      setThemes(stats.themes);
      // Report success to the worker health indicator (if wired)
      onNetworkResult?.(true);
    } catch (err) {
      // Log once and fall back to empty aggregates — never block the UI.
      console.warn(
        "[marketplace-stats] fetch failed, using empty aggregates:",
        err
      );
      if (cancelledRef.current) return;
      setPlugins({});
      setThemes({});
      // Report failure to the worker health indicator (if wired)
      onNetworkResult?.(false);
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [onNetworkResult]);

  // Fetch on mount (or serve from cache if fresh)
  useEffect(() => {
    void fetchStats(false);
  }, [fetchStats]);

  // refresh() bypasses the cache — callers use this to force a live re-fetch
  const refresh = useCallback(() => fetchStats(true), [fetchStats]);

  const value = useMemo<Ctx>(
    () => ({ loading, plugins, themes, refresh }),
    [loading, plugins, themes, refresh]
  );

  return (
    <MarketplaceStatsContext.Provider value={value}>
      {children}
    </MarketplaceStatsContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMarketplaceStats(): Ctx {
  const ctx = useContext(MarketplaceStatsContext);
  if (!ctx) {
    throw new Error(
      "useMarketplaceStats must be used inside <MarketplaceStatsProvider>"
    );
  }
  return ctx;
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Reset the module-level cache. Call this in beforeEach to isolate tests. */
export function __resetStatsCacheForTests(): void {
  cachedStats = null;
}
