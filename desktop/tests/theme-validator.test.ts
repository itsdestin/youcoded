import { describe, it, expect } from 'vitest';
import { validateTheme, computeOnAccent, luminance } from '../src/renderer/themes/theme-validator';

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
    expect(computeOnAccent('#0D0F1A')).toBe('#FFFFFF');
  });

  it('returns black for light accent colors', () => {
    expect(computeOnAccent('#F2F2F2')).toBe('#000000');
    expect(computeOnAccent('#FFFFFF')).toBe('#000000');
    expect(computeOnAccent('#D4D4D4')).toBe('#000000');
  });

  it('returns black for mid-range colors above 0.179 threshold', () => {
    expect(computeOnAccent('#7C6AF7')).toBe('#000000');
    expect(computeOnAccent('#FF7700')).toBe('#000000');
  });
});

describe('luminance', () => {
  it('returns 1.0 for white', () => {
    expect(luminance('#FFFFFF')).toBeCloseTo(1.0);
  });

  it('returns 0.0 for black', () => {
    expect(luminance('#000000')).toBeCloseTo(0.0);
  });

  it('returns 0 for non-hex input without crashing', () => {
    expect(luminance('rgb(255,255,255)')).toBe(0);
    expect(luminance('#FFF')).toBe(0);
  });
});

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
