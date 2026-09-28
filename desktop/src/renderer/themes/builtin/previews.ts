// Preview images for the four built-in themes — the SAME kind of picture the Marketplace
// and Library cards show for community themes: since 2026-09-24 a screenshot of the real
// app in that theme (youcoded-dev scripts/ui-review/theme-previews.py, 800×500; before
// that, a mock page from wecoded-themes/scripts/generate-previews.js).
// Community and user themes carry their own preview.png in their theme folder and are
// served through theme-asset://; built-ins have no folder on disk, so theirs ship in
// the bundle. Phase C, P-3 #1 (Destin, 2026-08-27): the Themes dialog cards show this
// preview instead of a token gradient.
import midnight from './previews/midnight.png';
import dark from './previews/dark.png';
import light from './previews/light.png';
import creme from './previews/creme.png';
import type { LoadedTheme } from '../theme-types';

const BUILTIN_PREVIEWS: Record<string, string> = { midnight, dark, light, creme };

/** URL of a theme's preview picture, or null when the theme cannot have one. */
export function themePreviewSrc(theme: Pick<LoadedTheme, 'slug' | 'source'>): string | null {
  if (theme.source === 'youcoded-core') return BUILTIN_PREVIEWS[theme.slug] ?? null;
  // Installed community themes and user-built themes keep preview.png beside their
  // manifest; the theme-asset:// protocol serves it on desktop and Android. A theme
  // without one 404s, and the card falls back to its token gradient on <img onError>.
  return `theme-asset://${theme.slug}/preview.png`;
}
