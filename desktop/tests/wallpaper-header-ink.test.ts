import { describe, expect, it } from 'vitest';
import { deriveWallpaperHeaderInk, type RGB } from '../src/renderer/themes/wallpaper-header-ink';

const rgb = (hex: string): RGB => [0, 2, 4].map(i => parseInt(hex.slice(i + 1, i + 3), 16)) as unknown as RGB;
const luminance = (c: RGB) => c.map(channel => {
  const v = channel / 255;
  return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
}).reduce((sum, v, index) => sum + v * [.2126, .7152, .0722][index], 0);
const contrast = (a: RGB, b: RGB) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const channels = (css: string): RGB => {
  const match = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(css);
  expect(match).not.toBeNull();
  return [Number(match![1]), Number(match![2]), Number(match![3])];
};
const statusColors = { red: rgb('#D94848'), green: rgb('#23B567'), blue: rgb('#398DD9'), amber: rgb('#E4AE39'), gray: rgb('#8C9295') };
const inputs = (background: RGB) => ({ controlPixels: [background], dotPixels: [background], fg2: rgb('#DCE6E3'), panel: rgb('#DDE9DA'), statusColors });

const hsl = (c: RGB) => {
  const [r, g, b] = c.map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60) + 360) % 360, d / (1 - Math.abs(2 * l - 1)), l];
};

describe('deriveWallpaperHeaderInk — header ink', () => {
  it('retains theme fg-2 on dark pixels when every control passes', () => {
    const result = deriveWallpaperHeaderInk(inputs(rgb('#172537')));
    expect(result!.ink).toBe('rgb(220 230 227)');
    expect(result!.contrast.controlMet).toBe(true);
  });

  it('keeps Meadow Mist header ink pale at the narrower 1280px wallpaper crop', () => {
    // The sampled strip center is #5890C1 at 1280×640: panel is 2.71:1,
    // dark fg-2 passes 3:1, but a lighter tint of panel also passes.
    const background: RGB = [88, 144, 193];
    const result = deriveWallpaperHeaderInk({ ...inputs(background), fg2: rgb('#1E3426') });
    expect(Math.min(...channels(result!.ink))).toBeGreaterThan(190);
    expect(contrast(channels(result!.ink), background)).toBeGreaterThanOrEqual(3);
  });

  it('makes panel-hue mint rather than black or white over mid-blue', () => {
    const result = deriveWallpaperHeaderInk(inputs(rgb('#476886')));
    const ink = channels(result!.ink);
    expect(ink[1]).toBeGreaterThan(ink[0]);
    expect(ink[1]).toBeGreaterThan(ink[2]);
    expect(result!.contrast.control).toBeGreaterThanOrEqual(3);
  });

  it('keeps dark fg-2 on pale wallpaper', () => {
    const result = deriveWallpaperHeaderInk({ ...inputs(rgb('#F1EDEA')), fg2: rgb('#293334') });
    expect(result!.ink).toBe('rgb(41 51 52)');
  });

  it('preserves passing panel ink and keeps a failing achromatic panel achromatic', () => {
    const withPanel = deriveWallpaperHeaderInk({ ...inputs(rgb('#172537')), fg2: rgb('#222222') });
    expect(withPanel!.ink).toBe('rgb(221 233 218)');
    const neutral = deriveWallpaperHeaderInk({ ...inputs(rgb('#888888')), fg2: rgb('#888888'), panel: rgb('#999999') });
    const ink = channels(neutral!.ink);
    expect(ink[0]).toBe(ink[1]);
    expect(ink[1]).toBe(ink[2]);
    expect(neutral!.contrast.control).toBeGreaterThanOrEqual(3);
  });

  it('accepts many samples without overflowing the argument list', () => {
    // WHY: the minimum must be scanned, not spread into Math.min.
    const dark = rgb('#172537');
    const result = deriveWallpaperHeaderInk({ ...inputs(dark), controlPixels: Array(130_000).fill(dark), dotPixels: Array(130_000).fill(dark) });
    expect(result?.ink).toBe('rgb(220 230 227)');
  });

  it('refuses contradictory control samples rather than reporting a false pass', () => {
    // WHY: black + white alone CAN admit a midtone at 3:1; the middle gray closes that gap.
    const impossible = [rgb('#000000'), rgb('#888888'), rgb('#FFFFFF')];
    expect(deriveWallpaperHeaderInk({ ...inputs(rgb('#000000')), controlPixels: impossible })).toBeNull();
  });

  it('returns null for invalid RGB and missing samples without mutating caller arrays', () => {
    expect(deriveWallpaperHeaderInk({ ...inputs(rgb('#123456')), fg2: [NaN, 3, 4] })).toBeNull();
    expect(deriveWallpaperHeaderInk({ ...inputs(rgb('#123456')), dotPixels: [] })).toBeNull();
    const original = inputs(rgb('#172537'));
    const snapshot = JSON.stringify(original);
    deriveWallpaperHeaderInk(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

// WHY: Destin, 2026-09-23 — dots have no backing, ring or glow, so the colour
// alone must read. An earlier solver lightened freely and forced saturation up:
// red became pink, green neon. These pin the replacement's limits.
describe('deriveWallpaperHeaderInk — status dots', () => {
  const tailwind = { red: rgb('#f87171'), green: rgb('#4ade80'), blue: rgb('#60a5fa'), amber: rgb('#fbbf24'), gray: rgb('#6b7280') };
  const dots = (background: RGB) => deriveWallpaperHeaderInk({ ...inputs(background), statusColors: tailwind })!;

  it('leaves the familiar colours untouched where they already read', () => {
    const result = dots(rgb('#0D1117'));
    for (const key of ['red', 'green', 'blue', 'amber'] as const) {
      expect(channels(result.statuses[key])).toEqual(tailwind[key]);
    }
  });

  for (const [name, background] of [['Meadow mid-blue', [88, 144, 193]], ['pale', rgb('#F1EDEA')], ['slate', rgb('#476886')]] as const) {
    it(`keeps hue and saturation and never turns pastel on ${name} wallpaper`, () => {
      const result = dots(background as RGB);
      for (const key of ['red', 'green', 'blue', 'amber', 'gray'] as const) {
        const [h0, s0, l0] = hsl(tailwind[key]);
        const [h1, s1, l1] = hsl(channels(result.statuses[key]));
        if (s0 > .05) expect(Math.abs(((h1 - h0 + 540) % 360) - 180)).toBeLessThan(6);
        expect(Math.abs(s1 - s0)).toBeLessThan(.06);
        expect(l1).toBeLessThanOrEqual(Math.min(.74, l0 + .08) + .01);
        expect(l1).toBeGreaterThanOrEqual(key === 'gray' ? .21 : l0 - .11);
        // Never worse than the untuned colour.
        expect(contrast(channels(result.statuses[key]), background as RGB) + 1e-9)
          .toBeGreaterThanOrEqual(contrast(tailwind[key], background as RGB));
      }
    });
  }

  it('keeps active dots vibrant: never more than a small nudge darker', () => {
    for (const background of [[88, 144, 193], rgb('#F1EDEA'), rgb('#476886')] as RGB[]) {
      const result = dots(background);
      for (const key of ['red', 'green', 'blue', 'amber'] as const) {
        expect(hsl(channels(result.statuses[key]))[2]).toBeGreaterThanOrEqual(hsl(tailwind[key])[2] - .1 - .01);
      }
    }
  });

  it('still renders dots on contradictory samples instead of dropping them', () => {
    const impossible = [rgb('#000000'), rgb('#888888'), rgb('#FFFFFF')];
    const result = deriveWallpaperHeaderInk({ ...inputs(rgb('#172537')), dotPixels: impossible, statusColors: tailwind });
    expect(result).not.toBeNull();
    expect(result!.statuses.red).toMatch(/^rgb\(/);
  });
});
