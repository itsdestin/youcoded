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
  // Already-resolved locations pass through too. This function's job is to turn
  // a RELATIVE path into a theme-asset:// URI; a data URI, an absolute URL or a
  // root-absolute path is already a location, and prefixing one produced
  // `theme-asset://slug/data:image/...` — a dead link, silently. The docblock
  // above has always claimed this behaviour; only theme-asset:// implemented it.
  if (
    value.startsWith('data:') ||
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('/')
  ) return value;
  return `theme-asset://${slug}/${value}`;
}

/**
 * resolveAssetPath for an asset the app FETCHES AND INLINES into its page — the
 * mascot rig, flat mascot variants and scene companions. Returns null for a web
 * address, a protocol-relative `//` address, or any scheme other than
 * theme-asset://.
 *
 * WHY (2026-09-10 security review): an inlined drawing is sanitized, but one
 * loaded from a web address can be swapped for a different file after the theme
 * was reviewed. A theme's own files (theme-asset://) and same-origin root paths
 * (the workbench serves its fixture packs as `/…` Vite URLs) are kept; no
 * published or theme-builder theme uses anything else.
 */
export function resolveInlineAssetPath(value: string | undefined, slug: string): string | null {
  const r = resolveAssetPath(value, slug);
  if (!r) return null;
  if (r.startsWith('theme-asset://')) return r;
  if (r.startsWith('/') && !r.startsWith('//')) return r;
  return null;
}

/**
 * Deep-resolves all asset paths in a theme to theme-asset:// URIs.
 * Only applies to user and community themes. Official (youcoded-core) themes are returned unchanged.
 */
export function resolveAllAssetPaths<T extends ThemeDefinition | LoadedTheme>(theme: T): T {
  if ('source' in theme && (theme as LoadedTheme).source === 'youcoded-core') return theme;

  const resolved = { ...theme };
  const slug = theme.slug;

  // Background
  if (resolved.background) {
    const bg = { ...resolved.background };
    if (bg.type === 'image') {
      const r = resolveAssetPath(bg.value, slug);
      if (r) bg.value = r;
    }
    if (bg['terminal-value']) {
      const r = resolveAssetPath(bg['terminal-value'], slug);
      if (r) bg['terminal-value'] = r;
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
      // Guard: only resolve string entries. A future manifest may put
      // structured values here and resolveAssetPath would throw on them.
      if (typeof val !== 'string') continue;
      const r = resolveInlineAssetPath(val, slug);
      // An address outside the theme is DROPPED, not passed through: the app
      // then falls back to the default buddy (see resolveInlineAssetPath).
      if (r) (mascot as Record<string, string>)[key] = r;
      else delete (mascot as Record<string, string>)[key];
    }
    resolved.mascot = mascot;
  }

  // Scene companions (top-level key — see MascotCompanion in theme-types)
  if (Array.isArray(resolved.companions)) {
    resolved.companions = resolved.companions.flatMap((c) => {
      if (!c || typeof c.asset !== 'string') return [c];
      const r = resolveInlineAssetPath(c.asset, slug);
      return r ? [{ ...c, asset: r }] : [];
    });
  }

  // Cursor
  if (resolved.cursor) {
    const r = resolveAssetPath(resolved.cursor, slug);
    if (r) resolved.cursor = r;
  }

  // App icon (window + dock icon hot-swap)
  if (resolved.appIcon) {
    const r = resolveAssetPath(resolved.appIcon, slug);
    if (r) resolved.appIcon = r;
  }

  // Scrollbar thumb image
  if (resolved.scrollbar?.['thumb-image']) {
    resolved.scrollbar = { ...resolved.scrollbar };
    const r = resolveAssetPath(resolved.scrollbar['thumb-image'], slug);
    if (r) resolved.scrollbar['thumb-image'] = r;
  }

  return resolved;
}
