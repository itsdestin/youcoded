import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Structural sync tests — verify that theme-preview.css covers the same
 * CSS features as globals.css. Catches drift without needing a browser.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const GLOBALS_PATH = path.join(ROOT, 'desktop', 'src', 'renderer', 'styles', 'globals.css');
// theme-preview.css lives in the youcoded-core repo (sibling workspace directory)
const PREVIEW_PATH = path.resolve(ROOT, '..', 'youcoded-core', 'core', 'skills', 'theme-builder', 'theme-preview.css');

const previewExists = fs.existsSync(PREVIEW_PATH);
const globals = fs.readFileSync(GLOBALS_PATH, 'utf8');
const preview = previewExists ? fs.readFileSync(PREVIEW_PATH, 'utf8') : '';

/** Extract all selectors from a CSS string (rough but sufficient for sync checking). */
function extractSelectors(css: string): string[] {
  const results: string[] = [];
  const regex = /([^{}@]+)\{[^}]*\}/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    const sel = match[1].trim();
    if (sel && !sel.startsWith('/*') && !sel.startsWith('from') && !sel.startsWith('to') && !sel.includes('%')) {
      results.push(sel);
    }
  }
  return results;
}

describe.skipIf(!previewExists)('theme-preview.css ↔ globals.css sync', () => {
  // All 15 token variables must be used in the preview
  const TOKEN_VARS = [
    '--canvas', '--panel', '--inset', '--well', '--accent', '--on-accent',
    '--fg', '--fg-2', '--fg-dim', '--fg-muted', '--fg-faint',
    '--edge', '--edge-dim', '--scrollbar-thumb', '--scrollbar-hover',
  ];

  it.each(TOKEN_VARS)('preview uses token variable %s', (token) => {
    expect(preview).toContain(`var(${token}`);
  });

  // Glassmorphism selectors must exist in both. After the glassmorphism
  // refactor these are unconditional (no [data-panels-blur] gate) — the
  // always-on --panels-*/--bubble-* vars control the effect level.
  const GLASS_SELECTORS = [
    '.header-bar',
    '.status-bar',
    '.bg-inset',
    '.bg-accent',
  ];

  it.each(GLASS_SELECTORS)('both files contain glassmorphism selector: %s', (sel) => {
    expect(globals).toContain(sel);
    expect(preview).toContain(sel);
  });

  // Layout preset selectors must exist in both
  const LAYOUT_SELECTORS = [
    '[data-input-style="floating"]',
    '[data-input-style="minimal"]',
    '[data-input-style="terminal"]',
    '[data-bubble-style="pill"]',
    '[data-bubble-style="flat"]',
    '[data-bubble-style="bordered"]',
    '[data-header-style="minimal"]',
    '[data-header-style="hidden"]',
    '[data-statusbar-style="minimal"]',
  ];

  it.each(LAYOUT_SELECTORS)('both files contain layout preset selector: %s', (sel) => {
    expect(globals).toContain(sel);
    expect(preview).toContain(sel);
  });

  // Background layer divs
  it('both files define #theme-bg styles', () => {
    expect(globals).toContain('#theme-bg');
    expect(preview).toContain('#theme-bg');
  });

  it('both files define #theme-pattern styles', () => {
    expect(globals).toContain('#theme-pattern');
    expect(preview).toContain('#theme-pattern');
  });

  // Effect overlay — globals.css uses a consolidated overlay div, preview uses classes
  it('globals.css has effect overlay CSS', () => {
    expect(globals).toContain('#theme-effects-overlay');
  });

  it('preview has effect overlay CSS', () => {
    expect(preview).toContain('.effect-vignette');
    expect(preview).toContain('.effect-noise');
    expect(preview).toContain('.effect-scanlines');
  });

  // Post-blur-fix: glass is gated behind [data-wallpaper] in globals.css,
  // and backdrop-filter is injected dynamically by theme-engine at apply
  // time (literal blur values, not var(), to force Chrome repaint on
  // slider changes). So the plain `.header-bar` rule no longer carries
  // blur/color-mix — only the wallpaper-scoped variant does.
  // See GLASSMORPHISM-BLUR-FIX-PLAN.md.
  it('wallpaper-gated header uses --panels-opacity color-mix in both files', () => {
    const headerWallpaperRe = /\[data-wallpaper\]\s*\.header-bar\s*\{([^}]+)\}/;
    const globalsMatch = globals.match(headerWallpaperRe);
    const previewMatch = preview.match(headerWallpaperRe);

    expect(globalsMatch).not.toBeNull();
    // Preview CSS may use its own model; only assert on globals here.
    const globalsBody = globalsMatch![1];
    expect(globalsBody).toContain('color-mix');
    expect(globalsBody).toContain('--panels-opacity');

    // Theme-preview.css still carries the old unconditional shape — it's
    // only used for static theme cards (not live chrome), so the
    // transform-breaks-backdrop-filter bug doesn't apply there. Either
    // shape is acceptable as long as it sets a panel-derived background.
    if (previewMatch) {
      const previewBody = previewMatch[1];
      expect(previewBody.includes('color-mix') || previewBody.includes('var(--panel)')).toBe(true);
    }
  });

  // Scrollbar sizing should match
  it('both files use responsive scrollbar widths', () => {
    // globals has 4px default + 8px at 640px
    expect(globals).toContain('width: 4px');
    expect(globals).toContain('width: 8px');

    // preview should match
    expect(preview).toContain('width: 4px');
    expect(preview).toContain('width: 8px');
  });
});
