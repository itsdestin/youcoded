# Theme Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the theme system from single JSON files to self-contained theme pack folders with local assets, custom SVG particles, icon/mascot overrides, and an upgraded `/theme-builder` skill.

**Architecture:** Theme packs are directories under `~/.claude/destinclaude-themes/<slug>/` containing a `manifest.json` (evolved ThemeDefinition) and an `assets/` folder for images, SVGs, and overrides. A custom Electron protocol (`theme-asset://`) serves local files to the renderer. The `/theme-builder` skill generates complete theme packs with downloaded imagery and Claude-generated SVGs.

**Tech Stack:** Electron (main process: fs, protocol, ipc), React (renderer: context, hooks, canvas), Vitest (tests), SVG (particles, icons, mascots)

---

## File Map

### New files
- `desktop/src/main/theme-protocol.ts` — Registers `theme-asset://` custom protocol
- `desktop/src/main/theme-migration.ts` — One-time migration of bare JSON files to folder format
- `desktop/src/renderer/themes/theme-asset-resolver.ts` — Resolves relative asset paths to `theme-asset://` URIs
- `desktop/src/renderer/hooks/useThemeIcon.ts` — Hook for icon override lookups
- `desktop/src/renderer/hooks/useThemeMascot.ts` — Hook for mascot override lookups
- `desktop/tests/theme-migration.test.ts` — Migration logic tests
- `desktop/tests/theme-asset-resolver.test.ts` — Asset path resolution tests

### Modified files
- `desktop/src/renderer/themes/theme-types.ts` — Add new manifest fields (background.pattern, effects.particle-shape, icons, mascot, cursor, scrollbar)
- `desktop/src/renderer/themes/theme-validator.ts` — Validate new fields, accept folder-based themes
- `desktop/src/renderer/themes/theme-engine.ts` — Build pattern overlay style, resolve asset paths
- `desktop/src/renderer/state/theme-context.tsx` — Load from folders, resolve assets, expose mascot/icon data
- `desktop/src/renderer/components/ThemeEffects.tsx` — Custom SVG particle renderer
- `desktop/src/renderer/components/Icons.tsx` — Mascot components check for theme overrides
- `desktop/src/renderer/App.tsx` — Pass theme mascot to initializing/welcome screens
- `desktop/src/renderer/components/TrustGate.tsx` — Use theme mascot override
- `desktop/src/main/theme-watcher.ts` — Watch directories recursively, handle migration
- `desktop/src/main/ipc-handlers.ts` — Update IPC to work with folder format, register protocol
- `desktop/src/main/preload.ts` — Add `theme.readAsset` IPC channel
- `desktop/src/shared/types.ts` — Add new IPC channel constants
- `desktop/src/main/main.ts` — Register `theme-asset://` protocol before window creation
- `desktop/tests/theme-engine.test.ts` — Add pattern overlay tests
- `desktop/tests/theme-validator.test.ts` — Add validation tests for new fields
- `core/skills/theme-builder/SKILL.md` — Rewrite for theme packs, two-round flow, asset pipeline

---

### Task 1: Expand ThemeDefinition types

**Files:**
- Modify: `desktop/src/renderer/themes/theme-types.ts`
- Test: `desktop/tests/theme-validator.test.ts`

- [ ] **Step 1: Write failing tests for new type validation**

Add to `desktop/tests/theme-validator.test.ts`:

```typescript
describe('validateTheme — new fields', () => {
  it('accepts theme with background pattern fields', () => {
    const theme = {
      ...MINIMAL_VALID,
      background: {
        type: 'image' as const,
        value: 'assets/wallpaper.png',
        opacity: 0.85,
        'panels-blur': 12,
        'panels-opacity': 0.75,
        pattern: 'assets/pattern.svg',
        'pattern-opacity': 0.06,
      },
    };
    expect(() => validateTheme(theme)).not.toThrow();
  });

  it('accepts theme with custom particle fields', () => {
    const theme = {
      ...MINIMAL_VALID,
      effects: {
        particles: 'custom' as const,
        'particle-shape': 'assets/heart.svg',
        'particle-count': 40,
        'particle-speed': 1.0,
        'particle-drift': 0.5,
        'particle-size-range': [8, 16],
      },
    };
    expect(() => validateTheme(theme)).not.toThrow();
  });

  it('accepts theme with icon overrides', () => {
    const theme = {
      ...MINIMAL_VALID,
      icons: { send: 'assets/icon-send.svg' },
    };
    expect(() => validateTheme(theme)).not.toThrow();
  });

  it('accepts theme with mascot overrides', () => {
    const theme = {
      ...MINIMAL_VALID,
      mascot: {
        idle: 'assets/mascot-idle.svg',
        welcome: 'assets/mascot-welcome.svg',
      },
    };
    expect(() => validateTheme(theme)).not.toThrow();
  });

  it('accepts theme with cursor and scrollbar', () => {
    const theme = {
      ...MINIMAL_VALID,
      cursor: 'assets/cursor.svg',
      scrollbar: { 'thumb-image': 'assets/thumb.svg', 'track-color': 'transparent' },
    };
    expect(() => validateTheme(theme)).not.toThrow();
  });

  it('rejects particle-shape when particles is not custom', () => {
    const theme = {
      ...MINIMAL_VALID,
      effects: {
        particles: 'rain' as const,
        'particle-shape': 'assets/heart.svg',
      },
    };
    expect(() => validateTheme(theme)).toThrow('particle-shape');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && npx vitest run tests/theme-validator.test.ts`
Expected: New tests fail (types don't exist yet, validator doesn't check new fields)

- [ ] **Step 3: Update ThemeDefinition types**

Replace the contents of `desktop/src/renderer/themes/theme-types.ts`:

```typescript
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
  'radius-sm'?: string;
  'radius-md'?: string;
  'radius-lg'?: string;
  'radius-full'?: string;
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
export type StatusbarStyle = 'default' | 'minimal' | 'floating';
export type ParticlePreset = 'none' | 'rain' | 'dust' | 'ember' | 'snow' | 'custom';

export interface ThemeLayout {
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
  background?: ThemeBackground;
  layout?: ThemeLayout;
  effects?: ThemeEffects;
  icons?: ThemeIcons;
  mascot?: ThemeMascot;
  cursor?: string;
  scrollbar?: ThemeScrollbar;
  custom_css?: string;
}

/** A loaded theme — same as ThemeDefinition but guaranteed slug is kebab-case */
export type LoadedTheme = ThemeDefinition & {
  source: 'builtin' | 'user';
  /** Absolute path to the theme folder on disk (user themes only) */
  basePath?: string;
};
```

- [ ] **Step 4: Update validator for new fields**

In `desktop/src/renderer/themes/theme-validator.ts`, add after the existing token validation:

```typescript
  // Validate effects consistency
  const effects = t.effects as Record<string, unknown> | undefined;
  if (effects) {
    if (effects['particle-shape'] && effects.particles !== 'custom') {
      throw new Error('particle-shape requires particles: "custom"');
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd desktop && npx vitest run tests/theme-validator.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer/themes/theme-types.ts desktop/src/renderer/themes/theme-validator.ts desktop/tests/theme-validator.test.ts
git commit -m "feat(themes): expand ThemeDefinition with icons, mascot, custom particles, pattern overlay"
```

---

### Task 2: Theme asset resolver

**Files:**
- Create: `desktop/src/renderer/themes/theme-asset-resolver.ts`
- Test: `desktop/tests/theme-asset-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

Create `desktop/tests/theme-asset-resolver.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveAssetPath, resolveAllAssetPaths } from '../src/renderer/themes/theme-asset-resolver';

describe('resolveAssetPath', () => {
  it('returns theme-asset:// URI for a relative path', () => {
    expect(resolveAssetPath('assets/wallpaper.png', 'hello-kitty'))
      .toBe('theme-asset://hello-kitty/assets/wallpaper.png');
  });

  it('returns null for undefined input', () => {
    expect(resolveAssetPath(undefined, 'hello-kitty')).toBeNull();
  });

  it('returns the input unchanged if already a theme-asset:// URI', () => {
    expect(resolveAssetPath('theme-asset://hello-kitty/assets/bg.png', 'hello-kitty'))
      .toBe('theme-asset://hello-kitty/assets/bg.png');
  });

  it('returns the input unchanged for gradient/color values', () => {
    expect(resolveAssetPath('linear-gradient(135deg, #000, #fff)', 'test'))
      .toBe('linear-gradient(135deg, #000, #fff)');
  });

  it('returns the input unchanged for hex color values', () => {
    expect(resolveAssetPath('#1a1a2e', 'test')).toBe('#1a1a2e');
  });
});

describe('resolveAllAssetPaths', () => {
  it('resolves background image value to theme-asset URI', () => {
    const theme = {
      name: 'Test', slug: 'test', dark: false,
      tokens: {} as any,
      background: { type: 'image' as const, value: 'assets/bg.png' },
    };
    const resolved = resolveAllAssetPaths(theme);
    expect(resolved.background?.value).toBe('theme-asset://test/assets/bg.png');
  });

  it('resolves pattern path', () => {
    const theme = {
      name: 'Test', slug: 'test', dark: false,
      tokens: {} as any,
      background: { type: 'solid' as const, value: '#000', pattern: 'assets/dots.svg', 'pattern-opacity': 0.05 },
    };
    const resolved = resolveAllAssetPaths(theme);
    expect(resolved.background?.pattern).toBe('theme-asset://test/assets/dots.svg');
  });

  it('resolves particle-shape, icons, mascot, cursor', () => {
    const theme = {
      name: 'Test', slug: 'test', dark: false,
      tokens: {} as any,
      effects: { particles: 'custom' as const, 'particle-shape': 'assets/heart.svg' },
      icons: { send: 'assets/send.svg' },
      mascot: { idle: 'assets/mascot.svg' },
      cursor: 'assets/cursor.svg',
    };
    const resolved = resolveAllAssetPaths(theme);
    expect(resolved.effects?.['particle-shape']).toBe('theme-asset://test/assets/heart.svg');
    expect(resolved.icons?.send).toBe('theme-asset://test/assets/send.svg');
    expect(resolved.mascot?.idle).toBe('theme-asset://test/assets/mascot.svg');
    expect(resolved.cursor).toBe('theme-asset://test/assets/cursor.svg');
  });

  it('does not modify builtin themes (no basePath)', () => {
    const theme = {
      name: 'Light', slug: 'light', dark: false, source: 'builtin' as const,
      tokens: {} as any,
    };
    const resolved = resolveAllAssetPaths(theme);
    expect(resolved).toEqual(theme);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && npx vitest run tests/theme-asset-resolver.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement the resolver**

Create `desktop/src/renderer/themes/theme-asset-resolver.ts`:

```typescript
import type { ThemeDefinition, LoadedTheme } from './theme-types';

/**
 * Resolves a single asset path to a theme-asset:// URI.
 * Returns null for undefined, passes through non-relative values unchanged
 * (gradients, hex colors, already-resolved URIs).
 */
export function resolveAssetPath(value: string | undefined, slug: string): string | null {
  if (!value) return null;
  // Already resolved
  if (value.startsWith('theme-asset://')) return value;
  // CSS values (gradients, colors) — not file paths
  if (value.startsWith('#') || value.startsWith('linear-gradient') || value.startsWith('radial-gradient') || value.startsWith('rgb')) return value;
  // Relative path → theme-asset URI
  return `theme-asset://${slug}/${value}`;
}

/**
 * Deep-resolves all asset paths in a theme to theme-asset:// URIs.
 * Only applies to user themes. Built-in themes are returned unchanged.
 */
export function resolveAllAssetPaths<T extends ThemeDefinition | LoadedTheme>(theme: T): T {
  // Built-in themes have no local assets
  if ('source' in theme && (theme as LoadedTheme).source === 'builtin') return theme;

  const resolved = { ...theme };
  const slug = theme.slug;

  // Background
  if (resolved.background) {
    const bg = { ...resolved.background };
    if (bg.type === 'image') {
      const r = resolveAssetPath(bg.value, slug);
      if (r) bg.value = r;
    }
    if (bg.pattern) {
      const r = resolveAssetPath(bg.pattern, slug);
      if (r) bg.pattern = r;
    }
    resolved.background = bg;
  }

  // Effects — particle shape
  if (resolved.effects?.['particle-shape']) {
    resolved.effects = { ...resolved.effects };
    const r = resolveAssetPath(resolved.effects['particle-shape'], slug);
    if (r) resolved.effects['particle-shape'] = r;
  }

  // Icons
  if (resolved.icons) {
    const icons = { ...resolved.icons };
    for (const [key, val] of Object.entries(icons)) {
      const r = resolveAssetPath(val, slug);
      if (r) (icons as Record<string, string>)[key] = r;
    }
    resolved.icons = icons;
  }

  // Mascot
  if (resolved.mascot) {
    const mascot = { ...resolved.mascot };
    for (const [key, val] of Object.entries(mascot)) {
      const r = resolveAssetPath(val, slug);
      if (r) (mascot as Record<string, string>)[key] = r;
    }
    resolved.mascot = mascot;
  }

  // Cursor
  if (resolved.cursor) {
    const r = resolveAssetPath(resolved.cursor, slug);
    if (r) resolved.cursor = r;
  }

  // Scrollbar thumb image
  if (resolved.scrollbar?.['thumb-image']) {
    resolved.scrollbar = { ...resolved.scrollbar };
    const r = resolveAssetPath(resolved.scrollbar['thumb-image'], slug);
    if (r) resolved.scrollbar['thumb-image'] = r;
  }

  return resolved;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop && npx vitest run tests/theme-asset-resolver.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add desktop/src/renderer/themes/theme-asset-resolver.ts desktop/tests/theme-asset-resolver.test.ts
git commit -m "feat(themes): add theme asset path resolver for theme-asset:// protocol"
```

---

### Task 3: Custom Electron protocol + migration

**Files:**
- Create: `desktop/src/main/theme-protocol.ts`
- Create: `desktop/src/main/theme-migration.ts`
- Create: `desktop/tests/theme-migration.test.ts`
- Modify: `desktop/src/main/main.ts`

- [ ] **Step 1: Write migration tests**

Create `desktop/tests/theme-migration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { migrateBarJsonFiles } from '../src/main/theme-migration';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-migration-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrateBarJsonFiles', () => {
  it('moves a bare .json file into a slug folder as manifest.json', () => {
    const json = JSON.stringify({ name: 'Test', slug: 'test-theme', dark: true, tokens: {} });
    fs.writeFileSync(path.join(tmpDir, 'test-theme.json'), json);

    const count = migrateBarJsonFiles(tmpDir);

    expect(count).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, 'test-theme', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'test-theme.json'))).toBe(false);
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-theme', 'manifest.json'), 'utf-8'));
    expect(content.name).toBe('Test');
  });

  it('skips directories that already exist', () => {
    fs.mkdirSync(path.join(tmpDir, 'existing-theme'));
    fs.writeFileSync(path.join(tmpDir, 'existing-theme', 'manifest.json'), '{}');

    const count = migrateBarJsonFiles(tmpDir);
    expect(count).toBe(0);
  });

  it('migrates multiple bare JSON files', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.json'), JSON.stringify({ name: 'A', slug: 'a', dark: true, tokens: {} }));
    fs.writeFileSync(path.join(tmpDir, 'b.json'), JSON.stringify({ name: 'B', slug: 'b', dark: false, tokens: {} }));

    const count = migrateBarJsonFiles(tmpDir);
    expect(count).toBe(2);
    expect(fs.existsSync(path.join(tmpDir, 'a', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'b', 'manifest.json'))).toBe(true);
  });

  it('creates assets subdirectory in migrated themes', () => {
    fs.writeFileSync(path.join(tmpDir, 'my-theme.json'), JSON.stringify({ name: 'My', slug: 'my-theme', dark: true, tokens: {} }));

    migrateBarJsonFiles(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'my-theme', 'assets'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop && npx vitest run tests/theme-migration.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement migration**

Create `desktop/src/main/theme-migration.ts`:

```typescript
import fs from 'fs';
import path from 'path';

/**
 * Migrates bare <slug>.json files in the themes directory to folder format:
 *   <slug>.json → <slug>/manifest.json + <slug>/assets/
 * Returns the number of files migrated.
 */
export function migrateBarJsonFiles(themesDir: string): number {
  if (!fs.existsSync(themesDir)) return 0;

  const entries = fs.readdirSync(themesDir);
  let count = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const fullPath = path.join(themesDir, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    const slug = entry.replace(/\.json$/, '');
    const folderPath = path.join(themesDir, slug);

    // Skip if folder already exists (already migrated or name collision)
    if (fs.existsSync(folderPath)) continue;

    // Create folder structure
    fs.mkdirSync(folderPath, { recursive: true });
    fs.mkdirSync(path.join(folderPath, 'assets'), { recursive: true });

    // Move JSON into folder as manifest.json
    fs.renameSync(fullPath, path.join(folderPath, 'manifest.json'));
    count++;
  }

  return count;
}
```

- [ ] **Step 4: Run migration tests**

Run: `cd desktop && npx vitest run tests/theme-migration.test.ts`
Expected: All PASS

- [ ] **Step 5: Implement custom protocol**

Create `desktop/src/main/theme-protocol.ts`:

```typescript
import { protocol, net } from 'electron';
import path from 'path';
import os from 'os';

const THEMES_DIR = path.join(os.homedir(), '.claude', 'destinclaude-themes');

/**
 * Registers the theme-asset:// custom protocol.
 * Resolves theme-asset://<slug>/<relative-path> to the file on disk.
 * Must be called before any BrowserWindow is created (in app.whenReady).
 */
export function registerThemeProtocol(): void {
  protocol.handle('theme-asset', (request) => {
    // URL: theme-asset://<slug>/<path>
    const url = new URL(request.url);
    const slug = url.hostname;
    const assetPath = decodeURIComponent(url.pathname.replace(/^\//, ''));

    // Security: resolve and verify path is within the theme's directory
    const themePath = path.join(THEMES_DIR, slug);
    const resolvedPath = path.resolve(themePath, assetPath);

    if (!resolvedPath.startsWith(themePath + path.sep) && resolvedPath !== themePath) {
      return new Response('Forbidden', { status: 403 });
    }

    return net.fetch(`file://${resolvedPath}`);
  });
}
```

- [ ] **Step 6: Register protocol in main.ts**

In `desktop/src/main/main.ts`, add import at top:

```typescript
import { registerThemeProtocol } from './theme-protocol';
```

Inside `app.whenReady().then(async () => {`, add before `createWindow()`:

```typescript
  registerThemeProtocol();
```

Also add `protocol` to the Electron import at line 1:

```typescript
import { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol } from 'electron';
```

And add the privilege registration before `app.whenReady()`:

```typescript
protocol.registerSchemesAsPrivileged([
  { scheme: 'theme-asset', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true } },
]);
```

- [ ] **Step 7: Commit**

```bash
git add desktop/src/main/theme-protocol.ts desktop/src/main/theme-migration.ts desktop/tests/theme-migration.test.ts desktop/src/main/main.ts
git commit -m "feat(themes): add theme-asset:// protocol and bare JSON migration"
```

---

### Task 4: Update theme watcher for folder format

**Files:**
- Modify: `desktop/src/main/theme-watcher.ts`
- Modify: `desktop/src/main/ipc-handlers.ts`
- Modify: `desktop/src/shared/types.ts`
- Modify: `desktop/src/main/preload.ts`

- [ ] **Step 1: Update theme-watcher.ts for directory scanning**

Replace `desktop/src/main/theme-watcher.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { BrowserWindow } from 'electron';
import { migrateBarJsonFiles } from './theme-migration';

const THEMES_DIR = path.join(os.homedir(), '.claude', 'destinclaude-themes');

/** Ensures themes dir exists and migrates any bare JSON files to folder format. */
function ensureAndMigrate(): void {
  if (!fs.existsSync(THEMES_DIR)) {
    fs.mkdirSync(THEMES_DIR, { recursive: true });
  }
  const count = migrateBarJsonFiles(THEMES_DIR);
  if (count > 0) {
    console.log(`[theme-watcher] Migrated ${count} bare JSON theme(s) to folder format`);
  }
}

/** Watches ~/.claude/destinclaude-themes/ for changes.
 *  Sends theme:reload to the renderer when a manifest.json or asset changes. */
export function startThemeWatcher(win: BrowserWindow): () => void {
  ensureAndMigrate();

  let watcher: fs.FSWatcher | null = null;
  const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

  try {
    watcher = fs.watch(THEMES_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      // Extract slug from path (first path component)
      const normalized = filename.replace(/\\/g, '/');
      const slug = normalized.split('/')[0];
      if (!slug) return;

      // Only reload on relevant file changes
      const ext = path.extname(normalized).toLowerCase();
      if (!['.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.css'].includes(ext)) return;

      const existing = debounceMap.get(slug);
      if (existing) clearTimeout(existing);
      debounceMap.set(slug, setTimeout(() => {
        debounceMap.delete(slug);
        if (!win.isDestroyed()) {
          win.webContents.send('theme:reload', slug);
        }
      }, 100));
    });
  } catch (err) {
    console.warn('[theme-watcher] fs.watch failed, themes will not hot-reload:', err);
  }

  return () => {
    watcher?.close();
    for (const t of debounceMap.values()) clearTimeout(t);
    debounceMap.clear();
  };
}

/** Returns list of user theme slugs (directories with manifest.json). */
export function listUserThemes(): string[] {
  try {
    return fs.readdirSync(THEMES_DIR)
      .filter(entry => {
        const entryPath = path.join(THEMES_DIR, entry);
        return fs.statSync(entryPath).isDirectory()
          && fs.existsSync(path.join(entryPath, 'manifest.json'));
      });
  } catch {
    return [];
  }
}

/** Returns absolute path to a theme's directory. */
export function userThemeDir(slug: string): string {
  return path.join(THEMES_DIR, slug);
}

/** Returns absolute path to a theme's manifest.json. */
export function userThemeManifest(slug: string): string {
  return path.join(THEMES_DIR, slug, 'manifest.json');
}

export { THEMES_DIR };
```

- [ ] **Step 2: Update IPC constants**

In `desktop/src/shared/types.ts`, update the `IPC` object — replace the theme section:

```typescript
  // Theme system
  THEME_RELOAD: 'theme:reload',
  THEME_LIST: 'theme:list',
  THEME_READ_FILE: 'theme:read-file',
  THEME_WRITE_FILE: 'theme:write-file',
  THEME_READ_ASSET: 'theme:read-asset',
```

- [ ] **Step 3: Update IPC handlers**

In `desktop/src/main/ipc-handlers.ts`, update the theme imports and handlers. Replace the existing theme handler section:

```typescript
import { startThemeWatcher, listUserThemes, userThemeDir, userThemeManifest, THEMES_DIR } from './theme-watcher';
```

Replace the three theme IPC handlers:

```typescript
  ipcMain.handle(IPC.THEME_LIST, async () => {
    return listUserThemes();
  });

  ipcMain.handle(IPC.THEME_READ_FILE, async (_event, slug: string) => {
    const manifestPath = path.resolve(userThemeManifest(slug));
    if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
    return fs.promises.readFile(manifestPath, 'utf-8');
  });

  ipcMain.handle(IPC.THEME_WRITE_FILE, async (_event, slug: string, content: string) => {
    const themeDir = path.resolve(userThemeDir(slug));
    if (!themeDir.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
    // Ensure folder structure exists
    await fs.promises.mkdir(path.join(themeDir, 'assets'), { recursive: true });
    await fs.promises.writeFile(path.join(themeDir, 'manifest.json'), content, 'utf-8');
  });
```

- [ ] **Step 4: Update preload.ts**

In `desktop/src/main/preload.ts`, the `THEME_READ_FILE` and `THEME_WRITE_FILE` channels already work (they're just string keys). Add `THEME_READ_ASSET` to the IPC object:

```typescript
  THEME_READ_ASSET: 'theme:read-asset',
```

No changes needed to the `theme` object in `contextBridge.exposeInMainWorld` — the existing `readFile`/`writeFile` methods still work, they just hit the updated handler that reads from `manifest.json`.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/theme-watcher.ts desktop/src/main/ipc-handlers.ts desktop/src/shared/types.ts desktop/src/main/preload.ts
git commit -m "feat(themes): update watcher and IPC for folder-based theme packs"
```

---

### Task 5: Update theme context for folder format + asset resolution

**Files:**
- Modify: `desktop/src/renderer/state/theme-context.tsx`

- [ ] **Step 1: Update theme loading to resolve asset paths**

In `desktop/src/renderer/state/theme-context.tsx`, add import:

```typescript
import { resolveAllAssetPaths } from '../themes/theme-asset-resolver';
```

In the `loadUserThemes` async function inside the `useEffect`, wrap the loaded theme with asset resolution. Replace:

```typescript
            loaded.push({ ...theme, source: 'user' });
```

With:

```typescript
            loaded.push(resolveAllAssetPaths({ ...theme, source: 'user' }));
```

Similarly in the hot-reload `useEffect`, replace:

```typescript
          const loaded: LoadedTheme = { ...theme, source: 'user' };
```

With:

```typescript
          const loaded: LoadedTheme = resolveAllAssetPaths({ ...theme, source: 'user' });
```

- [ ] **Step 2: Run existing tests to verify nothing broke**

Run: `cd desktop && npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 3: Commit**

```bash
git add desktop/src/renderer/state/theme-context.tsx
git commit -m "feat(themes): resolve asset paths in theme context loader"
```

---

### Task 6: Pattern overlay in background layer

**Files:**
- Modify: `desktop/src/renderer/themes/theme-engine.ts`
- Modify: `desktop/src/renderer/styles/globals.css`
- Modify: `desktop/tests/theme-engine.test.ts`

- [ ] **Step 1: Write failing test for pattern style builder**

Add to `desktop/tests/theme-engine.test.ts`:

```typescript
import { buildPatternStyle } from '../src/renderer/themes/theme-engine';

describe('buildPatternStyle', () => {
  it('returns repeating background style for pattern', () => {
    const result = buildPatternStyle('theme-asset://hello-kitty/assets/bow.svg', 0.06);
    expect(result).not.toBeNull();
    expect(result!.backgroundImage).toContain('theme-asset://hello-kitty/assets/bow.svg');
    expect(result!.backgroundRepeat).toBe('repeat');
    expect(result!.opacity).toBe('0.06');
  });

  it('returns null when pattern is undefined', () => {
    expect(buildPatternStyle(undefined, 0.06)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && npx vitest run tests/theme-engine.test.ts`
Expected: FAIL — `buildPatternStyle` doesn't exist

- [ ] **Step 3: Implement buildPatternStyle**

In `desktop/src/renderer/themes/theme-engine.ts`, add:

```typescript
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
```

- [ ] **Step 4: Add pattern overlay div to globals.css**

In `desktop/src/renderer/styles/globals.css`, add after the `#theme-bg` block:

```css
#theme-pattern {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: 0;
}
```

- [ ] **Step 5: Run tests**

Run: `cd desktop && npx vitest run tests/theme-engine.test.ts`
Expected: All PASS

- [ ] **Step 6: Wire pattern into App.tsx**

In `desktop/src/renderer/App.tsx`, the `#theme-bg` div already exists. Add a `#theme-pattern` div right after it. In the ThemeProvider consumer area, read `bgStyle` and the new pattern:

The pattern style needs to come from `activeTheme.background`. In `theme-context.tsx`, add to the context value:

```typescript
  const patternStyle = buildPatternStyle(
    activeTheme.background?.pattern,
    activeTheme.background?.['pattern-opacity'],
  ) as Record<string, string> | null;
```

Add `patternStyle` to the `ThemeContextValue` interface and the provider value. Then in `App.tsx`, render:

```tsx
{patternStyle && <div id="theme-pattern" style={patternStyle} />}
```

immediately after the `#theme-bg` div.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/renderer/themes/theme-engine.ts desktop/src/renderer/styles/globals.css desktop/src/renderer/state/theme-context.tsx desktop/src/renderer/App.tsx desktop/tests/theme-engine.test.ts
git commit -m "feat(themes): add pattern overlay layer for repeating SVG backgrounds"
```

---

### Task 7: Custom SVG particle renderer

**Files:**
- Modify: `desktop/src/renderer/components/ThemeEffects.tsx`

- [ ] **Step 1: Add custom particle rendering**

In `desktop/src/renderer/components/ThemeEffects.tsx`, add a custom SVG particle drawing function and update the component. Replace the existing file:

```typescript
import React, { useEffect, useRef } from 'react';
import { useTheme } from '../state/theme-context';

interface Particle {
  x: number; y: number; speed: number; opacity: number; length: number; size: number;
}

function drawRain(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number, rainColor: string) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = rainColor;
  ctx.lineWidth = 1;
  for (const p of particles) {
    ctx.globalAlpha = p.opacity;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - 1, p.y + p.length);
    ctx.stroke();
    p.y += p.speed;
    if (p.y > h) { p.y = -p.length; p.x = Math.random() * w; }
  }
  ctx.globalAlpha = 1;
}

function drawDust(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number, accent: string) {
  ctx.clearRect(0, 0, w, h);
  for (const p of particles) {
    ctx.globalAlpha = p.opacity;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1, 0, Math.PI * 2);
    ctx.fill();
    p.y -= p.speed * 0.3;
    p.x += Math.sin(p.y * 0.02) * 0.5;
    if (p.y < 0) { p.y = h; p.x = Math.random() * w; }
  }
  ctx.globalAlpha = 1;
}

function drawEmber(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number, accent: string) {
  ctx.clearRect(0, 0, w, h);
  const t = Date.now() * 0.001;
  for (const p of particles) {
    ctx.globalAlpha = p.opacity * 0.8;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    p.y -= p.speed;
    p.x += Math.sin(t + p.length) * 0.8;
    p.opacity -= 0.002;
    if (p.y < 0 || p.opacity <= 0) {
      p.y = h + 10; p.x = Math.random() * w;
      p.opacity = Math.random() * 0.5 + 0.2;
    }
  }
  ctx.globalAlpha = 1;
}

function drawSnow(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number, accent: string) {
  ctx.clearRect(0, 0, w, h);
  const t = Date.now() * 0.0005;
  for (const p of particles) {
    ctx.globalAlpha = p.opacity;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.length * 0.15 + 1, 0, Math.PI * 2);
    ctx.fill();
    p.y += p.speed * 0.4;
    p.x += Math.sin(t + p.length) * 0.6;
    if (p.y > h) { p.y = -5; p.x = Math.random() * w; }
  }
  ctx.globalAlpha = 1;
}

function drawCustom(
  ctx: CanvasRenderingContext2D,
  particles: Particle[],
  w: number, h: number,
  img: HTMLImageElement,
  drift: number,
) {
  ctx.clearRect(0, 0, w, h);
  const t = Date.now() * 0.001;
  for (const p of particles) {
    ctx.globalAlpha = p.opacity;
    ctx.drawImage(img, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    p.y -= p.speed * 0.5;
    p.x += Math.sin(t + p.length) * drift;
    if (p.y < -p.size) {
      p.y = h + p.size;
      p.x = Math.random() * w;
    }
  }
  ctx.globalAlpha = 1;
}

const DEFAULT_PARTICLE_COUNT = 60;

export default function ThemeEffects() {
  const { activeTheme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const effects = activeTheme?.effects;
  const preset = effects?.particles ?? 'none';
  const accent = activeTheme?.tokens?.accent ?? '#888888';
  const particleCount = effects?.['particle-count'] ?? DEFAULT_PARTICLE_COUNT;
  const particleSpeed = effects?.['particle-speed'] ?? 1.0;
  const particleDrift = effects?.['particle-drift'] ?? 0.5;
  const sizeRange = effects?.['particle-size-range'] ?? [8, 16];
  const shapeSrc = effects?.['particle-shape'];

  // Load custom SVG particle image
  useEffect(() => {
    if (preset !== 'custom' || !shapeSrc) {
      imgRef.current = null;
      return;
    }
    const img = new Image();
    img.src = shapeSrc;
    img.onload = () => { imgRef.current = img; };
    img.onerror = () => { imgRef.current = null; };
  }, [preset, shapeSrc]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || preset === 'none') {
      cancelAnimationFrame(animRef.current);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    // Initialize particles
    particlesRef.current = Array.from({ length: particleCount }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      speed: (Math.random() * 2 + 1) * particleSpeed,
      opacity: Math.random() * 0.4 + 0.1,
      length: Math.random() * 15 + 5,
      size: Math.random() * (sizeRange[1] - sizeRange[0]) + sizeRange[0],
    }));

    const rainColor = accent + '40';
    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      if (preset === 'rain') drawRain(ctx, particlesRef.current, w, h, rainColor);
      else if (preset === 'dust') drawDust(ctx, particlesRef.current, w, h, accent);
      else if (preset === 'ember') drawEmber(ctx, particlesRef.current, w, h, accent);
      else if (preset === 'snow') drawSnow(ctx, particlesRef.current, w, h, accent);
      else if (preset === 'custom' && imgRef.current) {
        drawCustom(ctx, particlesRef.current, w, h, imgRef.current, particleDrift);
      }
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [preset, accent, particleCount, particleSpeed, particleDrift, sizeRange[0], sizeRange[1]]);

  if (preset === 'none') return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 0,
        pointerEvents: 'none',
        opacity: 0.6,
      }}
      aria-hidden="true"
    />
  );
}
```

- [ ] **Step 2: Run existing tests + manual verify**

Run: `cd desktop && npx vitest run`
Expected: All existing tests PASS. ThemeEffects is a render component — manual testing needed when the app builds.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/renderer/components/ThemeEffects.tsx
git commit -m "feat(themes): add custom SVG particle rendering with tunable parameters"
```

---

### Task 8: Icon override hook

**Files:**
- Create: `desktop/src/renderer/hooks/useThemeIcon.ts`

- [ ] **Step 1: Implement useThemeIcon hook**

Create `desktop/src/renderer/hooks/useThemeIcon.ts`:

```typescript
import { useTheme } from '../state/theme-context';
import type { IconSlot } from '../themes/theme-types';

/**
 * Returns the resolved asset path for a themed icon override, or null if
 * the active theme doesn't override this icon slot.
 */
export function useThemeIcon(slot: IconSlot): string | null {
  const { activeTheme } = useTheme();
  return activeTheme?.icons?.[slot] ?? null;
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/renderer/hooks/useThemeIcon.ts
git commit -m "feat(themes): add useThemeIcon hook for icon overrides"
```

---

### Task 9: Mascot override hook + component updates

**Files:**
- Create: `desktop/src/renderer/hooks/useThemeMascot.ts`
- Modify: `desktop/src/renderer/components/Icons.tsx`
- Modify: `desktop/src/renderer/components/TrustGate.tsx`
- Modify: `desktop/src/renderer/App.tsx`

- [ ] **Step 1: Create useThemeMascot hook**

Create `desktop/src/renderer/hooks/useThemeMascot.ts`:

```typescript
import { useTheme } from '../state/theme-context';
import type { MascotVariant } from '../themes/theme-types';

/**
 * Returns the resolved asset path for a themed mascot variant, or null
 * if the active theme doesn't override this mascot.
 */
export function useThemeMascot(variant: MascotVariant): string | null {
  const { activeTheme } = useTheme();
  return activeTheme?.mascot?.[variant] ?? null;
}
```

- [ ] **Step 2: Create a ThemeMascot wrapper component**

Add to `desktop/src/renderer/components/Icons.tsx`:

```typescript
import { useThemeMascot } from '../hooks/useThemeMascot';
import type { MascotVariant } from '../themes/theme-types';

interface ThemeMascotProps {
  variant: MascotVariant;
  fallback: React.ComponentType<IconProps>;
  className?: string;
}

/** Renders a themed mascot SVG if the active theme overrides it, otherwise falls back to the default. */
export function ThemeMascot({ variant, fallback: Fallback, className = 'w-6 h-6' }: ThemeMascotProps) {
  const overrideSrc = useThemeMascot(variant);

  if (overrideSrc) {
    return <img src={overrideSrc} className={className} alt="" aria-hidden="true" draggable={false} />;
  }

  return <Fallback className={className} />;
}
```

- [ ] **Step 3: Update App.tsx initializing screen**

In `desktop/src/renderer/App.tsx`, replace:

```tsx
import { AppIcon, WelcomeAppIcon } from './components/Icons';
```

With:

```tsx
import { AppIcon, WelcomeAppIcon, ThemeMascot } from './components/Icons';
```

Replace the initializing overlay mascot (around line 683):

```tsx
<AppIcon className="w-16 h-16 text-fg-dim mb-6 animate-pulse" />
```

With:

```tsx
<ThemeMascot variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6 animate-pulse" />
```

Replace the welcome/no-session mascot (around line 718):

```tsx
<WelcomeAppIcon className="w-36 h-36 text-fg-dim" />
```

With:

```tsx
<ThemeMascot variant="welcome" fallback={WelcomeAppIcon} className="w-36 h-36 text-fg-dim" />
```

- [ ] **Step 4: Update TrustGate.tsx**

In `desktop/src/renderer/components/TrustGate.tsx`, replace:

```tsx
import { AppIcon } from './Icons';
```

With:

```tsx
import { AppIcon, ThemeMascot } from './Icons';
```

Replace:

```tsx
<AppIcon className="w-16 h-16 text-fg-dim mb-6" />
```

With:

```tsx
<ThemeMascot variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6" />
```

- [ ] **Step 5: Run all tests**

Run: `cd desktop && npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add desktop/src/renderer/hooks/useThemeMascot.ts desktop/src/renderer/components/Icons.tsx desktop/src/renderer/App.tsx desktop/src/renderer/components/TrustGate.tsx
git commit -m "feat(themes): add mascot override system with ThemeMascot component"
```

---

### Task 10: Update ThemeScreen editor for new fields

**Files:**
- Modify: `desktop/src/renderer/components/ThemeScreen.tsx`

- [ ] **Step 1: Add particle preset "custom" to the dropdown**

In `desktop/src/renderer/components/ThemeScreen.tsx`, update the `PARTICLE_OPTIONS` constant:

```typescript
const PARTICLE_OPTIONS = ['none', 'rain', 'dust', 'ember', 'snow', 'custom'] as const;
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/renderer/components/ThemeScreen.tsx
git commit -m "feat(themes): add custom particle option to ThemeScreen editor"
```

---

### Task 11: Update /theme-builder skill for theme packs

**Files:**
- Modify: `core/skills/theme-builder/SKILL.md`

- [ ] **Step 1: Rewrite the skill**

Replace `core/skills/theme-builder/SKILL.md` with the full updated skill. Key changes:

1. **Phase 1 updates:**
   - Two-round flow enforced: 3 concepts → user picks → 3 refinements (always) → user picks → build
   - Concept cards include asset preview row and vibe tags
   - Two prompt interpretation modes: Brand/IP (research-first) vs Vibe/Abstract (creative-first)

2. **Phase 2 updates:**
   - Output is a folder, not a single file: `~/.claude/destinclaude-themes/<slug>/manifest.json` + `assets/`
   - Claude downloads imagery via WebFetch/WebSearch for brand prompts
   - Claude generates SVG files for patterns, particles, icons, and mascots
   - manifest.json uses expanded schema (pattern, custom particles, icons, mascot, cursor, scrollbar)
   - Include base mascot SVG templates for all 3 variants so Claude can modify them

3. **Phase 3 unchanged:** Edit manifest.json, hot-reload picks it up.

4. **Asset generation rules:**
   - Brand/IP → web search for real imagery, download to assets/, Claude-generated SVGs for supporting elements
   - Vibe/Abstract → Claude-generated SVGs for everything, stock wallpapers from Unsplash
   - Mascots: always modify the base template, preserving body silhouette

The skill file should include:
- The complete manifest.json schema with all new fields
- The 3 base mascot SVG source code (copied from Icons.tsx) as reference templates
- The concept card HTML rendering spec (updated with asset preview row)
- Token design rules
- Rules about never modifying app source files

This is a large file (~400 lines). The implementing agent should read the current `SKILL.md`, the design spec at `desktop/docs/theme-packs-design (04-05-2026).md`, and the mascot SVGs from `desktop/src/renderer/components/Icons.tsx` to compose the full replacement.

- [ ] **Step 2: Update theme-preview.css**

Update `core/skills/theme-builder/theme-preview.css` to include pattern overlay rendering in concept card mockups.

- [ ] **Step 3: Commit**

```bash
git add core/skills/theme-builder/SKILL.md core/skills/theme-builder/theme-preview.css
git commit -m "feat(themes): rewrite /theme-builder skill for theme packs with asset pipeline"
```

---

### Task 12: Integration testing + manual verification

**Files:** None new — this is a verification task.

- [ ] **Step 1: Run full test suite**

Run: `cd desktop && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Build the app**

Run: `cd desktop && npm run build`
Expected: Clean build with no type errors

- [ ] **Step 3: Manual test — migration**

1. Create a bare JSON theme file at `~/.claude/destinclaude-themes/test-migration.json` with a valid theme
2. Launch the app
3. Verify the file was migrated to `~/.claude/destinclaude-themes/test-migration/manifest.json`
4. Verify the theme appears in the ThemeScreen grid

- [ ] **Step 4: Manual test — theme-asset protocol**

1. Create a test theme folder manually:
   ```
   ~/.claude/destinclaude-themes/test-assets/manifest.json
   ~/.claude/destinclaude-themes/test-assets/assets/wallpaper.png (any image)
   ```
2. Set `manifest.json` background to `{ "type": "image", "value": "assets/wallpaper.png" }`
3. Apply the theme — verify the wallpaper loads via `theme-asset://`

- [ ] **Step 5: Manual test — custom particles**

1. Create a simple SVG (e.g., a heart) at `~/.claude/destinclaude-themes/test-assets/assets/heart.svg`
2. Set `effects.particles: "custom"` and `effects["particle-shape"]: "assets/heart.svg"` in the manifest
3. Apply the theme — verify heart-shaped particles float on screen

- [ ] **Step 6: Manual test — mascot override**

1. Create a modified mascot SVG at `~/.claude/destinclaude-themes/test-assets/assets/mascot-welcome.svg`
2. Set `mascot.welcome: "assets/mascot-welcome.svg"` in the manifest
3. Apply the theme, go to no-session state — verify the custom mascot renders

- [ ] **Step 7: Commit any fixes found during testing**

```bash
git add -A && git commit -m "fix(themes): integration test fixes"
```
