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
import { useTheme } from './theme-context';
import { useSkills } from './skill-context';

// window.claude is typed for skills but not for theme.marketplace — cast via any
const claude = () => (window as any).claude;

// WHY: isNewerVersion moved to src/shared so the Electron main process can use the
// SAME comparison when deciding whether a bundled plugin needs upgrading at launch.
// One copy, one answer — a second implementation would drift and show a badge the
// upgrade path disagrees with.
import { isNewerVersion } from '../../shared/version-compare';

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
  themeFavorites: string[];
  installingIds: Set<string>;
  /** Which operation each in-flight key is running, so the footer can name it. */
  installOps: Map<string, InstallOp>;
  installError: Map<string, InstallFailure>;
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
  favoriteTheme: (slug: string, favorited: boolean) => Promise<void>;
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

// The one place the install-progress key is spelled. Both halves of the
// "Installing…" indicator — the writer here and every reader (MarketplaceCard,
// MarketplaceDetailOverlay, InstallingFooterStrip) — must go through this, or
// the reader silently asks for a key that is never set.
// The `skill:` / `theme:` prefix is load-bearing beyond equality:
// InstallingFooterStrip splits on it to decide which registry holds the
// display name for the item being installed.
export function installTrackingKey(kind: 'skill' | 'theme', idOrSlug: string): string {
  return `${kind}:${idOrSlug}`;
}

/** The three mutations that share one install-progress key. */
export type InstallOp = 'install' | 'uninstall' | 'update';
/** A recent failure for a key: which operation failed, in its own words. */
export type InstallFailure = { op: InstallOp; message: string; at: number };

/**
 * The failure a mutation channel ANSWERED, or null when it answered success.
 *
 * WHY (error inventory 2026-09-10, false message 14): skills:install and the theme
 * install/uninstall channels resolve { status: 'failed', error }; skills:update, theme
 * update and a bundled-plugin uninstall resolve { ok: false, error }. None of them
 * throws for these, so a provider that only catches reports every one as nothing.
 */
function answeredFailure(res: unknown): string | null {
  const r = res as { status?: unknown; ok?: unknown; error?: unknown } | null | undefined;
  if (!r || (r.status !== 'failed' && r.ok !== false)) return null;
  return typeof r.error === 'string' && r.error ? r.error : 'no reason was given';
}

export function MarketplaceProvider({ children }: { children: React.ReactNode }) {
  const [skillEntries, setSkillEntries] = useState<SkillEntry[]>([]);
  const [themeEntries, setThemeEntries] = useState<ThemeRegistryEntryWithStatus[]>([]);
  const [featured, setFeatured] = useState<FeaturedData>({ hero: [], rails: [] });
  const [packages, setPackages] = useState<Record<string, PackageInfo>>({});
  const [installedSkills, setInstalledSkills] = useState<SkillEntry[]>([]);
  const [favorites, setFavoritesState] = useState<string[]>([]);
  const [themeFavorites, setThemeFavoritesState] = useState<string[]>([]);
  const [installingIds, setInstallingIds] = useState<Set<string>>(() => new Set());
  const [installOps, setInstallOps] = useState<Map<string, InstallOp>>(() => new Map());
  const [installError, setInstallError] = useState<Map<string, InstallFailure>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guard against stale fetchAll responses when rapid install/uninstall triggers concurrent fetches
  const fetchGeneration = useRef(0);

  // Fix: theme install writes files to disk, but ThemeProvider's userThemes
  // list only updates via the chokidar watcher's debounced theme:reload event
  // (~200ms after files settle). Without an explicit reload, the user can
  // click "Apply theme" before the theme is in userThemes — the active-theme
  // fallback effect then misses the slug and reverts to the default theme,
  // producing a "briefly applies then unapplies" flicker. Force a reload
  // synchronously after install/uninstall/update so the lookup always succeeds.
  const { reloadUserThemes } = useTheme();
  // SkillContext.installed feeds the CommandDrawer. It's loaded once on
  // mount and never refreshes — so without this hook, marketplace installs
  // wouldn't appear in the drawer until app restart. Refresh after each
  // mutator below.
  const { refreshInstalled: refreshDrawerSkills } = useSkills();

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
        themeFavs,
        pkgs,
        feat,
      ] = await Promise.all([
        window.claude.skills.listMarketplace(),
        claude().theme.marketplace.list().catch(() => []),
        window.claude.skills.list(),
        window.claude.skills.getFavorites(),
        claude().appearance.getFavoriteThemes().catch(() => []),
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
      // `|| []` is not enough: a non-array OBJECT is truthy and sails through,
      // then dies at the next `for (const … of …)`. That is exactly how an
      // unbridged remote channel resolving {ok:false,unsupported:true} crashed
      // the marketplace screen on a phone. Guard on shape, not truthiness —
      // these five all feed iteration or .filter() below.
      const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

      setSkillEntries(
        arr<any>(marketplaceSkills).filter((e: any) => !e.deprecated && !e.integrationOnly),
      );
      setThemeEntries(arr(themes));
      setInstalledSkills(arr(installed));
      setFavoritesState(arr(favs));
      setThemeFavoritesState(arr(themeFavs));
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

  // Renderer-only install-tracking. Keys are built by `installTrackingKey`
  // (exported above) — never hand-spelled. MarketplaceCard used to ask for a
  // bare marketplace id here while this file wrote `skill:<id>`, so the two
  // strings could never match and a plugin install showed no progress at all.
  // Cleared in `finally` AFTER `fetchAll()` resolves — clearing before would
  // briefly flash Install → Installed because installed-state derivation
  // hasn't caught up.
  // WHY the operation is recorded with the key (error inventory 2026-09-10, false
  // message 14): only the key was kept, so InstallingFooterStrip said "Installing" and
  // "Failed to install" for uninstalls and updates too.
  const markInstalling = useCallback((key: string, op: InstallOp) => {
    setInstallingIds(prev => { const n = new Set(prev); n.add(key); return n; });
    setInstallOps(prev => { const n = new Map(prev); n.set(key, op); return n; });
  }, []);
  const clearInstalling = useCallback((key: string) => {
    setInstallingIds(prev => { const n = new Set(prev); n.delete(key); return n; });
    setInstallOps(prev => { const n = new Map(prev); n.delete(key); return n; });
  }, []);
  const recordInstallError = useCallback((key: string, op: InstallOp, message: string) => {
    setInstallError(prev => { const n = new Map(prev); n.set(key, { op, message, at: Date.now() }); return n; });
    // Auto-clear after 6s
    setTimeout(() => {
      setInstallError(prev => {
        const entry = prev.get(key);
        if (!entry || Date.now() - entry.at < 6000) return prev;
        const n = new Map(prev); n.delete(key); return n;
      });
    }, 6500);
  }, []);

  // Every mutation below has the same two halves, for the same two reasons
  // (error inventory 2026-09-10, false message 14):
  //   1. The ANSWER is read. These channels mostly RESOLVE their failures —
  //      { status: 'failed', error } or { ok: false, error } — instead of throwing,
  //      and the old code awaited them and carried on: no message, install
  //      telemetry posted for installs that never happened, a failed theme starred.
  //   2. The screen refresh runs AFTER the mutation's own try. Inside it, a refresh
  //      that failed was recorded as "Failed to install" for an install that worked.
  //      fetchAll reports its own failures through `error`.
  const installSkill = useCallback(async (id: string) => {
    const key = installTrackingKey('skill', id);
    markInstalling(key, 'install');
    try {
      const failure = answeredFailure(await window.claude.skills.install(id));
      if (failure) throw new Error(failure);
      // Fire install telemetry after successful local install. Non-blocking — we
      // never fail a local install because the Worker is down. Skip silently when
      // signed out (anonymous installs = no telemetry).
      // Cast via claude() (any) because marketplaceApi + account are exposed
      // in preload/remote-shim but not yet reflected in window.claude's TS type.
      try {
        const signedIn = await claude().account.signedIn();
        if (signedIn) {
          const res = await claude().marketplaceApi.install(id);
          if (!res.ok) console.warn("[marketplace] install telemetry failed:", res.status, res.message);
        }
      } catch (err) {
        console.warn("[marketplace] install telemetry threw (non-fatal):", err);
      }
    } catch (err: any) {
      recordInstallError(key, 'install', err?.message || '');
      clearInstalling(key);
      throw err;
    }
    try {
      await fetchAll();  // Refresh state BEFORE clearing installing flag
      await refreshDrawerSkills();  // Keep CommandDrawer in sync after install
    } catch (err) {
      console.warn('[marketplace] refresh after install failed:', err);
    } finally {
      clearInstalling(key);
    }
  }, [fetchAll, refreshDrawerSkills, markInstalling, clearInstalling, recordInstallError]);

  const uninstallSkill = useCallback(async (id: string) => {
    const key = installTrackingKey('skill', id);
    markInstalling(key, 'uninstall');
    try {
      // A bundled plugin is refused with the code 'bundled' — a word, not a reason.
      const failure = answeredFailure(await window.claude.skills.uninstall(id));
      if (failure) throw new Error(failure === 'bundled' ? 'it comes with YouCoded and cannot be removed' : failure);
    } catch (err: any) {
      recordInstallError(key, 'uninstall', err?.message || '');
      clearInstalling(key);
      throw err;
    }
    try {
      await fetchAll();
      await refreshDrawerSkills();  // Keep CommandDrawer in sync after uninstall
    } catch (err) {
      console.warn('[marketplace] refresh after uninstall failed:', err);
    } finally {
      clearInstalling(key);
    }
  }, [fetchAll, refreshDrawerSkills, markInstalling, clearInstalling, recordInstallError]);

  const installTheme = useCallback(async (slug: string) => {
    const key = installTrackingKey('theme', slug);
    markInstalling(key, 'install');
    try {
      // theme-marketplace:install RESOLVES { status: 'failed' } for a theme that never
      // landed on disk. Stopping here keeps it out of the download count AND out of
      // favorites — both used to happen for a failed install.
      const failure = answeredFailure(await claude().theme.marketplace.install(slug));
      if (failure) throw new Error(failure);
      // Task 22: tell the Worker a theme was installed, so theme cards can show
      // a download count. Themes are recorded under a `theme:<slug>` id, which
      // is how /stats tells them apart from plugins. Same rules as the skill
      // path above: only when signed in, never blocks, and a Worker failure is
      // logged but never fails the install the user actually asked for.
      try {
        const signedIn = await claude().account.signedIn();
        if (signedIn) {
          const stat = await claude().marketplaceApi.install(`theme:${slug}`);
          if (!stat.ok) console.warn("[marketplace] theme install telemetry failed:", stat.status, stat.message);
        }
      } catch (err) {
        console.warn("[marketplace] theme install telemetry threw (non-fatal):", err);
      }
      // Auto-favorite on install (mirrors skills)
      try { await claude().appearance.favoriteTheme(slug, true); } catch {}
    } catch (err: any) {
      recordInstallError(key, 'install', err?.message || '');
      clearInstalling(key);
      throw err;
    }
    try {
      // Fix: reload ThemeProvider's userThemes BEFORE fetchAll flips the
      // "Apply theme" button on. Otherwise the user can click Apply before
      // chokidar's debounced theme:reload event fires (~200ms), and the
      // active-theme fallback effect reverts to the default theme.
      await reloadUserThemes();
      await fetchAll();
      await refreshDrawerSkills();  // Keep CommandDrawer in sync after theme install
    } catch (err) {
      console.warn('[marketplace] refresh after theme install failed:', err);
    } finally {
      clearInstalling(key);
    }
  }, [fetchAll, reloadUserThemes, refreshDrawerSkills, markInstalling, clearInstalling, recordInstallError]);

  const uninstallTheme = useCallback(async (slug: string) => {
    const key = installTrackingKey('theme', slug);
    markInstalling(key, 'uninstall');
    try {
      const failure = answeredFailure(await claude().theme.marketplace.uninstall(slug));
      if (failure) throw new Error(failure);
    } catch (err: any) {
      recordInstallError(key, 'uninstall', err?.message || '');
      clearInstalling(key);
      throw err;
    }
    try {
      // Fix: same reasoning as installTheme — keep userThemes in sync with
      // disk so the active-theme fallback can correctly detect the removed
      // slug and revert to the default theme.
      await reloadUserThemes();
      await fetchAll();
      await refreshDrawerSkills();  // Keep CommandDrawer in sync after theme uninstall
    } catch (err) {
      console.warn('[marketplace] refresh after theme uninstall failed:', err);
    } finally {
      clearInstalling(key);
    }
  }, [fetchAll, reloadUserThemes, refreshDrawerSkills, markInstalling, clearInstalling, recordInstallError]);

  // Phase 3b: update an installed package (skill plugin or theme) by re-downloading
  // from source and overwriting files at the same install path. Config in
  // ~/.claude/youcoded-config/<id>.json is untouched.
  const update = useCallback(async (id: string, type: 'skill' | 'theme') => {
    const key = installTrackingKey(type, id);
    markInstalling(key, 'update');
    let result: any;
    try {
      result = type === 'theme'
        ? await claude().theme.marketplace.update(id)
        : await (window as any).claude.skills.update(id);
      // Both update channels answer { ok: false, error }. Rejecting carries the same
      // reason to UpdateButton, which shows a rejection's message beside the button.
      const failure = answeredFailure(result);
      if (failure) throw new Error(failure);
    } catch (err: any) {
      recordInstallError(key, 'update', err?.message || '');
      clearInstalling(key);
      throw err;
    }
    try {
      // Fix: theme update overwrites manifest + assets on disk; reload so
      // the in-memory theme picks up the new tokens/assets immediately.
      if (type === 'theme') await reloadUserThemes();
      await fetchAll();
      await refreshDrawerSkills();  // Keep CommandDrawer in sync after update — plugin update can change skill manifest
    } catch (err) {
      console.warn('[marketplace] refresh after update failed:', err);
    } finally {
      clearInstalling(key);
    }
    return result;
  }, [fetchAll, reloadUserThemes, refreshDrawerSkills, markInstalling, clearInstalling, recordInstallError]);

  const setFavorite = useCallback(async (id: string, favorited: boolean) => {
    await window.claude.skills.setFavorite(id, favorited);
    // Optimistic update
    setFavoritesState(prev =>
      favorited ? [...prev, id] : prev.filter(f => f !== id)
    );
  }, []);

  const favoriteTheme = useCallback(async (slug: string, favorited: boolean) => {
    await claude().appearance.favoriteTheme(slug, favorited);
    // Optimistic update — broadcast from main will reconcile any drift.
    setThemeFavoritesState(prev =>
      favorited ? [...new Set([...prev, slug])] : prev.filter(s => s !== slug)
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
  //
  // Today this is ONE signal: the version string an author bumps by hand. Two
  // known sharp edges follow from that, and neither is fixed here:
  //   • an entry with no version is recorded as '1.0.0' (the `|| '1.0.0'`
  //     fallbacks in skill-provider.ts), so it can be flagged spuriously;
  //   • an author who changes files without bumping the version is invisible.
  // Two independent signals, OR'd — "either differs" means there is something
  // new to fetch (marketplace overhaul, Tasks 1 + 17):
  //   • the VERSION is what an author bumps deliberately;
  //   • the COMMIT is what actually changed in the repo. Half the catalog
  //     mirrors projects whose authors never touch the version, so without this
  //     their updates were invisible.
  // Kept separate on purpose, and the commit check only ever ADDS a badge:
  //   • no commit recorded on the package (every install made before Task 17)
  //     contributes nothing, so an old library never lights up all at once;
  //   • no commit listed by the catalog (a Worker outage falls back to
  //     index.json, which has no catalog block) contributes nothing either,
  //     rather than reading as "downgraded".
  const updateAvailable = useMemo<Record<string, boolean>>(() => {
    const result: Record<string, boolean> = {};
    for (const entry of skillEntries) {
      const pkg = packages[entry.id];
      if (!pkg) continue; // not installed via marketplace
      const listedCommit = entry.catalog?.sourceCommit;
      const commitMoved = !!pkg.commit && !!listedCommit && pkg.commit !== listedCommit;
      if (isNewerVersion(pkg.version, entry.version) || commitMoved) {
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

  // Multi-window sync: when another Electron window toggles a theme favorite,
  // the main-process handler broadcasts `{themeFavoritesChanged: Date.now()}`
  // on `appearance:sync`. Refetch the list to stay in sync — the payload is
  // just a signal, not the updated data.
  useEffect(() => {
    const onSync = (window as any).claude?.appearance?.onSync;
    if (typeof onSync !== 'function') return;
    const unsub = onSync(async (prefs: any) => {
      if (prefs?.themeFavoritesChanged) {
        try {
          const favs = await (window as any).claude.appearance.getFavoriteThemes();
          setThemeFavoritesState(favs || []);
        } catch { /* best-effort refresh */ }
      }
    });
    return () => { try { unsub?.(); } catch {} };
  }, []);

  // Local user themes are surfaced in themeEntries via on-the-fly synthesis
  // in the main-process listThemes(). When the theme-watcher fires a reload
  // (chokidar detected a change in ~/.claude/wecoded-themes/), the merged
  // list may have changed — refetch so the Library reflects new/deleted/
  // edited user themes immediately rather than at next mount.
  useEffect(() => {
    const onReload = (window as any).claude?.theme?.onReload;
    if (typeof onReload !== 'function') return;
    const unsub = onReload(() => {
      fetchAll();
    });
    return () => { try { unsub?.(); } catch {} };
  }, [fetchAll]);

  // ── Memoized value ───────────────────────────────────────────────────────

  const value = useMemo<MarketplaceContextValue>(() => ({
    skillEntries,
    themeEntries,
    featured,
    packages,
    updateAvailable,
    installedSkills,
    favorites,
    themeFavorites,
    installingIds,
    installOps,
    installError,
    loading,
    error,
    installSkill,
    uninstallSkill,
    installTheme,
    uninstallTheme,
    update,
    setFavorite,
    favoriteTheme,
    refresh: fetchAll,
    publishSkill,
  }), [
    skillEntries, themeEntries, featured, packages, updateAvailable, installedSkills,
    favorites, themeFavorites, installingIds, installError, loading, error,
    installSkill, uninstallSkill, installTheme, uninstallTheme, update,
    setFavorite, favoriteTheme, fetchAll, publishSkill,
  ]);

  return (
    <MarketplaceContext.Provider value={value}>
      {children}
    </MarketplaceContext.Provider>
  );
}
