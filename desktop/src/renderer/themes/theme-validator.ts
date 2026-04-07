import type { ThemeDefinition } from './theme-types';

const REQUIRED_TOKENS = [
  'canvas', 'panel', 'inset', 'well', 'accent', 'on-accent',
  'fg', 'fg-2', 'fg-dim', 'fg-muted', 'fg-faint',
  'edge', 'edge-dim', 'scrollbar-thumb', 'scrollbar-hover',
] as const;

/** Relative luminance of a hex color (0–1). */
export function luminance(hex: string): number {
  const clean = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return 0; // treat unparseable as black
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Returns '#FFFFFF' or '#000000' based on accent luminance. */
export function computeOnAccent(accentHex: string): '#FFFFFF' | '#000000' {
  return luminance(accentHex) < 0.179 ? '#FFFFFF' : '#000000';
}

/** Throws a descriptive error if the theme JSON is invalid. */
export function validateTheme(raw: unknown): ThemeDefinition {
  if (!raw || typeof raw !== 'object') throw new Error('Theme must be an object');
  const t = raw as Record<string, unknown>;

  if (!t.name || typeof t.name !== 'string' || !t.name.trim()) throw new Error('Theme missing required field: name');
  if (!t.slug || typeof t.slug !== 'string' || !t.slug.trim()) throw new Error('Theme missing required field: slug');
  if (typeof t.dark !== 'boolean') throw new Error('Theme missing required field: dark (boolean)');
  if (!t.tokens || typeof t.tokens !== 'object') throw new Error('Theme missing required field: tokens');

  const tokens = t.tokens as Record<string, unknown>;
  for (const key of REQUIRED_TOKENS) {
    if (!tokens[key] || typeof tokens[key] !== 'string') {
      throw new Error(`Theme tokens missing required field: ${key}`);
    }
  }

  // Validate effects consistency
  const effects = t.effects as Record<string, unknown> | undefined;
  if (effects) {
    if (effects['particle-shape'] && effects.particles !== 'custom') {
      throw new Error('particle-shape requires particles: "custom"');
    }
  }

  // Clamp radius-2xl to 36px max to prevent bubble content clipping
  const shape = t.shape as Record<string, string> | undefined;
  if (shape && shape['radius-2xl']) {
    const val = parseInt(shape['radius-2xl'], 10);
    if (!isNaN(val) && val > 36) {
      shape['radius-2xl'] = '36px';
    }
  }

  return raw as ThemeDefinition;
}

/**
 * Sanitizes a CSS string by stripping dangerous patterns that could
 * load external resources or execute code. Safe patterns like
 * theme-asset:// and data: URIs are preserved.
 */
export function sanitizeCSS(css: string): string {
  let result = css;

  // Strip @import rules (could load external stylesheets that change over time)
  result = result.replace(/@import\s+[^;]+;?/gi, '');

  // Strip url() with external protocols — keep theme-asset:// and data: URIs
  result = result.replace(
    /url\(\s*['"]?\s*(https?:\/\/|\/\/|ftp:\/\/)[^)]*\)/gi,
    'url(/* blocked */)',
  );

  // Strip expression() — IE-era CSS expression injection
  result = result.replace(/expression\s*\([^)]*\)/gi, '/* blocked */');

  // Strip javascript: URIs anywhere in the CSS
  result = result.replace(/javascript\s*:/gi, '/* blocked */');

  // Strip -moz-binding — XBL binding injection (Firefox legacy)
  result = result.replace(/-moz-binding\s*:[^;]+;?/gi, '/* blocked */');

  return result;
}

/**
 * Validates and sanitizes a community-submitted theme.
 * Runs the standard validation plus CSS sanitization on custom_css.
 */
export function validateCommunityTheme(raw: unknown): ThemeDefinition {
  const theme = validateTheme(raw);
  if (theme.custom_css) {
    theme.custom_css = sanitizeCSS(theme.custom_css);
  }
  return theme;
}
