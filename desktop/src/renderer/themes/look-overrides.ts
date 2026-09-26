// The user's own look, laid over whichever theme is active.
//
// WHY this exists (Destin, appearance-panel-questions deck, 2026-09-24): a theme
// ships ONE set of look choices — layout, glass, bubble shape, message box,
// roundness — and the user may override any of them with a single GLOBAL
// choice that applies to every theme. There are deliberately no per-theme
// tweaks any more (AP-3 note: "themes will just have one set of settings, to be
// overridden by global tweak"); the old per-slug `glassOverrides` are dropped,
// not migrated (his pick in chat the same day).
//
// Every field is optional and ABSENT means "Theme's choice". With nothing set,
// applyLookOverrides returns the very same theme object — the promise on AP-S1
// that nobody's app changes until they change a setting is this identity.

import type { BubbleStyle, ChromeStyle, InputStyle, LoadedTheme, ThemeBackground } from './theme-types';

/** The seven glass knobs a theme's background can carry. */
export type GlassValues = {
  'panels-blur'?: number;
  'panels-opacity'?: number;
  'bubble-blur'?: number;
  'bubble-opacity'?: number;
  'terminal-opacity'?: number;
  'terminal-blur'?: number;
  'terminal-brightness'?: number;
};
export type GlassField = keyof GlassValues;

export type GlassPreset = 'clear' | 'frosted' | 'solid' | 'custom';

export interface LookOverrides {
  chromeStyle?: ChromeStyle;
  glass?: GlassPreset;
  /** The Fine-tune sliders' values; used only while `glass` is 'custom'. */
  glassCustom?: GlassValues;
  bubbleStyle?: BubbleStyle;
  /** 0 = square … 1 = fully round, the same scale the user-theme editor uses. */
  roundness?: number;
}

/** What the three one-tap glass choices mean. Terminal knobs are left to the
 *  theme — only Fine-tune reaches them — because the terminal already has its
 *  own readability floor and a preset has no business moving it. */
export const GLASS_PRESETS: Record<Exclude<GlassPreset, 'custom'>, GlassValues> = {
  clear:   { 'panels-blur': 10, 'panels-opacity': 0.55, 'bubble-blur': 8,  'bubble-opacity': 0.6 },
  frosted: { 'panels-blur': 24, 'panels-opacity': 0.78, 'bubble-blur': 16, 'bubble-opacity': 0.8 },
  solid:   { 'panels-blur': 12, 'panels-opacity': 0.97, 'bubble-blur': 8,  'bubble-opacity': 0.97 },
};

/** The engine's own fallbacks, so a slider shows the value that is actually painted
 *  when neither the theme nor the user set one. Must match theme-engine / ThemeScreen. */
export const GLASS_DEFAULTS: Required<GlassValues> = {
  'panels-blur': 24,
  'panels-opacity': 0.88,
  'bubble-blur': 16,
  'bubble-opacity': 0.88,
  'terminal-opacity': 0.6,
  'terminal-blur': 8,
  'terminal-brightness': 0.86,
};

/** The corner radii for a 0–1 roundness (moved here from ThemeScreen so the
 *  user-theme editor and the global override draw corners the same way). */
export function roundnessToShape(value: number) {
  const sm  = Math.round(value * 8);
  const md  = Math.round(value * 16);
  const lg  = Math.round(value * 24);
  const xl  = Math.round(value * 32);
  const xxl = Math.min(Math.round(value * 48), 36); // cap at 36px to prevent bubble content clipping
  return { 'radius-sm': `${sm}px`, 'radius-md': `${md}px`, 'radius-lg': `${lg}px`, 'radius-xl': `${xl}px`, 'radius-2xl': `${xxl}px`, 'radius-full': '9999px' };
}

/** A theme's roundness on the 0–1 scale, read back from its medium radius. */
export function themeRoundness(theme: Pick<LoadedTheme, 'shape'>): number {
  const md = theme.shape?.['radius-md'];
  if (!md) return 0.5;
  return Math.min(parseInt(md) / 16, 1);
}

/** Glass only shows through a wallpaper or gradient; on a flat theme there is
 *  nothing behind the panels, so the glass override is skipped rather than
 *  inventing a background the theme never had. */
export function hasSeeThroughBackground(theme: Pick<LoadedTheme, 'background'>): boolean {
  const t = theme.background?.type;
  return t === 'image' || t === 'gradient';
}

/** The glass values the user's choice adds, or null when glass follows the theme. */
function glassValuesFor(o: LookOverrides): GlassValues | null {
  if (!o.glass) return null;
  if (o.glass === 'custom') return o.glassCustom ?? {};
  return GLASS_PRESETS[o.glass];
}

/** The message box each layout wears when the user picks it for every theme — the
 *  theme builder's layout presets (kit-presets.json: Classic, Floating, Minimalist). */
const LAYOUT_INPUT_STYLE: Record<ChromeStyle, InputStyle> = {
  default: 'default',
  floating: 'floating',
  float: 'default',
};

export function hasAnyOverride(o: LookOverrides): boolean {
  return o.chromeStyle !== undefined || o.glass !== undefined || o.bubbleStyle !== undefined
    || o.roundness !== undefined;
}

export function applyLookOverrides(theme: LoadedTheme, o: LookOverrides): LoadedTheme {
  if (!hasAnyOverride(o)) return theme;
  let next: LoadedTheme = theme;
  const layoutPatch: Record<string, string> = {};
  if (o.chromeStyle) {
    layoutPatch['chrome-style'] = o.chromeStyle;
    // WHY the message box rides on the layout (Destin, appearance-panel-review-4 AR4-4:
    // "the message box setting should just be tied to the frame setting"): its own
    // setting was removed, and a layout picked for every theme brings its matching
    // message box — the same pairing as the theme builder's layout presets. Auto
    // layout leaves the theme's own message box alone.
    layoutPatch['input-style'] = LAYOUT_INPUT_STYLE[o.chromeStyle];
  }
  if (o.bubbleStyle) layoutPatch['bubble-style'] = o.bubbleStyle;
  if (Object.keys(layoutPatch).length) {
    next = { ...next, layout: { ...(next.layout ?? {}), ...layoutPatch } };
  }
  if (o.roundness !== undefined) {
    next = { ...next, shape: { ...(next.shape ?? {}), ...roundnessToShape(o.roundness) } };
  }
  const glass = glassValuesFor(o);
  if (glass && hasSeeThroughBackground(next)) {
    next = { ...next, background: { ...(next.background as ThemeBackground), ...glass } };
  }
  return next;
}

/** Reads a stored/synced value defensively: anything malformed is "no override",
 *  never a half-applied one. */
export function parseLookOverrides(raw: unknown): LookOverrides {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: LookOverrides = {};
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[]) =>
    (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : undefined);
  out.chromeStyle = oneOf(r.chromeStyle, ['default', 'floating', 'float'] as const);
  out.glass = oneOf(r.glass, ['clear', 'frosted', 'solid', 'custom'] as const);
  out.bubbleStyle = oneOf(r.bubbleStyle, ['default', 'pill', 'flat', 'bordered'] as const);
  if (typeof r.roundness === 'number' && r.roundness >= 0 && r.roundness <= 1) out.roundness = r.roundness;
  if (r.glassCustom && typeof r.glassCustom === 'object') {
    const g: GlassValues = {};
    for (const k of Object.keys(GLASS_DEFAULTS) as GlassField[]) {
      const v = (r.glassCustom as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) g[k] = v;
    }
    out.glassCustom = g;
  }
  for (const k of Object.keys(out) as (keyof LookOverrides)[]) if (out[k] === undefined) delete out[k];
  return out;
}
