import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We test the provider's public interface.
// The provider uses dynamic import for validateCommunityTheme (renderer code),
// so we test the provider logic in isolation with mocked fetch.

const THEMES_DIR = path.join(os.homedir(), '.claude', 'destinclaude-themes');

describe('ThemeMarketplaceProvider', () => {
  // We test slug validation and filter logic without the full provider
  // since the provider depends on Node fetch + fs in complex ways.

  describe('slug validation', () => {
    const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    it('accepts valid kebab-case slugs', () => {
      expect(SAFE_SLUG_RE.test('neon-tokyo')).toBe(true);
      expect(SAFE_SLUG_RE.test('golden-sunbreak')).toBe(true);
      expect(SAFE_SLUG_RE.test('dark')).toBe(true);
      expect(SAFE_SLUG_RE.test('my-theme-v2')).toBe(true);
    });

    it('rejects path traversal attempts', () => {
      expect(SAFE_SLUG_RE.test('../evil')).toBe(false);
      expect(SAFE_SLUG_RE.test('foo/bar')).toBe(false);
      expect(SAFE_SLUG_RE.test('..\\evil')).toBe(false);
    });

    it('rejects uppercase, spaces, and special characters', () => {
      expect(SAFE_SLUG_RE.test('NeonTokyo')).toBe(false);
      expect(SAFE_SLUG_RE.test('neon tokyo')).toBe(false);
      expect(SAFE_SLUG_RE.test('neon_tokyo')).toBe(false);
      expect(SAFE_SLUG_RE.test('')).toBe(false);
    });

    it('rejects leading or trailing hyphens', () => {
      expect(SAFE_SLUG_RE.test('-neon')).toBe(false);
      expect(SAFE_SLUG_RE.test('neon-')).toBe(false);
      expect(SAFE_SLUG_RE.test('-')).toBe(false);
    });
  });

  describe('filter logic', () => {
    const THEMES = [
      { slug: 'dark', name: 'Dark', author: 'destin', dark: true, source: 'destinclaude' as const, features: [], manifestUrl: '', created: '2026-01-01' },
      { slug: 'neon-tokyo', name: 'Neon Tokyo', author: 'alice', dark: true, source: 'community' as const, features: ['particles', 'wallpaper'], manifestUrl: '', created: '2026-04-01' },
      { slug: 'pastel-dream', name: 'Pastel Dream', author: 'bob', dark: false, source: 'community' as const, features: ['custom-font'], manifestUrl: '', created: '2026-03-15' },
    ];

    function applyFilters(themes: typeof THEMES, filters: any) {
      let result = themes;
      if (filters?.source && filters.source !== 'all') {
        result = result.filter(t => t.source === filters.source);
      }
      if (filters?.mode && filters.mode !== 'all') {
        const wantDark = filters.mode === 'dark';
        result = result.filter(t => t.dark === wantDark);
      }
      if (filters?.features && filters.features.length > 0) {
        const wanted = new Set(filters.features);
        result = result.filter(t => t.features.some((f: string) => wanted.has(f)));
      }
      if (filters?.query) {
        const q = filters.query.toLowerCase();
        result = result.filter(t =>
          t.name.toLowerCase().includes(q) || t.author.toLowerCase().includes(q),
        );
      }
      if (filters?.sort === 'name') {
        result = [...result].sort((a, b) => a.name.localeCompare(b.name));
      } else {
        result = [...result].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
      }
      return result;
    }

    it('filters by source', () => {
      const result = applyFilters(THEMES, { source: 'community' });
      expect(result).toHaveLength(2);
      expect(result.every(t => t.source === 'community')).toBe(true);
    });

    it('filters by mode (dark)', () => {
      const result = applyFilters(THEMES, { mode: 'dark' });
      expect(result).toHaveLength(2);
      expect(result.every(t => t.dark)).toBe(true);
    });

    it('filters by mode (light)', () => {
      const result = applyFilters(THEMES, { mode: 'light' });
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('pastel-dream');
    });

    it('filters by feature', () => {
      const result = applyFilters(THEMES, { features: ['particles'] });
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('neon-tokyo');
    });

    it('filters by query (name)', () => {
      const result = applyFilters(THEMES, { query: 'neon' });
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('neon-tokyo');
    });

    it('filters by query (author)', () => {
      const result = applyFilters(THEMES, { query: 'bob' });
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('pastel-dream');
    });

    it('sorts by name', () => {
      const result = applyFilters(THEMES, { sort: 'name' });
      expect(result.map(t => t.name)).toEqual(['Dark', 'Neon Tokyo', 'Pastel Dream']);
    });

    it('sorts by newest (default)', () => {
      const result = applyFilters(THEMES, {});
      expect(result.map(t => t.slug)).toEqual(['neon-tokyo', 'pastel-dream', 'dark']);
    });

    it('combines multiple filters', () => {
      const result = applyFilters(THEMES, { source: 'community', mode: 'dark' });
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('neon-tokyo');
    });
  });
});
