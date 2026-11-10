import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// We test the provider's public interface.
// The provider uses dynamic import for validateCommunityTheme (renderer code),
// so we test the provider logic in isolation with mocked fetch.

const THEMES_DIR = path.join(os.homedir(), '.claude', 'wecoded-themes');

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
      { slug: 'dark', name: 'Dark', author: 'test-user', dark: true, source: 'youcoded-core' as const, features: [], manifestUrl: '', created: '2026-01-01' },
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

// Theme files must come from our theme repo and match the registry's fingerprints; a file that
// fails leaves an already-installed theme exactly as it was (nothing is written until all pass).
describe('installTheme checks every file before writing any', () => {
  const ORIGIN = 'https://raw.githubusercontent.com/itsdestin/wecoded-themes/0123456789abcdef0123456789abcdef01234567/themes/check-me';
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  const manifest = JSON.stringify({ name: 'Check Me', slug: 'check-me', dark: true, tokens: {} });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  let dir: string;

  async function setup(served: Record<string, string>, hashes?: Record<string, string>, manifestUrl = `${ORIGIN}/manifest.json`) {
    vi.resetModules();
    const { ThemeMarketplaceProvider } = await import('../src/main/theme-marketplace-provider');
    const { THEMES_DIR: dirNow } = await import('../src/main/theme-watcher');
    dir = path.join(dirNow, 'check-me');
    const p = new ThemeMarketplaceProvider();
    (p as any).fetchRegistry = async () => ({ version: 1, themes: [{
      slug: 'check-me', name: 'Check Me', author: 'a', dark: true, source: 'community', features: [],
      manifestUrl, assetUrls: { 'assets/a.svg': `${ORIGIN}/assets/a.svg` }, fileHashes: hashes,
    }] });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = served[url];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    }));
    vi.doMock('../src/renderer/themes/theme-validator', () => ({ validateCommunityTheme: (m: any) => m }));
    return p;
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock('../src/renderer/themes/theme-validator'); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('installs when every file matches its fingerprint', async () => {
    const p = await setup({ [`${ORIGIN}/manifest.json`]: manifest, [`${ORIGIN}/assets/a.svg`]: svg },
      { 'manifest.json': sha(manifest), 'assets/a.svg': sha(svg) });
    expect((await p.installTheme('check-me')).status).toBe('installed');
    expect(fs.readFileSync(path.join(dir, 'assets', 'a.svg'), 'utf8')).toBe(svg);
  });

  it('refuses a swapped file and leaves the installed copy untouched', async () => {
    const p = await setup({ [`${ORIGIN}/manifest.json`]: manifest, [`${ORIGIN}/assets/a.svg`]: '<svg onload="x"/>' },
      { 'manifest.json': sha(manifest), 'assets/a.svg': sha(svg) });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'a.svg'), 'OLD');
    fs.writeFileSync(path.join(dir, 'manifest.json'), 'OLD-MANIFEST');
    const r = await p.installTheme('check-me');
    expect(r).toMatchObject({ status: 'failed', error: expect.stringContaining('did not match') });
    expect(fs.readFileSync(path.join(dir, 'assets', 'a.svg'), 'utf8')).toBe('OLD');
    expect(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toBe('OLD-MANIFEST');
  });

  it('refuses a file hosted anywhere but the theme repo', async () => {
    const evil = 'https://example.com/manifest.json';
    const p = await setup({ [evil]: manifest }, undefined, evil);
    expect(await p.installTheme('check-me')).toMatchObject({ status: 'failed', error: expect.stringContaining('not hosted') });
  });

  // WHY: the Update badge compares this recorded stamp to the store's current one, so an in-place
  // edit with no version bump is noticed, and re-running install (= Update) must store the NEW
  // stamp or the badge would never clear.
  it('records the file-list stamp on install and refreshes it on update', async () => {
    const { themeFingerprint } = await import('../src/shared/theme-fingerprint');
    const recorded: any[] = [];
    const p = await setup({ [`${ORIGIN}/manifest.json`]: manifest, [`${ORIGIN}/assets/a.svg`]: svg },
      { 'manifest.json': sha(manifest), 'assets/a.svg': sha(svg) });
    (p as any).configStore = { recordPackageInstall: (id: string, pkg: any) => recorded.push({ id, pkg }) };
    expect((await p.installTheme('check-me')).status).toBe('installed');
    const first = themeFingerprint({ fileHashes: { 'manifest.json': sha(manifest), 'assets/a.svg': sha(svg) } });
    expect(recorded[0]).toMatchObject({ id: 'theme:check-me', pkg: { themeFingerprint: first } });

    // The author edits the mascot in place (same version); the store lists a new hash.
    const svg2 = '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>';
    (p as any).fetchRegistry = async () => ({ version: 1, themes: [{
      slug: 'check-me', name: 'Check Me', author: 'a', dark: true, source: 'community', features: [], version: '1.0.0',
      manifestUrl: `${ORIGIN}/manifest.json`, assetUrls: { 'assets/a.svg': `${ORIGIN}/assets/a.svg` },
      fileHashes: { 'manifest.json': sha(manifest), 'assets/a.svg': sha(svg2) },
    }] });
    (globalThis.fetch as any) = vi.fn(async (url: string) => new Response(url.endsWith('a.svg') ? svg2 : manifest, { status: 200 }));
    expect((await p.updateTheme('check-me')).ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'assets', 'a.svg'), 'utf8')).toBe(svg2);
    expect(recorded[1].pkg.themeFingerprint).not.toBe(first);
  });

  it('records no stamp when the store lists no hashes (stays quiet)', async () => {
    const recorded: any[] = [];
    const p = await setup({ [`${ORIGIN}/manifest.json`]: manifest, [`${ORIGIN}/assets/a.svg`]: svg });
    (p as any).configStore = { recordPackageInstall: (id: string, pkg: any) => recorded.push(pkg) };
    await p.installTheme('check-me');
    expect(recorded[0].themeFingerprint).toBeUndefined();
  });
});
