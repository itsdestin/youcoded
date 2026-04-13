import { describe, it, expect } from 'vitest';
import { buildDefaultIconSvg } from '../src/renderer/themes/theme-default-icon';
import type { ThemeTokens } from '../src/renderer/themes/theme-types';

const TOKENS: ThemeTokens = {
  canvas: '#111111',
  panel: '#191919',
  inset: '#222222',
  well: '#1C1C1C',
  accent: '#D4D4D4',
  'on-accent': '#111111',
  fg: '#E0E0E0',
  'fg-2': '#B0B0B0',
  'fg-dim': '#999999',
  'fg-muted': '#666666',
  'fg-faint': '#444444',
  edge: '#2E2E2E',
  'edge-dim': '#37373780',
  'scrollbar-thumb': '#333333',
  'scrollbar-hover': '#555555',
};

describe('buildDefaultIconSvg', () => {
  it('emits a 256×256 SVG using the theme canvas as background', () => {
    const svg = buildDefaultIconSvg(TOKENS);
    expect(svg).toMatch(/width="256" height="256"/);
    expect(svg).toContain('fill="#111111"'); // canvas
  });

  it('tints the chevron and cursor with the accent token', () => {
    const svg = buildDefaultIconSvg(TOKENS);
    // accent appears at least twice — chevron path + cursor rect
    const matches = svg.match(/#D4D4D4/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('uses fg for the primary letter and fg-2 for the secondary letter', () => {
    const svg = buildDefaultIconSvg(TOKENS);
    expect(svg).toContain('#E0E0E0'); // fg (D)
    expect(svg).toContain('#B0B0B0'); // fg-2 (C)
  });

  it('produces different output for different themes', () => {
    const lightTokens: ThemeTokens = { ...TOKENS, canvas: '#F2F2F2', fg: '#1A1A1A', accent: '#1A1A1A' };
    const a = buildDefaultIconSvg(TOKENS);
    const b = buildDefaultIconSvg(lightTokens);
    expect(a).not.toBe(b);
  });
});
