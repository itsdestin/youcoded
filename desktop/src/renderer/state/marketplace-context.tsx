/**
 * MarketplaceContext — unified data layer for the marketplace modal.
 *
 * Fetches both skills/index.json and themes/index.json on mount,
 * loads package state from destincode-skills.json, and exposes
 * install/uninstall methods that work for any content type.
 *
 * Does NOT replace SkillContext (command drawer) or ThemeContext (DOM theming).
 * This context is only mounted when the marketplace modal is open.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { SkillEntry, ChipConfig, PackageInfo } from '../../shared/types';
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
  // Phase 3a: packages map from destincode-skills.json — tracks installed
  // versions, sources, and component paths for update detection + uninstall
  packages: Record<string, PackageInfo>;
  // Phase 3b: map of entry id → whether a newer version is in the marketplace
  updateAvailable: Record<string, boolean>;
  // Installed content (merged from all sources)
  installedSkills: SkillEntry[];
  // User content
  privateSkills: SkillEntry[];
  chips: ChipConfig[];
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
  // Favorites & chips
  setFavorite: (id: string, favorited: boolean) => Promise<void>;
  setChips: (chips: ChipConfig[]) => Promise<void>;
  // Refresh data
  refresh: () => Promise<void>;
  // Prompt skill management
  createPrompt: (skill: Omit<SkillEntry, 'id'>) => Promise<SkillEntry>;
  deletePrompt: (id: string) => Promise<void>;
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
  const [packages, setPackages] = useState<Record<string, PackageInfo>>({});
  const [installedSkills, setInstalledSkills] = useState<SkillEntry[]>([]);
  const [privateSkills, setPrivateSkills] = useState<SkillEntry[]>([]);
  const [chips, setChipsState] = useState<ChipConfig[]>([]);
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
      const [
        marketplaceSkills,
        themes,
        installed,
        favs,
        chipList,
        pkgs,
      ] = await Promise.all([
        window.claude.skills.listMarketplace(),
        claude().theme.marketplace.list().catch(() => []),
        window.claude.skills.list(),
        window.claude.skills.getFavorites(),
        window.claude.skills.getChips(),
        marketplaceApi?.getPackages?.().catch(() => ({})) ?? Promise.resolve({}),
      ]);

      // Discard stale response — a newer fetchAll was triggered while we were awaiting
      if (gen !== fetchGeneration.current) return;

      setSkillEntries(marketplaceSkills || []);
      setThemeEntries(themes || []);
      setInstalledSkills(installed || []);
      setFavoritesState(favs || []);
      setChipsState(chipList || []);
      setPackages((pkgs as Record<string, PackageInfo>) || {});

      // Extract private skills from installed list
      const priv = (installed || []).filter((s: SkillEntry) =>
        s.visibility === 'private' || s.source === 'self'
      );
      setPrivateSkills(priv);
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
  // ~/.claude/destincode-config/<id>.json is untouched.
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

  const setChips = useCallback(async (newChips: ChipConfig[]) => {
    await window.claude.skills.setChips(newChips);
    setChipsState(newChips);
  }, []);

  const createPrompt = useCallback(async (skill: Omit<SkillEntry, 'id'>) => {
    const result = await window.claude.skills.createPrompt(skill);
    await fetchAll();
    return result;
  }, [fetchAll]);

  const deletePrompt = useCallback(async (id: string) => {
    await window.claude.skills.deletePrompt(id);
    await fetchAll();
  }, [fetchAll]);

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
    packages,
    updateAvailable,
    installedSkills,
    privateSkills,
    chips,
    favorites,
    loading,
    error,
    installSkill,
    uninstallSkill,
    installTheme,
    uninstallTheme,
    update,
    setFavorite,
    setChips,
    refresh: fetchAll,
    createPrompt,
    deletePrompt,
    publishSkill,
  }), [
    skillEntries, themeEntries, packages, updateAvailable, installedSkills, privateSkills,
    chips, favorites, loading, error,
    installSkill, uninstallSkill, installTheme, uninstallTheme, update,
    setFavorite, setChips, fetchAll, createPrompt, deletePrompt, publishSkill,
  ]);

  return (
    <MarketplaceContext.Provider value={value}>
      {children}
    </MarketplaceContext.Provider>
  );
}
