import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantDefaults } from './assistant-settings/pages';

/** How long the panel slides in; refreshes wait for it (three bridge calls at once visibly stuttered the slide). */
const SLIDE_MS = 350;

/**
 * The Android Settings page's three readings: plan tier, version, and the new-session defaults.
 *
 * WHY read once while still closed, then refresh quietly (Destin, 2026-11-04: Settings "briefly flash[es] 'loading'
 * … doesnt happen on my installed desktop app"): every open used to blank the whole page to "Loading..." and wait
 * 350 ms before even asking, so the flash was guaranteed. The answers are small and rarely change, so they are read
 * once when the app starts (the panel stays mounted while closed, and nothing is sliding then); each later open shows
 * what is known straight away and refreshes it behind the scenes. `loading` can only be true if Settings is opened
 * before that first read has answered.
 */
export function useAndroidSettingsData(open: boolean) {
  const [loading, setLoading] = useState(true);
  const [tier, setTier] = useState('CORE');
  const [aboutInfo, setAboutInfo] = useState<{ version: string; build: string } | null>(null);
  const [defaults, setDefaults] = useState<AssistantDefaults>({ skipPermissions: false, model: 'sonnet', projectFolder: '' });

  const load = useCallback(() => {
    const claude = (window as any).claude;
    return Promise.all([
      claude?.android?.getTier?.() ?? 'CORE',
      claude?.android?.getAbout?.() ?? { version: 'unknown', build: '' },
      claude?.defaults?.get?.() ?? { skipPermissions: false, model: 'sonnet', projectFolder: '' },
    ]).then(([t, about, defs]) => {
      setTier(t?.tier || t || 'CORE');
      setAboutInfo(about);
      setDefaults(defs);
    }).catch(() => { /* keep what is shown; the next open tries again */ })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openedOnce = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (!openedOnce.current) { openedOnce.current = true; return; } // the startup read covers the first open
    const timer = setTimeout(() => { void load(); }, SLIDE_MS);
    return () => clearTimeout(timer);
  }, [open, load]);

  return { loading, tier, setTier, aboutInfo, defaults, setDefaults };
}
