import { describe, it, expect } from 'vitest';
import { synthesizeLocalThemeEntries } from '../src/main/local-theme-synthesizer';
import type { ThemeRegistryEntryWithStatus } from '../src/shared/theme-marketplace-types';

const marketplaceEntry: ThemeRegistryEntryWithStatus = {
  slug: 'golden-sunbreak', name: 'Golden Sunbreak', author: 'itsdestin', dark: true,
  source: 'youcoded-core', features: ['wallpaper'],
  manifestUrl: 'https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/golden-sunbreak/manifest.json',
  installed: true,
};

const localManifest = {
  slug: 'after-the-show', name: 'After the Show', author: 'destin', dark: true,
  description: 'Cozy mint glow under fairy lights',
  tokens: { canvas: '#231731', panel: '#2d1f3f', accent: '#6ad1b9', 'on-accent': '#000', fg: '#faedd5', 'fg-muted': '#a08fb0', edge: '#3a2a4f' },
  background: { type: 'image', value: 'assets/wallpaper.jpg', 'panels-blur': 12 },
};

describe('synthesizeLocalThemeEntries', () => {
  it('adds an isLocal entry for a manifest that has no marketplace match', () => {
    const result = synthesizeLocalThemeEntries(
      [marketplaceEntry],
      [{ slug: 'after-the-show', manifest: localManifest, hasPreview: true }],
    );
    expect(result).toHaveLength(2);
    const local = result.find(e => e.slug === 'after-the-show');
    expect(local).toBeDefined();
    expect(local!.isLocal).toBe(true);
    expect(local!.installed).toBe(true);
    expect(local!.name).toBe('After the Show');
    expect(local!.description).toBe('Cozy mint glow under fairy lights');
    expect(local!.preview).toBe('theme-asset://after-the-show/preview.png');
    expect(local!.previewTokens).toEqual({
      canvas: '#231731', panel: '#2d1f3f', accent: '#6ad1b9',
      'on-accent': '#000', fg: '#faedd5', 'fg-muted': '#a08fb0', edge: '#3a2a4f',
    });
    expect(local!.features).toContain('wallpaper');
    expect(local!.features).toContain('glassmorphism');
  });

  it('does not duplicate when a local manifest matches a marketplace slug, and the marketplace entry wins', () => {
    const result = synthesizeLocalThemeEntries(
      [marketplaceEntry],
      [{ slug: 'golden-sunbreak', manifest: { slug: 'golden-sunbreak', name: 'X', author: 'Y', dark: true, tokens: {} }, hasPreview: false }],
    );
    expect(result).toHaveLength(1);
    expect(result[0].isLocal).toBeUndefined();
    // Lock in "marketplace wins" as a contract — this prevents a future merge-order
    // swap from silently flipping which entry survives a slug collision.
    expect(result[0].slug).toBe('golden-sunbreak');
    expect(result[0].source).toBe('youcoded-core');
    expect(result[0].name).toBe('Golden Sunbreak');
  });

  it('falls back to wallpaper path when preview.png is missing', () => {
    const result = synthesizeLocalThemeEntries([], [{
      slug: 'after-the-show', manifest: localManifest, hasPreview: false,
    }]);
    expect(result[0].preview).toBe('theme-asset://after-the-show/assets/wallpaper.jpg');
  });

  it('omits preview when there is no preview.png and no wallpaper', () => {
    const result = synthesizeLocalThemeEntries([], [{
      slug: 'plain', manifest: { slug: 'plain', name: 'Plain', author: 'd', dark: false, tokens: {} },
      hasPreview: false,
    }]);
    expect(result[0].preview).toBeUndefined();
  });
});
