// marketplace-stats-context.tsx
// Live /stats fetcher — replaces the static stats.json fetch that skill-provider.ts
// previously performed on the main process side.
//
// GET /stats is unauthenticated so no token is needed. The response is cached
// in a module-level ref for 5 minutes. A provider re-mount within that window
// serves the cached value without a network round-trip. A full page reload clears
// the cache (module is reloaded), which is an acceptable tradeoff for the TTL.
//
// WHY the fetch waits for a consumer (2026-09-16 audit W16): the provider sits
// at the app root and used to request /stats on mount — one HTTP round-trip
// at every launch for cards that live only in the marketplace screen. The
// first useMarketplaceStats() caller starts it; the TTL cache is unchanged.

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
  /** Write a plugin's vote totals straight into the shared stats, no network.
   *  Every card reads `plugins[id]`, and `/stats` is served Cache-Control
   *  max-age=300 — so after you vote, refresh() CANNOT show the new number and
   *  the card you just voted on keeps its old percentage. The vote routes hand
   *  the fresh totals back with the response; this is where they land. */
  applyThumbs(pluginId: string, thumbsUp: number, thumbsDown: number): void;
  /** Start the first fetch (or serve the cache) if no consumer has asked yet. */
  ensureLoaded(): void;
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
  // Mirrors the pattern in ThemeProvider and AccountProvider.
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

  // Fetch (or serve from cache if fresh) on the first consumer, not on mount.
  const demanded = useRef(false);
  const ensureLoaded = useCallback(() => {
    if (demanded.current) return;
    demanded.current = true;
    void fetchStats(false);
  }, [fetchStats]);

  // refresh() bypasses the cache — callers use this to force a live re-fetch
  const refresh = useCallback(() => fetchStats(true), [fetchStats]);

  // Patch one plugin's totals in place. Also writes through to the module-level
  // cache: without that, a provider remount would restore the pre-vote number
  // and the card would silently revert.
  const applyThumbs = useCallback((pluginId: string, thumbsUp: number, thumbsDown: number) => {
    setPlugins((prev) => {
      const current = prev[pluginId];
      if (current && current.thumbs_up === thumbsUp && current.thumbs_down === thumbsDown) return prev;
      // Defaults FIRST only when there is no row yet — spreading them before
      // `current` would be a no-op, and after it would wipe the real installs.
      const base = current ?? { installs: 0, review_count: 0, rating: 0, thumbs_up: 0, thumbs_down: 0 };
      const entry = { ...base, thumbs_up: thumbsUp, thumbs_down: thumbsDown };
      const next = { ...prev, [pluginId]: entry };
      if (cachedStats) cachedStats = { ...cachedStats, value: { ...cachedStats.value, plugins: next } };
      return next;
    });
  }, []);

  const value = useMemo<Ctx>(
    () => ({ loading, plugins, themes, refresh, applyThumbs, ensureLoaded }),
    [loading, plugins, themes, refresh, applyThumbs, ensureLoaded]
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
  // The consumer is the demand — see the header.
  const { ensureLoaded } = ctx;
  useEffect(() => { ensureLoaded(); }, [ensureLoaded]);
  return ctx;
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Reset the module-level cache. Call this in beforeEach to isolate tests. */
export function __resetStatsCacheForTests(): void {
  cachedStats = null;
}
