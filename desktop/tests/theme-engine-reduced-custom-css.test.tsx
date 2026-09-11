// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyThemeToDom } from '../src/renderer/themes/theme-engine';

// WHY: tests/theme-engine.test.ts is a pure-function suite with no DOM: it can't
// assert on injected <style> elements. This file exercises applyThemeToDom's
// DOM side effects directly (jsdom environment), mirroring the minimal theme
// shape from theme-validator.test.ts's "accepts a minimal valid theme" case.
const minimalTheme = {
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

// WHY (test-suite-hygiene.md "Unmount what you render" + style-element leakage):
// applyThemeToDom creates/reuses singleton <style> elements by id, so a case that
// doesn't reset document.head would see the PREVIOUS case's elements/content.
beforeEach(() => {
  document.head.innerHTML = '';
});

describe('Reduced Effects neutralises theme-injected animation', () => {
  const theme = { ...minimalTheme, custom_css: `
    .header-bar { animation: theme-glow 2s linear infinite; }
    @media (min-width: 1px) { .assistant-bubble { animation-name: theme-bob; animation-duration: 3s; } }
    .input-bar-container { color: red; }
    @keyframes theme-glow { to { opacity: .5 } }` };

  it('emits an animation:none override for every selector the theme animates', () => {
    applyThemeToDom(theme as any, true);
    const css = document.getElementById('theme-custom-reduced')!.textContent!;
    expect(css).toContain('.header-bar { animation: none !important; }');
    expect(css).toContain('.assistant-bubble { animation: none !important; }');
    expect(css).not.toContain('.input-bar-container');
  });

  it('is empty when Reduced Effects is off, and the theme CSS is untouched', () => {
    applyThemeToDom(theme as any, false);
    expect(document.getElementById('theme-custom-reduced')!.textContent).toBe('');
    expect(document.getElementById('theme-custom')!.textContent).toContain('theme-glow 2s linear infinite');
  });

  it('survives a theme with no custom_css', () => {
    applyThemeToDom({ ...minimalTheme, custom_css: undefined } as any, true);
    expect(document.getElementById('theme-custom-reduced')?.textContent ?? '').toBe('');
  });

  // WHY (controller decision 2): #theme-custom is only created lazily, on the
  // first apply that HAS custom_css. If an earlier apply had none, the reduced
  // sheet gets created first and inserted at the end of <head> (nothing to sit
  // after yet) — a later apply that adds custom_css must then MOVE the reduced
  // sheet so it still sits immediately after #theme-custom, or the override
  // would silently lose to the theme's own rules of equal specificity.
  it('keeps #theme-custom-reduced immediately after #theme-custom across theme sequences', () => {
    applyThemeToDom({ ...minimalTheme, custom_css: undefined } as any, true);
    applyThemeToDom(theme as any, true);
    const customEl = document.getElementById('theme-custom');
    const reducedEl = document.getElementById('theme-custom-reduced');
    expect(reducedEl).not.toBeNull();
    expect(document.head.contains(reducedEl)).toBe(true);
    expect(reducedEl!.previousElementSibling).toBe(customEl);
  });

  // WHY (controller decision 4): sanitizeCSS does not strip vendor prefixes, so
  // a community theme is free to ship -webkit-animation / -webkit-animation-name
  // (Golden Sunbreak already ships other -webkit- properties in custom_css). The
  // unprefixed-only regex would silently miss these under Reduced Effects.
  it('also catches -webkit-animation and -webkit-animation-name', () => {
    const webkitTheme = { ...minimalTheme, custom_css: `
      .legacy-badge { -webkit-animation: theme-spin 1s linear infinite; }
      .legacy-glow { -webkit-animation-name: theme-glow; -webkit-animation-duration: 2s; }` };
    applyThemeToDom(webkitTheme as any, true);
    const css = document.getElementById('theme-custom-reduced')!.textContent!;
    expect(css).toContain('.legacy-badge { animation: none !important; }');
    expect(css).toContain('.legacy-glow { animation: none !important; }');
  });
});
