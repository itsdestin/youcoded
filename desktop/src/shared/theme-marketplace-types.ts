/**
 * Types for the Theme Marketplace registry and filtering.
 * Used by both the main process (provider) and renderer (UI).
 */

import type { ConfigSchema } from './types';

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
  /** 'youcoded-core' = official theme, 'community' = user-submitted */
  source: 'youcoded-core' | 'community';
  /** Auto-detected features: wallpaper, particles, glassmorphism, custom-font, custom-icons, mascot, custom-css */
  features: string[];
  /** URL to the raw manifest.json for download */
  manifestUrl: string;
  /** Map of relative asset path → download URL */
  assetUrls?: Record<string, string>;
  /** Phase 3c: optional config schema for the settings form */
  configSchema?: ConfigSchema;
  /**
   * sha256:<hex> of the theme's manifest + assets (excluding preview.png and
   * ephemeral fields). Used to detect drift between a published registry entry
   * and its local source. Optional — entries published before this field
   * existed are treated as matching by the resolver.
   */
  contentHash?: string;
}

/**
 * Discriminated union describing where a user-authored theme stands relative
 * to the marketplace. Derived fresh on every theme-detail open from three
 * authoritative sources (registry entry, open/recently-merged PR, local
 * content hash) — never persisted, so it self-heals after reinstalls, PR
 * rejections, and cross-device publishes.
 */
export type PublishState =
  | { kind: 'draft' }
  | { kind: 'in-review'; prNumber: number; prUrl: string }
  | { kind: 'published-current'; marketplaceUrl: string }
  | { kind: 'published-drift'; marketplaceUrl: string }
  | { kind: 'unknown'; reason: string };

export interface ThemeRegistryIndex {
  version: number;
  generatedAt: string;
  themes: ThemeRegistryEntry[];
}

export interface ThemeMarketplaceFilters {
  query?: string;
  source?: 'youcoded-core' | 'community' | 'all';
  mode?: 'dark' | 'light' | 'all';
  features?: string[];
  sort?: 'newest' | 'name';
}

/** Result returned to the renderer with installation status annotated */
export type ThemeRegistryEntryWithStatus = ThemeRegistryEntry & {
  installed: boolean;
  /** True for entries synthesized from a locally-built user theme that has no
   * marketplace registry entry. Drives the "Local" badge + tooltip in
   * MarketplaceCard, and the permanent-deletion confirmation copy. Distinct
   * from `installed: true` which means "manifest.json exists on disk" — a
   * marketplace theme can be installed but not local. */
  isLocal?: boolean;
};
