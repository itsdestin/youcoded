import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Structural sync tests — verify that theme-preview.css covers the same
 * CSS features as globals.css. Catches drift without needing a browser.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const GLOBALS_PATH = path.join(ROOT, 'desktop', 'src', 'renderer', 'styles', 'globals.css');
// theme-preview.css lives in the destinclaude repo (sibling workspace directory)
const PREVIEW_PATH = path.resolve(ROOT, '..', 'destinclaude', 'core', 'skills', 'theme-builder', 'theme-preview.css');

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

  // Key CSS properties that must be present in the glassmorphism rules.
  // Post-refactor: the .header-bar rule is unconditional and reads
  // --panels-blur / --panels-opacity directly (defaults 0px / 1).
  it('glassmorphism header has blur + saturate in both files', () => {
    const globalsHeaderMatch = globals.match(/\n\.header-bar\s*\{([^}]+)\}/);
    const previewHeaderMatch = preview.match(/\n\.header-bar\s*\{([^}]+)\}/);

    expect(globalsHeaderMatch).not.toBeNull();
    expect(previewHeaderMatch).not.toBeNull();

    const globalsBody = globalsHeaderMatch![1];
    const previewBody = previewHeaderMatch![1];

    // Both should read --panels-blur with 0px default and saturate(1.2)
    expect(globalsBody).toContain('blur(var(--panels-blur, 0px))');
    expect(previewBody).toContain('blur(var(--panels-blur, 0px))');
    expect(globalsBody).toContain('saturate(1.2)');
    expect(previewBody).toContain('saturate(1.2)');

    // Both should use color-mix with --panels-opacity
    expect(globalsBody).toContain('color-mix');
    expect(previewBody).toContain('color-mix');
    expect(globalsBody).toContain('--panels-opacity');
    expect(previewBody).toContain('--panels-opacity');
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
