import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';
import type { SkillEntry, ChipConfig, MetadataOverride, CommandEntry } from '../../shared/types';

interface SkillState {
  installed: SkillEntry[];
  favorites: string[];
  chips: ChipConfig[];
}

interface SkillActions {
  refreshInstalled: () => Promise<void>;
  setFavorite: (id: string, favorited: boolean) => Promise<void>;
  setChips: (chips: ChipConfig[]) => Promise<void>;
  setOverride: (id: string, override: MetadataOverride) => Promise<void>;
  getShareLink: (id: string) => Promise<string>;
  publish: (id: string) => Promise<{ prUrl: string }>;
}

interface SkillContextValue extends SkillState, SkillActions {
  /** Skills filtered for the CommandDrawer: user favorites only. Curated defaults
   *  seed the favorites list on first encounter (see SEEDED_KEY below), not at read time. */
  drawerSkills: SkillEntry[];
  /** Slash commands for the CommandDrawer — shown only in search mode. */
  drawerCommands: CommandEntry[];
}

// localStorage key tracking which curated-default skill ids have already been
// one-time seeded into favorites. Once an id is in this list we never re-seed it,
// so unfavoriting it sticks. Adding NEW curated defaults later still seeds them
// the next time the app loads.
const SEEDED_KEY = 'youcoded-seeded-favorites';

const SkillContext = createContext<SkillContextValue | null>(null);

export function SkillProvider({ children }: { children: ReactNode }) {
  const [installed, setInstalled] = useState<SkillEntry[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [chips, setChipsState] = useState<ChipConfig[]>([]);
  const [drawerCommands, setDrawerCommands] = useState<CommandEntry[]>([]);

  // Fetch slash commands separately from skills — the remote-shim exposes
  // window.claude.commands only when the server supports it, so guard the
  // call and tolerate fetch failures (drawer falls back to skills only).
  useEffect(() => {
    let cancelled = false;
    const api = (window as any).claude?.commands;
    if (!api?.list) return;
    api.list()
      .then((list: CommandEntry[]) => { if (!cancelled) setDrawerCommands(list ?? []); })
      .catch(() => { /* non-fatal — drawer works without commands */ });
    return () => { cancelled = true; };
  }, []);

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
    }).catch((err) => {
      console.error('[SkillContext] Failed to load:', err);
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

  // Drawer shows ALL installed skills. Sorting (favorites first) happens in
  // CommandDrawer itself so callers can apply category/search filters first.
  // The seed-favorites first-run logic still runs — it pre-populates the
  // favorites array so the drawer's Favorites section is non-empty on day 1.
  const drawerSkills = useMemo(() => installed, [installed]);

  // Stable references for pass-through IPC methods (no state dependencies)
  const getShareLink = useCallback((id: string) => window.claude.skills.getShareLink(id), []);
  const publish = useCallback((id: string) => window.claude.skills.publish(id), []);

  const value = useMemo<SkillContextValue>(() => ({
    installed, favorites, chips, drawerSkills, drawerCommands,
    refreshInstalled, setFavorite: setFavoriteAction, setChips: setChipsAction,
    setOverride: setOverrideAction, getShareLink, publish,
  }), [installed, favorites, chips, drawerSkills, drawerCommands,
       refreshInstalled, setFavoriteAction, setChipsAction, setOverrideAction,
       getShareLink, publish]);

  return <SkillContext.Provider value={value}>{children}</SkillContext.Provider>;
}

export function useSkills(): SkillContextValue {
  const ctx = useContext(SkillContext);
  if (!ctx) throw new Error('useSkills must be used within SkillProvider');
  return ctx;
}
