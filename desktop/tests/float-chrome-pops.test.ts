// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyThemeToDom } from '../src/renderer/themes/theme-engine';

// The 'float' chrome style (styles/float-chrome.css) is a NEW option a theme can
// select. Destin's requirement for shipping it (2026-09-23): "our changes should
// only be noticeable if/when a user selects this new minimal chrome style." These
// tests pin that isolation as behaviour; how it looks is judged by screenshot review.

const TOKENS = {
  canvas: '#0D1117', panel: '#161B22', inset: '#21262D', well: '#0D1117',
  accent: '#B1BAC4', 'on-accent': '#0D1117',
  fg: '#E6EDF3', 'fg-2': '#C9D1D9', 'fg-dim': '#8B949E',
  'fg-muted': '#6E7681', 'fg-faint': '#484F58',
  edge: '#343A41', 'edge-dim': '#3F454C80',
  'scrollbar-thumb': '#30363D', 'scrollbar-hover': '#484F58',
};

const wallpaper = {
  type: 'image' as const,
  value: 'assets/wallpaper.jpg',
  'panels-blur': 22,
  'panels-opacity': 0.58,
};

const theme = (layout: Record<string, string>) => ({
  name: 'Float Test', slug: 'float-test', dark: true,
  tokens: TOKENS, layout, background: wallpaper,
});

beforeEach(() => { document.head.innerHTML = ''; document.body.removeAttribute('data-chrome-style'); });

describe('float chrome never reaches another chrome style', () => {
  it('sets no float attribute on a theme that does not select it', () => {
    applyThemeToDom(theme({ 'chrome-style': 'default', 'input-style': 'floating' }) as any, false);
    expect(document.body.getAttribute('data-chrome-style')).toBe('default');
    for (const attr of ['data-veil', 'data-pop', 'data-header-lens']) expect(document.body.hasAttribute(attr)).toBe(false);
  });

  it('sets data-chrome-style=float when a theme selects it', () => {
    applyThemeToDom(theme({ 'chrome-style': 'float' }) as any, false);
    expect(document.body.getAttribute('data-chrome-style')).toBe('float');
  });
});

describe('the float look respects effect settings', () => {
  it('drops all float frost under Reduced effects or a zero blur, like every other glass surface', () => {
    const frost = () => [...document.head.querySelectorAll('style')].map(el => el.textContent ?? '').join('\n')
      .includes("[data-chrome-style='float'] .input-bar-container form");
    applyThemeToDom(theme({ 'chrome-style': 'float' }) as any, false);
    expect(frost()).toBe(true);
    applyThemeToDom(theme({ 'chrome-style': 'float' }) as any, true);
    expect(frost()).toBe(false);
    applyThemeToDom({ ...theme({ 'chrome-style': 'float' }), background: { ...wallpaper, 'panels-blur': 0 } } as any, false);
    expect(frost()).toBe(false);
  });
});
