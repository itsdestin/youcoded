import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
// @ts-ignore — Vite inline CSS import
import hljsDarkCss from 'highlight.js/styles/github-dark.css?inline';
// @ts-ignore — Vite inline CSS import
import hljsLightCss from 'highlight.js/styles/github.css?inline';

import { validateTheme } from '../themes/theme-validator';
import { applyThemeToDom, applyThemeFont, buildBackgroundStyle, buildPatternStyle } from '../themes/theme-engine';
import type { ThemeDefinition, LoadedTheme } from '../themes/theme-types';
import { resolveAllAssetPaths } from '../themes/theme-asset-resolver';
import { buildDefaultIconSvg, rasterizeSvgToPngDataUrl } from '../themes/theme-default-icon';

// Built-in themes imported as JSON (Vite handles JSON imports natively)
import lightJson from '../themes/builtin/light.json';
import darkJson from '../themes/builtin/dark.json';
import midnightJson from '../themes/builtin/midnight.json';
import cremeJson from '../themes/builtin/creme.json';

const BUILTIN_THEMES: LoadedTheme[] = [
  { ...(lightJson as unknown as ThemeDefinition), source: 'youcoded-core' },
  { ...(darkJson as unknown as ThemeDefinition), source: 'youcoded-core' },
  { ...(midnightJson as unknown as ThemeDefinition), source: 'youcoded-core' },
  { ...(cremeJson as unknown as ThemeDefinition), source: 'youcoded-core' },
];

export const DEFAULT_FONT_FAMILY = "'Cascadia Mono', 'Cascadia Code', 'Fira Code', monospace";

const STORAGE_KEY = 'youcoded-theme';
const CYCLE_KEY = 'youcoded-theme-cycle';
const REDUCED_EFFECTS_KEY = 'youcoded-reduced-effects';
const SHOW_TIMESTAMPS_KEY = 'youcoded-show-timestamps';
const SHOW_TURN_METADATA_KEY = 'youcoded-show-turn-metadata';
const GLASS_OVERRIDES_KEY = 'youcoded-glass-overrides';
const DEFAULT_THEME = 'midnight';
const DEFAULT_CYCLE = ['midnight', 'dark'];

/** Per-theme glass overrides for non-user themes (community/builtin).
 *  User themes write directly to the theme file instead. */
export type GlassOverrides = {
  'panels-blur'?: number;
  'panels-opacity'?: number;
  'bubble-blur'?: number;
  'bubble-opacity'?: number;
  // Terminal transparency sliders (see TerminalView + theme-engine). Kept in the
  // same override bag as glass — same persistence, same per-slug scoping.
  'terminal-opacity'?: number;
  'terminal-blur'?: number;
  'terminal-brightness'?: number;
};
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
  showTurnMetadata: boolean;
  setShowTurnMetadata: (v: boolean) => void;
  allThemes: LoadedTheme[];
  activeTheme: LoadedTheme;
  bgStyle: Record<string, string> | null;
  patternStyle: Record<string, string> | null;
  /** Update a glass override for a non-user theme (community/builtin).
   *  Overrides persist per-slug so switching themes preserves the user's preference. */
  setGlassOverride: (slug: string, field: string, value: number) => void;
  /** Re-read user themes from disk. Call after install/uninstall so the
   *  context's userThemes list stays in sync (the active-theme fallback
   *  effect then auto-resets to the default if the active slug vanished). */
  reloadUserThemes: () => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME, setTheme: () => {}, cycleTheme: () => {},
  cycleList: DEFAULT_CYCLE, setCycleList: () => {},
  font: DEFAULT_FONT_FAMILY,
  reducedEffects: false, setReducedEffects: () => {},
  showTimestamps: true, setShowTimestamps: () => {},
  showTurnMetadata: false, setShowTurnMetadata: () => {},
  allThemes: BUILTIN_THEMES, activeTheme: BUILTIN_THEMES[0], bgStyle: null, patternStyle: null,
  setGlassOverride: () => {},
  reloadUserThemes: async () => {},
});

function getStored(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function getStoredJSON<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

/** Fire-and-forget write of appearance prefs to disk via IPC, plus a peer-
 *  window broadcast so ThemeProvider in other windows applies the change
 *  live (no reload). The broadcast is a no-op on single-window hosts. */
function persistAppearance(prefs: Record<string, any>) {
  try { (window as any).claude?.appearance?.set(prefs); } catch {}
  try { (window as any).claude?.appearance?.broadcast?.(prefs); } catch {}
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
  // Task 5.1: opt-in per-turn metadata strip (model, tokens, cache hit %).
  // Defaults to false — advanced diagnostic signal, mirrors the "default hidden"
  // treatment of StatusBar's derived-metric widgets (commit da18ee7).
  const [showTurnMetadata, setShowTurnMetadataState] = useState(() => getStored(SHOW_TURN_METADATA_KEY, '') === '1');
  const [userThemes, setUserThemes] = useState<LoadedTheme[]>([]);
  const [userThemesLoaded, setUserThemesLoaded] = useState(false);
  // Glass overrides for non-user themes — keyed by theme slug, persisted to
  // localStorage and disk so users can tweak community/builtin glass values
  // without modifying the theme file they don't own.
  const [glassOverrides, setGlassOverrides] = useState<Record<string, GlassOverrides>>(
    () => getStoredJSON(GLASS_OVERRIDES_KEY, {} as Record<string, GlassOverrides>)
  );

  // All themes including _preview (for engine lookup) — memoized to stabilize references
  const allThemesInternal = useMemo(() => [...BUILTIN_THEMES, ...userThemes], [userThemes]);
  // Public list excludes _preview (UI pickers shouldn't show it)
  const allThemes = useMemo(() => allThemesInternal.filter(t => t.slug !== PREVIEW_SLUG), [allThemesInternal]);
  const activeThemeRaw = useMemo(() => allThemesInternal.find(t => t.slug === activeSlug) ?? BUILTIN_THEMES[0], [allThemesInternal, activeSlug]);

  // Merge glass overrides into the active theme for non-user themes.
  // User themes write glass values directly to the theme file. For solid
  // themes the sliders are disabled (see ThemeScreen.tsx) so overrides
  // wouldn't normally be written — but we keep the override values in
  // place so if a user later upgrades a solid theme to a wallpaper theme
  // their saved glass values survive. Fix: dropped the solid-background
  // guard that used to discard overrides for non-image backgrounds.
  const activeTheme = useMemo(() => {
    const overrides = glassOverrides[activeSlug];
    if (!overrides || activeThemeRaw.source === 'user') return activeThemeRaw;
    const base = activeThemeRaw.background ?? ({ type: 'solid', value: '' } as const);
    return {
      ...activeThemeRaw,
      background: { ...base, ...overrides },
    };
  }, [activeThemeRaw, activeSlug, glassOverrides]);

  // Fallback if active theme was uninstalled (slug no longer in allThemes).
  // Guard: skip until user themes have loaded, otherwise a valid community/user
  // theme would be falsely detected as "uninstalled" before its theme file loads.
  useEffect(() => {
    if (!userThemesLoaded) return;
    // Check allThemesInternal (includes _preview) not allThemes (filters it out) —
    // otherwise the fallback would treat _preview as "uninstalled" and reset to
    // DEFAULT, silently undoing every theme-builder preview activation.
    if (!allThemesInternal.find(t => t.slug === activeSlug)) {
      setActiveSlug(DEFAULT_THEME);
      try { localStorage.setItem(STORAGE_KEY, DEFAULT_THEME); } catch {}
      persistAppearance({ theme: DEFAULT_THEME });
    }
  }, [allThemesInternal, activeSlug, userThemesLoaded]);

  // Re-read all user themes from disk. Exposed so install/uninstall flows
  // can refresh the list; the active-theme fallback effect (above) uses the
  // refreshed list to reset to the default if the user just uninstalled the
  // theme they had applied.
  const reloadUserThemes = useCallback(async () => {
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
  }, []);

  // Initial load on mount
  useEffect(() => { reloadUserThemes(); }, [reloadUserThemes]);

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
        if (typeof prefs.showTurnMetadata === 'boolean') {
          setShowTurnMetadataState(prefs.showTurnMetadata);
          try { localStorage.setItem(SHOW_TURN_METADATA_KEY, prefs.showTurnMetadata ? '1' : '0'); } catch {}
        }
        // Load per-theme glass overrides from disk (same pattern as theme/cycle)
        if (prefs.glassOverrides && typeof prefs.glassOverrides === 'object') {
          setGlassOverrides(prefs.glassOverrides);
          try { localStorage.setItem(GLASS_OVERRIDES_KEY, JSON.stringify(prefs.glassOverrides)); } catch {}
        }
      } catch {}
    };
    loadAppearance();
  }, []);

  // Listen for cross-window appearance broadcasts from peer windows. The
  // source window already persisted to disk, so we only update in-memory
  // state + localStorage here. No re-broadcast — that would bounce forever.
  useEffect(() => {
    const onSync = (window as any).claude?.appearance?.onSync;
    if (typeof onSync !== 'function') return;
    const unsub = onSync((prefs: any) => {
      if (!prefs || typeof prefs !== 'object') return;
      if (typeof prefs.theme === 'string' && prefs.theme) {
        setActiveSlug(prefs.theme);
        try { localStorage.setItem(STORAGE_KEY, prefs.theme); } catch {}
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
      if (typeof prefs.showTurnMetadata === 'boolean') {
        setShowTurnMetadataState(prefs.showTurnMetadata);
        try { localStorage.setItem(SHOW_TURN_METADATA_KEY, prefs.showTurnMetadata ? '1' : '0'); } catch {}
      }
      if (prefs.glassOverrides && typeof prefs.glassOverrides === 'object') {
        setGlassOverrides(prefs.glassOverrides);
        try { localStorage.setItem(GLASS_OVERRIDES_KEY, JSON.stringify(prefs.glassOverrides)); } catch {}
      }
    });
    return () => { try { unsub?.(); } catch {} };
  }, []);

  // Track the slug the user had before preview auto-switch
  const [prePreviewSlug, setPrePreviewSlug] = useState<string | null>(null);

  // Initial-load auto-switch to _preview.
  // Without this, a _preview folder that exists BEFORE the app starts (e.g. user
  // restarted mid-theme-build, or chokidar's `ignoreInitial: true` skipped the
  // add event because files settled before the watcher mounted) loads into
  // userThemes but never activates — theme-builder appears to "silently fail."
  // Runs once after initial theme load completes. Does NOT persist to
  // localStorage/appearance — preview is ephemeral; deleting the folder reverts.
  useEffect(() => {
    if (!userThemesLoaded) return;
    if (activeSlug === PREVIEW_SLUG) return; // localStorage shouldn't hold this, but guard anyway
    if (!userThemes.some(t => t.slug === PREVIEW_SLUG)) return;
    setPrePreviewSlug(p => p ?? activeSlug);
    setActiveSlug(PREVIEW_SLUG);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userThemesLoaded]);

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
          // Dir name and manifest.slug must match — renderer keys activeSlug on dir
          // name but resolves the active theme by .slug. A mismatch silently falls
          // back to the built-in default theme. Warn loudly to catch theme-builder
          // footguns during authoring.
          if (theme.slug !== slug) {
            console.warn(
              `[ThemeProvider] Slug mismatch for theme dir "${slug}": manifest.slug is "${theme.slug}". ` +
              `The app keys activeSlug on the directory name — this theme will silently fall back to the default.`
            );
          }
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

    // Hot-swap the Electron window + dock icon. Guarded via optional chaining —
    // the Android WebView shim deliberately omits window.* (launcher icons can't
    // be swapped at runtime), so this is a no-op there.
    // If the theme declares its own appIcon we use it directly; otherwise we
    // synthesize a theme-tinted variant of the default YouCoded glyph so every
    // theme (built-in, community, user, marketplace) gets a matching icon without
    // shipping per-theme artwork.
    let iconCancelled = false;
    const anyWin = window as unknown as { claude?: { window?: { setIcon?: (u: string | null) => Promise<void> } } };
    const setIconFn = anyWin.claude?.window?.setIcon;
    if (setIconFn) {
      if (activeTheme.appIcon) {
        setIconFn(activeTheme.appIcon).catch(() => {});
      } else {
        const svg = buildDefaultIconSvg(activeTheme.tokens);
        rasterizeSvgToPngDataUrl(svg).then(dataUrl => {
          if (iconCancelled) return;
          // Null on rasterizer failure — main resets to bundled default, which
          // is the right fallback.
          setIconFn(dataUrl).catch(() => {});
        });
      }
    }

    // Sync font state: use theme's declared font, or fall back to default
    if (activeTheme.font?.family) {
      setFontState(activeTheme.font.family);
    } else {
      setFontState(DEFAULT_FONT_FAMILY);
      applyFont(DEFAULT_FONT_FAMILY);
    }
    return () => { iconCancelled = true; };
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

  // Task 5.1: setter for per-turn metadata strip. Mirrors setShowTimestamps —
  // localStorage + disk persistence; empty deps array because persistAppearance
  // is module-scope and setShowTurnMetadataState is a stable React setter.
  const setShowTurnMetadata = useCallback((v: boolean) => {
    setShowTurnMetadataState(v);
    try { localStorage.setItem(SHOW_TURN_METADATA_KEY, v ? '1' : '0'); } catch {}
    persistAppearance({ showTurnMetadata: v });
  }, []);

  // Update a glass field for a non-user theme. Persists per-slug so the
  // user's glass preferences survive theme switches and app restarts.
  const setGlassOverride = useCallback((slug: string, field: string, value: number) => {
    setGlassOverrides(prev => {
      const next = { ...prev, [slug]: { ...prev[slug], [field]: value } };
      try { localStorage.setItem(GLASS_OVERRIDES_KEY, JSON.stringify(next)); } catch {}
      persistAppearance({ glassOverrides: next });
      return next;
    });
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
    showTurnMetadata, setShowTurnMetadata,
    allThemes, activeTheme, bgStyle, patternStyle,
    setGlassOverride, reloadUserThemes,
  }), [activeSlug, setTheme, cycleTheme, cycleList, setCycleList, font,
       reducedEffects, setReducedEffects, showTimestamps, setShowTimestamps,
       showTurnMetadata, setShowTurnMetadata,
       allThemes, activeTheme, bgStyle, patternStyle, setGlassOverride, reloadUserThemes]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() { return useContext(ThemeContext); }
