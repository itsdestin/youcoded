// Pure source-pixel estimate for cushion/float chrome. No browser or theme state lives here.
export type RGB = readonly [number, number, number];
type ActiveStatus = 'red' | 'green' | 'blue' | 'amber';
type StatusColors = Readonly<Record<ActiveStatus | 'gray', RGB>>;

interface HeaderInkInputs {
  controlPixels: readonly RGB[];
  dotPixels: readonly RGB[];
  fg2: RGB;
  panel: RGB;
  statusColors: StatusColors;
}

interface HeaderInk {
  ink: string;
  statuses: Readonly<Record<ActiveStatus | 'gray', string>>;
  contrast: {
    control: number;
    controlMet: boolean;
    /** Dots aim for 2.5:1 (idle 1.8:1) within a hue-preserving band; see tuneDot. */
    active: Readonly<Record<ActiveStatus, number>>;
    idle: number;
  };
}

const valid = (color: RGB) => Array.isArray(color) && color.length === 3
  && color.every(v => Number.isFinite(v) && v >= 0 && v <= 255);
const css = (color: RGB) => `rgb(${color.map(Math.round).join(' ')})`;
const lum = (color: RGB) => color.map(channel => {
  const v = channel / 255;
  return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
}).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
/** WCAG contrast ratio between two opaque colours. */
export const contrastRatio = (a: RGB, b: RGB) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
const ratio = contrastRatio;
const floor = (color: RGB, pixels: readonly RGB[]) => {
  // WHY: a sampled wallpaper may supply more pixels than a JS argument list permits.
  let minimum = Infinity;
  for (const pixel of pixels) minimum = Math.min(minimum, ratio(color, pixel));
  return minimum;
};

function hsl(color: RGB): [number, number, number] {
  const [r, g, b] = color.map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const lightness = (max + min) / 2;
  if (!d) return [0, 0, lightness];
  const saturation = d / (1 - Math.abs(2 * lightness - 1));
  const sector = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((sector * 60) + 360) % 360, saturation, lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number): RGB {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = lightness - chroma / 2;
  const sectors = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]];
  const [r, g, b] = sectors[Math.min(5, Math.floor(hue / 60))];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function averageLum(pixels: readonly RGB[]): number {
  return pixels.reduce((sum, pixel) => sum + lum(pixel), 0) / pixels.length;
}

function tintedCandidate(base: RGB, pixels: readonly RGB[], threshold: number, minSaturation: number, direction?: 1 | -1): RGB | null {
  const [hue, saturation, lightness] = hsl(base);
  const preferred = direction ?? (averageLum(pixels) < .25 ? 1 : -1);
  // WHY: walking lightness in both directions preserves semantic/panel hue; never
  // claim a pass by picking a high-contrast but unrelated black or white.
  for (const direction of [preferred, -preferred]) {
    for (let i = 0; i <= 490; i++) {
      const next = lightness + direction * i / 500;
      if (next < .02 || next > .98) break;
      const candidate = fromHsl(hue, saturation < .02 ? 0 : Math.max(saturation, minSaturation), next);
      if (floor(candidate, pixels) >= threshold) return candidate;
    }
  }
  return null;
}

/** Return null instead of publishing a misleading contrast result for invalid/impossible samples. */
export function deriveWallpaperHeaderInk(input: HeaderInkInputs): HeaderInk | null {
  const { controlPixels, dotPixels, fg2, panel, statusColors } = input;
  if (!controlPixels.length || !dotPixels.length ||
      ![...controlPixels, ...dotPixels, fg2, panel, ...Object.values(statusColors)].every(valid)) return null;

  // WHY: Meadow Mist's pale panel is only 2.71:1 on its 1280px blue crop,
  // while its dark fg-2 passes. Prefer brightening the approved light panel
  // when WHITE could reach 3:1; otherwise a pale wallpaper keeps dark fg-2.
  const lightPanel = lum(fg2) < .6 && lum(panel) > .6 && floor([255, 255, 255], controlPixels) >= 3
    ? (floor(panel, controlPixels) >= 3 ? panel : tintedCandidate(panel, controlPixels, 3, 0, 1)) : null;
  const ink = lightPanel ?? (floor(fg2, controlPixels) >= 3 ? fg2
    : floor(panel, controlPixels) >= 3 ? panel : tintedCandidate(panel, controlPixels, 3, .58));
  if (!ink) return null;
  // WHY: Destin, 2026-09-23 — dots get no ring or backing; the colour itself must
  // read on any wallpaper. An earlier solver forced saturation up and lightened
  // freely, which turned red pink and green neon. Here each dot keeps its own
  // hue AND saturation; it may deepen a long way (deep red is still red) but may
  // only lighten slightly, because a much lighter red is pink.
  const keys: ActiveStatus[] = ['red', 'green', 'blue', 'amber'];
  const statuses = {} as Record<ActiveStatus | 'gray', string>;
  const active = {} as Record<ActiveStatus, number>;
  for (const key of keys) {
    // WHY: Destin, 2026-09-23 — "the red is too dark. i want it to be vibrant
    // like the green." Active dots may only nudge (±.1 lightness), never deepen.
    const dot = tuneDot(statusColors[key], dotPixels, 2.5, .1);
    statuses[key] = css(dot);
    active[key] = floor(dot, dotPixels);
  }
  // Idle is decorative: a lower target keeps it quieter than the active dots.
  const gray = tuneDot(statusColors.gray, dotPixels, 1.8, .5);
  statuses.gray = css(gray);
  const control = floor(ink, controlPixels);
  return { ink: css(ink), statuses, contrast: {
    control, controlMet: control >= 3, active, idle: floor(gray, dotPixels),
  } };
}

/** Nearest lightness (same hue and saturation) that reaches `target` against every
 *  sample, inside a band that cannot drift into pastel or dull; otherwise the
 *  best contrast that band allows. Never null: a dot always renders something. */
function tuneDot(original: RGB, pixels: readonly RGB[], target: number, maxDarken: number): RGB {
  if (floor(original, pixels) >= target) return original;
  const [hue, saturation, lightness] = hsl(original);
  const low = Math.max(.22, lightness - maxDarken);
  const high = Math.min(.74, lightness + .08);
  let best = original;
  let bestRatio = floor(original, pixels);
  for (let step = 1; step <= 100; step++) {
    for (const next of [lightness - step / 200, lightness + step / 200]) {
      if (next < low || next > high) continue;
      const candidate = fromHsl(hue, saturation, next);
      const r = floor(candidate, pixels);
      if (r >= target) return candidate;
      if (r > bestRatio) { best = candidate; bestRatio = r; }
    }
  }
  return best;
}
