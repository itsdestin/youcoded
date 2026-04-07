/**
 * Types for the Theme Marketplace registry and filtering.
 * Used by both the main process (provider) and renderer (UI).
 */

export interface ThemeRegistryEntry {
  slug: string;
  name: string;
  author: string;
  dark: boolean;
  description?: string;
  /** URL to a preview image (PNG) hosted on GitHub Pages */
  preview?: string;
  /** Subset of token colors for rendering CSS-based preview cards */
  previewTokens?: {
    canvas: string;
    panel: string;
    accent: string;
    'on-accent': string;
    fg: string;
    'fg-muted': string;
    edge: string;
  };
  version?: string;
  created?: string;
  updated?: string;
  /** 'destinclaude' = official theme, 'community' = user-submitted */
  source: 'destinclaude' | 'community';
  /** Auto-detected features: wallpaper, particles, glassmorphism, custom-font, custom-icons, mascot, custom-css */
  features: string[];
  /** URL to the raw manifest.json for download */
  manifestUrl: string;
  /** Map of relative asset path → download URL */
  assetUrls?: Record<string, string>;
}

export interface ThemeRegistryIndex {
  version: number;
  generatedAt: string;
  themes: ThemeRegistryEntry[];
}

export interface ThemeMarketplaceFilters {
  query?: string;
  source?: 'destinclaude' | 'community' | 'all';
  mode?: 'dark' | 'light' | 'all';
  features?: string[];
  sort?: 'newest' | 'name';
}

/** Result returned to the renderer with installation status annotated */
export type ThemeRegistryEntryWithStatus = ThemeRegistryEntry & {
  installed: boolean;
};
