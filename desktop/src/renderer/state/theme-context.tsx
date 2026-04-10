import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
// @ts-ignore — Vite inline CSS import
import hljsDarkCss from 'highlight.js/styles/github-dark.css?inline';
// @ts-ignore — Vite inline CSS import
import hljsLightCss from 'highlight.js/styles/github.css?inline';

import { validateTheme } from '../themes/theme-validator';
import { applyThemeToDom, applyThemeFont, buildBackgroundStyle, buildPatternStyle } from '../themes/theme-engine';
import type { ThemeDefinition, LoadedTheme } from '../themes/theme-types';
import { resolveAllAssetPaths } from '../themes/theme-asset-resolver';

// Built-in themes imported as JSON (Vite handles JSON imports natively)
import lightJson from '../themes/builtin/light.json';
import darkJson from '../themes/builtin/dark.json';
import midnightJson from '../themes/builtin/midnight.json';
import cremeJson from '../themes/builtin/creme.json';

const BUILTIN_THEMES: LoadedTheme[] = [
  { ...(lightJson as unknown as ThemeDefinition), source: 'destinclaude' },
  { ...(darkJson as unknown as ThemeDefinition), source: 'destinclaude' },
  { ...(midnightJson as unknown as ThemeDefinition), source: 'destinclaude' },
  { ...(cremeJson as unknown as ThemeDefinition), source: 'destinclaude' },
];

export const DEFAULT_FONT_FAMILY = "'Cascadia Mono', 'Cascadia Code', 'Fira Code', monospace";

const STORAGE_KEY = 'destincode-theme';
const CYCLE_KEY = 'destincode-theme-cycle';
const REDUCED_EFFECTS_KEY = 'destincode-reduced-effects';
const SHOW_TIMESTAMPS_KEY = 'destincode-show-timestamps';
const DEFAULT_THEME = 'midnight';
const DEFAULT_CYCLE = ['midnight', 'dark'];
/** Reserved slug for live-preview during /theme-builder — auto-switches on write, reverts on delete. */
const PREVIEW_SLUG = '_preview';

interface ThemeContextValue {
  theme: string;
  setTheme: (slug: string) => void;
  cycleTheme: () => void;
  cycleList: string[];
  setCycleList: (list: string[]) => void;
  font: string;
  reducedEffects: boolean;
  setReducedEffects: (v: boolean) => void;
  showTimestamps: boolean;
  setShowTimestamps: (v: boolean) => void;
  allThemes: LoadedTheme[];
  activeTheme: LoadedTheme;
  bgStyle: Record<string, string> | null;
  patternStyle: Record<string, string> | null;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME, setTheme: () => {}, cycleTheme: () => {},
  cycleList: DEFAULT_CYCLE, setCycleList: () => {},
  font: DEFAULT_FONT_FAMILY,
  reducedEffects: false, setReducedEffects: () => {},
  showTimestamps: true, setShowTimestamps: () => {},
  allThemes: BUILTIN_THEMES, activeTheme: BUILTIN_THEMES[0], bgStyle: null, patternStyle: null,
});

function getStored(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function getStoredJSON<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

/** Fire-and-forget write of appearance prefs to disk via IPC */
function persistAppearance(prefs: Record<string, any>) {
  try { (window as any).claude?.appearance?.set(prefs); } catch {}
}

function applyFont(font: string) {
  document.documentElement.style.setProperty('--font-sans', font);
  document.documentElement.style.setProperty('--font-mono', font);
}

function applyHighlightTheme(dark: boolean) {
  const id = 'hljs-theme';
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
  el.textContent = dark ? hljsDarkCss : hljsLightCss;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [activeSlug, setActiveSlug] = useState(() => getStored(STORAGE_KEY, DEFAULT_THEME));
  const [cycleList, setCycleListState] = useState<string[]>(() => getStoredJSON(CYCLE_KEY, DEFAULT_CYCLE));
  const [font, setFontState] = useState(DEFAULT_FONT_FAMILY);
  const [reducedEffects, setReducedEffectsState] = useState(() => getStored(REDUCED_EFFECTS_KEY, '') === '1');
  const [showTimestamps, setShowTimestampsState] = useState(() => getStored(SHOW_TIMESTAMPS_KEY, '1') !== '0');
  const [userThemes, setUserThemes] = useState<LoadedTheme[]>([]);
  const [userThemesLoaded, setUserThemesLoaded] = useState(false);

  // All themes including _preview (for engine lookup) — memoized to stabilize references
  const allThemesInternal = useMemo(() => [...BUILTIN_THEMES, ...userThemes], [userThemes]);
  // Public list excludes _preview (UI pickers shouldn't show it)
  const allThemes = useMemo(() => allThemesInternal.filter(t => t.slug !== PREVIEW_SLUG), [allThemesInternal]);
  const activeTheme = useMemo(() => allThemesInternal.find(t => t.slug === activeSlug) ?? BUILTIN_THEMES[0], [allThemesInternal, activeSlug]);

  // Fallback if active theme was uninstalled (slug no longer in allThemes).
  // Guard: skip until user themes have loaded, otherwise a valid community/user
  // theme would be falsely detected as "uninstalled" before its theme file loads.
  useEffect(() => {
    if (!userThemesLoaded) return;
    if (!allThemes.find(t => t.slug === activeSlug)) {
      setActiveSlug(DEFAULT_THEME);
      try { localStorage.setItem(STORAGE_KEY, DEFAULT_THEME); } catch {}
      persistAppearance({ theme: DEFAULT_THEME });
    }
  }, [allThemes, activeSlug, userThemesLoaded]);

  // Load user themes from disk on mount
  useEffect(() => {
    const loadUserThemes = async () => {
      try {
        const claude = (window as any).claude;
        if (!claude?.theme?.list) { setUserThemesLoaded(true); return; }
        const slugs: string[] = await claude.theme.list();
        const loaded: LoadedTheme[] = [];
        for (const slug of slugs) {
          try {
            const raw = await claude.theme.readFile(slug);
            const theme = validateTheme(JSON.parse(raw));
            const source = (theme as any).source === 'community' ? 'community' as const : 'user' as const;
            loaded.push(resolveAllAssetPaths({ ...theme, source }));
          } catch (e) {
            console.warn(`[ThemeProvider] Failed to load user theme "${slug}":`, e);
          }
        }
        setUserThemes(loaded);
        setUserThemesLoaded(true);
      } catch {
        setUserThemesLoaded(true); // Mark loaded even on error so fallback can run
      }
    };
    loadUserThemes();
  }, []);

  // Load appearance preferences from disk (source of truth) on mount
  useEffect(() => {
    const loadAppearance = async () => {
      try {
        const claude = (window as any).claude;
        if (!claude?.appearance?.get) return;
        const prefs = await claude.appearance.get();
        if (!prefs) return; // First launch — no file yet, keep localStorage/defaults

        if (prefs.theme && typeof prefs.theme === 'string') {
          setActiveSlug(prefs.theme);
          try { localStorage.setItem(STORAGE_KEY, prefs.theme); } catch {}
          document.documentElement.setAttribute('data-theme', prefs.theme);
        }
        if (Array.isArray(prefs.themeCycle) && prefs.themeCycle.length > 0) {
          setCycleListState(prefs.themeCycle);
          try { localStorage.setItem(CYCLE_KEY, JSON.stringify(prefs.themeCycle)); } catch {}
        }
        if (typeof prefs.reducedEffects === 'boolean') {
          setReducedEffectsState(prefs.reducedEffects);
          try { localStorage.setItem(REDUCED_EFFECTS_KEY, prefs.reducedEffects ? '1' : ''); } catch {}
        }
        if (typeof prefs.showTimestamps === 'boolean') {
          setShowTimestampsState(prefs.showTimestamps);
          try { localStorage.setItem(SHOW_TIMESTAMPS_KEY, prefs.showTimestamps ? '1' : '0'); } catch {}
        }
      } catch {}
    };
    loadAppearance();
  }, []);

  // Track the slug the user had before preview auto-switch
  const [prePreviewSlug, setPrePreviewSlug] = useState<string | null>(null);

  // Listen for hot-reload signal from main process
  useEffect(() => {
    const claude = (window as any).claude;
    if (!claude?.theme?.onReload) return;
    const cleanup = claude.theme.onReload((slug: string) => {
      claude.theme.readFile(slug).then((raw: string) => {
        try {
          const theme = validateTheme(JSON.parse(raw));
          const source = (theme as any).source === 'community' ? 'community' as const : 'user' as const;
          const loaded: LoadedTheme = resolveAllAssetPaths({ ...theme, source });
          setUserThemes(prev => {
            const idx = prev.findIndex(t => t.slug === slug);
            if (idx >= 0) { const next = [...prev]; next[idx] = loaded; return next; }
            return [...prev, loaded];
          });

          if (slug === PREVIEW_SLUG) {
            // Auto-switch to preview theme, remembering previous
            setActiveSlug(prev => {
              setPrePreviewSlug(p => p ?? prev); // only save if not already previewing
              return slug;
            });
          } else {
            // Only switch to the reloaded theme if the user is already viewing it
            setActiveSlug(prev => {
              if (prev !== slug) return prev;
              try { localStorage.setItem(STORAGE_KEY, slug); } catch {}
              return slug;
            });
          }
        } catch (e) {
          console.warn(`[ThemeProvider] Hot-reload failed for "${slug}":`, e);
        }
      }).catch(() => {
        // readFile failed — theme was likely deleted
        if (slug === PREVIEW_SLUG) {
          // Preview theme removed — revert to pre-preview theme
          setUserThemes(prev => prev.filter(t => t.slug !== PREVIEW_SLUG));
          setActiveSlug(prev => {
            if (prev !== PREVIEW_SLUG) return prev;
            const revert = prePreviewSlug ?? DEFAULT_THEME;
            setPrePreviewSlug(null);
            try { localStorage.setItem(STORAGE_KEY, revert); } catch {}
            persistAppearance({ theme: revert });
            return revert;
          });
        }
      });
    });
    return cleanup;
  }, [prePreviewSlug]);

  // Apply theme to DOM whenever active theme or reduced-effects changes
  useEffect(() => {
    applyThemeToDom(activeTheme, reducedEffects);
    applyHighlightTheme(activeTheme.dark);

    // Sync font state: use theme's declared font, or fall back to default
    if (activeTheme.font?.family) {
      setFontState(activeTheme.font.family);
    } else {
      setFontState(DEFAULT_FONT_FAMILY);
      applyFont(DEFAULT_FONT_FAMILY);
    }
  }, [activeTheme, reducedEffects]);

  const setTheme = useCallback((slug: string) => {
    setActiveSlug(slug);
    try { localStorage.setItem(STORAGE_KEY, slug); } catch {}
    if (slug !== PREVIEW_SLUG) persistAppearance({ theme: slug });
  }, []);

  const setCycleList = useCallback((list: string[]) => {
    const safe = list.length > 0 ? list : DEFAULT_CYCLE;
    setCycleListState(safe);
    try { localStorage.setItem(CYCLE_KEY, JSON.stringify(safe)); } catch {}
    persistAppearance({ themeCycle: safe });
  }, []);

  const setReducedEffects = useCallback((v: boolean) => {
    setReducedEffectsState(v);
    try { localStorage.setItem(REDUCED_EFFECTS_KEY, v ? '1' : ''); } catch {}
    persistAppearance({ reducedEffects: v });
  }, []);

  const setShowTimestamps = useCallback((v: boolean) => {
    setShowTimestampsState(v);
    try { localStorage.setItem(SHOW_TIMESTAMPS_KEY, v ? '1' : '0'); } catch {}
    persistAppearance({ showTimestamps: v });
  }, []);

  const cycleTheme = useCallback(() => {
    setActiveSlug(prev => {
      // If currently previewing, exit preview and cycle from the pre-preview theme
      if (prev === PREVIEW_SLUG && prePreviewSlug) {
        setPrePreviewSlug(null);
        try { localStorage.setItem(STORAGE_KEY, prePreviewSlug); } catch {}
        persistAppearance({ theme: prePreviewSlug });
        return prePreviewSlug;
      }
      const pool = allThemes.filter(t => cycleList.includes(t.slug));
      if (pool.length === 0) return prev;
      const idx = pool.findIndex(t => t.slug === prev);
      const next = idx === -1 ? pool[0].slug : pool[(idx + 1) % pool.length].slug;
      try { localStorage.setItem(STORAGE_KEY, next); } catch {}
      persistAppearance({ theme: next });
      return next;
    });
  }, [allThemes, cycleList, prePreviewSlug]);

  const bgStyle = useMemo(
    () => buildBackgroundStyle(activeTheme.background) as Record<string, string> | null,
    [activeTheme.background],
  );
  const patternStyle = useMemo(
    () => buildPatternStyle(activeTheme.background?.pattern, activeTheme.background?.['pattern-opacity']) as Record<string, string> | null,
    [activeTheme.background?.pattern, activeTheme.background?.['pattern-opacity']],
  );

  const value = useMemo(() => ({
    theme: activeSlug, setTheme, cycleTheme,
    cycleList, setCycleList, font,
    reducedEffects, setReducedEffects,
    showTimestamps, setShowTimestamps,
    allThemes, activeTheme, bgStyle, patternStyle,
  }), [activeSlug, setTheme, cycleTheme, cycleList, setCycleList, font,
       reducedEffects, setReducedEffects, showTimestamps, setShowTimestamps,
       allThemes, activeTheme, bgStyle, patternStyle]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() { return useContext(ThemeContext); }
