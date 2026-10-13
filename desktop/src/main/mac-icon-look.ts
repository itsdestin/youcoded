// mac-icon-look.ts — which icon look a macOS 26 user picked (System Settings → Appearance →
// "Icon & widget style": Default, Dark, Clear, Tinted), so the Dock rule in app-icon.ts
// (chooseDockIcon) can decide whether a theme's icon may replace the Liquid Glass one.
//
// WHY its own file: the setting's name is not documented by Apple. It was read off a real
// macOS 26 install (the Tahoe test VM, docs/vm-testing.md) — if Apple renames it, this is the one
// place to change, and an unrecognised value reads as 'unknown', which leaves the Dock alone.
import { app, systemPreferences } from 'electron';
import type { MacIconLook } from './app-icon';

// Read off macOS 26.7.1 (Tahoe VM, 2026-10-04): System Settings → Appearance → Icon & widget style
// writes this global default — "RegularDark" (Dark), "ClearLight" (Clear), "TintedLight" (Tinted) —
// and REMOVES it for Default.
const LOOK_KEY = 'AppleIconAppearanceTheme';

/** Map the raw setting to a look. Exported for tests. */
export function parseMacIconLook(raw: unknown): MacIconLook {
  // WHY missing = default: macOS deletes the setting when the user picks Default, and Electron
  // hands back '' for a missing string default. Reading that as 'unknown' left the Dock alone in
  // the most common look of all.
  if (raw === undefined || raw === null || raw === '') return 'default';
  if (typeof raw !== 'string') return 'unknown';
  const v = raw.toLowerCase();
  if (v.includes('tint')) return 'tinted';
  if (v.includes('clear')) return 'clear';
  if (v.includes('dark')) return 'dark';
  if (v.includes('regular') || v.includes('default') || v.includes('light')) return 'default';
  return 'unknown';
}

export function readMacIconLook(): MacIconLook {
  if (process.platform !== 'darwin') return 'unknown';
  try {
    return parseMacIconLook(systemPreferences.getUserDefault(LOOK_KEY, 'string'));
  } catch {
    return 'unknown';
  }
}

/** Call `onChange` when the look may have changed. WHY on focus: the user changes it in System
 *  Settings, then comes back to the app — re-reading one setting on focus is cheap and needs no
 *  undocumented change notification. */
export function watchMacIconLook(onChange: () => void): void {
  if (process.platform !== 'darwin') return;
  let last = readMacIconLook();
  app.on('browser-window-focus', () => {
    const now = readMacIconLook();
    if (now !== last) { last = now; onChange(); }
  });
}
