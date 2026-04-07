import { describe, it, expect } from 'vitest';
import { buildTokenCSS, buildShapeCSS, buildBackgroundStyle, buildLayoutAttrs, buildPatternStyle } from '../src/renderer/themes/theme-engine';

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

  it('skips empty string values and includes non-empty values', () => {
    const result = buildShapeCSS({ 'radius-sm': '', 'radius-md': '4px' });
    expect('--radius-sm' in result).toBe(false);
    expect(result['--radius-md']).toBe('4px');
  });
});

describe('buildBackgroundStyle', () => {
  it('returns gradient CSS for gradient type', () => {
    const result = buildBackgroundStyle({ type: 'gradient', value: 'linear-gradient(135deg, #000, #fff)' });
    expect(result?.background).toBe('linear-gradient(135deg, #000, #fff)');
  });

  it('returns image CSS for image type', () => {
    const result = buildBackgroundStyle({ type: 'image', value: 'https://example.com/bg.jpg' });
    expect(result?.backgroundImage).toBe('url("https://example.com/bg.jpg")');
    expect(result?.backgroundSize).toBe('cover');
  });

  it('returns solid CSS for solid type', () => {
    const result = buildBackgroundStyle({ type: 'solid', value: '#1a1a2e' });
    expect(result?.background).toBe('#1a1a2e');
  });

  it('passes opacity through to the result', () => {
    const result = buildBackgroundStyle({ type: 'solid', value: '#1a1a2e', opacity: 0.8 });
    expect(result?.opacity).toBe('0.8');
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
