import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Isolate the store's config path per test via a temp HOME override.
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-skill-config-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;  // Windows homedir backing
  vi.resetModules();  // CONFIG_PATH is computed at import time — re-evaluate it under the new HOME
});

afterEach(() => {
  if (originalHome) process.env.HOME = originalHome;
  if (originalUserProfile) process.env.USERPROFILE = originalUserProfile;
  else delete process.env.USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// The registry's curated-defaults.json once named `theme-builder` — an id that
// exists nowhere (the plugin is `wecoded-themes-plugin`). Seeding wrote that
// bare string into `~/.claude/youcoded-skills.json` → favorites[], where it
// resolved to nothing. These pin the one-time cleanup: it removes exactly that
// string, keeps everything else byte-for-byte, rewrites the file once, and
// leaves a legitimately-owned `theme-builder` alone.
describe('SkillConfigStore dead-favourite cleanup', () => {
  const configPath = () => path.join(tmpHome, '.claude', 'youcoded-skills.json');

  function writeProfile(extra: Record<string, unknown>) {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({
      version: 2,
      favorites: ['superpowers:brainstorming', 'theme-builder', 'journaling-assistant'],
      chips: [{ label: 'Git Status', prompt: 'run git status' }],
      overrides: { 'journaling-assistant': { name: 'Journal' } },
      privateSkills: [],
      packages: { superpowers: { version: '1.0.0', source: 'marketplace', installedAt: 'x', removable: true, components: [] } },
      themeFavorites: ['light', 'dark'],
      ...extra,
    }, null, 2));
  }

  it('removes the bare theme-builder string and nothing else, then persists once', async () => {
    writeProfile({});
    const before = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    const favs = new SkillConfigStore().getFavorites();
    expect(favs).toEqual(['superpowers:brainstorming', 'journaling-assistant']);

    const after = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    // Everything except favorites is untouched — chips, overrides, packages,
    // theme favourites all survive exactly.
    expect(after).toEqual({ ...before, favorites: ['superpowers:brainstorming', 'journaling-assistant'] });
  });

  it('is idempotent: a clean profile is never rewritten', async () => {
    writeProfile({ favorites: ['superpowers:brainstorming'] });
    const mtimeBefore = fs.statSync(configPath()).mtimeMs;
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    expect(new SkillConfigStore().getFavorites()).toEqual(['superpowers:brainstorming']);
    expect(fs.statSync(configPath()).mtimeMs).toBe(mtimeBefore);
  });

  it('leaves theme-builder alone when the user actually owns something by that id', async () => {
    writeProfile({ privateSkills: [{ id: 'theme-builder', name: 'My theme builder' }] });
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    expect(new SkillConfigStore().getFavorites()).toContain('theme-builder');
  });
});

describe('SkillConfigStore theme favorites', () => {
  it('seeds the four built-in theme slugs on first read when missing', async () => {
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    const store = new SkillConfigStore();
    const favs = store.getThemeFavorites();
    expect(favs.sort()).toEqual(['creme', 'dark', 'light', 'midnight']);
  });

  it('persists setThemeFavorite across reload', async () => {
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    const store = new SkillConfigStore();
    store.getThemeFavorites();  // trigger seed
    store.setThemeFavorite('solarized', true);
    store.setThemeFavorite('light', false);

    const store2 = new SkillConfigStore();
    const favs = store2.getThemeFavorites();
    expect(favs).toContain('solarized');
    expect(favs).not.toContain('light');
  });

  it('is idempotent when setting a favorite that already exists', async () => {
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    const store = new SkillConfigStore();
    store.setThemeFavorite('dark', true);
    store.setThemeFavorite('dark', true);
    const favs = store.getThemeFavorites();
    expect(favs.filter(s => s === 'dark')).toHaveLength(1);
  });

  it('setThemeFavorite cold-start seeds defaults before applying the mutation', async () => {
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    const store = new SkillConfigStore();
    // Call set without ever calling get first
    store.setThemeFavorite('light', false);
    const favs = store.getThemeFavorites();
    // dark/midnight/creme should survive even though getThemeFavorites was never called first
    expect(favs).toContain('dark');
    expect(favs).toContain('midnight');
    expect(favs).toContain('creme');
    expect(favs).not.toContain('light');
  });
});
