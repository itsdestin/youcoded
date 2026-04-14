import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';
import type { SkillEntry, ChipConfig, MetadataOverride, SkillFilters, SkillDetailView } from '../../shared/types';

interface SkillState {
  installed: SkillEntry[];
  favorites: string[];
  chips: ChipConfig[];
  curatedDefaults: string[];
  loading: boolean;
}

interface SkillActions {
  refreshInstalled: () => Promise<void>;
  setFavorite: (id: string, favorited: boolean) => Promise<void>;
  setChips: (chips: ChipConfig[]) => Promise<void>;
  setOverride: (id: string, override: MetadataOverride) => Promise<void>;
  createPrompt: (skill: Omit<SkillEntry, 'id'>) => Promise<SkillEntry>;
  deletePrompt: (id: string) => Promise<void>;
  install: (id: string) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  listMarketplace: (filters?: SkillFilters) => Promise<SkillEntry[]>;
  getDetail: (id: string) => Promise<SkillDetailView>;
  search: (query: string) => Promise<SkillEntry[]>;
  getShareLink: (id: string) => Promise<string>;
  importFromLink: (encoded: string) => Promise<SkillEntry>;
  publish: (id: string) => Promise<{ prUrl: string }>;
}

interface SkillContextValue extends SkillState, SkillActions {
  /** Skills filtered for the CommandDrawer: user favorites only. Curated defaults
   *  seed the favorites list on first encounter (see SEEDED_KEY below), not at read time. */
  drawerSkills: SkillEntry[];
}

// localStorage key tracking which curated-default skill ids have already been
// one-time seeded into favorites. Once an id is in this list we never re-seed it,
// so unfavoriting it sticks. Adding NEW curated defaults later still seeds them
// the next time the app loads.
const SEEDED_KEY = 'destincode-seeded-favorites';

const SkillContext = createContext<SkillContextValue | null>(null);

export function SkillProvider({ children }: { children: ReactNode }) {
  const [installed, setInstalled] = useState<SkillEntry[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [chips, setChipsState] = useState<ChipConfig[]>([]);
  const [curatedDefaults, setCuratedDefaults] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Load initial state
  useEffect(() => {
    Promise.all([
      window.claude.skills.list(),
      window.claude.skills.getFavorites(),
      window.claude.skills.getChips(),
      window.claude.skills.getCuratedDefaults(),
    ]).then(async ([inst, favs, ch, defaults]) => {
      setInstalled(inst ?? []);
      setChipsState(ch ?? []);
      setCuratedDefaults(defaults ?? []); // Guard: IPC may return undefined if registry key mismatches

      // First-run seeding: for each curated default we haven't seeded before,
      // persist it as a favorite so the drawer is non-empty out of the box.
      // We track seeded ids separately so unfavoriting sticks permanently.
      const curated = defaults ?? [];
      const currentFavs = favs ?? [];
      let seeded: string[] = [];
      try { seeded = JSON.parse(localStorage.getItem(SEEDED_KEY) ?? '[]'); } catch {}
      const toSeed = curated.filter(id => !seeded.includes(id));
      if (toSeed.length > 0) {
        const favSet = new Set(currentFavs);
        for (const id of toSeed) {
          if (!favSet.has(id)) {
            try { await window.claude.skills.setFavorite(id, true); favSet.add(id); } catch {}
          }
        }
        localStorage.setItem(SEEDED_KEY, JSON.stringify([...new Set([...seeded, ...toSeed])]));
        setFavorites(Array.from(favSet));
      } else {
        setFavorites(currentFavs);
      }
      setLoading(false);
    }).catch((err) => {
      console.error('[SkillContext] Failed to load:', err);
      setLoading(false);
    });
  }, []);

  const refreshInstalled = useCallback(async () => {
    const inst = await window.claude.skills.list();
    setInstalled(inst);
  }, []);

  const setFavoriteAction = useCallback(async (id: string, favorited: boolean) => {
    await window.claude.skills.setFavorite(id, favorited);
    setFavorites(prev => favorited ? [...new Set([...prev, id])] : prev.filter(f => f !== id));
  }, []);

  const setChipsAction = useCallback(async (newChips: ChipConfig[]) => {
    await window.claude.skills.setChips(newChips);
    setChipsState(newChips);
  }, []);

  const setOverrideAction = useCallback(async (id: string, override: MetadataOverride) => {
    await window.claude.skills.setOverride(id, override);
    await refreshInstalled();
  }, [refreshInstalled]);

  const createPromptAction = useCallback(async (skill: Omit<SkillEntry, 'id'>) => {
    const entry = await window.claude.skills.createPrompt(skill);
    await refreshInstalled();
    return entry;
  }, [refreshInstalled]);

  const deletePromptAction = useCallback(async (id: string) => {
    await window.claude.skills.deletePrompt(id);
    setFavorites(prev => prev.filter(f => f !== id));
    setChipsState(prev => prev.filter(c => c.skillId !== id));
    await refreshInstalled();
  }, [refreshInstalled]);

  const installAction = useCallback(async (id: string) => {
    await window.claude.skills.install(id);
    await refreshInstalled();
  }, [refreshInstalled]);

  const uninstallAction = useCallback(async (id: string) => {
    await window.claude.skills.uninstall(id);
    await refreshInstalled();
  }, [refreshInstalled]);

  // Drawer shows only user favorites. Curated defaults seed favorites on first run
  // (see initial-load effect); after that the user fully controls what's in the drawer.
  // Favorites may hold PACKAGE ids (e.g. "destinclaude-encyclopedia") post-decomposition,
  // so also match skill.pluginName — a single favorited package surfaces all its skills.
  const drawerSkills = useMemo(() => {
    const favSet = new Set(favorites);
    return installed.filter(s => favSet.has(s.id) || (s.pluginName && favSet.has(s.pluginName)));
  }, [installed, favorites]);

  // Stable references for pass-through IPC methods (no state dependencies)
  const listMarketplace = useCallback((filters?: SkillFilters) => window.claude.skills.listMarketplace(filters), []);
  const getDetail = useCallback((id: string) => window.claude.skills.getDetail(id), []);
  const search = useCallback((query: string) => window.claude.skills.search(query), []);
  const getShareLink = useCallback((id: string) => window.claude.skills.getShareLink(id), []);
  const importFromLink = useCallback((encoded: string) => window.claude.skills.importFromLink(encoded), []);
  const publish = useCallback((id: string) => window.claude.skills.publish(id), []);

  const value = useMemo<SkillContextValue>(() => ({
    installed, favorites, chips, curatedDefaults, loading, drawerSkills,
    refreshInstalled, setFavorite: setFavoriteAction, setChips: setChipsAction,
    setOverride: setOverrideAction, createPrompt: createPromptAction,
    deletePrompt: deletePromptAction, install: installAction, uninstall: uninstallAction,
    listMarketplace, getDetail, search, getShareLink, importFromLink, publish,
  }), [installed, favorites, chips, curatedDefaults, loading, drawerSkills,
       refreshInstalled, setFavoriteAction, setChipsAction, setOverrideAction,
       createPromptAction, deletePromptAction, installAction, uninstallAction,
       listMarketplace, getDetail, search, getShareLink, importFromLink, publish]);

  return <SkillContext.Provider value={value}>{children}</SkillContext.Provider>;
}

export function useSkills(): SkillContextValue {
  const ctx = useContext(SkillContext);
  if (!ctx) throw new Error('useSkills must be used within SkillProvider');
  return ctx;
}
