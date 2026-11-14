// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSource } from './helpers/guard-scope';
import { BRAND_BASE, computeBrandTokens, applyThemeToDom } from '../src/renderer/themes/theme-engine';

// Card #135 / deck C-8: brand colours are adjusted per theme at runtime so they
// read at 4.5:1. Built-in themes must not move; adjusted ones must pass.
const css = readSource(resolve(__dirname, '..', 'src', 'renderer', 'styles', 'globals.css'));

function lum(hex: string) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
function block(selector: string) {
  const start = css.indexOf(selector);
  return css.slice(start, css.indexOf('\n}', start));
}
const cssBrand = (sel: string) =>
  Object.fromEntries([...block(sel).matchAll(/--brand-([a-z]+):\s*(#[0-9A-Fa-f]{6});/g)].map((m) => [m[1], m[2].toUpperCase()]));
const token = (sel: string, name: string) => block(sel).match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))![1];

describe('brand colour adjustment', () => {
  it('keeps the engine tables identical to globals.css', () => {
    expect(BRAND_BASE.light).toEqual(cssBrand('[data-theme-mode="light"] {'));
    expect(BRAND_BASE.dark).toEqual(cssBrand('[data-theme-mode="dark"] {'));
  });

  const TOKENS = (canvas: string, panel: string) => ({
    canvas, panel, inset: panel, well: canvas, accent: '#7C6AF7', 'on-accent': '#FFFFFF',
    fg: '#222222', 'fg-2': '#444444', 'fg-dim': '#666666', 'fg-muted': '#888888', 'fg-faint': '#AAAAAA',
    edge: '#999999', 'edge-dim': '#99999980', 'scrollbar-thumb': '#999999', 'scrollbar-hover': '#777777',
  });
  const pale = (source: string) => ({ name: 'T', slug: 't', dark: false, source, tokens: TOKENS('#E8DDF3', '#D4C5E6') }) as any;

  it('paints the adjusted colour on a community theme and leaves built-ins on their CSS values', () => {
    const root = document.documentElement;
    applyThemeToDom(pale('community'));
    const adjusted = root.style.getPropertyValue('--brand-claude');
    expect(adjusted).not.toBe('');
    expect(adjusted.toUpperCase()).not.toBe('#C2410C');
    // Switching to a built-in must clear it so Light/Creme keep exactly the values they had.
    applyThemeToDom(pale('youcoded-core'));
    expect(root.style.getPropertyValue('--brand-claude')).toBe('');
  });

  it('darkens Claude orange on Kuromi Dreamer to a readable shade, still orange', () => {
    const panel = '#D4C5E6';
    const out = computeBrandTokens({ canvas: '#E8DDF3', panel }, false);
    expect(ratio(out['--brand-claude'], panel)).toBeGreaterThanOrEqual(4.5);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(out['--brand-claude'].slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('never throws on missing, invalid or 3-digit surface colours', () => {
    const base = BRAND_BASE.light;
    for (const bad of [undefined, null, '', 'red', 'rgb(1,2,3)', '#12', '#GGGGGG', 42, '#1234567', '#123456789']) {
      const out = computeBrandTokens({ canvas: bad as any, panel: '#D4C5E6' }, false);
      expect(out['--brand-claude']).toBe(base.claude);
      expect(() => computeBrandTokens({ canvas: '#FFFFFF', panel: bad as any }, false)).not.toThrow();
    }
    expect(() => computeBrandTokens(undefined as any, true)).not.toThrow();
    // An 8-digit #RRGGBBAA surface is read by its first six digits.
    expect(computeBrandTokens({ canvas: '#FFFFFF', panel: '#D4C5E680' }, false)).toEqual(computeBrandTokens({ canvas: '#FFFFFF', panel: '#D4C5E6' }, false));
    // A 3-digit hex is understood, not rejected: "#dcf" is the same pale panel as "#DDCCFF".
    expect(computeBrandTokens({ canvas: '#fff', panel: '#dcf' }, false)).toEqual(computeBrandTokens({ canvas: '#FFFFFF', panel: '#DDCCFF' }, false));
  });

  it('lightens colours on a dark theme that is too dim for them', () => {
    const panel = '#101018';
    const out = computeBrandTokens({ canvas: '#000000', panel }, true);
    for (const v of Object.values(out)) expect(ratio(v, panel)).toBeGreaterThanOrEqual(4.5);
  });

  it('clears 4.5:1 for every published community theme (when the sibling checkout exists)', (ctx) => {
    // The sibling wecoded-themes checkout: beside youcoded/ in the workspace, or at the workspace root when run from a session worktree.
    const candidates = [
      resolve(__dirname, '..', '..', '..', 'wecoded-themes', 'themes'),
      resolve(__dirname, '..', '..', '..', '..', '..', '..', 'wecoded-themes', 'themes'),
    ];
    const dir = candidates.find((d) => existsSync(d));
    if (!dir) { ctx.skip(); return; } // skipped with a visible reason, not silently passed: no wecoded-themes checkout beside this one
    let checked = 0;
    for (const slug of readdirSync(dir)) {
      const f = join(dir, slug, 'manifest.json');
      if (!existsSync(f)) continue;
      const m = JSON.parse(readSource(f));
      if (typeof m.tokens?.panel !== 'string' || !m.tokens.panel.startsWith('#')) continue;
      const out = computeBrandTokens(m.tokens, !!m.dark);
      for (const [k, v] of Object.entries(out)) expect(ratio(v, m.tokens.panel), `${slug} ${k}`).toBeGreaterThanOrEqual(4.5);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
