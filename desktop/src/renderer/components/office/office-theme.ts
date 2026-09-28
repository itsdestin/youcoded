// The theme Office's editors wear (office-questions#Q-theme: "colours, font,
// glass" — and Destin's note: "our roundness/token settings if possible").
//
// The editors run on their own sealed origin, so nothing here can style them
// directly: the host reads the live tokens and posts them into the frame, and
// the add-on's bridge (yc-bridge.js, on the editor side) maps them onto the
// editor's own CSS variables. Same pattern as Pages' theme message, reusing its
// watcher so a theme switch reaches an open document without a reload.
import { watchThemeCss } from '../pages/page-theme';

const TOKENS = [
  'canvas', 'panel', 'inset', 'well', 'accent', 'on-accent',
  'fg', 'fg-2', 'fg-dim', 'fg-muted', 'fg-faint', 'edge', 'edge-dim', 'link',
  'radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'font-sans',
] as const;

export const OFFICE_THEME_MESSAGE = 'yc:office-theme';
export const OFFICE_MODE_MESSAGE = 'yc:office-mode';

export interface OfficeTheme {
  tokens: Record<string, string>;
  dark: boolean;
  /** A wallpaper theme: the editor's bands go see-through over it. */
  wallpaper: boolean;
  panelsOpacity: number;
  panelsBlur: number;
  /** The theme's web-font stylesheets, so the editor can load the same font. */
  fontLinks: string[];
}

/** Relative luminance of a `#rrggbb` / `rgb()` colour, 0 (black) to 1 (white). */
function luminance(color: string): number | null {
  let r: number, g: number, b: number;
  const hex = /^#([0-9a-f]{6})/i.exec(color);
  const rgb = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(color);
  if (hex) { const n = parseInt(hex[1], 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
  else if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
  else return null;
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function readOfficeTheme(root: HTMLElement = document.documentElement): OfficeTheme {
  const cs = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const t of TOKENS) {
    const v = cs.getPropertyValue(`--${t}`).trim();
    if (v) tokens[t] = v;
  }
  // Dark by the PANEL's own colour, not color-scheme: community packs (Halftone)
  // leave color-scheme unset, and the editor then drew dark icons on a dark band.
  const lum = luminance(tokens.panel ?? '');
  const scheme = cs.colorScheme || cs.getPropertyValue('color-scheme').trim();
  return {
    tokens,
    dark: lum !== null ? lum < 0.3 : /dark/.test(scheme),
    fontLinks: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href^="https://fonts.googleapis.com/"]')].map((l) => l.href),
    wallpaper: root.hasAttribute('data-wallpaper'),
    panelsOpacity: Number.parseFloat(cs.getPropertyValue('--panels-opacity')) || 1,
    // Reduced effects zeroes this at the source (theme-engine), so the editor follows.
    panelsBlur: Number.parseFloat(cs.getPropertyValue('--panels-blur')) || 0,
  };
}

/** Calls back with a fresh theme whenever the app's theme changes. */
export function watchOfficeTheme(onChange: (theme: OfficeTheme) => void): () => void {
  return watchThemeCss(() => onChange(readOfficeTheme()));
}
