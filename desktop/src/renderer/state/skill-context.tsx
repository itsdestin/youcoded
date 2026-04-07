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
  /** Skills filtered for the CommandDrawer: favorites ∪ curated defaults */
  drawerSkills: SkillEntry[];
}

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
    ]).then(([inst, favs, ch, defaults]) => {
      setInstalled(inst);
      setFavorites(favs);
      setChipsState(ch);
      setCuratedDefaults(defaults);
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

  // Compute drawer skills: favorites ∪ curated defaults, favorites sorted first
  const drawerSkills = useMemo(() => {
    const favSet = new Set(favorites);
    const ids = new Set([...favorites, ...curatedDefaults]);
    return installed
      .filter(s => ids.has(s.id))
      .sort((a, b) => {
        const aFav = favSet.has(a.id) ? 0 : 1;
        const bFav = favSet.has(b.id) ? 0 : 1;
        return aFav - bFav;
      });
  }, [installed, favorites, curatedDefaults]);

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
