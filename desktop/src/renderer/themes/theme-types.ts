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
  opacity?: number;
  'panels-blur'?: number;
  'panels-opacity'?: number;
  pattern?: string;
  'pattern-opacity'?: number;
}

export type InputStyle = 'default' | 'floating' | 'minimal' | 'terminal';
export type BubbleStyle = 'default' | 'pill' | 'flat' | 'bordered';
export type HeaderStyle = 'default' | 'minimal' | 'hidden';
export type StatusbarStyle = 'default' | 'minimal';
export type ChromeStyle = 'default' | 'floating';
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

export type MascotVariant = 'idle' | 'welcome' | 'inquisitive';

export type ThemeMascot = Partial<Record<MascotVariant, string>>;

export interface ThemeScrollbar {
  'thumb-image'?: string;
  'track-color'?: string;
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
  cursor?: string;
  scrollbar?: ThemeScrollbar;
  custom_css?: string;
}

/**
 * A loaded theme — same as ThemeDefinition but guaranteed slug is kebab-case.
 *
 * source values:
 *   'destinclaude' — ships natively with the app (official themes)
 *   'community'    — installed from the theme marketplace (user-submitted, approved)
 *   'user'         — created locally by the user on their machine
 */
export type LoadedTheme = ThemeDefinition & {
  source: 'destinclaude' | 'community' | 'user';
  /** Absolute path to the theme folder on disk (community and user themes) */
  basePath?: string;
};
