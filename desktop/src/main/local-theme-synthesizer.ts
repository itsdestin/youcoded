import type { ThemeRegistryEntry, ThemeRegistryEntryWithStatus } from '../shared/theme-marketplace-types';

/** What we read for each local user theme on disk. The caller (provider)
 * supplies these — this module is pure so it stays unit-testable. */
export interface LocalThemeRecord {
  slug: string;
  manifest: Record<string, any>;
  /** True if `<themeDir>/preview.png` exists on disk. */
  hasPreview: boolean;
}

const PREVIEW_TOKEN_KEYS = [
  'canvas', 'panel', 'accent', 'on-accent', 'fg', 'fg-muted', 'edge',
] as const;

function detectFeatures(manifest: Record<string, any>): string[] {
  const features: string[] = [];
  const bg = manifest.background ?? {};
  if (bg.type === 'image') features.push('wallpaper');
  if ((bg['panels-blur'] ?? 0) > 0) features.push('glassmorphism');
  const effects = manifest.effects ?? {};
  if (effects.particles && effects.particles !== 'none') features.push('particles');
  if (manifest.font) features.push('custom-font');
  if (manifest.icons) features.push('custom-icons');
  if (manifest.mascot) features.push('mascot');
  if (manifest.custom_css) features.push('custom-css');
  return features;
}

function pickPreviewTokens(
  manifest: Record<string, any>,
): ThemeRegistryEntry['previewTokens'] | undefined {
  const tokens = manifest.tokens ?? {};
  const picked: Record<string, string> = {};
  for (const key of PREVIEW_TOKEN_KEYS) {
    if (typeof tokens[key] === 'string') picked[key] = tokens[key];
  }
  if (Object.keys(picked).length !== PREVIEW_TOKEN_KEYS.length) return undefined;
  return {
    canvas: picked.canvas,
    panel: picked.panel,
    accent: picked.accent,
    'on-accent': picked['on-accent'],
    fg: picked.fg,
    'fg-muted': picked['fg-muted'],
    edge: picked.edge,
  };
}

function pickPreviewUrl(rec: LocalThemeRecord): string | undefined {
  if (rec.hasPreview) return `theme-asset://${rec.slug}/preview.png`;
  const wallpaperPath = rec.manifest?.background?.value;
  if (typeof wallpaperPath === 'string' && wallpaperPath.startsWith('assets/')) {
    return `theme-asset://${rec.slug}/${wallpaperPath}`;
  }
  return undefined;
}

/** Return the merged list of marketplace entries plus synthesized entries
 * for local themes that don't appear in the marketplace list. Local entries
 * are tagged `isLocal: true` and `installed: true`. */
export function synthesizeLocalThemeEntries(
  marketplaceEntries: ThemeRegistryEntryWithStatus[],
  localRecords: LocalThemeRecord[],
): ThemeRegistryEntryWithStatus[] {
  const marketplaceSlugs = new Set(marketplaceEntries.map(e => e.slug));
  const synthesized: ThemeRegistryEntryWithStatus[] = [];

  for (const rec of localRecords) {
    if (marketplaceSlugs.has(rec.slug)) continue;
    const m = rec.manifest;
    synthesized.push({
      slug: rec.slug,
      name: m.name ?? rec.slug,
      author: m.author ?? 'unknown',
      dark: !!m.dark,
      description: typeof m.description === 'string' ? m.description : undefined,
      preview: pickPreviewUrl(rec),
      previewTokens: pickPreviewTokens(m),
      version: typeof m.version === 'string' ? m.version : '1.0.0',
      created: typeof m.created === 'string' ? m.created : undefined,
      source: 'community',
      features: detectFeatures(m),
      manifestUrl: '',
      installed: true,
      isLocal: true,
    });
  }

  return [...marketplaceEntries, ...synthesized];
}
