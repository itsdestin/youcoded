// theme-icons.ts — the icon files the active theme hands the desktop app, renderer → main.
//
// WHY one bundle instead of one URL: since brand rounds 27–31 a theme's icon is several files — the
// app icon, a multi-size .ico for Windows, a see-through version for the Mac Dock's Dark and Clear
// looks, and the tray icon with its "needs you" twin. Sending them together means main can choose
// per platform (and per Mac look) without asking the renderer again.

/** Every value is a theme-asset:// URL inside the theme's own folder; main confines and loads it. */
export interface ThemeIconSet {
  /** The app icon (PNG). Window, Linux taskbar, the Mac Dock in the Default look. */
  app: string;
  windows?: string;
  macGlass?: string;
  tray?: string;
  trayAlert?: string;
}

/** The bundle for a loaded theme, or null when it has no icon of its own (then the app's default shows). */
export function themeIconSet(theme: { appIcon?: string; appIconVariants?: { windows?: string; macGlass?: string; tray?: string; trayAlert?: string } }): ThemeIconSet | null {
  if (!theme.appIcon) return null;
  const v = theme.appIconVariants ?? {};
  return { app: theme.appIcon, windows: v.windows, macGlass: v.macGlass, tray: v.tray, trayAlert: v.trayAlert };
}
