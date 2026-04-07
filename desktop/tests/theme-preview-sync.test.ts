import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Structural sync tests — verify that theme-preview.css covers the same
 * CSS features as globals.css. Catches drift without needing a browser.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const GLOBALS_PATH = path.join(ROOT, 'desktop', 'src', 'renderer', 'styles', 'globals.css');
const PREVIEW_PATH = path.join(ROOT, 'core', 'skills', 'theme-builder', 'theme-preview.css');

const globals = fs.readFileSync(GLOBALS_PATH, 'utf8');
const preview = fs.readFileSync(PREVIEW_PATH, 'utf8');

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

describe('theme-preview.css ↔ globals.css sync', () => {
  // All 15 token variables must be used in the preview
  const TOKEN_VARS = [
    '--canvas', '--panel', '--inset', '--well', '--accent', '--on-accent',
    '--fg', '--fg-2', '--fg-dim', '--fg-muted', '--fg-faint',
    '--edge', '--edge-dim', '--scrollbar-thumb', '--scrollbar-hover',
  ];

  it.each(TOKEN_VARS)('preview uses token variable %s', (token) => {
    expect(preview).toContain(`var(${token}`);
  });

  // Glassmorphism selectors must exist in both
  const GLASS_SELECTORS = [
    '[data-panels-blur] .header-bar',
    '[data-panels-blur] .status-bar',
    '[data-panels-blur] .bg-inset',
    '[data-panels-blur] .bg-accent',
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
    '[data-statusbar-style="floating"]',
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

  // Effect overlay selectors — globals.css uses IDs, preview uses classes
  it('globals.css has effect overlay CSS', () => {
    expect(globals).toContain('#effect-vignette');
    expect(globals).toContain('#effect-noise');
    expect(globals).toContain('#effect-scanlines');
  });

  it('preview has effect overlay CSS', () => {
    expect(preview).toContain('.effect-vignette');
    expect(preview).toContain('.effect-noise');
    expect(preview).toContain('.effect-scanlines');
  });

  // Key CSS properties that must be present in the glassmorphism rules
  it('glassmorphism header has blur + saturate in both files', () => {
    // Extract the header-bar glass rule content from both
    const globalsHeaderMatch = globals.match(/\[data-panels-blur\]\s+\.header-bar\s*\{([^}]+)\}/);
    const previewHeaderMatch = preview.match(/\[data-panels-blur\]\s+\.header-bar\s*\{([^}]+)\}/);

    expect(globalsHeaderMatch).not.toBeNull();
    expect(previewHeaderMatch).not.toBeNull();

    const globalsBody = globalsHeaderMatch![1];
    const previewBody = previewHeaderMatch![1];

    // Both should have blur(24px) and saturate(1.2)
    expect(globalsBody).toContain('blur(24px)');
    expect(previewBody).toContain('blur(24px)');
    expect(globalsBody).toContain('saturate(1.2)');
    expect(previewBody).toContain('saturate(1.2)');

    // Both should use color-mix for transparency
    expect(globalsBody).toContain('color-mix');
    expect(previewBody).toContain('color-mix');
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
