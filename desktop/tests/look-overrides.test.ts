import { describe, it, expect } from 'vitest';
import {
  applyLookOverrides, parseLookOverrides, GLASS_PRESETS, roundnessToShape,
} from '../src/renderer/themes/look-overrides';
import type { LoadedTheme } from '../src/renderer/themes/theme-types';

const wallpaperTheme = {
  slug: 'meadow', name: 'Meadow', dark: false, source: 'community',
  tokens: {} as LoadedTheme['tokens'],
  layout: { 'chrome-style': 'default', 'bubble-style': 'bordered', 'input-style': 'default' },
  shape: { 'radius-md': '8px' },
  background: { type: 'image', value: 'bg.png', 'panels-blur': 20, 'panels-opacity': 0.9, 'terminal-opacity': 0.7 },
} as unknown as LoadedTheme;

const flatTheme = {
  slug: 'midnight', name: 'Midnight', dark: true, source: 'youcoded-core',
  tokens: {} as LoadedTheme['tokens'],
} as unknown as LoadedTheme;

describe('applyLookOverrides', () => {
  it('returns the very same theme object when nothing is overridden', () => {
    // The "nobody's look changes until they change a setting" promise: not an equal
    // copy, the same object, so no downstream memo or DOM write even re-runs.
    expect(applyLookOverrides(wallpaperTheme, {})).toBe(wallpaperTheme);
    expect(applyLookOverrides(flatTheme, {})).toBe(flatTheme);
  });

  it('lays the chosen layout, bubble shape and message box over the theme', () => {
    const out = applyLookOverrides(wallpaperTheme, { chromeStyle: 'float', bubbleStyle: 'pill', inputStyle: 'minimal' });
    expect(out.layout).toMatchObject({ 'chrome-style': 'float', 'bubble-style': 'pill', 'input-style': 'minimal' });
    expect(wallpaperTheme.layout?.['chrome-style']).toBe('default');
  });

  it('gives a theme with no layout block the chosen layout', () => {
    expect(applyLookOverrides(flatTheme, { chromeStyle: 'floating' }).layout?.['chrome-style']).toBe('floating');
  });

  it('replaces the corner radii with the chosen roundness', () => {
    const out = applyLookOverrides(wallpaperTheme, { roundness: 1 });
    expect(out.shape).toMatchObject(roundnessToShape(1));
  });

  it('applies a glass preset over a wallpaper, keeping the theme terminal settings', () => {
    const out = applyLookOverrides(wallpaperTheme, { glass: 'solid' });
    expect(out.background).toMatchObject(GLASS_PRESETS.solid);
    expect(out.background?.['terminal-opacity']).toBe(0.7);
    expect(out.background?.value).toBe('bg.png');
  });

  it('applies fine-tuned glass values only while glass is custom', () => {
    const custom = { 'panels-opacity': 0.4, 'terminal-opacity': 0.95 };
    expect(applyLookOverrides(wallpaperTheme, { glass: 'custom', glassCustom: custom }).background)
      .toMatchObject(custom);
    // Stored fine-tune values with a preset picked are remembered, not applied.
    expect(applyLookOverrides(wallpaperTheme, { glass: 'clear', glassCustom: custom }).background?.['panels-opacity'])
      .toBe(GLASS_PRESETS.clear['panels-opacity']);
  });

  it('never invents a background for a theme without a wallpaper or gradient', () => {
    const out = applyLookOverrides(flatTheme, { glass: 'frosted' });
    expect(out.background).toBeUndefined();
  });
});

describe('parseLookOverrides', () => {
  it('keeps valid choices and drops unknown or malformed ones', () => {
    expect(parseLookOverrides({
      chromeStyle: 'float', glass: 'shiny', bubbleStyle: 'pill', inputStyle: 42, roundness: 3,
      glassCustom: { 'panels-blur': 5, 'panels-opacity': 'x', bogus: 1 },
    })).toEqual({ chromeStyle: 'float', bubbleStyle: 'pill', glassCustom: { 'panels-blur': 5 } });
  });

  it('reads anything that is not an object as no overrides', () => {
    expect(parseLookOverrides(null)).toEqual({});
    expect(parseLookOverrides('float')).toEqual({});
  });
});
