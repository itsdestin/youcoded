import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';
import type { SkillEntry, ChipConfig, MetadataOverride, CommandEntry } from '../../shared/types';
import { useOnRemoteReconnect } from '../hooks/useOnRemoteReconnect';
import { plainMessage } from '../utils/ipc-error';

interface SkillState {
  installed: SkillEntry[];
  favorites: string[];
  chips: ChipConfig[];
  /** Why the last load of installed skills failed, in plain words; null once one works.
   *  `installed` is [] both when nothing is installed and when loading failed — this is
   *  the only way a screen can tell those apart. */
  loadError: string | null;
}

interface SkillActions {
  refreshInstalled: () => Promise<void>;
  /** Run the initial load again — what a Retry behind `loadError` calls. */
  retryLoad: () => void;
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
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch slash commands separately from skills — the remote-shim exposes
  // window.claude.commands only when the server supports it, so guard the
  // call and tolerate fetch failures (drawer falls back to skills only).
  const loadCommands = useCallback(() => {
    const api = (window as any).claude?.commands;
    if (!api?.list) return;
    api.list()
      .then((list: CommandEntry[]) => setDrawerCommands(list ?? []))
      .catch(() => { /* non-fatal — drawer works without commands */ });
  }, []);
  useEffect(() => { loadCommands(); }, [loadCommands]);

  // Load initial state.
  // WHY the failure is kept (error inventory 2026-09-10, false message 10): this catch
  // only logged, so one failed call left `installed` at [] for the whole app run and the
  // command drawer told someone with skills "No skills installed yet." — with no way to
  // try again short of restarting the app. `retryLoad` re-runs exactly this.
  const load = useCallback(() => {
    Promise.all([
      window.claude.skills.list(),
      window.claude.skills.getFavorites(),
      window.claude.skills.getChips(),
      window.claude.skills.getCuratedDefaults(),
    ]).then(async ([inst, favs, ch, defaults]) => {
      setInstalled(inst ?? []);
      setChipsState(ch ?? []);
      setLoadError(null);

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
      setLoadError(plainMessage(err));
    });
  }, []);
  useEffect(() => { load(); }, [load]);
  // Both again after a remote reconnect: a read lost during a drop left "No skills installed
  // yet" and a / menu with no commands until the page reloaded (2026-09-11 phone pass sweep).
  // Re-running the seeding is safe: it skips every id already recorded in SEEDED_KEY.
  useOnRemoteReconnect(() => { loadCommands(); load(); });


  const refreshInstalled = useCallback(async () => {
    const inst = await window.claude.skills.list();
    setInstalled(inst);
    // A list that loaded answers an earlier failed load.
    setLoadError(null);
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
    installed, favorites, chips, loadError, drawerSkills, drawerCommands,
    refreshInstalled, retryLoad: load, setFavorite: setFavoriteAction, setChips: setChipsAction,
    setOverride: setOverrideAction, getShareLink, publish,
  }), [installed, favorites, chips, loadError, drawerSkills, drawerCommands,
       refreshInstalled, load, setFavoriteAction, setChipsAction, setOverrideAction,
       getShareLink, publish]);

  return <SkillContext.Provider value={value}>{children}</SkillContext.Provider>;
}

export function useSkills(): SkillContextValue {
  const ctx = useContext(SkillContext);
  if (!ctx) throw new Error('useSkills must be used within SkillProvider');
  return ctx;
}
