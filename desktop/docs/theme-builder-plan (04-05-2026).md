# Theme Builder System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude-powered `/theme-builder` skill and an expanded settings panel to DestinCode, enabling fully custom Tier 3 themes with colors, shapes, backgrounds, layout presets, effects, and arbitrary CSS injection.

**Architecture:** Theme definitions are JSON files stored in `~/.claude/destinclaude-themes/`. The main process watches that directory with `fs.watch` and sends a `theme:reload` IPC event when files change. The renderer's `ThemeEngine` converts JSON to DOM mutations (CSS variables, data attributes, style injection). The `/theme-builder` skill uses a two-phase flow: concept browser (localhost HTML, no app changes) → full JSON generation (hot-reloads into the live app).

**Tech Stack:** TypeScript, React, Electron (Vite renderer), Tailwind v4 CSS custom properties, `fs.watch`, vitest, HTML5 Canvas

---

## File Map

### New files
| File | Responsibility |
|---|---|
| `src/renderer/themes/theme-types.ts` | TypeScript interfaces for theme JSON |
| `src/renderer/themes/theme-validator.ts` | Validate + normalize raw JSON; compute on-accent |
| `src/renderer/themes/theme-engine.ts` | Pure functions: JSON → CSS mutations |
| `src/renderer/themes/builtin/light.json` | Light built-in theme as JSON |
| `src/renderer/themes/builtin/dark.json` | Dark built-in theme as JSON |
| `src/renderer/themes/builtin/midnight.json` | Midnight built-in theme as JSON |
| `src/renderer/themes/builtin/creme.json` | Crème built-in theme as JSON |
| `src/main/theme-watcher.ts` | `fs.watch` on `~/.claude/destinclaude-themes/`, emits `theme:reload` |
| `src/renderer/components/ThemeEffects.tsx` | Canvas particle system overlay component |
| `src/renderer/components/ThemeScreen.tsx` | Manual theme editor (replaces ThemeSelector) |
| `tests/theme-validator.test.ts` | Tests for validation + on-accent computation |
| `tests/theme-engine.test.ts` | Tests for CSS generation logic |
| `~/.claude/skills/theme-builder/theme-builder.md` | The Claude skill |

### Modified files
| File | Change |
|---|---|
| `src/shared/types.ts` | Add `THEME_RELOAD`, `THEME_LIST` IPC channels |
| `src/main/preload.ts` | Add same channels to inlined IPC const + expose via contextBridge |
| `src/main/ipc-handlers.ts` | Add `theme:list` handler, start theme watcher |
| `src/renderer/styles/globals.css` | Add `--radius-*` vars, layout data-attribute selectors, background layer |
| `src/renderer/state/theme-context.tsx` | Extend to use ThemeEngine, load custom + builtin themes |
| `src/renderer/components/SettingsPanel.tsx` | Replace `ThemeSelector` with `ThemeScreen` |
| `src/renderer/App.tsx` | Add `<ThemeEffects />` and `<div id="theme-bg" />` |

---

## Phase 1 — App Infrastructure

### Task 1: TypeScript theme types + validation

**Files:**
- Create: `src/renderer/themes/theme-types.ts`
- Create: `src/renderer/themes/theme-validator.ts`
- Create: `tests/theme-validator.test.ts`

- [ ] **Step 1: Create the type file**

```typescript
// src/renderer/themes/theme-types.ts

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
}

export type InputStyle = 'default' | 'floating' | 'minimal' | 'terminal';
export type BubbleStyle = 'default' | 'pill' | 'flat' | 'bordered';
export type HeaderStyle = 'default' | 'minimal' | 'hidden';
export type StatusbarStyle = 'default' | 'minimal' | 'floating';
export type ParticlePreset = 'none' | 'rain' | 'dust' | 'ember' | 'snow';

export interface ThemeLayout {
  'input-style'?: InputStyle;
  'bubble-style'?: BubbleStyle;
  'header-style'?: HeaderStyle;
  'statusbar-style'?: StatusbarStyle;
}

export interface ThemeEffects {
  particles?: ParticlePreset;
  'scan-lines'?: boolean;
  vignette?: number;
  noise?: number;
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
  custom_css?: string;
}

/** A loaded theme — same as ThemeDefinition but guaranteed slug is kebab-case */
export type LoadedTheme = ThemeDefinition & { source: 'builtin' | 'user' };
```

- [ ] **Step 2: Write the failing tests**

```typescript
// tests/theme-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateTheme, computeOnAccent } from '../src/renderer/themes/theme-validator';

const MINIMAL_VALID = {
  name: 'Test Theme',
  slug: 'test-theme',
  dark: false,
  tokens: {
    canvas: '#F2F2F2', panel: '#EAEAEA', inset: '#E0E0E0', well: '#F7F7F7',
    accent: '#1A1A1A', 'on-accent': '#F2F2F2',
    fg: '#1A1A1A', 'fg-2': '#444444', 'fg-dim': '#666666',
    'fg-muted': '#888888', 'fg-faint': '#AAAAAA',
    edge: '#CFCFCF', 'edge-dim': '#DCDCDC80',
    'scrollbar-thumb': '#C0C0C0', 'scrollbar-hover': '#999999',
  },
};

describe('validateTheme', () => {
  it('accepts a minimal valid theme', () => {
    expect(() => validateTheme(MINIMAL_VALID)).not.toThrow();
  });

  it('throws when name is missing', () => {
    expect(() => validateTheme({ ...MINIMAL_VALID, name: '' })).toThrow('name');
  });

  it('throws when slug is missing', () => {
    expect(() => validateTheme({ ...MINIMAL_VALID, slug: '' })).toThrow('slug');
  });

  it('throws when a required token is missing', () => {
    const { canvas, ...rest } = MINIMAL_VALID.tokens;
    expect(() => validateTheme({ ...MINIMAL_VALID, tokens: rest as any })).toThrow('canvas');
  });

  it('throws when tokens block is absent', () => {
    const { tokens, ...rest } = MINIMAL_VALID;
    expect(() => validateTheme(rest as any)).toThrow('tokens');
  });
});

describe('computeOnAccent', () => {
  it('returns white for dark accent colors', () => {
    expect(computeOnAccent('#1A1A1A')).toBe('#FFFFFF');
    expect(computeOnAccent('#7C6AF7')).toBe('#FFFFFF');
    expect(computeOnAccent('#0D0F1A')).toBe('#FFFFFF');
  });

  it('returns black for light accent colors', () => {
    expect(computeOnAccent('#F2F2F2')).toBe('#000000');
    expect(computeOnAccent('#FFFFFF')).toBe('#000000');
    expect(computeOnAccent('#D4D4D4')).toBe('#000000');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd $REPO_ROOT/desktop && npm test -- --reporter=verbose tests/theme-validator.test.ts
```

Expected: FAIL — `Cannot find module '../src/renderer/themes/theme-validator'`

- [ ] **Step 4: Create the validator**

```typescript
// src/renderer/themes/theme-validator.ts
import type { ThemeDefinition } from './theme-types';

const REQUIRED_TOKENS = [
  'canvas', 'panel', 'inset', 'well', 'accent', 'on-accent',
  'fg', 'fg-2', 'fg-dim', 'fg-muted', 'fg-faint',
  'edge', 'edge-dim', 'scrollbar-thumb', 'scrollbar-hover',
] as const;

/** Relative luminance of a hex color (0–1). */
export function luminance(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Returns '#FFFFFF' or '#000000' based on accent luminance. */
export function computeOnAccent(accentHex: string): string {
  return luminance(accentHex) < 0.4 ? '#FFFFFF' : '#000000';
}

/** Throws a descriptive error if the theme JSON is invalid. */
export function validateTheme(raw: unknown): ThemeDefinition {
  if (!raw || typeof raw !== 'object') throw new Error('Theme must be an object');
  const t = raw as Record<string, unknown>;

  if (!t.name || typeof t.name !== 'string' || !t.name.trim()) throw new Error('Theme missing required field: name');
  if (!t.slug || typeof t.slug !== 'string' || !t.slug.trim()) throw new Error('Theme missing required field: slug');
  if (typeof t.dark !== 'boolean') throw new Error('Theme missing required field: dark (boolean)');
  if (!t.tokens || typeof t.tokens !== 'object') throw new Error('Theme missing required field: tokens');

  const tokens = t.tokens as Record<string, unknown>;
  for (const key of REQUIRED_TOKENS) {
    if (!tokens[key] || typeof tokens[key] !== 'string') {
      throw new Error(`Theme tokens missing required field: ${key}`);
    }
  }

  return raw as ThemeDefinition;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd $REPO_ROOT/desktop && npm test -- --reporter=verbose tests/theme-validator.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd $REPO_ROOT/desktop && git add src/renderer/themes/theme-types.ts src/renderer/themes/theme-validator.ts tests/theme-validator.test.ts && git commit -m "feat(themes): add ThemeDefinition types and validation"
```

---

### Task 2: Built-in theme JSON files

**Files:**
- Create: `src/renderer/themes/builtin/light.json`
- Create: `src/renderer/themes/builtin/dark.json`
- Create: `src/renderer/themes/builtin/midnight.json`
- Create: `src/renderer/themes/builtin/creme.json`

Values are extracted from the existing `[data-theme]` blocks in `src/renderer/styles/globals.css`.

- [ ] **Step 1: Create light.json**

```json
{
  "name": "Light", "slug": "light", "dark": false, "source": "builtin",
  "tokens": {
    "canvas": "#F2F2F2", "panel": "#EAEAEA", "inset": "#E0E0E0", "well": "#F7F7F7",
    "accent": "#1A1A1A", "on-accent": "#F2F2F2",
    "fg": "#1A1A1A", "fg-2": "#444444", "fg-dim": "#666666",
    "fg-muted": "#888888", "fg-faint": "#AAAAAA",
    "edge": "#CFCFCF", "edge-dim": "#DCDCDC80",
    "scrollbar-thumb": "#C0C0C0", "scrollbar-hover": "#999999"
  }
}
```

- [ ] **Step 2: Create dark.json**

```json
{
  "name": "Dark", "slug": "dark", "dark": true, "source": "builtin",
  "tokens": {
    "canvas": "#111111", "panel": "#191919", "inset": "#222222", "well": "#1C1C1C",
    "accent": "#D4D4D4", "on-accent": "#111111",
    "fg": "#E0E0E0", "fg-2": "#B0B0B0", "fg-dim": "#999999",
    "fg-muted": "#666666", "fg-faint": "#444444",
    "edge": "#2E2E2E", "edge-dim": "#37373780",
    "scrollbar-thumb": "#333333", "scrollbar-hover": "#555555"
  }
}
```

- [ ] **Step 3: Create midnight.json**

```json
{
  "name": "Midnight", "slug": "midnight", "dark": true, "source": "builtin",
  "tokens": {
    "canvas": "#0D1117", "panel": "#161B22", "inset": "#21262D", "well": "#0D1117",
    "accent": "#B1BAC4", "on-accent": "#0D1117",
    "fg": "#C9D1D9", "fg-2": "#A0AAB4", "fg-dim": "#8B949E",
    "fg-muted": "#6E7681", "fg-faint": "#484F58",
    "edge": "#30363D", "edge-dim": "#30363D80",
    "scrollbar-thumb": "#30363D", "scrollbar-hover": "#484F58"
  }
}
```

- [ ] **Step 4: Create creme.json**

```json
{
  "name": "Crème", "slug": "creme", "dark": false, "source": "builtin",
  "tokens": {
    "canvas": "#F0E6D6", "panel": "#EBE1D1", "inset": "#DDD1BE", "well": "#F5ECDE",
    "accent": "#3D3229", "on-accent": "#F0E6D6",
    "fg": "#2C2418", "fg-2": "#5C4F3E", "fg-dim": "#7A6E5D",
    "fg-muted": "#9E9283", "fg-faint": "#BEB3A4",
    "edge": "#CBBFAD", "edge-dim": "#D4C8B580",
    "scrollbar-thumb": "#CBBFB0", "scrollbar-hover": "#A89A8A"
  }
}
```

- [ ] **Step 5: Commit**

```bash
cd $REPO_ROOT/desktop && git add src/renderer/themes/builtin/ && git commit -m "feat(themes): add built-in themes as JSON files"
```

---

### Task 3: CSS layer — radius variables, layout selectors, background layer

**Files:**
- Modify: `src/renderer/styles/globals.css`

- [ ] **Step 1: Add shape radius CSS variables to all four theme blocks**

In `globals.css`, add these lines inside each `[data-theme]` block (and `:root`):

```css
/* Add to [data-theme="light"], :root { ... } */
--radius-sm: 4px;
--radius-md: 8px;
--radius-lg: 12px;
--radius-full: 9999px;
```

Add the same four lines to `[data-theme="dark"]`, `[data-theme="midnight"]`, and `[data-theme="creme"]` blocks with the same values (all built-ins use the same default radius scale).

- [ ] **Step 2: Add radius tokens to the Tailwind @theme block**

Inside the existing `@theme { }` block in `globals.css`, add:

```css
/* Border radius scale — driven by theme variables */
--radius-sm: var(--radius-sm);
--radius-md: var(--radius-md);
--radius-lg: var(--radius-lg);
--radius-full: var(--radius-full);
```

- [ ] **Step 3: Add the background layer styles**

After the existing global styles section, add:

```css
/* ═══════════════════════════════════════════════════════════════════════════
   Theme background layer — sits behind all panels
   ═══════════════════════════════════════════════════════════════════════════ */

#theme-bg {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: var(--canvas); /* fallback — overridden by ThemeEngine */
  opacity: 1;
}

/* Glassmorphism panels — active when data-panels-blur is set on <html> */
[data-panels-blur] .bg-panel {
  backdrop-filter: blur(var(--panels-blur, 0px));
  -webkit-backdrop-filter: blur(var(--panels-blur, 0px));
}
```

- [ ] **Step 4: Add layout data-attribute selectors**

```css
/* ═══════════════════════════════════════════════════════════════════════════
   Layout presets — applied via data attributes on <body>
   ═══════════════════════════════════════════════════════════════════════════ */

/* Input styles */
[data-input-style="floating"] .input-bar-container {
  margin: 8px 12px;
  border-radius: var(--radius-full);
  box-shadow: 0 2px 16px rgba(0,0,0,0.2);
}

[data-input-style="minimal"] .input-bar-container {
  border-top: none;
  background: transparent;
}

[data-input-style="terminal"] .input-bar-container {
  border-radius: 0;
  font-family: var(--font-mono);
  border-top: 1px solid var(--edge);
}

/* Bubble styles */
[data-bubble-style="pill"] .assistant-bubble,
[data-bubble-style="pill"] .user-bubble {
  border-radius: var(--radius-full);
  padding-left: 16px;
  padding-right: 16px;
}

[data-bubble-style="flat"] .assistant-bubble,
[data-bubble-style="flat"] .user-bubble {
  border-radius: 0;
  border-left: 2px solid var(--edge);
}

[data-bubble-style="bordered"] .assistant-bubble,
[data-bubble-style="bordered"] .user-bubble {
  border: 1px solid var(--edge);
  border-radius: var(--radius-md);
}

/* Header styles */
[data-header-style="minimal"] .header-bar {
  background: transparent;
  border-bottom: none;
}

[data-header-style="hidden"] .header-bar {
  display: none;
}

/* Status bar styles */
[data-statusbar-style="minimal"] .status-bar {
  background: transparent;
  border-top: none;
  font-size: 9px;
}

[data-statusbar-style="floating"] .status-bar {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  border-radius: var(--radius-full);
  background: var(--panel);
  border: 1px solid var(--edge);
  padding: 2px 12px;
}
```

Note: The CSS class names (`input-bar-container`, `assistant-bubble`, etc.) must be added to the corresponding components in a later task. This CSS has no effect until the classes exist.

- [ ] **Step 5: Verify no visual regressions by running the dev server**

```bash
cd $REPO_ROOT/desktop && npm run dev
```

Open the app. All four built-in themes should look identical to before. The new CSS rules have no effect yet (no data attributes set, no class names matched).

- [ ] **Step 6: Commit**

```bash
cd $REPO_ROOT/desktop && git add src/renderer/styles/globals.css && git commit -m "feat(themes): add radius vars, layout selectors, background layer to CSS"
```

---

### Task 4: ThemeEngine — pure CSS application functions

**Files:**
- Create: `src/renderer/themes/theme-engine.ts`
- Create: `tests/theme-engine.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/theme-engine.test.ts
import { describe, it, expect } from 'vitest';
import { buildTokenCSS, buildShapeCSS, buildBackgroundStyle, buildLayoutAttrs } from '../src/renderer/themes/theme-engine';

const TOKENS = {
  canvas: '#0D0F1A', panel: '#141726', inset: '#1F2440', well: '#0D0F1A',
  accent: '#7C6AF7', 'on-accent': '#FFFFFF',
  fg: '#C4BFFF', 'fg-2': '#9090C0', 'fg-dim': '#6060A0',
  'fg-muted': '#404070', 'fg-faint': '#282848',
  edge: '#2A2F55', 'edge-dim': '#2A2F5580',
  'scrollbar-thumb': '#2A2F55', 'scrollbar-hover': '#3A3F70',
};

describe('buildTokenCSS', () => {
  it('returns an object of CSS property → value pairs', () => {
    const result = buildTokenCSS(TOKENS);
    expect(result['--canvas']).toBe('#0D0F1A');
    expect(result['--accent']).toBe('#7C6AF7');
    expect(result['--on-accent']).toBe('#FFFFFF');
    expect(Object.keys(result)).toHaveLength(15);
  });
});

describe('buildShapeCSS', () => {
  it('returns radius CSS properties', () => {
    const result = buildShapeCSS({ 'radius-sm': '2px', 'radius-md': '4px', 'radius-lg': '8px', 'radius-full': '9999px' });
    expect(result['--radius-sm']).toBe('2px');
    expect(result['--radius-full']).toBe('9999px');
  });

  it('returns empty object for undefined shape', () => {
    expect(buildShapeCSS(undefined)).toEqual({});
  });
});

describe('buildBackgroundStyle', () => {
  it('returns gradient CSS for gradient type', () => {
    const result = buildBackgroundStyle({ type: 'gradient', value: 'linear-gradient(135deg, #000, #fff)' });
    expect(result.background).toBe('linear-gradient(135deg, #000, #fff)');
  });

  it('returns image CSS for image type', () => {
    const result = buildBackgroundStyle({ type: 'image', value: 'https://example.com/bg.jpg' });
    expect(result.backgroundImage).toBe('url("https://example.com/bg.jpg")');
    expect(result.backgroundSize).toBe('cover');
  });

  it('returns null for undefined background', () => {
    expect(buildBackgroundStyle(undefined)).toBeNull();
  });
});

describe('buildLayoutAttrs', () => {
  it('returns data attribute values for each layout field', () => {
    const result = buildLayoutAttrs({ 'input-style': 'floating', 'bubble-style': 'pill' });
    expect(result['data-input-style']).toBe('floating');
    expect(result['data-bubble-style']).toBe('pill');
    expect(result['data-header-style']).toBeUndefined();
  });

  it('returns empty object for undefined layout', () => {
    expect(buildLayoutAttrs(undefined)).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd $REPO_ROOT/desktop && npm test -- --reporter=verbose tests/theme-engine.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the ThemeEngine**

```typescript
// src/renderer/themes/theme-engine.ts
import type { ThemeTokens, ThemeShape, ThemeBackground, ThemeLayout, ThemeDefinition } from './theme-types';

/** Returns CSS custom property map for all 15 color tokens. */
export function buildTokenCSS(tokens: ThemeTokens): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    result[`--${key}`] = value;
  }
  return result;
}

/** Returns CSS custom property map for shape radius variables. */
export function buildShapeCSS(shape: ThemeShape | undefined): Record<string, string> {
  if (!shape) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (value) result[`--${key}`] = value;
  }
  return result;
}

/** Returns inline style properties for the #theme-bg div. Null if no background defined. */
export function buildBackgroundStyle(bg: ThemeBackground | undefined): React.CSSProperties | null {
  if (!bg) return null;
  if (bg.type === 'solid') return { background: bg.value, opacity: bg.opacity ?? 1 };
  if (bg.type === 'gradient') return { background: bg.value, opacity: bg.opacity ?? 1 };
  if (bg.type === 'image') return {
    backgroundImage: `url("${bg.value}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    opacity: bg.opacity ?? 1,
  };
  return null;
}

/** Returns data-attribute key/value pairs to set on <body>. */
export function buildLayoutAttrs(layout: ThemeLayout | undefined): Record<string, string> {
  if (!layout) return {};
  const result: Record<string, string> = {};
  if (layout['input-style']) result['data-input-style'] = layout['input-style'];
  if (layout['bubble-style']) result['data-bubble-style'] = layout['bubble-style'];
  if (layout['header-style']) result['data-header-style'] = layout['header-style'];
  if (layout['statusbar-style']) result['data-statusbar-style'] = layout['statusbar-style'];
  return result;
}

/** Applies a full ThemeDefinition to the live DOM. Call this from ThemeContext. */
export function applyThemeToDom(theme: ThemeDefinition): void {
  const root = document.documentElement;
  const body = document.body;

  // 1. data-theme attribute (drives existing [data-theme] CSS blocks as fallback)
  root.setAttribute('data-theme', theme.slug);

  // 2. Color tokens
  for (const [prop, value] of Object.entries(buildTokenCSS(theme.tokens))) {
    root.style.setProperty(prop, value);
  }

  // 3. Shape radius
  for (const [prop, value] of Object.entries(buildShapeCSS(theme.shape))) {
    root.style.setProperty(prop, value);
  }

  // 4. Glassmorphism — set/remove data-panels-blur + CSS var
  const blur = theme.background?.['panels-blur'];
  if (blur && blur > 0) {
    root.setAttribute('data-panels-blur', String(blur));
    root.style.setProperty('--panels-blur', `${blur}px`);
  } else {
    root.removeAttribute('data-panels-blur');
    root.style.removeProperty('--panels-blur');
  }

  // 5. Layout data attributes on body
  // Clear previous layout attrs first
  ['data-input-style', 'data-bubble-style', 'data-header-style', 'data-statusbar-style'].forEach(attr => {
    body.removeAttribute(attr);
  });
  for (const [attr, value] of Object.entries(buildLayoutAttrs(theme.layout))) {
    body.setAttribute(attr, value);
  }

  // 6. custom_css — inject/replace in <style id="theme-custom">
  const customCSSId = 'theme-custom';
  let customEl = document.getElementById(customCSSId) as HTMLStyleElement | null;
  if (theme.custom_css) {
    if (!customEl) {
      customEl = document.createElement('style');
      customEl.id = customCSSId;
      document.head.appendChild(customEl);
    }
    customEl.textContent = theme.custom_css;
  } else if (customEl) {
    customEl.textContent = '';
  }
}

/** Clears all theme-engine-applied DOM mutations (used when resetting to builtin). */
export function clearThemeFromDom(): void {
  const root = document.documentElement;
  const body = document.body;
  root.removeAttribute('data-panels-blur');
  ['--panels-blur', '--radius-sm', '--radius-md', '--radius-lg', '--radius-full'].forEach(p => root.style.removeProperty(p));
  ['data-input-style', 'data-bubble-style', 'data-header-style', 'data-statusbar-style'].forEach(a => body.removeAttribute(a));
  const customEl = document.getElementById('theme-custom') as HTMLStyleElement | null;
  if (customEl) customEl.textContent = '';
}
```

Note: `buildBackgroundStyle` returns `React.CSSProperties` — add `import type React from 'react'` at the top, or change the return type to `Record<string, string> | null` if React isn't available in the test environment.

- [ ] **Step 4: Fix import if needed — theme-engine uses React type**

If tests fail due to React import, replace the return type in `buildBackgroundStyle`:

```typescript
// Change the return type from React.CSSProperties to:
export function buildBackgroundStyle(bg: ThemeBackground | undefined): Record<string, string> | null {
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd $REPO_ROOT/desktop && npm test -- --reporter=verbose tests/theme-engine.test.ts
```

Expected: All 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd $REPO_ROOT/desktop && git add src/renderer/themes/theme-engine.ts tests/theme-engine.test.ts && git commit -m "feat(themes): add ThemeEngine pure functions with tests"
```

---

### Task 5: IPC channels + main process theme watcher

**Files:**
- Modify: `src/shared/types.ts` (add THEME_RELOAD, THEME_LIST)
- Modify: `src/main/preload.ts` (add same channels + expose via contextBridge)
- Create: `src/main/theme-watcher.ts`
- Modify: `src/main/ipc-handlers.ts` (add theme:list handler, start watcher)

- [ ] **Step 1: Add IPC channels to shared/types.ts**

In `src/shared/types.ts`, inside the `export const IPC = { ... }` block, add before the closing `} as const;`:

```typescript
  // Theme system
  THEME_RELOAD: 'theme:reload',   // Main -> Renderer: a theme file changed
  THEME_LIST: 'theme:list',       // Renderer -> Main: get list of user theme slugs
```

- [ ] **Step 2: Add same channels to preload.ts inlined IPC const**

In `src/main/preload.ts`, inside the `const IPC = { ... }` block (the inlined copy), add before the closing `} as const;`:

```typescript
  THEME_RELOAD: 'theme:reload',
  THEME_LIST: 'theme:list',
```

- [ ] **Step 3: Expose theme IPC in contextBridge**

In `src/main/preload.ts`, inside `contextBridge.exposeInMainWorld('claude', { ... })`, add a new `theme` section. Find the end of the existing object and add:

```typescript
  theme: {
    list: () => ipcRenderer.invoke(IPC.THEME_LIST),
    onReload: (handler: (slug: string) => void) => {
      const wrapped = (_event: IpcRendererEvent, slug: string) => handler(slug);
      ipcRenderer.on(IPC.THEME_RELOAD, wrapped);
      return () => ipcRenderer.removeListener(IPC.THEME_RELOAD, wrapped);
    },
  },
```

- [ ] **Step 4: Create the theme watcher**

```typescript
// src/main/theme-watcher.ts
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { BrowserWindow } from 'electron';

const THEMES_DIR = path.join(os.homedir(), '.claude', 'destinclaude-themes');

/** Ensures ~/.claude/destinclaude-themes/ exists, then watches it for JSON changes.
 *  Sends theme:reload to the renderer window whenever a .json file is written. */
export function startThemeWatcher(win: BrowserWindow): () => void {
  if (!fs.existsSync(THEMES_DIR)) {
    fs.mkdirSync(THEMES_DIR, { recursive: true });
  }

  let watcher: fs.FSWatcher | null = null;

  try {
    watcher = fs.watch(THEMES_DIR, (eventType, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      const slug = filename.replace(/\.json$/, '');
      if (!win.isDestroyed()) {
        win.webContents.send('theme:reload', slug);
      }
    });
  } catch (err) {
    console.warn('[theme-watcher] fs.watch failed, themes will not hot-reload:', err);
  }

  return () => { watcher?.close(); };
}

/** Returns list of user theme slugs from ~/.claude/destinclaude-themes/. */
export function listUserThemes(): string[] {
  try {
    return fs.readdirSync(THEMES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/** Returns path for a given user theme slug. */
export function userThemePath(slug: string): string {
  return path.join(THEMES_DIR, `${slug}.json`);
}

export { THEMES_DIR };
```

- [ ] **Step 5: Wire watcher into ipc-handlers.ts**

In `src/main/ipc-handlers.ts`, add the import at the top:

```typescript
import { startThemeWatcher, listUserThemes } from './theme-watcher';
```

Find the `setupIpcHandlers` function signature — it already receives a `win: BrowserWindow` parameter (check the actual signature). Add inside the function body:

```typescript
  // Theme watcher — watches ~/.claude/destinclaude-themes/ and hot-reloads
  startThemeWatcher(win);

  ipcMain.handle(IPC.THEME_LIST, async () => {
    return listUserThemes();
  });
```

If `setupIpcHandlers` doesn't already take a `win` parameter, check `src/main/main.ts` to see how it's called and add the parameter accordingly.

- [ ] **Step 6: Verify watcher starts without errors**

```bash
cd $REPO_ROOT/desktop && npm run dev
```

In the app, open DevTools console. There should be no errors. Create a test file:

```bash
echo '{"name":"Test","slug":"test","dark":true,"tokens":{"canvas":"#000"}}' > ~/.claude/destinclaude-themes/test.json
```

The main process terminal should not crash (even if the theme is invalid — the renderer handles validation).

- [ ] **Step 7: Commit**

```bash
cd $REPO_ROOT/desktop && git add src/shared/types.ts src/main/preload.ts src/main/theme-watcher.ts src/main/ipc-handlers.ts && git commit -m "feat(themes): add theme IPC channels and file watcher"
```

---

### Task 6: Wire ThemeEngine into ThemeContext

**Files:**
- Modify: `src/renderer/state/theme-context.tsx`
- Modify: `src/renderer/App.tsx` (add `<div id="theme-bg">`)

- [ ] **Step 1: Extend ThemeContext to load and apply custom themes**

Replace the contents of `src/renderer/state/theme-context.tsx` with the following. This preserves all existing exports (`useTheme`, `ThemeProvider`, `THEMES`, `ThemeName`, `DEFAULT_FONT_FAMILY`) while adding custom theme support.

```typescript
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
// @ts-ignore
import hljsDarkCss from 'highlight.js/styles/github-dark.css?inline';
// @ts-ignore
import hljsLightCss from 'highlight.js/styles/github.css?inline';

import { validateTheme } from './themes/theme-validator';
import { applyThemeToDom, clearThemeFromDom, buildBackgroundStyle } from './themes/theme-engine';
import type { ThemeDefinition, LoadedTheme } from './themes/theme-types';

// Built-in themes imported as JSON (Vite handles JSON imports natively)
import lightJson from './themes/builtin/light.json';
import darkJson from './themes/builtin/dark.json';
import midnightJson from './themes/builtin/midnight.json';
import cremeJson from './themes/themes/builtin/creme.json';

export type ThemeName = string; // Now dynamic — any loaded slug
const BUILTIN_THEMES: LoadedTheme[] = [
  { ...lightJson, source: 'builtin' } as LoadedTheme,
  { ...darkJson, source: 'builtin' } as LoadedTheme,
  { ...midnightJson, source: 'builtin' } as LoadedTheme,
  { ...cremeJson, source: 'builtin' } as LoadedTheme,
];

// Keep backward-compat THEMES export (slugs of builtin themes)
export const THEMES = BUILTIN_THEMES.map(t => t.slug) as ['light', 'dark', 'midnight', 'creme'];

const STORAGE_KEY = 'destincode-theme';
const CYCLE_KEY = 'destincode-theme-cycle';
const FONT_KEY = 'destincode-font';
const DEFAULT_THEME = 'light';
const DEFAULT_CYCLE = ['light', 'dark'];
export const DEFAULT_FONT_FAMILY = "'Cascadia Mono', 'Cascadia Code', 'Fira Code', monospace";

interface ThemeContextValue {
  theme: string;
  setTheme: (slug: string) => void;
  cycleTheme: () => void;
  cycleList: string[];
  setCycleList: (list: string[]) => void;
  font: string;
  setFont: (font: string) => void;
  allThemes: LoadedTheme[];
  activeTheme: LoadedTheme | null;
  bgStyle: Record<string, string> | null;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME, setTheme: () => {}, cycleTheme: () => {},
  cycleList: DEFAULT_CYCLE, setCycleList: () => {},
  font: DEFAULT_FONT_FAMILY, setFont: () => {},
  allThemes: BUILTIN_THEMES, activeTheme: null, bgStyle: null,
});

function getStored(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function getStoredJSON<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

function applyFont(font: string) {
  document.documentElement.style.setProperty('--font-sans', font);
  document.documentElement.style.setProperty('--font-mono', font);
}

function applyHighlightTheme(dark: boolean) {
  const id = 'hljs-theme';
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
  el.textContent = dark ? hljsDarkCss : hljsLightCss;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [activeSlug, setActiveSlug] = useState(() => getStored(STORAGE_KEY, DEFAULT_THEME));
  const [cycleList, setCycleListState] = useState<string[]>(() => getStoredJSON(CYCLE_KEY, DEFAULT_CYCLE));
  const [font, setFontState] = useState(() => getStored(FONT_KEY, DEFAULT_FONT_FAMILY));
  const [userThemes, setUserThemes] = useState<LoadedTheme[]>([]);

  const allThemes = [...BUILTIN_THEMES, ...userThemes];
  const activeTheme = allThemes.find(t => t.slug === activeSlug) ?? BUILTIN_THEMES[0];

  // Load user themes from disk on mount
  useEffect(() => {
    const loadUserThemes = async () => {
      try {
        const slugs: string[] = await (window as any).claude.theme.list();
        const loaded: LoadedTheme[] = [];
        for (const slug of slugs) {
          try {
            // Fetch the JSON file via IPC — main process can read it
            const raw = await (window as any).claude.theme.readFile(slug);
            const theme = validateTheme(JSON.parse(raw));
            loaded.push({ ...theme, source: 'user' });
          } catch (e) {
            console.warn(`[ThemeProvider] Failed to load user theme "${slug}":`, e);
          }
        }
        setUserThemes(loaded);
      } catch { /* not in Electron */ }
    };
    loadUserThemes();
  }, []);

  // Listen for hot-reload signal from main process
  useEffect(() => {
    const cleanup = (window as any).claude?.theme?.onReload?.((slug: string) => {
      // Re-fetch the updated theme file
      (window as any).claude.theme.readFile(slug).then((raw: string) => {
        try {
          const theme = validateTheme(JSON.parse(raw));
          const loaded: LoadedTheme = { ...theme, source: 'user' };
          setUserThemes(prev => {
            const idx = prev.findIndex(t => t.slug === slug);
            if (idx >= 0) { const next = [...prev]; next[idx] = loaded; return next; }
            return [...prev, loaded];
          });
          // Auto-switch to the newly reloaded theme
          setActiveSlug(slug);
          try { localStorage.setItem(STORAGE_KEY, slug); } catch {}
        } catch (e) {
          console.warn(`[ThemeProvider] Hot-reload failed for "${slug}":`, e);
        }
      });
    });
    return cleanup;
  }, []);

  // Apply theme to DOM whenever active theme changes
  useEffect(() => {
    applyThemeToDom(activeTheme);
    applyHighlightTheme(activeTheme.dark);
  }, [activeTheme]);

  // Apply font
  useEffect(() => { applyFont(font); }, [font]);

  const setTheme = useCallback((slug: string) => {
    setActiveSlug(slug);
    try { localStorage.setItem(STORAGE_KEY, slug); } catch {}
  }, []);

  const setCycleList = useCallback((list: string[]) => {
    const safe = list.length > 0 ? list : DEFAULT_CYCLE;
    setCycleListState(safe);
    try { localStorage.setItem(CYCLE_KEY, JSON.stringify(safe)); } catch {}
  }, []);

  const setFont = useCallback((f: string) => {
    setFontState(f); applyFont(f);
    try { localStorage.setItem(FONT_KEY, f); } catch {}
  }, []);

  const cycleTheme = useCallback(() => {
    setActiveSlug(prev => {
      const pool = allThemes.filter(t => cycleList.includes(t.slug));
      if (pool.length === 0) return prev;
      const idx = pool.findIndex(t => t.slug === prev);
      const next = idx === -1 ? pool[0].slug : pool[(idx + 1) % pool.length].slug;
      try { localStorage.setItem(STORAGE_KEY, next); } catch {}
      return next;
    });
  }, [allThemes, cycleList]);

  const bgStyle = buildBackgroundStyle(activeTheme.background) as Record<string, string> | null;

  return (
    <ThemeContext.Provider value={{
      theme: activeSlug, setTheme, cycleTheme,
      cycleList, setCycleList, font, setFont,
      allThemes, activeTheme, bgStyle,
    }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() { return useContext(ThemeContext); }
```

- [ ] **Step 2: Add theme:readFile IPC (main process reads the JSON file)**

In `src/shared/types.ts`, add:
```typescript
  THEME_READ_FILE: 'theme:read-file',
```

In `src/main/preload.ts` inlined IPC const, add:
```typescript
  THEME_READ_FILE: 'theme:read-file',
```

In `src/main/preload.ts` contextBridge `theme` section, add:
```typescript
    readFile: (slug: string) => ipcRenderer.invoke(IPC.THEME_READ_FILE, slug),
```

In `src/main/ipc-handlers.ts`, add handler:
```typescript
  ipcMain.handle(IPC.THEME_READ_FILE, async (_event, slug: string) => {
    const { userThemePath } = await import('./theme-watcher');
    return fs.promises.readFile(userThemePath(slug), 'utf-8');
  });
```

Add `import fs from 'fs';` at the top of ipc-handlers.ts if not already present.

- [ ] **Step 3: Add `<div id="theme-bg">` to App.tsx**

In `src/renderer/App.tsx`, inside the `ThemeProvider` wrapper (at the top of the JSX returned from `App`), add the background div. Find the return statement of the top-level `App` component and add before the main content:

```tsx
// Add import at top
import { useTheme } from './state/theme-context';

// Inside the component that renders inside ThemeProvider, add:
function ThemeBg() {
  const { bgStyle } = useTheme();
  if (!bgStyle) return null;
  return <div id="theme-bg" style={bgStyle} aria-hidden="true" />;
}
// Render <ThemeBg /> as the first child inside the ThemeProvider wrapper in App.tsx
```

- [ ] **Step 4: Fix the creme.json import path typo**

In step 1 there is a typo: `from './themes/themes/builtin/creme.json'`. The correct path is:
```typescript
import cremeJson from './themes/builtin/creme.json';
```

Fix before running.

- [ ] **Step 5: Run dev server and verify**

```bash
cd $REPO_ROOT/desktop && npm run dev
```

1. All 4 builtin themes should switch correctly via the status bar pill.
2. Write a valid user theme to test hot-reload:
```bash
cat > ~/.claude/destinclaude-themes/tokyo-rain.json << 'EOF'
{"name":"Tokyo Rain","slug":"tokyo-rain","dark":true,"tokens":{"canvas":"#0D0F1A","panel":"#141726","inset":"#1F2440","well":"#0D0F1A","accent":"#7C6AF7","on-accent":"#FFFFFF","fg":"#C4BFFF","fg-2":"#9090C0","fg-dim":"#6060A0","fg-muted":"#404070","fg-faint":"#282848","edge":"#2A2F55","edge-dim":"#2A2F5580","scrollbar-thumb":"#2A2F55","scrollbar-hover":"#3A3F70"},"background":{"type":"gradient","value":"linear-gradient(135deg, #0D0F1A 0%, #1A1F35 60%, #0D1A2A 100%)","panels-blur":8,"panels-opacity":0.8}}
EOF
```
The app should immediately switch to Tokyo Rain with the gradient background visible.

- [ ] **Step 6: Commit**

```bash
cd $REPO_ROOT/desktop && git add src/renderer/state/theme-context.tsx src/renderer/App.tsx src/shared/types.ts src/main/preload.ts src/main/ipc-handlers.ts && git commit -m "feat(themes): wire ThemeEngine into ThemeContext with hot-reload"
```

---

### Task 7: ThemeEffects component — particle system

**Files:**
- Create: `src/renderer/components/ThemeEffects.tsx`
- Modify: `src/renderer/App.tsx` (render `<ThemeEffects />`)

- [ ] **Step 1: Create ThemeEffects component**

```tsx
// src/renderer/components/ThemeEffects.tsx
import React, { useEffect, useRef } from 'react';
import { useTheme } from '../state/theme-context';

interface Particle {
  x: number; y: number; speed: number; opacity: number; length: number;
}

function drawRain(ctx: CanvasRenderingContext2D, particles: Particle[], w: number, h: number, accent: string) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = accent + '40';
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
  for (const p of particles) {
    ctx.globalAlpha = p.opacity * 0.8;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    p.y -= p.speed;
    p.x += Math.sin(Date.now() * 0.001 + p.length) * 0.8;
    p.opacity -= 0.002;
    if (p.y < 0 || p.opacity <= 0) {
      p.y = h + 10; p.x = Math.random() * w;
      p.opacity = Math.random() * 0.5 + 0.2;
    }
  }
  ctx.globalAlpha = 1;
}

const PARTICLE_COUNT = 60;

export default function ThemeEffects() {
  const { activeTheme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);

  const preset = activeTheme?.effects?.particles ?? 'none';
  const accent = activeTheme?.tokens?.accent ?? '#888888';

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
    particlesRef.current = Array.from({ length: PARTICLE_COUNT }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      speed: Math.random() * 2 + 1,
      opacity: Math.random() * 0.4 + 0.1,
      length: Math.random() * 15 + 5,
    }));

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      if (preset === 'rain') drawRain(ctx, particlesRef.current, w, h, accent);
      else if (preset === 'dust') drawDust(ctx, particlesRef.current, w, h, accent);
      else if (preset === 'ember') drawEmber(ctx, particlesRef.current, w, h, accent);
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [preset, accent]);

  if (preset === 'none') return null;

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed', inset: 0, zIndex: 0,
        pointerEvents: 'none', opacity: 0.6,
      }}
      aria-hidden="true"
    />
  );
}
```

- [ ] **Step 2: Add ThemeEffects to App.tsx**

In `src/renderer/App.tsx`, import and render `<ThemeEffects />` as a sibling to `<ThemeBg />` inside the ThemeProvider wrapper:

```tsx
import ThemeEffects from './components/ThemeEffects';

// Inside App JSX, after <ThemeBg />:
<ThemeEffects />
```

- [ ] **Step 3: Test manually**

Add a tokyo-rain theme with `"particles": "rain"` to `~/.claude/destinclaude-themes/tokyo-rain.json` (update the effects block):

```json
"effects": { "particles": "rain", "vignette": 0.2 }
```

Save the file — the app should hot-reload and show subtle rain streaks.

- [ ] **Step 4: Commit**

```bash
cd $REPO_ROOT/desktop && git add src/renderer/components/ThemeEffects.tsx src/renderer/App.tsx && git commit -m "feat(themes): add particle effects canvas layer (rain, dust, ember)"
```

---

## Phase 2 — Manual Settings Editor

### Task 8: ThemeScreen — replace ThemeSelector in SettingsPanel

**Files:**
- Create: `src/renderer/components/ThemeScreen.tsx`
- Modify: `src/renderer/components/SettingsPanel.tsx` (replace `ThemeSelector` with `ThemeScreen`)

- [ ] **Step 1: Create ThemeScreen component**

```tsx
// src/renderer/components/ThemeScreen.tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../state/theme-context';
import type { LoadedTheme } from '../state/themes/theme-types';
import { computeOnAccent } from '../state/themes/theme-validator';

declare function queryLocalFonts(): Promise<{ family: string }[]>;

const FALLBACK_FONTS = [
  'Arial', 'Cascadia Mono', 'Cascadia Code', 'Consolas', 'Courier New',
  'Fira Code', 'Georgia', 'Helvetica', 'Inter', 'JetBrains Mono',
  'Menlo', 'Monaco', 'Roboto', 'Segoe UI', 'SF Mono',
  'Source Code Pro', 'System UI', 'Times New Roman', 'Verdana',
];

const PARTICLE_OPTIONS = ['none', 'rain', 'dust', 'ember', 'snow'] as const;
const BG_TYPE_OPTIONS = ['solid', 'gradient', 'image'] as const;

/** Converts 0–1 roundness value to the 4 radius CSS values. */
function roundnessToShape(value: number) {
  const sm   = Math.round(value * 8);
  const md   = Math.round(value * 16);
  const lg   = Math.round(value * 24);
  return { 'radius-sm': `${sm}px`, 'radius-md': `${md}px`, 'radius-lg': `${lg}px`, 'radius-full': '9999px' };
}

interface Props {
  onClose: () => void;
}

export default function ThemeScreen({ onClose }: Props) {
  const { allThemes, theme: activeSlug, setTheme, cycleList, setCycleList, font, setFont, activeTheme } = useTheme();
  const [fonts, setFonts] = useState<string[] | null>(null);
  const [fontSearch, setFontSearch] = useState('');
  const [view, setView] = useState<'grid' | 'fonts'>('grid');
  const searchRef = useRef<HTMLInputElement>(null);

  // Load system fonts
  useEffect(() => {
    if (fonts !== null) return;
    if (typeof queryLocalFonts === 'function') {
      queryLocalFonts()
        .then(f => { const s = new Set(f.map(x => x.family)); setFonts([...s].sort()); })
        .catch(() => setFonts(FALLBACK_FONTS));
    } else {
      setFonts(FALLBACK_FONTS);
    }
  }, [fonts]);

  useEffect(() => {
    if (view === 'fonts') setTimeout(() => searchRef.current?.focus(), 50);
  }, [view]);

  const currentFontName = font.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  const filteredFonts = (fonts ?? []).filter(f => f.toLowerCase().includes(fontSearch.toLowerCase()));

  const updateAccent = useCallback((hex: string) => {
    if (!activeTheme) return;
    const onAccent = computeOnAccent(hex);
    // Write updated theme file
    const updated = { ...activeTheme, tokens: { ...activeTheme.tokens, accent: hex, 'on-accent': onAccent } };
    (window as any).claude?.theme?.writeFile?.(activeTheme.slug, JSON.stringify(updated, null, 2));
  }, [activeTheme]);

  const updateRoundness = useCallback((value: number) => {
    if (!activeTheme) return;
    const shape = roundnessToShape(value);
    const updated = { ...activeTheme, shape };
    (window as any).claude?.theme?.writeFile?.(activeTheme.slug, JSON.stringify(updated, null, 2));
  }, [activeTheme]);

  const updateParticles = useCallback((preset: string) => {
    if (!activeTheme) return;
    const updated = { ...activeTheme, effects: { ...(activeTheme.effects ?? {}), particles: preset as any } };
    (window as any).claude?.theme?.writeFile?.(activeTheme.slug, JSON.stringify(updated, null, 2));
  }, [activeTheme]);

  const currentRoundness = (() => {
    const md = activeTheme?.shape?.['radius-md'];
    if (!md) return 0.5;
    return Math.min(parseInt(md) / 16, 1);
  })();

  if (view === 'fonts') {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-edge shrink-0">
          <button onClick={() => setView('grid')} className="text-fg-muted hover:text-fg-2">←</button>
          <input
            ref={searchRef}
            value={fontSearch}
            onChange={e => setFontSearch(e.target.value)}
            placeholder="Search fonts..."
            className="flex-1 bg-transparent text-xs text-fg outline-none"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredFonts.map(f => (
            <button
              key={f}
              onClick={() => { setFont(`'${f}', monospace`); setView('grid'); }}
              className={`w-full px-4 py-2 text-left text-xs hover:bg-inset transition-colors ${f === currentFontName ? 'text-fg font-medium' : 'text-fg-2'}`}
              style={{ fontFamily: `'${f}', monospace` }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
        <h2 className="text-sm font-bold text-fg">Themes</h2>
        <button onClick={onClose} className="text-fg-muted hover:text-fg-2 text-lg leading-none">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Theme grid */}
        <div>
          <p className="text-[9px] text-fg-faint uppercase tracking-wider mb-2">Your Themes</p>
          <div className="grid grid-cols-2 gap-2">
            {allThemes.map(t => {
              const isActive = t.slug === activeSlug;
              const inCycle = cycleList.includes(t.slug);
              const bg = t.tokens.canvas;
              const accent = t.tokens.accent;
              return (
                <button
                  key={t.slug}
                  onClick={() => setTheme(t.slug)}
                  className={`relative rounded-lg overflow-hidden border text-left transition-colors ${isActive ? 'border-accent' : 'border-edge-dim hover:border-edge'}`}
                >
                  <div style={{ height: 6, background: `linear-gradient(90deg, ${bg}, ${accent})` }} />
                  <div className="px-2 py-1.5" style={{ background: bg }}>
                    <p className="text-[10px] font-medium truncate" style={{ color: t.tokens.fg }}>{t.name}</p>
                    {isActive && <span className="text-[8px]" style={{ color: accent }}>active</span>}
                  </div>
                  {/* Cycle toggle */}
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      setCycleList(inCycle
                        ? cycleList.filter(s => s !== t.slug).filter(Boolean).length > 0 ? cycleList.filter(s => s !== t.slug) : cycleList
                        : [...cycleList, t.slug]
                      );
                    }}
                    className="absolute top-1 right-1 w-4 h-4 rounded border flex items-center justify-center"
                    style={{ background: inCycle ? accent : 'transparent', borderColor: inCycle ? accent : '#555' }}
                    title={inCycle ? 'Remove from cycle' : 'Add to cycle'}
                  >
                    {inCycle && <span style={{ color: t.tokens['on-accent'], fontSize: 8 }}>✓</span>}
                  </button>
                </button>
              );
            })}
          </div>
        </div>

        {/* Edit active theme — only shown for user themes */}
        {activeTheme && activeTheme.source === 'user' && (
          <div>
            <p className="text-[9px] text-fg-faint uppercase tracking-wider mb-2">Edit: {activeTheme.name}</p>
            <div className="space-y-3">
              {/* Accent */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-fg-2">Accent</span>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={activeTheme.tokens.accent}
                    onChange={e => updateAccent(e.target.value)}
                    className="w-6 h-6 rounded cursor-pointer border-0 bg-transparent"
                  />
                  <span className="text-[10px] text-fg-muted font-mono">{activeTheme.tokens.accent}</span>
                </div>
              </div>
              {/* Roundness */}
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-fg-2">Roundness</span>
                <div className="flex items-center gap-2 flex-1">
                  <span className="text-[10px] text-fg-faint">□</span>
                  <input
                    type="range" min="0" max="1" step="0.05"
                    value={currentRoundness}
                    onChange={e => updateRoundness(parseFloat(e.target.value))}
                    className="flex-1 accent-accent"
                  />
                  <span className="text-[10px] text-fg-faint">◯</span>
                </div>
              </div>
              {/* Particles */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-fg-2">Particles</span>
                <select
                  value={activeTheme.effects?.particles ?? 'none'}
                  onChange={e => updateParticles(e.target.value)}
                  className="bg-inset text-fg-2 text-[10px] rounded border border-edge-dim px-2 py-0.5"
                >
                  {PARTICLE_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Font */}
        <div>
          <p className="text-[9px] text-fg-faint uppercase tracking-wider mb-2">Font</p>
          <button
            onClick={() => setView('fonts')}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-edge-dim hover:border-edge transition-colors"
          >
            <span className="text-xs text-fg-2" style={{ fontFamily: font }}>{currentFontName}</span>
            <span className="text-fg-muted text-xs">›</span>
          </button>
        </div>

        {/* Build with Claude */}
        <button
          onClick={() => {
            (window as any).claude?.session?.sendInput?.('/theme-builder ');
            onClose();
          }}
          className="w-full py-2 rounded-lg border border-accent/30 bg-accent/10 text-accent text-xs font-medium hover:bg-accent/20 transition-colors"
        >
          ✦ Build New Theme with Claude
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add theme:writeFile IPC**

In `src/shared/types.ts`:
```typescript
  THEME_WRITE_FILE: 'theme:write-file',
```

In `src/main/preload.ts` inlined const:
```typescript
  THEME_WRITE_FILE: 'theme:write-file',
```

In `src/main/preload.ts` contextBridge theme section:
```typescript
    writeFile: (slug: string, content: string) => ipcRenderer.invoke(IPC.THEME_WRITE_FILE, slug, content),
```

In `src/main/ipc-handlers.ts`:
```typescript
  ipcMain.handle(IPC.THEME_WRITE_FILE, async (_event, slug: string, content: string) => {
    const { userThemePath } = await import('./theme-watcher');
    await fs.promises.writeFile(userThemePath(slug), content, 'utf-8');
  });
```

- [ ] **Step 3: Replace ThemeSelector in SettingsPanel.tsx**

In `src/renderer/components/SettingsPanel.tsx`:

1. Add the import:
```tsx
import ThemeScreen from './ThemeScreen';
```

2. Find the `ThemeSelector` component usage inside `DesktopSettings` and `AndroidSettings`. Replace the `<ThemeSelector />` call with:
```tsx
<ThemeScreen onClose={onClose} />
```

3. Delete the entire `ThemeSelector` function (it's no longer used). It starts at `function ThemeSelector()` and spans to its closing `}`.

- [ ] **Step 4: Run dev server and test**

```bash
cd $REPO_ROOT/desktop && npm run dev
```

1. Open settings — should show the new theme grid.
2. All themes visible. Built-in themes show color bars.
3. Cycle toggles work on each card.
4. Tokyo Rain (user theme): accent color picker changes and hot-reloads. Roundness slider changes and hot-reloads.
5. "Build New Theme with Claude" button opens a session with `/theme-builder `.
6. Font picker opens font list, selecting changes the app font.

- [ ] **Step 5: Commit**

```bash
cd $REPO_ROOT/desktop && git add src/renderer/components/ThemeScreen.tsx src/renderer/components/SettingsPanel.tsx src/shared/types.ts src/main/preload.ts src/main/ipc-handlers.ts && git commit -m "feat(themes): add ThemeScreen manual editor in settings panel"
```

---

## Phase 3 — The Skill

### Task 9: /theme-builder Claude skill

**Files:**
- Create: `~/.claude/skills/theme-builder/theme-builder.md`

The skill uses the existing brainstorming visual companion server infrastructure (already installed at `~/.claude/plugins/.../skills/brainstorming/scripts/start-server.sh`) to render concept cards in Phase 1.

- [ ] **Step 1: Create the skill directory and file**

```bash
mkdir -p ~/.claude/skills/theme-builder
```

- [ ] **Step 2: Write the skill**

```markdown
---
name: theme-builder
description: Build custom DestinCode themes. Invoke as /theme-builder "your vibe description". Two-phase: concept browser first, then full theme generation into the app.
---

# /theme-builder

Build a custom DestinCode theme. Claude generates concept options in a browser window first — no app changes — then implements the chosen theme as a hot-reloading JSON file.

## Phase 1 — Concept Browser

**When the user invokes this skill:**

1. Start the visual companion server:
   ```bash
   bash "~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/brainstorming/scripts/start-server.sh" --project-dir ~/.claude/destinclaude-themes
   ```
   Use `run_in_background: true`. Then read the `server-info` file after 3 seconds.

2. Generate 3 theme concepts based on the user's prompt. Each concept is just a name, palette, and vibe — NOT a full theme.json yet.

3. Render them as concept cards using the visual companion (write an HTML file to `screen_dir`). Use this card template for each theme:
   - A mini app preview (header bar div + chat area div + input div) using the theme's colors
   - Theme name + 4-5 color swatches
   - 1-sentence vibe description
   - Label the layout/effects you plan (e.g., "floating input · rain particles · glassmorphism")

4. Tell the user the URL and ask them to look while iterating in chat.

**Iteration loop:** User requests changes → re-render in the browser. Loop until the user says "go with [option]", "build [name]", or "apply [number]".

## Phase 2 — Full Theme Generation

**When the user picks a concept:**

1. Generate the complete theme JSON matching this schema exactly:

```json
{
  "name": "string — display name",
  "slug": "kebab-case-slug — used as filename and data-theme",
  "dark": true,
  "author": "claude",
  "created": "YYYY-MM-DD",
  "tokens": {
    "canvas": "#hex", "panel": "#hex", "inset": "#hex", "well": "#hex",
    "accent": "#hex", "on-accent": "#hex (white if accent dark, black if light)",
    "fg": "#hex", "fg-2": "#hex", "fg-dim": "#hex",
    "fg-muted": "#hex", "fg-faint": "#hex",
    "edge": "#hex", "edge-dim": "#hex80 (add 50% alpha)",
    "scrollbar-thumb": "#hex", "scrollbar-hover": "#hex"
  },
  "shape": {
    "radius-sm": "Npx", "radius-md": "Npx", "radius-lg": "Npx", "radius-full": "9999px"
  },
  "background": {
    "type": "solid | gradient | image",
    "value": "color or gradient or url",
    "opacity": 1,
    "panels-blur": 0,
    "panels-opacity": 1.0
  },
  "layout": {
    "input-style": "default | floating | minimal | terminal",
    "bubble-style": "default | pill | flat | bordered",
    "header-style": "default | minimal | hidden",
    "statusbar-style": "default | minimal | floating"
  },
  "effects": {
    "particles": "none | rain | dust | ember | snow",
    "scan-lines": false,
    "vignette": 0,
    "noise": 0
  },
  "custom_css": ""
}
```

Token design rules:
- `panel` should be slightly lighter/different from `canvas`
- `inset` is slightly lighter/different from `panel`
- `fg` through `fg-faint` form a descending opacity/contrast scale
- `on-accent`: use `#FFFFFF` if accent luminance < 0.4, else `#000000`
- For glassmorphism: set `panels-blur: 8-16`, `panels-opacity: 0.6-0.85`, and ensure `canvas` has a visible gradient/image

2. Write the file to `~/.claude/destinclaude-themes/<slug>.json` using the Write tool.

3. Tell the user: "**[Theme Name]** is live in the app now. The app has hot-reloaded. What would you like to change?"

## Phase 3 — In-App Refinement

After the file is written, every refinement the user requests goes directly to the JSON file. Edit the specific field, write the updated file. The app hot-reloads automatically.

Common refinements:
- "More X color" → adjust `tokens.accent` or relevant token
- "Rounder edges" → increase `shape.radius-*` values
- "More glassmorphism" → increase `background.panels-blur`, set `panels-opacity: 0.7`
- "Add rain particles" → set `effects.particles: "rain"`
- "Custom effect" → write CSS to `custom_css` field

## Rules

- NEVER modify files in `src/renderer/themes/builtin/` — those are built-in themes
- NEVER write to any path inside the app bundle (`desktop/src/`)
- Always validate that `slug` is kebab-case with no spaces
- If the user gives you a theme name with spaces, auto-convert: "Tokyo Rain" → "tokyo-rain"
- Use `custom_css` for effects the schema doesn't cover (CSS animations, ::before overlays, etc.)
```

- [ ] **Step 3: Verify the skill is discovered**

```bash
ls ~/.claude/skills/theme-builder/
```

Expected: `theme-builder.md`

The skill will appear in the settings skill list. Test by running `/theme-builder "cozy warm coffee shop, amber tones, soft glow"` in a Claude chat session.

- [ ] **Step 4: Commit**

```bash
git -C ~/.claude add skills/theme-builder/theme-builder.md && git -C ~/.claude commit -m "feat: add /theme-builder skill"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| JSON theme format with all 6 sections | Task 1 (types), Task 2 (builtin JSON) |
| ThemeEngine CSS application | Task 4 |
| fs.watch hot-reload | Task 5 |
| Built-in themes migrated to JSON | Task 2 |
| Background layer + glassmorphism | Task 3 (CSS), Task 6 (ThemeEngine wire) |
| Layout preset data attributes | Task 3 (CSS), Task 4 (buildLayoutAttrs) |
| Particle effects | Task 7 |
| custom_css injection | Task 4 (applyThemeToDom) |
| IPC channels (theme:reload, theme:list, theme:read-file, theme:write-file) | Task 5, Task 6, Task 8 |
| Settings manual editor (accent, roundness, particles, font, cycle) | Task 8 |
| /theme-builder skill: Phase 1 concept browser | Task 9 |
| /theme-builder skill: Phase 2 full generation | Task 9 |
| /theme-builder skill: Phase 3 in-app refinement | Task 9 |
| "Build with Claude" button in settings | Task 8 |

**Placeholder scan:** None found. All steps contain actual code or exact commands.

**Type consistency:**
- `ThemeDefinition` defined in Task 1, used in Tasks 4, 6, 7, 8 ✓
- `LoadedTheme` (extends ThemeDefinition + source) defined in Task 1, used in Tasks 6, 8 ✓
- `buildTokenCSS`, `buildShapeCSS`, `buildBackgroundStyle`, `buildLayoutAttrs`, `applyThemeToDom` defined in Task 4, imported in Task 6 ✓
- `validateTheme`, `computeOnAccent` defined in Task 1, imported in Tasks 6, 8 ✓
- IPC channels `THEME_RELOAD`, `THEME_LIST`, `THEME_READ_FILE`, `THEME_WRITE_FILE` defined in Task 5, used in Tasks 6, 8 ✓
- `startThemeWatcher`, `listUserThemes`, `userThemePath` defined in Task 5 (`theme-watcher.ts`), used in Task 5 (`ipc-handlers.ts`) ✓
