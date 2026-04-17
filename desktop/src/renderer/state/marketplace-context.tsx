/**
 * MarketplaceContext — unified data layer for the marketplace modal.
 *
 * Fetches both skills/index.json and themes/index.json on mount,
 * loads package state from youcoded-skills.json, and exposes
 * install/uninstall methods that work for any content type.
 *
 * Does NOT replace SkillContext (command drawer) or ThemeContext (DOM theming).
 * This context is only mounted when the marketplace modal is open.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { SkillEntry, PackageInfo, FeaturedData } from '../../shared/types';
import type { ThemeRegistryEntryWithStatus } from '../../shared/theme-marketplace-types';

// window.claude is typed for skills but not for theme.marketplace — cast via any
const claude = () => (window as any).claude;

/**
 * Phase 3b: semver-ish comparison. Returns true if `latest` is a greater
 * version than `installed`. Falls back to strict inequality for non-numeric
 * version strings (different = update available).
 */
function isNewerVersion(installed: string | undefined, latest: string | undefined): boolean {
  if (!installed || !latest) return false;
  const stripV = (v: string) => v.replace(/^v/i, '').trim();
  const a = stripV(installed);
  const b = stripV(latest);
  if (a === b) return false;
  const parse = (v: string) => v.split(/[.\-+]/).map(p => /^\d+$/.test(p) ? parseInt(p, 10) : NaN);
  const pa = parse(a);
  const pb = parse(b);
  // If any segment is NaN, fall back to string inequality (different = update)
  if (pa.some(isNaN) || pb.some(isNaN)) return a !== b;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (bi > ai) return true;
    if (bi < ai) return false;
  }
  return false;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type MarketplaceTab = 'installed' | 'skills' | 'themes';

export interface MarketplaceEntry {
  id: string;
  type: 'plugin' | 'prompt' | 'theme';
  displayName: string;
  description: string;
  category?: string;
  author?: string;
  version?: string;
  source?: string; // marketplace, user, external
  installed?: boolean;
  installedVersion?: string;
  updateAvailable?: boolean;
}

interface MarketplaceState {
  // Raw index data
  skillEntries: SkillEntry[];
  themeEntries: ThemeRegistryEntryWithStatus[];
  // Marketplace redesign Phase 1: hero + rails curation. Empty-default so UIs
  // that don't need it can ignore this field entirely.
  featured: FeaturedData;
  // Phase 3a: packages map from youcoded-skills.json — tracks installed
  // versions, sources, and component paths for update detection + uninstall
  packages: Record<string, PackageInfo>;
  // Phase 3b: map of entry id → whether a newer version is in the marketplace
  updateAvailable: Record<string, boolean>;
  // Installed content (merged from all sources)
  installedSkills: SkillEntry[];
  favorites: string[];
  // Loading/error state
  loading: boolean;
  error: string | null;
}

interface MarketplaceActions {
  // Install/uninstall for any content type
  installSkill: (id: string) => Promise<void>;
  uninstallSkill: (id: string) => Promise<void>;
  installTheme: (slug: string) => Promise<void>;
  uninstallTheme: (slug: string) => Promise<void>;
  // Phase 3b: update an installed entry to the latest marketplace version
  update: (id: string, type: 'skill' | 'theme') => Promise<any>;
  // Favorites
  setFavorite: (id: string, favorited: boolean) => Promise<void>;
  // Refresh data
  refresh: () => Promise<void>;
  // Phase 4a: publish a user-created skill to the community marketplace via PR
  publishSkill: (id: string) => Promise<{ prUrl: string }>;
}

type MarketplaceContextValue = MarketplaceState & MarketplaceActions;

// ── Context ──────────────────────────────────────────────────────────────────

const MarketplaceContext = createContext<MarketplaceContextValue | null>(null);

export function useMarketplace(): MarketplaceContextValue {
  const ctx = useContext(MarketplaceContext);
  if (!ctx) throw new Error('useMarketplace must be used within MarketplaceProvider');
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function MarketplaceProvider({ children }: { children: React.ReactNode }) {
  const [skillEntries, setSkillEntries] = useState<SkillEntry[]>([]);
  const [themeEntries, setThemeEntries] = useState<ThemeRegistryEntryWithStatus[]>([]);
  const [featured, setFeatured] = useState<FeaturedData>({ hero: [], rails: [] });
  const [packages, setPackages] = useState<Record<string, PackageInfo>>({});
  const [installedSkills, setInstalledSkills] = useState<SkillEntry[]>([]);
  const [favorites, setFavoritesState] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guard against stale fetchAll responses when rapid install/uninstall triggers concurrent fetches
  const fetchGeneration = useRef(0);

  // Fetch all marketplace data in parallel on mount
  const fetchAll = useCallback(async () => {
    const gen = ++fetchGeneration.current;
    setLoading(true);
    setError(null);
    try {
      // Phase 3a: include packages map so update detection works on first load
      const marketplaceApi = (window as any).claude.marketplace;
      // Marketplace redesign Phase 1: featured is additive and non-blocking;
      // fall back to empty hero/rails if the endpoint isn't available (older
      // app versions) or the network call fails.
      const featuredCall =
        (window.claude.skills as any).getFeatured?.().catch(() => ({ hero: [], rails: [] }))
          ?? Promise.resolve({ hero: [], rails: [] });
      const [
        marketplaceSkills,
        themes,
        installed,
        favs,
        pkgs,
        feat,
      ] = await Promise.all([
        window.claude.skills.listMarketplace(),
        claude().theme.marketplace.list().catch(() => []),
        window.claude.skills.list(),
        window.claude.skills.getFavorites(),
        marketplaceApi?.getPackages?.().catch(() => ({})) ?? Promise.resolve({}),
        featuredCall,
      ]);

      // Discard stale response — a newer fetchAll was triggered while we were awaiting
      if (gen !== fetchGeneration.current) return;

      // Filter out entries sync.js flagged as deprecated — they refer to
      // upstream plugins that no longer exist (e.g. pre-decomposition
      // journaling-assistant prompt stubs). Metadata is preserved in the
      // registry but shouldn't surface in the install UI.
      // Also filter integrationOnly entries — those plugins (e.g. imessage,
      // google-services) are surfaced through the Integrations tile instead
      // and would double-list if shown in the plugins grid too.
      setSkillEntries(
        (marketplaceSkills || []).filter((e: any) => !e.deprecated && !e.integrationOnly),
      );
      setThemeEntries(themes || []);
      setInstalledSkills(installed || []);
      setFavoritesState(favs || []);
      setPackages((pkgs as Record<string, PackageInfo>) || {});
      setFeatured((feat && typeof feat === 'object') ? feat : { hero: [], rails: [] });
    } catch (err: any) {
      if (gen !== fetchGeneration.current) return;
      setError(err?.message || 'Failed to load marketplace data');
    } finally {
      if (gen === fetchGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const installSkill = useCallback(async (id: string) => {
    await window.claude.skills.install(id);
    // Fire install telemetry after successful local install. Non-blocking — we
    // never fail a local install because the Worker is down. Skip silently when
    // signed out (anonymous installs = no telemetry).
    // Cast via claude() (any) because marketplaceApi + marketplaceAuth are exposed
    // in preload/remote-shim but not yet reflected in window.claude's TS type.
    try {
      const signedIn = await claude().marketplaceAuth.signedIn();
      if (signedIn) {
        const res = await claude().marketplaceApi.install(id);
        if (!res.ok) {
          console.warn("[marketplace] install telemetry failed:", res.status, res.message);
        }
      }
    } catch (err) {
      console.warn("[marketplace] install telemetry threw (non-fatal):", err);
    }
    await fetchAll(); // Refresh all state after install
  }, [fetchAll]);

  const uninstallSkill = useCallback(async (id: string) => {
    await window.claude.skills.uninstall(id);
    await fetchAll();
  }, [fetchAll]);

  const installTheme = useCallback(async (slug: string) => {
    await claude().theme.marketplace.install(slug);
    await fetchAll();
  }, [fetchAll]);

  const uninstallTheme = useCallback(async (slug: string) => {
    await claude().theme.marketplace.uninstall(slug);
    await fetchAll();
  }, [fetchAll]);

  // Phase 3b: update an installed package (skill plugin or theme) by re-downloading
  // from source and overwriting files at the same install path. Config in
  // ~/.claude/youcoded-config/<id>.json is untouched.
  const update = useCallback(async (id: string, type: 'skill' | 'theme') => {
    let result: any;
    if (type === 'theme') {
      result = await claude().theme.marketplace.update(id);
    } else {
      result = await (window as any).claude.skills.update(id);
    }
    await fetchAll();
    return result;
  }, [fetchAll]);

  const setFavorite = useCallback(async (id: string, favorited: boolean) => {
    await window.claude.skills.setFavorite(id, favorited);
    // Optimistic update
    setFavoritesState(prev =>
      favorited ? [...prev, id] : prev.filter(f => f !== id)
    );
  }, []);

  // Phase 4a: publish a user-created skill to the community marketplace.
  // Calls the skills:publish IPC which forks the marketplace repo, uploads
  // files, and opens a PR via `gh` CLI.
  const publishSkill = useCallback(async (id: string) => {
    const result = await window.claude.skills.publish(id);
    return result;
  }, []);

  // Phase 3b: compute update-available map by comparing marketplace versions
  // against installed package versions. Themes use the "theme:<slug>" key
  // prefix in the packages map to avoid colliding with skill ids.
  const updateAvailable = useMemo<Record<string, boolean>>(() => {
    const result: Record<string, boolean> = {};
    for (const entry of skillEntries) {
      const pkg = packages[entry.id];
      if (!pkg) continue; // not installed via marketplace
      if (isNewerVersion(pkg.version, entry.version)) {
        result[entry.id] = true;
      }
    }
    for (const theme of themeEntries) {
      const pkg = packages[`theme:${theme.slug}`];
      if (!pkg) continue;
      if (isNewerVersion(pkg.version, theme.version)) {
        result[theme.slug] = true;
      }
    }
    return result;
  }, [skillEntries, themeEntries, packages]);

  // ── Memoized value ───────────────────────────────────────────────────────

  const value = useMemo<MarketplaceContextValue>(() => ({
    skillEntries,
    themeEntries,
    featured,
    packages,
    updateAvailable,
    installedSkills,
    favorites,
    loading,
    error,
    installSkill,
    uninstallSkill,
    installTheme,
    uninstallTheme,
    update,
    setFavorite,
    refresh: fetchAll,
    publishSkill,
  }), [
    skillEntries, themeEntries, featured, packages, updateAvailable, installedSkills,
    favorites, loading, error,
    installSkill, uninstallSkill, installTheme, uninstallTheme, update,
    setFavorite, fetchAll, publishSkill,
  ]);

  return (
    <MarketplaceContext.Provider value={value}>
      {children}
    </MarketplaceContext.Provider>
  );
}
