import type { ThemeTokens, ThemeShape, ThemeFont, ThemeBackground, ThemeLayout, ThemeEffects, ThemeDefinition } from './theme-types';

/** Returns CSS custom property map for all 15 color tokens. */
export function buildTokenCSS(tokens: ThemeTokens): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value !== 'string') continue;
    result[`--${key}`] = value;
  }
  return result;
}

/** Returns CSS custom property map for shape radius variables. */
export function buildShapeCSS(shape: ThemeShape | undefined): Record<string, string> {
  if (!shape) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (value) result[`--${key}`] = value;
  }
  return result;
}

/** Returns inline style properties for the #theme-bg div. Null if no background defined. */
export function buildBackgroundStyle(bg: ThemeBackground | undefined): Record<string, string> | null {
  if (!bg) return null;
  if (bg.type === 'solid') return { background: bg.value, opacity: String(bg.opacity ?? 1) };
  if (bg.type === 'gradient') return { background: bg.value, opacity: String(bg.opacity ?? 1) };
  if (bg.type === 'image') return {
    backgroundImage: `url("${bg.value}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    opacity: String(bg.opacity ?? 1),
  };
  return null;
}

/** Returns inline style properties for the #theme-pattern div. Null if no pattern. */
export function buildPatternStyle(
  pattern: string | undefined,
  opacity: number | undefined,
): Record<string, string> | null {
  if (!pattern) return null;
  return {
    backgroundImage: `url("${pattern}")`,
    backgroundRepeat: 'repeat',
    backgroundSize: 'auto',
    opacity: String(opacity ?? 0.06),
  };
}

const GOOGLE_FONT_LINK_ID = 'theme-google-font';

/** Injects or removes a Google Fonts <link> in <head>. Returns the font-family string if set. */
export function applyThemeFont(font: ThemeFont | undefined): string | null {
  let linkEl = document.getElementById(GOOGLE_FONT_LINK_ID) as HTMLLinkElement | null;

  if (!font) {
    // No theme font — clean up any previously injected link
    if (linkEl) linkEl.remove();
    return null;
  }

  // Inject or update Google Font <link> if URL is provided
  const url = font['google-font-url'];
  if (url) {
    if (!linkEl) {
      linkEl = document.createElement('link');
      linkEl.id = GOOGLE_FONT_LINK_ID;
      linkEl.rel = 'stylesheet';
      document.head.appendChild(linkEl);
    }
    linkEl.href = url;
  } else if (linkEl) {
    linkEl.remove();
  }

  // Apply font-family to CSS variables
  if (font.family) {
    document.documentElement.style.setProperty('--font-sans', font.family);
    document.documentElement.style.setProperty('--font-mono', font.family);
    return font.family;
  }

  return null;
}

/** Returns data-attribute key/value pairs to set on <body>. */
export function buildLayoutAttrs(layout: ThemeLayout | undefined): Record<string, string> {
  if (!layout) return {};
  const result: Record<string, string> = {};
  if (layout['chrome-style']) result['data-chrome-style'] = layout['chrome-style'];
  if (layout['input-style']) result['data-input-style'] = layout['input-style'];
  if (layout['bubble-style']) result['data-bubble-style'] = layout['bubble-style'];
  if (layout['header-style']) result['data-header-style'] = layout['header-style'];
  if (layout['statusbar-style']) result['data-statusbar-style'] = layout['statusbar-style'];
  return result;
}

const EFFECT_IDS = ['effect-vignette', 'effect-noise', 'effect-scanlines'] as const;

/** Creates or removes effect overlay divs based on theme effects config. */
function applyEffects(effects: ThemeEffects | undefined): void {
  const root = document.documentElement;

  // Vignette
  const vignetteVal = effects?.vignette ?? 0;
  if (vignetteVal > 0) {
    root.style.setProperty('--vignette-opacity', String(vignetteVal));
    ensureEffectDiv('effect-vignette');
  } else {
    root.style.removeProperty('--vignette-opacity');
    removeEffectDiv('effect-vignette');
  }

  // Noise
  const noiseVal = effects?.noise ?? 0;
  if (noiseVal > 0) {
    root.style.setProperty('--noise-opacity', String(noiseVal));
    ensureEffectDiv('effect-noise');
  } else {
    root.style.removeProperty('--noise-opacity');
    removeEffectDiv('effect-noise');
  }

  // Scan-lines
  const scanlines = effects?.['scan-lines'] ?? false;
  if (scanlines) {
    root.style.setProperty('--scanline-opacity', '0.08');
    ensureEffectDiv('effect-scanlines');
  } else {
    root.style.removeProperty('--scanline-opacity');
    removeEffectDiv('effect-scanlines');
  }
}

function ensureEffectDiv(id: string): void {
  if (document.getElementById(id)) return;
  const div = document.createElement('div');
  div.id = id;
  document.body.appendChild(div);
}

function removeEffectDiv(id: string): void {
  document.getElementById(id)?.remove();
}

const LAYOUT_ATTRS = ['data-chrome-style', 'data-input-style', 'data-bubble-style', 'data-header-style', 'data-statusbar-style'] as const;

/** Applies a full ThemeDefinition to the live DOM. Only call from renderer process. */
export function applyThemeToDom(theme: ThemeDefinition): void {
  const root = document.documentElement;
  const body = document.body;

  // 1. data-theme attribute (drives existing [data-theme] CSS blocks as fallback)
  root.setAttribute('data-theme', theme.slug);

  // 2. Color tokens as CSS custom properties on :root
  for (const [prop, value] of Object.entries(buildTokenCSS(theme.tokens))) {
    root.style.setProperty(prop, value);
  }

  // 3. Shape radius overrides
  for (const [prop, value] of Object.entries(buildShapeCSS(theme.shape))) {
    root.style.setProperty(prop, value);
  }

  // 4. Glassmorphism — set/remove data-panels-blur + CSS vars
  const blur = theme.background?.['panels-blur'];
  const panelsOpacity = theme.background?.['panels-opacity'];
  if (blur && blur > 0) {
    root.setAttribute('data-panels-blur', String(blur));
    root.style.setProperty('--panels-blur', `${blur}px`);
    // Compute semi-transparent panel color for glassmorphism
    if (panelsOpacity !== undefined && panelsOpacity < 1) {
      const hex = theme.tokens.panel.replace(/^#/, '');
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      root.style.setProperty('--panel-glass', `rgba(${r}, ${g}, ${b}, ${panelsOpacity})`);
    } else {
      root.style.removeProperty('--panel-glass');
    }
  } else {
    root.removeAttribute('data-panels-blur');
    root.style.removeProperty('--panels-blur');
    root.style.removeProperty('--panel-glass');
  }

  // 5. Background wallpaper — set directly on <body> (bypasses z-index stacking issues)
  const bg = theme.background;
  if (bg?.type === 'image' && bg.value) {
    body.style.backgroundImage = `url("${bg.value}")`;
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
    body.style.backgroundRepeat = 'no-repeat';
    if (bg.opacity !== undefined && bg.opacity < 1) {
      // Can't set opacity on body without affecting children, so leave at 1
      // The slight dimming is handled by the vignette/overlay in custom_css if needed
    }
  } else {
    body.style.backgroundImage = '';
    body.style.backgroundSize = '';
    body.style.backgroundPosition = '';
    body.style.backgroundRepeat = '';
  }

  // 6. Layout data attributes on body — clear previous first
  for (const attr of LAYOUT_ATTRS) {
    body.removeAttribute(attr);
  }
  for (const [attr, value] of Object.entries(buildLayoutAttrs(theme.layout))) {
    body.setAttribute(attr, value);
  }

  // 7. custom_css — inject/replace in <style id="theme-custom">
  const customCSSId = 'theme-custom';
  let customEl = document.getElementById(customCSSId) as HTMLStyleElement | null;
  if (theme.custom_css) {
    if (!customEl) {
      customEl = document.createElement('style');
      customEl.id = customCSSId;
      document.head.appendChild(customEl);
    }
    customEl.textContent = theme.custom_css;
  } else if (customEl) {
    customEl.textContent = '';
  }

  // 8. Theme font — inject Google Font <link> and set --font-sans/--font-mono
  applyThemeFont(theme.font);

  // 9. Visual effects — create/remove overlay divs for vignette, noise, scan-lines
  applyEffects(theme.effects);
}

const TOKEN_CSS_PROPS = [
  '--canvas', '--panel', '--inset', '--well', '--accent', '--on-accent',
  '--fg', '--fg-2', '--fg-dim', '--fg-muted', '--fg-faint',
  '--edge', '--edge-dim', '--scrollbar-thumb', '--scrollbar-hover',
] as const;

/** Clears all theme-engine-applied DOM mutations. */
export function clearThemeFromDom(): void {
  const root = document.documentElement;
  const body = document.body;
  root.removeAttribute('data-panels-blur');
  body.style.backgroundImage = '';
  body.style.backgroundSize = '';
  body.style.backgroundPosition = '';
  body.style.backgroundRepeat = '';
  const propsToRemove = [
    ...TOKEN_CSS_PROPS,
    '--panels-blur', '--panel-glass',
    '--radius', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl', '--radius-full',
    '--font-sans', '--font-mono',
    '--vignette-opacity', '--noise-opacity', '--scanline-opacity',
  ];
  for (const p of propsToRemove) root.style.removeProperty(p);
  for (const a of LAYOUT_ATTRS) body.removeAttribute(a);
  // Remove effect overlay divs
  for (const id of EFFECT_IDS) removeEffectDiv(id);
  const customEl = document.getElementById('theme-custom') as HTMLStyleElement | null;
  if (customEl) customEl.textContent = '';
  // Remove injected Google Font link
  document.getElementById(GOOGLE_FONT_LINK_ID)?.remove();
}
