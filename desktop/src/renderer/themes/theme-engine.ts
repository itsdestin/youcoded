import type { ThemeTokens, ThemeShape, ThemeFont, ThemeBackground, ThemeLayout, ThemeEffects, ThemeOverlay, ThemeDefinition } from './theme-types';

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

const EFFECTS_OVERLAY_ID = 'theme-effects-overlay';
// Legacy per-effect divs that need cleanup when applying a new theme
const LEGACY_EFFECT_IDS = ['effect-vignette', 'effect-noise', 'effect-scanlines'] as const;

/** Builds a single consolidated overlay div with combined backgrounds for all effects.
 *  Reduces compositor layers from 3 to 1 compared to the previous per-effect divs. */
function applyEffects(effects: ThemeEffects | undefined): void {
  // Remove any legacy per-effect divs from previous theme applications
  for (const id of LEGACY_EFFECT_IDS) document.getElementById(id)?.remove();

  if (!effects) {
    document.getElementById(EFFECTS_OVERLAY_ID)?.remove();
    return;
  }

  const backgrounds: string[] = [];
  const sizes: string[] = [];

  // Vignette — opacity baked into radial gradient endpoint
  const vignetteVal = effects.vignette ?? 0;
  if (vignetteVal > 0) {
    backgrounds.push(`radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,${vignetteVal}) 100%)`);
    sizes.push('100% 100%');
  }

  // Scanlines — opacity baked into gradient colors (0.08 base * line alpha)
  if (effects['scan-lines']) {
    backgrounds.push('repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(0,0,0,0.012) 1px, rgba(0,0,0,0.012) 2px)');
    sizes.push('100% 100%');
  }

  // Noise — opacity baked into SVG rect attribute
  const noiseVal = effects.noise ?? 0;
  if (noiseVal > 0) {
    const noiseSvg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='${noiseVal}'/%3E%3C/svg%3E`;
    backgrounds.push(`url("${noiseSvg}")`);
    sizes.push('200px 200px');
  }

  if (backgrounds.length === 0) {
    document.getElementById(EFFECTS_OVERLAY_ID)?.remove();
    return;
  }

  let div = document.getElementById(EFFECTS_OVERLAY_ID);
  if (!div) {
    div = document.createElement('div');
    div.id = EFFECTS_OVERLAY_ID;
    document.body.appendChild(div);
  }
  div.style.backgroundImage = backgrounds.join(', ');
  div.style.backgroundSize = sizes.join(', ');
  div.style.backgroundRepeat = backgrounds.map(() => 'repeat').join(', ');
}

/** Parses a hex color string (#RRGGBB) into [r, g, b] components (0-255). */
function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '');
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0,
  ];
}

/** Relative luminance of an [r, g, b] triplet (0-255) — WCAG 2.0 formula. */
function rgbLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Computes overlay CSS custom properties from existing theme tokens.
 *  After the glassmorphism refactor, overlay surfaces consume --panels-blur /
 *  --panels-opacity directly (set globally in applyThemeToDom), so this helper
 *  only emits scrim, shadow, and destructive tokens — NOT overlay-bg/overlay-blur. */
export function computeOverlayTokens(
  tokens: ThemeTokens,
  _background: ThemeBackground | undefined,
  overlay: ThemeOverlay | undefined,
  _reducedEffects: boolean,
): Record<string, string> {
  const [canvasR, canvasG, canvasB] = parseHex(tokens.canvas);
  const lum = rgbLuminance(canvasR, canvasG, canvasB);

  // Scrim — darken canvas toward black for a theme-tinted overlay dim.
  // Dark themes: mix canvas 40% with black → subtle tinted dim.
  // Light themes: mix canvas 30% with black → darker dim needed for contrast.
  const scrimMix = lum > 0.2 ? 0.3 : 0.4;
  const scrimR = Math.round(canvasR * scrimMix);
  const scrimG = Math.round(canvasG * scrimMix);
  const scrimB = Math.round(canvasB * scrimMix);

  // Shadow strength — light themes need heavier shadows for visibility,
  // dark themes rely more on borders so shadows can be subtle.
  const shadowStrength = overlay?.['shadow-strength'] ?? (lum > 0.2 ? 0.2 : 0.1);

  const result: Record<string, string> = {
    '--scrim': overlay?.scrim ?? `rgba(${scrimR}, ${scrimG}, ${scrimB}, 0.5)`,
    '--scrim-heavy': overlay?.['scrim-heavy'] ?? `rgba(${scrimR}, ${scrimG}, ${scrimB}, 0.7)`,
    '--shadow-strength': String(shadowStrength),
    '--destructive': overlay?.destructive ?? '#DD4444',
    '--destructive-dim': `rgba(${parseHex(overlay?.destructive ?? '#DD4444').join(', ')}, 0.15)`,
  };

  return result;
}

/** Implicit opacity fallback when a theme declares blur without opacity.
 *  Preserves translucent feel for themes written before the fields were decoupled.
 *  See GLASSMORPHISM-REFACTOR-PLAN.md § "Implicit opacity fallback". */
const IMPLICIT_GLASS_OPACITY = 0.77;

const LAYOUT_ATTRS = ['data-chrome-style', 'data-input-style', 'data-bubble-style', 'data-header-style', 'data-statusbar-style'] as const;

/** Applies a full ThemeDefinition to the live DOM. Only call from renderer process.
 *  When reducedEffects is true, glassmorphism, particles, and overlay effects are suppressed. */
export function applyThemeToDom(theme: ThemeDefinition, reducedEffects = false): void {
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

  // 4. Glassmorphism — always-on CSS vars with safe defaults.
  //    Blur and opacity are INDEPENDENT knobs. globals.css rules consume the
  //    vars unconditionally; at 0px blur + opacity 1 the effect is a no-op.
  //    Implicit opacity fallback (IMPLICIT_GLASS_OPACITY) preserves the
  //    translucent look for legacy themes that only declared blur.
  //    Reduced-effects mode forces blurs to 0 but leaves opacities alone so
  //    the user's transparency intent is respected.
  const rawPanelsBlur = theme.background?.['panels-blur'] ?? 0;
  const rawBubbleBlur = theme.background?.['bubble-blur'] ?? 0;
  const panelsBlur = reducedEffects ? 0 : rawPanelsBlur;
  const bubbleBlur = reducedEffects ? 0 : rawBubbleBlur;
  const panelsOpacity = theme.background?.['panels-opacity']
    ?? (rawPanelsBlur > 0 ? IMPLICIT_GLASS_OPACITY : 1);
  const bubbleOpacity = theme.background?.['bubble-opacity']
    ?? (rawBubbleBlur > 0 ? IMPLICIT_GLASS_OPACITY : 1);

  root.style.setProperty('--panels-blur', `${panelsBlur}px`);
  root.style.setProperty('--panels-opacity', String(panelsOpacity));
  root.style.setProperty('--bubble-blur', `${bubbleBlur}px`);
  root.style.setProperty('--bubble-opacity', String(bubbleOpacity));

  // Terminal transparency vars. Read directly by TerminalView — no global
  // CSS rules consume these, so literal-value injection (like the #theme-glass
  // hack for panels-blur) is not needed. Reduced-effects zeros runtime blur
  // but leaves opacity + brightness alone (same policy as panels-blur).
  const rawTerminalBlur = theme.background?.['terminal-blur'] ?? 8;
  const terminalBlur = reducedEffects ? 0 : rawTerminalBlur;
  const terminalOpacity = theme.background?.['terminal-opacity'] ?? 0.6;
  const terminalBrightness = theme.background?.['terminal-brightness'] ?? 0.86;
  root.style.setProperty('--terminal-xterm-opacity', String(terminalOpacity));
  root.style.setProperty('--terminal-bg-blur', `${terminalBlur}px`);
  root.style.setProperty('--terminal-bg-brightness', String(terminalBrightness));

  if (reducedEffects) {
    root.setAttribute('data-reduced-effects', '');
  } else {
    root.removeAttribute('data-reduced-effects');
  }

  // 4b. Overlay tokens — scrim, overlay surface, shadow strength, destructive accent.
  //     Computed from existing color tokens; theme authors can override via overlay field.
  //     Uses concrete rgba() values (not color-mix) for Android WebView compatibility.
  for (const [prop, value] of Object.entries(computeOverlayTokens(theme.tokens, theme.background, theme.overlay, reducedEffects))) {
    root.style.setProperty(prop, value);
  }

  // 5. Background wallpaper — set directly on <body> (bypasses z-index stacking issues)
  //    Also expose as --wallpaper-url so portaled glass overlays can render
  //    a blurred copy via ::before (backdrop-filter doesn't work on body children)
  const bg = theme.background;
  // Fix: gradient backgrounds also need the app-shell transparency + glass treatment
  // gated on [data-wallpaper]. Without this, the bg-canvas app-shell paints over the
  // #theme-bg gradient layer and the gradient appears as a flat canvas-colored screen.
  const hasBackgroundLayer = (bg?.type === 'image' || bg?.type === 'gradient') && !!bg.value;
  if (hasBackgroundLayer) {
    root.setAttribute('data-wallpaper', '');
  } else {
    root.removeAttribute('data-wallpaper');
  }
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

  // 7b. Engine overrides style tag — removed in the glassmorphism refactor.
  //     Manifest fields flow through --panels-* / --bubble-* CSS variables which
  //     globals.css consumes unconditionally, so there's no longer a need to
  //     re-inject rules after theme custom_css. If a stale overrides tag exists
  //     from a previous engine version, clear it so it can't compete.
  const staleOverridesEl = document.getElementById('theme-engine-overrides');
  if (staleOverridesEl) staleOverridesEl.textContent = '';

  // 7c. Wallpaper-only glass stylesheet.
  //     Fix: Chromium does NOT repaint backdrop-filter: blur(var(--x)) when
  //     --x changes, so sliders appear inert. Injecting the blur value as a
  //     LITERAL in the rule declaration forces the declaration itself to
  //     change on each apply → Chrome reruns the filter pipeline. Gated on
  //     [data-wallpaper] so solid themes never pay the stacking-context +
  //     GPU cost for zero visual benefit. See GLASSMORPHISM-BLUR-FIX-PLAN.md.
  const glassCSSId = 'theme-glass';
  let glassEl = document.getElementById(glassCSSId) as HTMLStyleElement | null;
  if (!glassEl) {
    glassEl = document.createElement('style');
    glassEl.id = glassCSSId;
    document.head.appendChild(glassEl);
  }
  const isWallpaper = bg?.type === 'image' && !!bg.value;
  if (isWallpaper && !reducedEffects && panelsBlur > 0) {
    const scrimBlur = Math.min(panelsBlur, 8);
    const bubbleRule = bubbleBlur > 0 ? `
    [data-wallpaper] .in-view .bg-inset,
    [data-wallpaper] .in-view .bg-accent {
      backdrop-filter: blur(${bubbleBlur}px) saturate(1.1);
      -webkit-backdrop-filter: blur(${bubbleBlur}px) saturate(1.1);
    }` : '';
    // Slide polish: while the settings drawer is mid-slide we drop the blur
    // radius to ~30% so Chrome re-samples a much cheaper region per frame,
    // then transition back to full radius on transitionend. Without this,
    // a 320×100vh backdrop-filter re-rasterizes every animation frame and
    // visibly stutters the slide on integrated GPUs.
    const drawerReducedBlur = Math.max(1, Math.round(panelsBlur * 0.3));
    glassEl.textContent = `
    [data-wallpaper] .header-bar,
    [data-wallpaper] .status-bar,
    [data-wallpaper] .input-bar-container,
    [data-wallpaper] .settings-drawer,
    [data-wallpaper] .glass-overlay,
    [data-wallpaper] .layer-surface,
    [data-wallpaper] .panel-glass {
      backdrop-filter: blur(${panelsBlur}px) saturate(1.2);
      -webkit-backdrop-filter: blur(${panelsBlur}px) saturate(1.2);
    }
    [data-wallpaper] .settings-drawer {
      transition: backdrop-filter 220ms ease-out, -webkit-backdrop-filter 220ms ease-out;
    }
    [data-wallpaper] .settings-drawer[data-animating="true"] {
      backdrop-filter: blur(${drawerReducedBlur}px) saturate(1.1);
      -webkit-backdrop-filter: blur(${drawerReducedBlur}px) saturate(1.1);
    }
    [data-wallpaper] .layer-scrim {
      backdrop-filter: blur(${scrimBlur}px);
      -webkit-backdrop-filter: blur(${scrimBlur}px);
    }${bubbleRule}
    `;
  } else {
    // Keep the tag in place but empty it — avoids layout thrash from
    // repeatedly creating/removing the element across theme switches.
    glassEl.textContent = '';
  }

  // 8. Theme font — inject Google Font <link> and set --font-sans/--font-mono
  applyThemeFont(theme.font);

  // 9. Visual effects — create/remove overlay divs for vignette, noise, scan-lines
  applyEffects(reducedEffects ? undefined : theme.effects);
}

const TOKEN_CSS_PROPS = [
  '--canvas', '--panel', '--inset', '--well', '--accent', '--on-accent',
  '--fg', '--fg-2', '--fg-dim', '--fg-muted', '--fg-faint',
  '--edge', '--edge-dim', '--scrollbar-thumb', '--scrollbar-hover',
  // Overlay tokens (computed by theme engine from color tokens)
  '--scrim', '--scrim-heavy',
  '--shadow-strength', '--destructive', '--destructive-dim',
  // Glassmorphism vars — always present with safe defaults (blur 0, opacity 1)
  '--panels-blur', '--panels-opacity', '--bubble-blur', '--bubble-opacity',
] as const;

