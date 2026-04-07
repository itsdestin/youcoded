import type { ThemeDefinition, LoadedTheme } from './theme-types';

/**
 * Resolves a single asset path to a theme-asset:// URI.
 * Returns null for undefined, passes through non-relative values unchanged
 * (gradients, hex colors, already-resolved URIs).
 */
export function resolveAssetPath(value: string | undefined, slug: string): string | null {
  if (!value) return null;
  if (value.startsWith('theme-asset://')) return value;
  if (
    value.startsWith('#') ||
    value.startsWith('linear-gradient') ||
    value.startsWith('radial-gradient') ||
    value.startsWith('rgb')
  ) return value;
  return `theme-asset://${slug}/${value}`;
}

/**
 * Deep-resolves all asset paths in a theme to theme-asset:// URIs.
 * Only applies to user and community themes. Official (destinclaude) themes are returned unchanged.
 */
export function resolveAllAssetPaths<T extends ThemeDefinition | LoadedTheme>(theme: T): T {
  if ('source' in theme && (theme as LoadedTheme).source === 'destinclaude') return theme;

  const resolved = { ...theme };
  const slug = theme.slug;

  // Background
  if (resolved.background) {
    const bg = { ...resolved.background };
    if (bg.type === 'image') {
      const r = resolveAssetPath(bg.value, slug);
      if (r) bg.value = r;
    }
    if (bg.pattern) {
      const r = resolveAssetPath(bg.pattern, slug);
      if (r) bg.pattern = r;
    }
    resolved.background = bg;
  }

  // Effects — particle shape
  if (resolved.effects?.['particle-shape']) {
    resolved.effects = { ...resolved.effects };
    const r = resolveAssetPath(resolved.effects['particle-shape'], slug);
    if (r) resolved.effects['particle-shape'] = r;
  }

  // Icons
  if (resolved.icons) {
    const icons = { ...resolved.icons };
    for (const [key, val] of Object.entries(icons)) {
      const r = resolveAssetPath(val, slug);
      if (r) (icons as Record<string, string>)[key] = r;
    }
    resolved.icons = icons;
  }

  // Mascot
  if (resolved.mascot) {
    const mascot = { ...resolved.mascot };
    for (const [key, val] of Object.entries(mascot)) {
      const r = resolveAssetPath(val, slug);
      if (r) (mascot as Record<string, string>)[key] = r;
    }
    resolved.mascot = mascot;
  }

  // Cursor
  if (resolved.cursor) {
    const r = resolveAssetPath(resolved.cursor, slug);
    if (r) resolved.cursor = r;
  }

  // Scrollbar thumb image
  if (resolved.scrollbar?.['thumb-image']) {
    resolved.scrollbar = { ...resolved.scrollbar };
    const r = resolveAssetPath(resolved.scrollbar['thumb-image'], slug);
    if (r) resolved.scrollbar['thumb-image'] = r;
  }

  return resolved;
}
