export interface ThemeTokens {
  canvas: string;
  panel: string;
  inset: string;
  well: string;
  accent: string;
  'on-accent': string;
  fg: string;
  'fg-2': string;
  'fg-dim': string;
  'fg-muted': string;
  'fg-faint': string;
  edge: string;
  'edge-dim': string;
  'scrollbar-thumb': string;
  'scrollbar-hover': string;
  /** Hyperlink color. OPTIONAL — the engine derives it from accent/fg-2 when a
   *  pack omits it (see computeOverlayTokens). Before this was derivable, packs
   *  had no way to set it and silently inherited the Light theme's #2563EB from
   *  :root, so every community theme rendered light-blue links. The four
   *  built-ins declare their own hand-picked values. */
  link?: string;
  /** Hover state for `link`. Derived as link mixed 85% toward fg when omitted. */
  'link-hover'?: string;
}

export interface ThemeShape {
  'radius'?: string;
  'radius-sm'?: string;
  'radius-md'?: string;
  'radius-lg'?: string;
  'radius-xl'?: string;
  'radius-2xl'?: string;
  'radius-full'?: string;
}

export interface ThemeFont {
  /** CSS font-family value, e.g. "'Victor Mono', 'Cascadia Mono', monospace" */
  family: string;
  /** Google Fonts @import URL. Injected as a <link> at theme load time. */
  'google-font-url'?: string;
}

export interface ThemeBackground {
  type: 'solid' | 'gradient' | 'image';
  value: string;
  // Pre-blurred + darkened wallpaper used exclusively in TerminalView so
  // xterm text stays readable over high-frequency image detail. Optional —
  // themes without it fall back to the container-opacity wallpaper-peek trick.
  'terminal-value'?: string;
  // TerminalView transparency knobs. All three are overridable per-theme via
  // the Appearance editor sliders. Defaults live in theme-engine.ts.
  'terminal-opacity'?: number;     // 0.3–1   xterm layer opacity (how much background peeks through)
  'terminal-blur'?: number;        // 0–30 px runtime blur sigma on the wallpaper layer (image themes only)
  'terminal-brightness'?: number;  // 0.5–1.2 wallpaper brightness multiplier
  opacity?: number;
  'panels-blur'?: number;
  'panels-opacity'?: number;
  'bubble-blur'?: number;
  'bubble-opacity'?: number;
  pattern?: string;
  'pattern-opacity'?: number;
}

export type InputStyle = 'default' | 'floating' | 'minimal' | 'terminal';
export type BubbleStyle = 'default' | 'pill' | 'flat' | 'bordered';
export type HeaderStyle = 'default' | 'minimal' | 'hidden';
export type StatusbarStyle = 'default' | 'minimal';
/** `float` = the "popped through glass" chrome: the wrapping chrome surfaces go
 *  away entirely — no header strip, no container around the composer + quick
 *  chips, no strip behind the status chips — and the individual chrome elements
 *  rise out of the canvas on their own, as if a sign were being pushed through a
 *  soft translucent sheet. Unlike `floating`, which gives each BAR a detached
 *  rounded card, this gives each CONTROL its own lift.
 *
 *  WHY the value is `float` and not `minimal`: `input-style: minimal` and
 *  `header-style: minimal` already exist and mean something finer-grained, and
 *  the theme-builder Kit already shows a preset called "Minimal" — a third
 *  meaning would be ambiguous in the one place a non-developer picks it. */
export type ChromeStyle = 'default' | 'floating' | 'float';
export type ParticlePreset = 'none' | 'rain' | 'dust' | 'ember' | 'snow' | 'custom';

export interface ThemeLayout {
  'chrome-style'?: ChromeStyle;
  'input-style'?: InputStyle;
  'bubble-style'?: BubbleStyle;
  'header-style'?: HeaderStyle;
  'statusbar-style'?: StatusbarStyle;
}

export interface ThemeEffects {
  particles?: ParticlePreset;
  'particle-shape'?: string;
  'particle-count'?: number;
  'particle-speed'?: number;
  'particle-drift'?: number;
  'particle-size-range'?: [number, number];
  'scan-lines'?: boolean;
  vignette?: number;
  noise?: number;
}

export type IconSlot = 'send' | 'new-chat' | 'settings' | 'theme-cycle' | 'close' | 'menu';

export type ThemeIcons = Partial<Record<IconSlot, string>>;

export type MascotVariant = 'idle' | 'welcome' | 'inquisitive' | 'shocked';

export type ThemeMascot = Partial<Record<MascotVariant, string>> & {
  /** Optional rigged SVG (named part groups + data-pivot attrs) — the
   *  preferred mascot format; the flat variants above are the legacy tier.
   *  Full authoring contract: wecoded-themes mascots/README.md.
   *  Resolved to theme-asset:// by theme-asset-resolver like the flat variants
   *  (its Object.entries loop is key-agnostic — no resolver change needed). */
  rig?: string;
};

/** A scene companion: a small flourish SVG that accompanies the mascot (spec
 *  §5 — Golden Sunbreak's sun, Halftone's chromatic ghost, Kuromi's sparkles).
 *  All lengths are FRACTIONS of the mascot's rendered size, so the same
 *  declaration works at any surface scale. Declared as a TOP-LEVEL manifest
 *  key (not inside `mascot`) so app versions that predate companions ignore
 *  it — a non-string value inside `mascot` crashes their asset resolver. */
export interface MascotCompanion {
  /** Relative asset path (resolved to theme-asset:// like other assets). */
  asset: string;
  /** Width as a fraction of the mascot's rendered size. */
  size: number;
  /** Optional height fraction for non-square art (defaults to `size`). */
  height?: number;
  /** Preferred offset of the companion's center from the mascot's center. */
  dx: number;
  dy: number;
  /** Follow-spring tuning (buddy floater; static surfaces ignore these). */
  stiffness?: number;
  damping?: number;
  /** Idle bob amplitude (fraction of mascot size) + period. */
  float?: number;
  floatMs?: number;
  /** Lag-distance after-image: invisible at rest, fades in while trailing.
   *  Static surfaces skip ghosts entirely (nothing lags on a still mascot). */
  ghost?: boolean;
}

export interface ThemeScrollbar {
  'thumb-image'?: string;
  'track-color'?: string;
}

/** Optional overlay appearance overrides. When omitted, the theme engine
 *  computes sensible defaults from the existing color tokens — dark themes
 *  get subtle shadows and cool-tinted scrims, light themes get stronger
 *  shadows and warm-tinted scrims. Theme authors only need to set these
 *  if the computed defaults don't match their vision. */
export interface ThemeOverlay {
  /** Scrim (backdrop dim) color — CSS color string, e.g. 'rgba(10, 10, 15, 0.5)'.
   *  Computed from canvas darkened toward black when omitted. */
  scrim?: string;
  /** Heavy scrim for destructive/critical dialogs — deeper dim than standard scrim. */
  'scrim-heavy'?: string;
  /** Destructive accent color for delete/danger actions. Defaults to #C62828
   *  (was #DD4444, which could not carry an AA label at any text color).
   *  Distinct from the fixed status red #DD4444 used for state indicators. */
  destructive?: string;
  /** Shadow intensity multiplier (0–1). Higher = more visible popup shadows.
   *  Computed from canvas luminance when omitted (light themes ≈ 0.2, dark ≈ 0.1). */
  'shadow-strength'?: number;
}

export interface ThemeDefinition {
  name: string;
  slug: string;
  dark: boolean;
  author?: string;
  created?: string;
  tokens: ThemeTokens;
  shape?: ThemeShape;
  font?: ThemeFont;
  background?: ThemeBackground;
  layout?: ThemeLayout;
  effects?: ThemeEffects;
  icons?: ThemeIcons;
  mascot?: ThemeMascot;
  /** Scene companions — TOP-LEVEL by design, see MascotCompanion. */
  companions?: MascotCompanion[];
  cursor?: string;
  scrollbar?: ThemeScrollbar;
  /** Overlay appearance — scrim color, shadow strength, destructive accent.
   *  All fields optional; the engine computes defaults from color tokens. */
  overlay?: ThemeOverlay;
  /** Optional window/dock icon, hot-swapped when the theme becomes active.
   *  Relative path inside the theme dir (resolved to theme-asset:// URI at load time).
   *  Desktop-only: Electron calls BrowserWindow.setIcon() + app.dock.setIcon().
   *  Android WebView ignores this — launcher icons can't be hot-swapped. */
  appIcon?: string;
  custom_css?: string;
}

/**
 * A loaded theme — same as ThemeDefinition but guaranteed slug is kebab-case.
 *
 * source values:
 *   'youcoded-core' — ships natively with the app (official themes)
 *   'community'    — installed from the theme marketplace (user-submitted, approved)
 *   'user'         — created locally by the user on their machine
 */
export type LoadedTheme = ThemeDefinition & {
  source: 'youcoded-core' | 'community' | 'user';
  /** Absolute path to the theme folder on disk (community and user themes) */
  basePath?: string;
};
