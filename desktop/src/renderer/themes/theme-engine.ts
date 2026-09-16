import type { ThemeTokens, ThemeShape, ThemeFont, ThemeBackground, ThemeLayout, ThemeEffects, ThemeOverlay, ThemeDefinition } from './theme-types';

/** True when the theme composites a real layer behind the chrome — a wallpaper
 *  image or a gradient. This is THE predicate that stamps `[data-wallpaper]` on
 *  <html> (which gates every glass/backdrop rule in globals.css) and it is what
 *  the terminal's surface guarantee keys on too, so "has a wallpaper" means the
 *  same thing everywhere in the renderer. A `panels-blur` on a solid theme does
 *  NOT count: there is nothing behind the canvas to see through to. */
export function hasBackgroundLayer(bg: ThemeBackground | undefined): boolean {
  return (bg?.type === 'image' || bg?.type === 'gradient') && !!bg.value;
}

/** Terminal surface guarantee under wallpaper themes (UI review ledger P-20.2,
 *  decided by Destin 2026-08-27): the terminal grid paints the theme's PANEL
 *  colour and sits at no less than 80% opacity, so Claude Code's TUI text
 *  reads over any wallpaper instead of being drawn straight onto the image at
 *  60%. Flat themes are untouched — they keep the --canvas surface and the
 *  theme's own `terminal-opacity` (default 0.6). */
export const TERMINAL_WALLPAPER_OPACITY_FLOOR = 0.8;
/** The pre-guarantee default, still what a flat theme gets when it declares
 *  no `terminal-opacity`. */
const TERMINAL_DEFAULT_OPACITY = 0.6;

interface TerminalSurface {
  /** Which theme token xterm paints as its OPAQUE background, and what the
   *  grid container / `.xterm-viewport` fill with. */
  backing: 'panel' | 'canvas';
  /** The grid container's opacity (`--terminal-xterm-opacity`). */
  opacity: number;
}

/** The ONE place the terminal's surface is decided. applyThemeToDom writes it
 *  out as `--terminal-backing` / `--terminal-xterm-opacity`; TerminalView calls
 *  it directly for the token name xterm needs (xterm wants a resolved colour,
 *  not a var() reference, so it reads --panel / --canvas by name).
 *
 *  WHY a floor rather than a fixed 0.8: the guarantee exists for readability,
 *  so a pack that asks for MORE solidity (0.9, 1) is honoured, while a pack
 *  that asks for less (0.4) would defeat the point and is raised to 0.8. Pack
 *  authors keep full control on flat themes, where readability was never the
 *  problem. */
export function computeTerminalSurface(bg: ThemeBackground | undefined): TerminalSurface {
  const declared = bg?.['terminal-opacity'] ?? TERMINAL_DEFAULT_OPACITY;
  if (!hasBackgroundLayer(bg)) return { backing: 'canvas', opacity: declared };
  return { backing: 'panel', opacity: Math.max(declared, TERMINAL_WALLPAPER_OPACITY_FLOOR) };
}

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
/**
 * The pure half of applyEffects: which background layers an effects block
 * produces, and at what size. Exported so the layer STRINGS can be pinned by a
 * test — applyEffects itself only exists to poke the DOM, and the scanline
 * alpha silently drifted out of sync with the theme-builder preview precisely
 * because nothing could assert on it.
 */
export function buildEffectLayers(
  effects: ThemeEffects | undefined,
): { backgrounds: string[]; sizes: string[] } {
  const backgrounds: string[] = [];
  const sizes: string[] = [];
  if (!effects) return { backgrounds, sizes };

  // Vignette — opacity baked into radial gradient endpoint
  const vignetteVal = effects.vignette ?? 0;
  if (vignetteVal > 0) {
    backgrounds.push(`radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,${vignetteVal}) 100%)`);
    sizes.push('100% 100%');
  }

  // Scanlines — line alpha is (theme base opacity x 0.15 line alpha).
  //
  // Fix: read --scanline-opacity instead of baking the product as the literal
  // 0.012. `scan-lines` is a bare boolean in ThemeEffects — unlike vignette and
  // noise, which are numeric intensities interpolated around it — so a theme had
  // no way to say how strong its scanlines should be. The theme-builder Kit
  // ships an intensity slider that writes `:root { --scanline-opacity: N }` into
  // custom_css; because this rule contained no var() at all, that slider visibly
  // worked in the Kit preview and did nothing in the shipped theme.
  //
  // The 0.08 fallback reproduces the previous literal exactly (0.08 * 0.15 =
  // 0.012), so every existing theme renders unchanged. Custom properties resolve
  // at computed-value time, so it does not matter that custom_css is injected
  // before this runs, nor that this ends up in an inline style.
  if (effects['scan-lines']) {
    const lineAlpha = 'calc(var(--scanline-opacity, 0.08) * 0.15)';
    backgrounds.push(
      `repeating-linear-gradient(0deg, transparent, transparent 1px, rgb(0 0 0 / ${lineAlpha}) 1px, rgb(0 0 0 / ${lineAlpha}) 2px)`,
    );
    sizes.push('100% 100%');
  }

  // Noise — opacity baked into SVG rect attribute
  const noiseVal = effects.noise ?? 0;
  if (noiseVal > 0) {
    const noiseSvg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='${noiseVal}'/%3E%3C/svg%3E`;
    backgrounds.push(`url("${noiseSvg}")`);
    sizes.push('200px 200px');
  }

  return { backgrounds, sizes };
}

function applyEffects(effects: ThemeEffects | undefined): void {
  // Remove any legacy per-effect divs from previous theme applications
  for (const id of LEGACY_EFFECT_IDS) document.getElementById(id)?.remove();

  const { backgrounds, sizes } = buildEffectLayers(effects);

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

/** WCAG 2.0 contrast ratio between two hex colors (1:1 … 21:1).
 *  Mirrors scripts/audit-theme-contrast.mjs so runtime derivation and the CI
 *  audit agree on what "readable" means. */
function contrastRatio(hexA: string, hexB: string): number {
  const lA = rgbLuminance(...parseHex(hexA));
  const lB = rgbLuminance(...parseHex(hexB));
  const [hi, lo] = lA > lB ? [lA, lB] : [lB, lA];
  return (hi + 0.05) / (lo + 0.05);
}

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Linear RGB blend of two hexes. t=0 returns a, t=1 returns b. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/**
 * Derive the destructive colour used as TEXT on the theme's own surfaces.
 *
 * WHY this is a separate token from --destructive: that one is used as a FILLED
 * surface (danger buttons/toggles), where the label needs contrast *against* it,
 * so it wants to be dark. `text-destructive` needs contrast against the CANVAS,
 * which on a dark theme means it wants to be light. Those pull in opposite
 * directions, and a sweep of the red space found ZERO values that satisfy both
 * at AA across all five shipped themes — one token genuinely cannot do both.
 * This is the same split --accent / --on-accent already has, for the same reason.
 *
 * Nudges --destructive toward white (dark themes) or black (light themes) until
 * it clears AA against the WORSE of canvas and panel. Most `text-destructive`
 * sites sit on one or the other, and popups (panel) are the tighter constraint.
 * Returns --destructive unchanged when it already passes, so light themes — where
 * the fill colour is already legible as text — see no change at all.
 */
function deriveDestructiveFg(destructive: string, canvas: string, panel: string): string {
  const worst = (c: string) => Math.min(contrastRatio(c, canvas), contrastRatio(c, panel));
  if (worst(destructive) >= 4.5) return destructive;
  const target = rgbLuminance(...parseHex(canvas)) < 0.5 ? '#FFFFFF' : '#000000';
  // 2% steps: fine enough that the result stays recognisably the pack's red,
  // coarse enough to terminate quickly. Falls through to the pure target only
  // for a pathological pack whose destructive is the canvas colour.
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const candidate = mixHex(destructive, target, t);
    if (worst(candidate) >= 4.5) return candidate;
  }
  return target;
}

/**
 * The one amber every warning is drawn in, before the theme gets a say. Tailwind
 * amber-400 — the colour the app has always used for a warning.
 */
export const WARNING_BASE = '#FBBF24';

/**
 * Derive the amber a warning is actually painted in, per theme.
 *
 * WHY (contract R30, measured 2026-09-06): warnings were drawn in one fixed
 * amber. On a dark theme that is crisp — 9.5:1 on Halftone Dimension. On a pale
 * theme it is not: the same amber on Meadow Mist's pale-green card measured
 * 1.05:1, roughly the same brightness as the card behind it. It was legible only
 * if you already knew it was there, and it did not read as a warning at all.
 * Themes are user-installable, so no per-theme colour can fix this — a theme
 * nobody has written yet has to come out right on its own.
 *
 * Same shape as deriveDestructiveFg: mix the amber toward white (dark themes) or
 * black (light themes) in 2% steps until it clears AA against every surface a
 * warning is painted on, and return it unchanged when it already passes — so
 * dark themes, where the amber is already crisp, see no change whatsoever.
 *
 * The surfaces are panel, inset AND their half-and-half blend, because the
 * warning card is `bg-inset/50` sitting on a panel: the pixels behind the text
 * are literally that mix, and checking only the two endpoints would let a
 * straddling pair through. Canvas is in the set too — the same amber marks
 * warnings out on the page itself.
 */
function deriveWarningFg(canvas: string, panel: string, inset: string): string {
  const blend = mixHex(inset, panel, 0.5);
  const worst = (c: string) => Math.min(
    contrastRatio(c, canvas), contrastRatio(c, panel),
    contrastRatio(c, inset), contrastRatio(c, blend),
  );
  if (worst(WARNING_BASE) >= 4.5) return WARNING_BASE;
  const target = rgbLuminance(...parseHex(canvas)) < 0.5 ? '#FFFFFF' : '#000000';
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const candidate = mixHex(WARNING_BASE, target, t);
    if (worst(candidate) >= 4.5) return candidate;
  }
  return target;
}

/**
 * Nudge a DERIVED link colour until it is actually readable.
 *
 * WHY: the accent-vs-fg distance guard below only asks "is this link
 * distinguishable from body text" — never "can you read it". Measured across
 * the 11 shipped themes, that let 4 community packs derive a link that fails
 * AA on the surface links are mostly painted on, worst of them kuromi-dreamer
 * at 2.90:1. Same failure shape as --destructive-fg, so same fix: mix toward
 * white (dark themes) / black (light themes) in 2% steps until it clears 4.5:1
 * against the WORST of canvas, panel and inset.
 *
 * Inset is in that set and canvas is not the tight one: the assistant bubble is
 * `bg-inset` (AssistantTurnBubble.tsx:374) and MarkdownContent renders inside
 * it, so the bubble — not the page — is where most links actually live. `well`
 * is deliberately excluded; it is the command-drawer search surface and nothing
 * renders a link on it. Including it would fail two packs with no site to fix.
 *
 * Only DERIVED links go through this. A pack that declares `link` has made an
 * explicit choice, and silently overriding it would both break author intent
 * (creme's olive #5B4A1E is deliberate) and make the audit's HARD link rules
 * unfailable — a gate that cannot fail reports nothing.
 */
function deriveLink(base: string, canvas: string, panel: string, inset: string): string {
  const worst = (c: string) =>
    Math.min(contrastRatio(c, canvas), contrastRatio(c, panel), contrastRatio(c, inset));
  if (worst(base) >= 4.5) return base;
  const target = rgbLuminance(...parseHex(canvas)) < 0.5 ? '#FFFFFF' : '#000000';
  for (let t = 0.02; t <= 1.0001; t += 0.02) {
    const candidate = mixHex(base, target, t);
    if (worst(candidate) >= 4.5) return candidate;
  }
  return target;
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

  // Inline-code color — prefer the theme's accent so code picks up palette
  // character, but fall back to fg-2 when accent is too close to fg (some
  // themes use accent == fg for high-contrast buttons, which would make code
  // invisible against prose). Previously this was a hardcoded yellow/gold in
  // globals.css that community themes silently inherited from :root.
  const [fgR, fgG, fgB] = parseHex(tokens.fg);
  const [accR, accG, accB] = parseHex(tokens.accent);
  const accentFgDistance = Math.sqrt(
    (accR - fgR) ** 2 + (accG - fgG) ** 2 + (accB - fgB) ** 2,
  );
  const code = accentFgDistance > 40 ? tokens.accent : tokens['fg-2'];

  // Link color — same accent-vs-fg guard as --code above, for the same reason:
  // themes that set accent == fg would otherwise render links invisible against
  // prose. Packs may declare `link` explicitly to opt out of the derivation.
  // Built-ins all declare their own, so this branch only runs for community packs.
  //
  // The guard alone is not enough: it answers "different from body text?" but
  // not "readable?", which is how 4 packs shipped a sub-AA link. deriveLink
  // finishes the job — see its comment for why inset is in the surface set.
  const link = tokens.link
    ?? deriveLink(
      accentFgDistance > 40 ? tokens.accent : tokens['fg-2'],
      tokens.canvas,
      tokens.panel,
      tokens.inset,
    );
  const linkHover = tokens['link-hover'] ?? `color-mix(in oklab, ${link} 85%, ${tokens.fg})`;

  // Label color for filled --destructive surfaces (danger buttons, danger toggles).
  // --destructive is pack-overridable with NO contrast guard, so hardcoding white
  // can render white-on-pale-pink. Pick whichever of white / near-black reads
  // better against the theme's actual destructive.
  //
  // NOTE: this is a max-contrast pick, NOT the "white if >= 4.5, else near-black"
  // threshold the UI spec asked for. That rule was written believing white on the
  // old default #DD4444 scored 4.7:1; it actually scored 4.213:1, so the threshold
  // would have failed for EVERY theme and flipped every danger button to near-black
  // — both a visible regression and LOWER contrast than the white it replaced
  // (near-black on #DD4444 was 4.131:1). Picking the better of the two delivers
  // what the spec intended: white everywhere today, near-black only for packs
  // whose destructive is genuinely too light to carry it.
  //
  // The default was #DD4444, which could not carry an AA label at ANY text color:
  // 4.213:1 vs white and 4.131:1 vs near-black, both under the 4.5 bar for text
  // below 18px — and danger labels render at text-xs (12px) / text-2xs (11px).
  // No label color fixed it; only darkening the red did. #C62828 scores 5.62:1
  // against white, the largest margin of the candidates considered, so it stays
  // AA even if a future size change pushes labels smaller. No shipped theme
  // overrides overlay.destructive, so this default is what all 11 actually paint.
  const destructive = overlay?.destructive ?? '#C62828';
  const onDestructive =
    contrastRatio('#FFFFFF', destructive) >= contrastRatio('#1A1A1A', destructive)
      ? '#FFFFFF'
      : '#1A1A1A';

  const result: Record<string, string> = {
    '--scrim': overlay?.scrim ?? `rgba(${scrimR}, ${scrimG}, ${scrimB}, 0.5)`,
    '--scrim-heavy': overlay?.['scrim-heavy'] ?? `rgba(${scrimR}, ${scrimG}, ${scrimB}, 0.7)`,
    '--shadow-strength': String(shadowStrength),
    '--destructive': destructive,
    '--destructive-dim': `rgba(${parseHex(destructive).join(', ')}, 0.15)`,
    '--on-destructive': onDestructive,
    // Text-on-surface variant. See deriveDestructiveFg — --destructive is a FILL
    // colour and cannot also serve as legible text on a dark canvas.
    '--destructive-fg': deriveDestructiveFg(destructive, tokens.canvas, tokens.panel),
    // The amber warnings are painted in, made readable on THIS theme's surfaces.
    // See deriveWarningFg — one fixed amber vanished on pale themes.
    '--warning-fg': deriveWarningFg(tokens.canvas, tokens.panel, tokens.inset),
    '--code': code,
    '--link': link,
    '--link-hover': linkHover,
  };

  return result;
}

/** Implicit opacity fallback when a theme declares blur without opacity.
 *  Preserves translucent feel for themes written before the fields were decoupled.
 *  See GLASSMORPHISM-REFACTOR-PLAN.md § "Implicit opacity fallback". */
const IMPLICIT_GLASS_OPACITY = 0.77;

const LAYOUT_ATTRS = ['data-chrome-style', 'data-input-style', 'data-bubble-style', 'data-header-style', 'data-statusbar-style'] as const;

// WHY: Reduced Effects (applyThemeToDom's `reducedEffects` flag) has its own
// [data-reduced-effects] rules in globals.css, but those are selector-specific
// to the app's own chrome — they say nothing about a community theme's
// custom_css, which can keep a forever animation running on permanent chrome
// (.header-bar etc.) with Reduced Effects ON, the one setting a user reaches
// for to make the app stop moving. Rather than banning animation for every
// theme author (a change to what they shipped), read the selectors the theme
// itself animates and cancel exactly those, only while the setting is on.
//
// Matches the unprefixed longhand/shorthand AND -webkit-animation(-name):
// sanitizeCSS (theme-validator.ts) strips only script/URL injection vectors,
// not vendor prefixes, and Golden Sunbreak's own custom_css already ships
// other -webkit- properties — so a theme is free to use the legacy prefix and
// this must not miss it. The negative lookahead skips `animation: none` (and
// `-webkit-animation: none`) so a theme that's already off gets no useless
// override rule.
const ANIMATION_DECL = /(^|[\s;{])(-webkit-)?animation(-name)?\s*:\s*(?!none\b)/;

/** Reads every rule a theme's injected <style> animates and returns an
 *  `animation: none !important` override per selector, so applyThemeToDom
 *  can neutralise exactly the theme's own forever-animations under Reduced
 *  Effects. Detection uses each rule's cssText, not the animationName
 *  longhand, because jsdom's CSSOM does not expand shorthands and Chromium
 *  does — cssText is stable in both.
 *
 *  WHY selectorText is checked BEFORE the nested-cssRules branch: jsdom
 *  (unlike Chromium) exposes an (empty) `cssRules` on every CSSRule,
 *  including plain CSSStyleRule — an empty CSSRuleList is a truthy object,
 *  so checking `rule.cssRules` first would treat EVERY rule as a grouping
 *  rule and never read a single style rule's selector. Checking
 *  `selectorText` first is correct in both engines and is not a jsdom-only
 *  workaround: a real CSSMediaRule/CSSKeyframesRule has no selectorText, so
 *  it still falls through to the nested walk exactly as intended. */
export function buildReducedOverrides(styleEl: HTMLStyleElement): string {
  const sheet = styleEl.sheet as CSSStyleSheet | null;
  if (!sheet) return '';
  const selectors = new Set<string>();
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const style = rule as CSSStyleRule;
      if (style.selectorText) {
        if (ANIMATION_DECL.test(style.cssText)) selectors.add(style.selectorText);
        continue;
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested) walk(nested); // @media/@supports/@keyframes, …
    }
  };
  try { walk(sheet.cssRules); } catch { return ''; } // a cross-origin sheet would throw; ours never is
  return Array.from(selectors).map((s) => `${s} { animation: none !important; }`).join('\n');
}

/** Applies a full ThemeDefinition to the live DOM. Only call from renderer process.
 *  When reducedEffects is true, glassmorphism, particles, and overlay effects are suppressed. */
export function applyThemeToDom(theme: ThemeDefinition, reducedEffects = false): void {
  const root = document.documentElement;
  const body = document.body;

  // 1. data-theme attribute (drives existing [data-theme] CSS blocks as fallback)
  root.setAttribute('data-theme', theme.slug);

  // 1b. data-theme-mode — light/dark WITHOUT naming a slug. The [data-theme="…"]
  //     blocks in globals.css only match the four built-in slugs, so anything
  //     token-ish defined there is invisible to a community theme, which then
  //     silently inherits the :root (light) values no matter how dark it is.
  //     Provider brand colours hit exactly that: measured 2026-08-31, all seven
  //     published community themes failed 4.5:1 on the model chip and the three
  //     dark ones sat at 2.25–2.38:1. `dark` is a REQUIRED field on every
  //     ThemeDefinition, so this is authoritative rather than a luminance guess.
  root.setAttribute('data-theme-mode', theme.dark ? 'dark' : 'light');

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
  // Surface guarantee (P-20.2): under a wallpaper/gradient the backing is the
  // panel colour and the opacity is floored at 0.8; flat themes get --canvas
  // and their declared value, exactly as before. Decided in ONE place
  // (computeTerminalSurface) so TerminalView can never disagree with the vars.
  // `--terminal-backing` is consumed by the `.xterm-viewport` rule in
  // globals.css (the strip below the last cell row must match the grid).
  // Reduced-effects does not lift the floor: the wallpaper is still there,
  // only sharper, so the text needs the backing at least as much.
  const terminalSurface = computeTerminalSurface(theme.background);
  const terminalBrightness = theme.background?.['terminal-brightness'] ?? 0.86;
  root.style.setProperty('--terminal-xterm-opacity', String(terminalSurface.opacity));
  root.style.setProperty('--terminal-backing', `var(--${terminalSurface.backing})`);
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

  // 5. Background wallpaper — [data-wallpaper] gates app-shell transparency and glass treatment.
  //    The actual image is rendered by the React #theme-bg div (via buildBackgroundStyle),
  //    NOT on body. Setting it on body caused position:fixed z-index:-1 elements (the pattern
  //    overlay) to render BEHIND the body's own background, making patterns invisible on
  //    wallpaper themes. By keeping the wallpaper on #theme-bg (z-index:-1) and the pattern
  //    on #theme-pattern (z-index:-1, later in DOM), both sit below chat content and the
  //    pattern correctly renders in front of the wallpaper.
  const bg = theme.background;
  // Fix: gradient backgrounds also need the app-shell transparency + glass treatment
  // gated on [data-wallpaper]. Without this, the bg-canvas app-shell paints over the
  // #theme-bg gradient layer and the gradient appears as a flat canvas-colored screen.
  if (hasBackgroundLayer(bg)) {
    root.setAttribute('data-wallpaper', '');
  } else {
    root.removeAttribute('data-wallpaper');
  }
  // Always clear body background — the #theme-bg React div owns the wallpaper image.
  // Previously this was set on body, but that caused the pattern layer (z-index:-1) to
  // render behind body's own background-image, hiding patterns on all wallpaper themes.
  body.style.backgroundImage = '';
  body.style.backgroundSize = '';
  body.style.backgroundPosition = '';
  body.style.backgroundRepeat = '';

  // 6. Layout data attributes on body — clear previous first
  for (const attr of LAYOUT_ATTRS) {
    body.removeAttribute(attr);
  }
  for (const [attr, value] of Object.entries(buildLayoutAttrs(theme.layout))) {
    body.setAttribute(attr, value);
  }

  // 6b. Traffic-light positioning used to live here but was moved to
  //     HeaderBar's <MacTrafficLights> component. That component owns a
  //     ResizeObserver + MutationObserver on .header-bar so the lights track
  //     header height changes and chrome-style swaps without needing a theme
  //     re-apply. Keeping this note so future readers don't re-add it here.

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

  // 7a. Reduced Effects for theme-injected animation.
  //
  // WHY: see ANIMATION_DECL/buildReducedOverrides above for what this reads.
  // Off → this sheet is empty and #theme-custom is byte-identical to before
  // this feature existed, so nothing changes for users who don't touch the
  // setting.
  //
  // WHY reposition on EVERY apply, not only at creation: #theme-custom is
  // created lazily (only once a theme HAS custom_css). A theme with none,
  // followed by one that has custom_css, creates #theme-custom on the
  // SECOND apply — by which point #theme-custom-reduced may already exist
  // from the first apply's fallback append to the end of <head>. Without
  // reasserting adjacency here, the override sheet would sit BEFORE the
  // theme's own rules and lose ties on specificity. Must come AFTER
  // #theme-custom so equal-specificity rules win by source order.
  const reducedCSSId = 'theme-custom-reduced';
  let reducedEl = document.getElementById(reducedCSSId) as HTMLStyleElement | null;
  if (!reducedEl) {
    reducedEl = document.createElement('style');
    reducedEl.id = reducedCSSId;
  }
  if (customEl) {
    if (reducedEl.previousElementSibling !== customEl) {
      customEl.insertAdjacentElement('afterend', reducedEl);
    }
  } else if (!reducedEl.isConnected) {
    document.head.appendChild(reducedEl);
  }
  reducedEl.textContent = reducedEffects && customEl ? buildReducedOverrides(customEl) : '';

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
  //     Gradient backgrounds also qualify — they composite a real layer behind
  //     the chrome, so blurring it produces a visible effect just like an image.
  const glassCSSId = 'theme-glass';
  let glassEl = document.getElementById(glassCSSId) as HTMLStyleElement | null;
  if (!glassEl) {
    glassEl = document.createElement('style');
    glassEl.id = glassCSSId;
    document.head.appendChild(glassEl);
  }
  if (hasBackgroundLayer(bg) && !reducedEffects && panelsBlur > 0) {
    const scrimBlur = Math.min(panelsBlur, 8);
    const bubbleRule = bubbleBlur > 0 ? `
    [data-wallpaper] .in-view .bg-inset,
    [data-wallpaper] .in-view .bg-accent,
    /* Artifact drawer reads as a bubble-like surface in any partial-or-
       full floating-chrome theme, so it picks up the bubble blur radius
       (not the panels blur used for chrome). Gating includes both
       chrome-style='floating' (full floating) and input-style='floating'
       (partial: floating input over default header — e.g. devils-garden).
       Wallpaper presence is required since there's nothing behind a
       solid theme to actually blur. */
    [data-wallpaper] [data-chrome-style='floating'] .framed-shell > .drawer-pane,
    [data-wallpaper] [data-input-style='floating'] .framed-shell > .drawer-pane {
      backdrop-filter: blur(${bubbleBlur}px) saturate(1.1);
      -webkit-backdrop-filter: blur(${bubbleBlur}px) saturate(1.1);
    }

    /* A .bg-inset card INSIDE an already-blurred assistant bubble is a
       redundant blur layer: it samples a backdrop that is already blurred, so it
       adds almost nothing visually while costing a full blur re-rasterisation on
       every repaint inside the card — including each frame of a hover fade. Same
       shape as the drawer-tile bug this repo shipped twice (globals.css:1095-1129).
       The bubble keeps its blur; only the nested layers drop out. */
    [data-wallpaper] .in-view .assistant-bubble .bg-inset {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }` : '';
    // Slide polish: while the settings drawer is mid-slide we drop the blur
    // radius to ~30% so Chrome re-samples a much cheaper region per frame,
    // then transition back to full radius on transitionend. Without this,
    // a 320×100vh backdrop-filter re-rasterizes every animation frame and
    // visibly stutters the slide on integrated GPUs.
    const drawerReducedBlur = Math.max(1, Math.round(panelsBlur * 0.3));
    glassEl.textContent = `
    /* SINGLE chrome-glass surface for the entire framed chrome region.
       In framed mode this one element carries the backdrop-filter for
       the whole frame (header strip, side edges, divider, bottom strip,
       rounded inner corners) — see globals.css .chrome-glass for the
       full rationale. The per-element backdrop-filters on
       header-bar/status-bar/input-bar-container/frame-edge/etc. were
       removed because compositing them produced subpixel-boundary
       seams at non-100% zoom. */
    [data-wallpaper] .chrome-glass,

    /* Floating chrome themes — header/input/status are independent
       pills (chrome-glass is display:none in those themes) and need
       their own backdrop-filter. The selectors match BOTH full
       floating chrome AND partial-floating (input-only) variants.
       Partial-floating themes like devils-garden have chrome-style
       'default' but input-style 'floating'; their header + status are
       non-pill full-width strips that still need glass treatment. */
    [data-wallpaper] [data-chrome-style='floating'] .header-bar,
    [data-wallpaper] [data-chrome-style='floating'] .status-bar,
    [data-wallpaper] [data-chrome-style='floating'] .input-bar-container,
    [data-wallpaper] [data-input-style='floating'] .header-bar,
    [data-wallpaper] [data-input-style='floating'] .status-bar,
    [data-wallpaper] [data-input-style='floating'] .input-bar-container,

    /* Popups / drawers / modals — independent of chrome style. */
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


